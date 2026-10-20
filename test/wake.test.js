import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  apply,
  normalizeJobs,
  normalizeForFingerprint,
  fingerprintOf,
  renderWakePrompt,
} from '../index.js'

test('normalizeForFingerprint：忽略噪声行后保持稳定', () => {
  const wake = { ignoreLines: ['^ts='] }
  const a = normalizeForFingerprint('HEAD 3 OWED 1\nts=10:01\n张三 | 在吗', wake)
  const b = normalizeForFingerprint('HEAD 3 OWED 1\nts=10:05\n张三 | 在吗', wake)
  assert.equal(a, b, '只差时间戳时应视为没变化')
  const c = normalizeForFingerprint('HEAD 3 OWED 2\nts=10:05\n李四 | 你好', wake)
  assert.notEqual(a, c, '正文变化时必须不同')
})

test('fingerprintOf：稳定且区分内容', () => {
  assert.equal(fingerprintOf('abc'), fingerprintOf('abc'))
  assert.notEqual(fingerprintOf('abc'), fingerprintOf('abd'))
})

test('renderWakePrompt：占位符替换与截断', () => {
  const out = renderWakePrompt('任务 {{id}} 有新内容：\n{{output}}', { id: 'boss', name: 'B' }, {
    current: 'x'.repeat(50),
  }, 10)
  assert.match(out, /任务 boss 有新内容/)
  assert.match(out, /已截断/)
})

test('normalizeJobs：wakeOnChange 校验', () => {
  const jobs = normalizeJobs({
    jobs: [
      { id: 'a', everySeconds: 60, command: 'true', wakeOnChange: { sessionId: 'session-1' } },
    ],
  })
  assert.equal(jobs[0].wakeOnChange.sessionId, 'session-1')
  assert.deepEqual(jobs[0].wakeOnChange.ignoreLines, [])
  assert.equal(jobs[0].wakeOnChange.notifyOnFirstRun, false)

  assert.throws(
    () => normalizeJobs({ jobs: [{ id: 'b', everySeconds: 60, command: 'true', wakeOnChange: {} }] }),
    /缺少 sessionId/,
  )
})

/** 构造一个最小可用的假 ctx，schedule.create 记录每次唤醒。 */
function makeCtx(outputs) {
  const ticks = []
  const wakes = []
  let index = 0
  const ctx = {
    logger: { info() {} },
    effect: (fn) => fn(),
    interval: (cb) => {
      ticks.push(cb)
      return () => {}
    },
    get: (name) => (name === 'schedule' ? { create: async (sid, req) => {
      wakes.push({ sid, ...req })
      return { id: `sched-${wakes.length}` }
    } } : undefined),
    subprocess: {
      spawn() {
        const text = outputs[index] ?? outputs[outputs.length - 1]
        index += 1
        return {
          collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
        }
      },
    },
  }
  return { ctx, ticks, wakes }
}

test('apply：输出不变不唤醒，变了才唤醒一次', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-wake-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [{
      id: 'probe',
      name: '探针',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '新内容：{{output}}' },
    }],
  }))

  // tick 用 new Date() 判定 everySeconds 是否到期；整体替换 Date 才能推进时钟。
  const RealDate = Date
  let offset = 0
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + offset]))
    }
    static now() {
      return RealDate.now() + offset
    }
  }

  const { ctx, ticks, wakes } = makeCtx(['OWED 0', 'OWED 0', 'OWED 1 | 张三 | 在吗', 'OWED 1 | 张三 | 在吗'])
  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    const tick = async () => {
      await ticks[0]()
      await new Promise((r) => setTimeout(r, 150))
      offset += 61_000
    }
    await tick() // 基线：只记指纹
    await tick() // 未变
    await tick() // 变了 → 唤醒
    await tick() // 又未变
  } finally {
    globalThis.Date = RealDate
  }

  assert.equal(wakes.length, 1, '只有内容变化那一次应该唤醒')
  assert.equal(wakes[0].sid, 'session-abc')
  assert.equal(wakes[0].after_seconds, 1)
  assert.match(wakes[0].prompt, /OWED 1 \| 张三 \| 在吗/)

  const state = JSON.parse(await fs.readFile(`${dir}/state.json`, 'utf8'))
  assert.ok(state.jobs.probe.fingerprint, '应记录指纹')
})

test('apply：脚本失败时不唤醒', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-wake-fail-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [{ id: 'p', everySeconds: 60, command: 'x', wakeOnChange: { sessionId: 's1' } }],
    }),
  )
  const ticks = []
  const wakes = []
  const ctx = {
    logger: { info() {} },
    effect: (fn) => fn(),
    interval: (cb) => {
      ticks.push(cb)
      return () => {}
    },
    get: () => ({ create: async (...args) => wakes.push(args) }),
    subprocess: {
      spawn: () => ({
        collected: {
          stdout: { readFrom: () => ({ text: 'OWED 9', nextOffset: 5, lossy: false }) },
          stderr: { readFrom: () => ({ text: 'boom', nextOffset: 4, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 1, signal: null }),
        terminate() {},
      }),
    },
  }
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
  await ticks[0]()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(wakes.length, 0, '失败运行不应冒充新消息')
})

