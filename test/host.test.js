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

  // 1) 注册面：四个工具 + 一条精确 fetch 路由
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['noagent_log', 'noagent_run', 'noagent_status', 'noagent_update'],
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

  // 上一轮的 run 是 wait:false，日志文件名带毫秒戳、在跑完之后才落盘。
  // 不等它写完就进第 4 步，两次读取就可能分别看到这次和上一次的日志（file 差 1ms）。
  const runLogDir = path.join(dir, 'runs', 'unit')
  for (let i = 0; i < 1000; i += 1) {
    const files = await fs.readdir(runLogDir).catch(() => [])
    if (files.filter((name) => name.endsWith('.log')).length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

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

// ---------------------------------------------------------------------------
// 0.4.0：界面上的写操作（启停 / 改计划 / 删除）必须安全 —— 保留未知字段、
// 先备份、非法值拒绝落盘。
// ---------------------------------------------------------------------------

/** 一份带「本插件不认识」的字段的 jobs.json：写回时这些字段必须原样保留。 */
function richJobs() {
  return {
    version: 3,
    note: '手写的清单',
    jobs: [
      {
        id: 'unit',
        name: '单元测试任务',
        cron: '30 18 * * *',
        command: 'echo ok',
        timeZone: 'Asia/Shanghai',
        timeoutSeconds: 180,
        env: { FEISHU_CHAT_ID: 'oc_x', TELEGRAM_CHAT_ID: '1' },
        cwd: '/tmp',
        customField: { nested: true },
      },
      {
        id: 'watch',
        name: '探针任务',
        everySeconds: 120,
        command: 'bash probe.sh',
        wakeOnChange: { sessionId: 'session-abc', title: '有新消息', onlyOnNew: true },
      },
    ],
  }
}

async function setupRich() {
  const dir = await tempDir()
  const jobsFile = path.join(dir, 'jobs.json')
  await fs.writeFile(jobsFile, JSON.stringify(richJobs()))
  const { ctx, routes } = createCtx({})
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1 })
  return { dir, jobsFile, route: routes[0] }
}

test('RPC update：只改传入字段，未知字段与 wakeOnChange 原样保留', async () => {
  const { jobsFile, route } = await setupRich()

  const response = await postRpc(route, {
    op: 'update',
    id: 'unit',
    patch: { cron: '0 7 * * 1-5', timeoutSeconds: 600, name: '改过名的任务' },
  })
  const body = await response.json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.equal(body.value.updated, true)

  const saved = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  assert.equal(saved.version, 3, '顶层未知字段必须保留')
  assert.equal(saved.note, '手写的清单')
  const unit = saved.jobs.find((job) => job.id === 'unit')
  assert.equal(unit.cron, '0 7 * * 1-5')
  assert.equal(unit.timeoutSeconds, 600)
  assert.equal(unit.name, '改过名的任务')
  // 没点到的字段一个都不能丢
  assert.deepEqual(unit.env, { FEISHU_CHAT_ID: 'oc_x', TELEGRAM_CHAT_ID: '1' })
  assert.equal(unit.cwd, '/tmp')
  assert.deepEqual(unit.customField, { nested: true })
  assert.equal(unit.command, 'echo ok')

  const watch = saved.jobs.find((job) => job.id === 'watch')
  assert.equal(watch.wakeOnChange.sessionId, 'session-abc', '另一个任务的 wakeOnChange 不能被碰')
})

test('RPC update：cron / 间隔模式互斥，切换时删掉另一种字段', async () => {
  const { jobsFile, route } = await setupRich()

  const toEvery = await (await postRpc(route, {
    op: 'update',
    id: 'unit',
    patch: { mode: 'every', everySeconds: 300 },
  })).json()
  assert.equal(toEvery.ok, true, JSON.stringify(toEvery))
  let saved = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  let unit = saved.jobs.find((job) => job.id === 'unit')
  assert.equal(unit.everySeconds, 300)
  assert.equal(unit.cron, undefined, '切到间隔后 cron 必须删除')

  const backToCron = await (await postRpc(route, {
    op: 'update',
    id: 'unit',
    patch: { mode: 'cron', cron: '5 6 * * *' },
  })).json()
  assert.equal(backToCron.ok, true, JSON.stringify(backToCron))
  saved = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  unit = saved.jobs.find((job) => job.id === 'unit')
  assert.equal(unit.cron, '5 6 * * *')
  assert.equal(unit.everySeconds, undefined, '切回 cron 后 everySeconds 必须删除')
})

test('RPC update：非法 cron / 间隔 / 超时 / 时区一律拒绝且不落盘', async () => {
  const { jobsFile, route } = await setupRich()
  const before = await fs.readFile(jobsFile, 'utf8')

  const cases = [
    { op: 'update', id: 'unit', patch: { mode: 'cron', cron: '61 99 * * *' } },
    { op: 'update', id: 'unit', patch: { mode: 'cron', cron: '' } },
    { op: 'update', id: 'unit', patch: { mode: 'every', everySeconds: 5 } },
    { op: 'update', id: 'unit', patch: { timeoutSeconds: 1 } },
    { op: 'update', id: 'unit', patch: { timeZone: 'Mars/Olympus' } },
  ]
  for (const payload of cases) {
    const body = await (await postRpc(route, payload)).json()
    assert.equal(body.ok, false, `应当拒绝：${JSON.stringify(payload)}`)
    assert.ok(body.error.code, '被拒绝时必须给出错误码')
  }
  assert.equal(await fs.readFile(jobsFile, 'utf8'), before, '被拒绝的修改不能写进文件')
})

