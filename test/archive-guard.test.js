import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { apply } from '../index.js'

/**
 * 构造一个最小 ctx，只额外提供 `on`，用来抓 session-activity provider。
 *
 * 背景（2026-10-26 事故）：四个 job 的唤醒目标会话被归档后，ArchivedSessionGate 在
 * agent/pre-step 直接 reject，整轮记为 blocked —— 模型一次都没跑，但本插件这边
 * create 成功、lastWakeAt 有值、探针 exit 0，面板上完全健康，静默失效两天。
 * dsh-schedule 早就注册了这个闸门 provider，本插件一个都没注册，于是归档放行。
 */
function makeCtx() {
  const handlers = new Map()
  const ctx = {
    logger: { info() {} },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    interval: () => () => {},
    on: (name, fn) => {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    get: () => undefined,
  }
  return { ctx, handlers }
}

async function writeJobs(jobs) {
  const dir = await fs.mkdtemp('/tmp/noagent-archive-guard-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(jobsFile, JSON.stringify({ jobs }))
  return { dir, jobsFile }
}

test('apply：注册 session-activity provider，唤醒目标会话被判为「有活」', async () => {
  const { dir, jobsFile } = await writeJobs([
    {
      id: 'probe',
      name: '探针',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '有新内容：{{output}}' },
    },
  ])
  const { ctx, handlers } = makeCtx()
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 3600, jobsReloadMs: 0 })

  const handler = handlers.get('workspace/session-activity')
  assert.equal(typeof handler, 'function', '必须注册 workspace/session-activity provider')

  const blocked = await handler({ sessionId: 'session-abc' }, async () => [])
  assert.equal(blocked.length, 1, '依赖该会话的 job 必须让归档被拒绝')
  assert.equal(blocked[0].kind, 'noagent')
  assert.equal(blocked[0].items[0].id, 'probe')
  assert.match(blocked[0].items[0].label, /探针/)

  const untouched = await handler({ sessionId: 'session-other' }, async () => [])
  assert.deepEqual(untouched, [], '没有 job 依赖的会话不该被拦')
})

test('apply：wakeMode=fresh 的 job 不占用任何会话', async () => {
  const { dir, jobsFile } = await writeJobs([
    {
      id: 'fresh-probe',
      name: '无会话探针',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { wakeMode: 'fresh', prompt: '{{output}}' },
    },
  ])
  const { ctx, handlers } = makeCtx()
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 3600, jobsReloadMs: 0 })

  const handler = handlers.get('workspace/session-activity')
  const activity = await handler({ sessionId: 'session-abc' }, async () => [])
  assert.deepEqual(activity, [], 'fresh 模式每次新建会话，不依赖任何既有会话')
})

test('apply：已停用的 job 仍要拦住归档（重新启用就会静默失效）', async () => {
  const { dir, jobsFile } = await writeJobs([
    {
      id: 'paused-probe',
      name: '停用的探针',
      enabled: false,
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '{{output}}' },
    },
  ])
  const { ctx, handlers } = makeCtx()
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 3600, jobsReloadMs: 0 })

  const activity = await handlers.get('workspace/session-activity')({ sessionId: 'session-abc' }, async () => [])
  assert.equal(activity.length, 1)
  assert.match(activity[0].items[0].label, /已停用/)
})

test('apply：任务清单读不出来时 fail closed，宁可拒绝归档', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-archive-guard-broken-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(jobsFile, '{ 这不是 JSON')
  const { ctx, handlers } = makeCtx()
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 3600, jobsReloadMs: 0 })

  const activity = await handlers.get('workspace/session-activity')({ sessionId: 'session-abc' }, async () => [])
  assert.equal(activity.length, 1, '清单坏了不能假装没有依赖')
  assert.equal(activity[0].items[0].id, 'jobs-unreadable')
})

test('apply：provider 保留下游 provider 的结论', async () => {
  const { dir, jobsFile } = await writeJobs([
    {
      id: 'probe',
      name: '探针',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '{{output}}' },
    },
  ])
  const { ctx, handlers } = makeCtx()
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 3600, jobsReloadMs: 0 })

  const downstream = [{ kind: 'schedule', items: [{ id: 's1', label: '别的任务' }] }]
  const activity = await handlers.get('workspace/session-activity')(
    { sessionId: 'session-abc' },
    async () => downstream,
  )
  assert.equal(activity.length, 2)
  assert.deepEqual(activity[1], downstream[0])
})
