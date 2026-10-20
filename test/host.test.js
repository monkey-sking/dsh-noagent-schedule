import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply, assertJobId, readJobStatus, readRunLog, RPC_PATH } from '../index.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'noagent-host-'))
}

/** 假 subprocess：一次 spawn 直接以 exitCode 0 + 固定 stdout 结束。 */
function fakeSubprocess(calls, stdoutText = 'hello from stdout\n') {
  return {
    spawn(spec) {
      calls.push(spec)
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdoutText, nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
      }
    },
  }
}

/** 最小假 ctx：捕获工具定义与 fetch 路由，不碰真的 profile / ~/.dsh。 */
function createCtx({ calls = [], stdoutText } = {}) {
  const tools = []
  const routes = []
  const ctx = {
    logger: { info() {} },
    effect(fn) {
      return fn()
    },
    interval() {
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return async () => {}
        },
      },
    },
    subprocess: fakeSubprocess(calls, stdoutText),
  }
  return { ctx, tools, routes }
}

async function postRpc(route, payload) {
  return route.fetch(
    new Request(`http://127.0.0.1:1${RPC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

test('assertJobId：拒绝路径穿越', () => {
  assert.equal(assertJobId('unit-job_1'), 'unit-job_1')
  for (const bad of ['../etc', 'a/b', '..', '', 'a\\b']) {
    assert.throws(() => assertJobId(bad), /任务 id 非法/)
  }
})

test('readJobStatus：合并 jobs.json / state.json / runs.jsonl', async () => {
  const dir = await tempDir()
  const jobsFile = path.join(dir, 'jobs.json')
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [
        { id: 'cron-job', name: '定时任务', cron: '30 18 * * *', command: 'true' },
        { id: 'every-job', everySeconds: 60, argv: ['/bin/echo', 'hi'], enabled: false },
      ],
    }),
  )
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      updatedAt: '2026-10-19T10:00:00.000Z',
      jobs: { 'cron-job': { lastStartedAt: '2026-10-19T09:00:00.000Z', lastExitCode: 0, lastOk: true, lastDurationMs: 12 } },
    }),
  )
  await fs.writeFile(
    path.join(dir, 'runs.jsonl'),
    `${JSON.stringify({ id: 'cron-job', startedAt: '2026-10-19T09:00:00.000Z', durationMs: 12, exitCode: 0, ok: true, timedOut: false, stderrTail: '' })}\n`,
  )
  const status = await readJobStatus({ jobsFile, stateDir: dir, runningIds: new Set(['every-job']) })
  assert.equal(status.updatedAt, '2026-10-19T10:00:00.000Z')
  assert.equal(status.jobs.length, 2)
  const cron = status.jobs.find((job) => job.id === 'cron-job')
  assert.equal(cron.schedule.kind, 'cron')
  assert.equal(cron.schedule.cron, '30 18 * * *')
  assert.equal(cron.last.exitCode, 0)
  assert.equal(cron.last.ok, true)
  assert.equal(cron.command, 'true')
  const every = status.jobs.find((job) => job.id === 'every-job')
  assert.equal(every.schedule.kind, 'every')
  assert.equal(every.schedule.everySeconds, 60)
  assert.equal(every.enabled, false)
  assert.equal(every.command, '/bin/echo hi')
  assert.equal(every.running, true, 'runningIds 要反映到 running 标志')
  // 不泄漏 env
  assert.equal('env' in cron, false)
})

test('readJobStatus：jobs 文件缺失或格式错误要给出可读错误码', async () => {
  const dir = await tempDir()
  await assert.rejects(
    () => readJobStatus({ jobsFile: path.join(dir, 'nope.json'), stateDir: dir }),
    (error) => error.code === 'jobs_missing',
  )
  const bad = path.join(dir, 'bad.json')
  await fs.writeFile(bad, JSON.stringify({ jobs: [{ id: 'x', command: 'true' }] }))
  await assert.rejects(
    () => readJobStatus({ jobsFile: bad, stateDir: dir }),
    (error) => error.code === 'jobs_invalid',
  )
})

test('readRunLog：取最新日志、支持截断、缺日志不报错', async () => {
  const dir = await tempDir()
  await assert.doesNotReject(() => readRunLog({ stateDir: dir, id: 'none' }))
  const empty = await readRunLog({ stateDir: dir, id: 'none' })
  assert.equal(empty.file, null)
  assert.equal(empty.text, '')

  const runDir = path.join(dir, 'runs', 'unit')
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(path.join(runDir, '2026-10-19T09-00-00-000Z.log'), 'older run\n')
  await fs.writeFile(path.join(runDir, '2026-10-19T10-00-00-000Z.log'), 'line one\nline two\n')
  const latest = await readRunLog({ stateDir: dir, id: 'unit' })
  assert.equal(latest.file, '2026-10-19T10-00-00-000Z.log')
  assert.equal(latest.text, 'line one\nline two\n')
  assert.equal(latest.truncated, false)

  const tail = await readRunLog({ stateDir: dir, id: 'unit', limitBytes: 9 })
  assert.equal(tail.truncated, true)
  assert.equal(tail.text, 'line two\n')

  await assert.rejects(() => readRunLog({ stateDir: dir, id: '../escape' }), /任务 id 非法/)
})

test('apply：UI 路由与 agent 工具共用同一份操作实现', async () => {
  const dir = await tempDir()
  const jobsFile = path.join(dir, 'jobs.json')
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [{ id: 'unit', name: '单元测试任务', everySeconds: 60, command: 'echo ok' }],
    }),
  )

  const calls = []
  const { ctx, tools, routes } = createCtx({ calls })
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1 })

  // 1) 注册面：三个工具 + 一条精确 fetch 路由
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['noagent_log', 'noagent_run', 'noagent_status'],
  )
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, RPC_PATH)
  assert.deepEqual(routes[0].methods, ['POST'])
  assert.equal(routes[0].requestBody, 'buffered')
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.render({}, { ok: true })[0].type, 'text')
  }

  // 2) status：路由与工具返回同一份数据
  const statusResponse = await postRpc(routes[0], { op: 'status' })
  assert.equal(statusResponse.status, 200)
  const statusBody = await statusResponse.json()
  assert.equal(statusBody.ok, true)
  assert.equal(statusBody.value.jobs.length, 1)
  assert.equal(statusBody.value.jobs[0].id, 'unit')

  const statusTool = tools.find((tool) => tool.name === 'noagent_status')
  const statusFromTool = await statusTool.execute({}, {})
  assert.deepEqual(statusFromTool.jobs.map((job) => job.id), statusBody.value.jobs.map((job) => job.id))
  assert.equal(statusFromTool.jobs[0].last, null)

  // 3) run：UI 用 wait:false 只启动；工具等待并返回记录
  const runTool = tools.find((tool) => tool.name === 'noagent_run')
  const runResult = await runTool.execute({ id: 'unit' }, {})
  assert.equal(runResult.id, 'unit')
  assert.equal(runResult.record.exitCode, 0)
  assert.equal(runResult.record.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, ['/bin/bash', '-lc', 'echo ok'])

  const accepted = await postRpc(routes[0], { op: 'run', id: 'unit' })
  const acceptedBody = await accepted.json()
  // 上一轮已结束，所以这次可以再次启动
  assert.equal(acceptedBody.ok, true)
  assert.equal(acceptedBody.value.accepted, true)

  const missing = await postRpc(routes[0], { op: 'run', id: 'nope' })
  const missingBody = await missing.json()
  assert.equal(missingBody.ok, false)
  assert.equal(missingBody.error.code, 'job_not_found')

  // 4) log：路由与工具读到同一份日志
  const logResponse = await postRpc(routes[0], { op: 'log', id: 'unit' })
  const logBody = await logResponse.json()
  assert.equal(logBody.ok, true)
  assert.match(logBody.value.file, /\.log$/)
  assert.match(logBody.value.text, /--- stdout ---/)
  assert.match(logBody.value.text, /hello from stdout/)

  const logTool = tools.find((tool) => tool.name === 'noagent_log')
  const logFromTool = await logTool.execute({ id: 'unit' }, {})
  assert.equal(logFromTool.file, logBody.value.file)
  assert.equal(logFromTool.text, logBody.value.text)

  // 5) 错误面：未知 op -> 400；非法 id -> invalid_job_id
  const unknown = await postRpc(routes[0], { op: 'bogus' })
  assert.equal(unknown.status, 400)
  const unknownBody = await unknown.json()
  assert.equal(unknownBody.error.code, 'unknown_op')

  const badId = await postRpc(routes[0], { op: 'log', id: '../escape' })
  const badIdBody = await badId.json()
  assert.equal(badIdBody.ok, false)
  assert.equal(badIdBody.error.code, 'invalid_job_id')

  const badBody = await routes[0].fetch(
    new Request(`http://127.0.0.1:1${RPC_PATH}`, { method: 'POST', body: 'not json' }),
  )
  assert.equal(badBody.status, 400)

  // 6) 状态落盘没被破坏：state.json / runs.jsonl 都有记录
  const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(state.jobs.unit.lastExitCode, 0)
  const runs = (await fs.readFile(path.join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(runs.length, 2)
})