test('重启后从磁盘恢复指纹：变化仍然会唤醒', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-restart-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [
        {
          id: 'probe',
          name: '探针',
          everySeconds: 30,
          command: 'echo',
          wakeOnChange: { sessionId: 'session-restart', prompt: '来了：{{output}}' },
        },
      ],
    }),
  )

  const RealDate = Date
  let offset = 0
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + offset]))
    }
    static now() {
      return RealDate.now() + offset
    }
  }

  try {
    // 第一次启动：基线
    const first = makeCtx(['HR: 在吗'])
    apply(first.ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    await first.ticks[0]()
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(first.wakes.length, 0, '首轮只记基线')
    offset += 61_000

    // 模拟重启：新的 apply 实例，同一 stateDir，内容没变 → 不该唤醒
    const second = makeCtx(['HR: 在吗'])
    apply(second.ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    await second.ticks[0]()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(second.wakes.length, 0, '重启后内容未变，不应重复唤醒')
    offset += 61_000

    // 再重启一次，内容变了 → 应该唤醒（这正是修复前会丢的那一次）
    const third = makeCtx(['HR: 明天来面试'])
    apply(third.ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    await third.ticks[0]()
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(third.wakes.length, 1, '重启后内容变化必须唤醒')
    assert.match(third.wakes[0].prompt, /明天来面试/)
  } finally {
    globalThis.Date = RealDate
  }
})

test('onlyOnNew：条目消失不唤醒，冒出新条目才唤醒', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-newonly-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [{
        id: 'probe',
        everySeconds: 30,
        command: 'echo',
        wakeOnChange: { sessionId: 's', onlyOnNew: true, prompt: '{{output}}' },
      }],
    }),
  )

  const RealDate = Date
  let offset = 0
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])) }
    static now() { return RealDate.now() + offset }
  }

  // 序列：基线(2条) → 少一条(回复后消失) → 冒出新的一条
  const { ctx, ticks, wakes } = makeCtx([
    'A 在吗\nB 你好',
    'A 在吗',
    'A 在吗\nC 新消息',
  ])
  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    for (let i = 0; i < 3; i += 1) {
      await ticks[0]()
      await new Promise((r) => setTimeout(r, 150))
      offset += 61_000
    }
  } finally {
    globalThis.Date = RealDate
  }

  assert.equal(wakes.length, 1, '只有新条目那次该唤醒')
  assert.match(wakes[0].prompt, /C 新消息/)
})

test('唤醒行清理：已投递的一次性任务被删掉，等待投递与其他任务保留', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-wake-prune-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [{
        id: 'probe',
        name: '探针',
        everySeconds: 30,
        command: 'echo',
        wakeOnChange: { sessionId: 'session-abc', title: '有新消息', prompt: '{{output}}' },
      }],
    }),
  )

  const RealDate = Date
  let offset = 0
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])) }
    static now() { return RealDate.now() + offset }
  }

  const deleted = []
  const wakes = []
  const rows = [
    { id: 'stale-1', sessionId: 'session-abc', kind: 'after', title: '有新消息', status: 'inactive', scheduledAt: new Date(RealDate.now() - 3_600_000).toISOString() },
    { id: 'stale-2', sessionId: 'session-abc', kind: 'after', title: '有新消息', status: 'inactive', scheduledAt: new Date(RealDate.now() - 3_600_000).toISOString() },
    { id: 'pending', sessionId: 'session-abc', kind: 'after', title: '有新消息', status: 'active', scheduledAt: new Date(RealDate.now()).toISOString() },
    { id: 'other-title', sessionId: 'session-abc', kind: 'after', title: '别的任务', status: 'inactive', scheduledAt: new Date(RealDate.now() - 3_600_000).toISOString() },
    { id: 'cron-row', sessionId: 'session-abc', kind: 'cron', title: '有新消息', status: 'inactive', scheduledAt: new Date(RealDate.now() - 3_600_000).toISOString() },
    { id: 'other-session', sessionId: 'session-xyz', kind: 'after', title: '有新消息', status: 'inactive', scheduledAt: new Date(RealDate.now() - 3_600_000).toISOString() },
  ]
  const ticks = []
  const ctx = {
    logger: { info() {} },
    effect: (fn) => fn(),
    interval: (cb) => { ticks.push(cb); return () => {} },
    get: (name) => (name === 'schedule' ? {
      create: async (sid, req) => { wakes.push({ sid, ...req }); return { id: `sched-${wakes.length}` } },
      catalog: async () => rows,
      delete: async ({ id }) => { deleted.push(id); return { id, deleted: true } },
    } : undefined),
    subprocess: {
      spawn: () => ({
        collected: {
          stdout: { readFrom: () => ({ text: 'OWED 1 | 张三 | 在吗', nextOffset: 18, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
      }),
    },
  }

  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    await ticks[0]()
    await new Promise((r) => setTimeout(r, 250))
  } finally {
    globalThis.Date = RealDate
  }

  assert.deepEqual(deleted.sort(), ['stale-1', 'stale-2'], '只清理同名、同 Session、已投递的一次性唤醒行')
})