test('RPC update：写回前留备份，且备份数量有上限', async () => {
  const { dir, jobsFile, route } = await setupRich()

  for (let i = 0; i < 13; i += 1) {
    const body = await (await postRpc(route, { op: 'update', id: 'unit', patch: { timeoutSeconds: 100 + i } })).json()
    assert.equal(body.ok, true, JSON.stringify(body))
  }

  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith('jobs.json.bak-'))
  assert.equal(backups.length, 10, `备份应只保留 10 份，实际 ${backups.length}`)
  // 备份是「改之前」的内容：13 次写入只留最后 10 份，即改动前的 102–111 秒
  const contents = await Promise.all(backups.sort().map((name) => fs.readFile(path.join(dir, name), 'utf8')))
  const values = contents
    .flatMap((text) => JSON.parse(text).jobs)
    .filter((job) => job.id === 'unit')
    .map((job) => job.timeoutSeconds)
  assert.ok(values.includes(102), `备份里应能找回历史值，实际 ${values.join(',')}`)
  assert.ok(values.length >= 10, '每份备份都该是完整清单')
})

test('RPC toggle：只改 enabled，返回后 status 反映新状态', async () => {
  const { route } = await setupRich()

  const off = await (await postRpc(route, { op: 'toggle', id: 'unit', enabled: false })).json()
  assert.equal(off.ok, true, JSON.stringify(off))
  let status = await (await postRpc(route, { op: 'status' })).json()
  assert.equal(status.value.jobs.find((job) => job.id === 'unit').enabled, false)
  // 停用的任务没有下次运行时间
  assert.equal(status.value.jobs.find((job) => job.id === 'unit').nextRunAt, null)

  const on = await (await postRpc(route, { op: 'toggle', id: 'unit', enabled: true })).json()
  assert.equal(on.ok, true)
  status = await (await postRpc(route, { op: 'status' })).json()
  const unit = status.value.jobs.find((job) => job.id === 'unit')
  assert.equal(unit.enabled, true)
  assert.ok(Number.isFinite(unit.nextRunAt), '启用后应算出下次运行时间')
})

test('RPC delete：删除任务并保留其它任务，未知顶层字段不丢', async () => {
  const { jobsFile, route } = await setupRich()

  const body = await (await postRpc(route, { op: 'delete', id: 'watch' })).json()
  assert.equal(body.ok, true, JSON.stringify(body))

  const saved = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  assert.equal(saved.version, 3)
  assert.equal(saved.note, '手写的清单')
  assert.deepEqual(saved.jobs.map((job) => job.id), ['unit'])

  const missing = await (await postRpc(route, { op: 'delete', id: 'watch' })).json()
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'job_not_found')
})

test('RPC status：带 nextRunAt / recent / jobsFile / now', async () => {
  const { route } = await setupRich()
  const body = await (await postRpc(route, { op: 'status' })).json()
  assert.equal(body.ok, true)

  const value = body.value
  assert.ok(Number.isFinite(value.now))
  assert.ok(typeof value.jobsFile === 'string' && value.jobsFile.endsWith('jobs.json'))
  const unit = value.jobs.find((job) => job.id === 'unit')
  assert.equal(unit.schedule.kind, 'cron')
  assert.ok(Number.isFinite(unit.nextRunAt))
  // 18:30 每天一次，下次不会超过 24 小时
  assert.ok(unit.nextRunAt - value.now <= 86_400_000)
  assert.ok(Array.isArray(unit.recent))
  const watch = value.jobs.find((job) => job.id === 'watch')
  assert.equal(watch.watch, true)
  assert.equal(watch.wakeSessionId, 'session-abc')
})

test('RPC log：按 at 精确取某一次运行的日志', async () => {
  const { dir, route } = await setupRich()
  const logDir = path.join(dir, 'runs', 'unit')
  await fs.mkdir(logDir, { recursive: true })
  const first = '2026-10-20T10-00-00-000Z'
  const second = '2026-10-21T10-00-00-000Z'
  await fs.writeFile(path.join(logDir, `${first}.log`), 'first run\n')
  await fs.writeFile(path.join(logDir, `${second}.log`), 'second run\n')

  const latest = await (await postRpc(route, { op: 'log', id: 'unit' })).json()
  assert.equal(latest.value.text, 'second run\n')

  const older = await (await postRpc(route, {
    op: 'log',
    id: 'unit',
    at: '2026-10-20T10:00:00.000Z',
  })).json()
  assert.equal(older.value.text, 'first run\n')
  assert.equal(older.value.file, `${first}.log`)
})

test('noagent_update 工具：与 UI 走同一份实现', async () => {
  const dir = await tempDir()
  const jobsFile = path.join(dir, 'jobs.json')
  await fs.writeFile(jobsFile, JSON.stringify(richJobs()))
  const { ctx, tools } = createCtx({})
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1 })

  const update = tools.find((tool) => tool.name === 'noagent_update')
  assert.ok(update, '缺少 noagent_update 工具')
  await update.execute({ id: 'unit', cron: '0 3 * * *' }, {})

  const saved = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  const unit = saved.jobs.find((job) => job.id === 'unit')
  assert.equal(unit.cron, '0 3 * * *')
  assert.deepEqual(unit.env, { FEISHU_CHAT_ID: 'oc_x', TELEGRAM_CHAT_ID: '1' })

  // everySeconds 代表切到间隔模式
  await update.execute({ id: 'unit', everySeconds: 600 }, {})
  const again = JSON.parse(await fs.readFile(jobsFile, 'utf8'))
  const changed = again.jobs.find((job) => job.id === 'unit')
  assert.equal(changed.everySeconds, 600)
  assert.equal(changed.cron, undefined)
})
