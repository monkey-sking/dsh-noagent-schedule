import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  apply,
  normalizeJobs,
  normalizeForFingerprint,
  fingerprintOf,
  renderWakePrompt,
  makeLineKey,
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

test('makeLineKey：keyPattern 只取身份段，正文变化不影响', () => {
  const keyOf = makeLineKey('^[A-Z_]+ \\| [^|]+ \\| [^|]+')
  assert.equal(keyOf('UNKNOWN | 张三 | 甲公司 | 10:00 | 在吗'), keyOf('UNKNOWN | 张三 | 甲公司 | 10:30 | 我回复了'))
  assert.notEqual(keyOf('UNKNOWN | 张三 | 甲公司 | 10:00 | 在吗'), keyOf('UNKNOWN | 张三 | 乙公司 | 10:00 | 在吗'))
  assert.equal(makeLineKey(undefined)('任意'), '任意', '没配置时整行比较')
})

test('keyPattern：同一会话正文变了不唤醒，冒出新会话才唤醒', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-keypattern-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [{
        id: 'probe',
        everySeconds: 30,
        command: 'echo',
        wakeOnChange: {
          sessionId: 's',
          onlyOnNew: true,
          keyPattern: '^[A-Z_]+ \\| [^|]+ \\| [^|]+',
          ignoreLines: ['^AUTH_OK'],
          prompt: '{{output}}',
        },
      }],
    }),
  )

  const RealDate = Date
  let offset = 0
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])) }
    static now() { return RealDate.now() + offset }
  }

  const { ctx, ticks, wakes } = makeCtx([
    'AUTH_OK 2 OWED 1 MODE summary\nUNKNOWN | 张三 | 甲 | 10:00 | 在吗',
    'AUTH_OK 2 OWED 1 MODE summary\nUNKNOWN | 张三 | 甲 | 10:05 | 我回过了', // 同会话，正文变了
    'AUTH_OK 3 OWED 2 MODE summary\nUNKNOWN | 张三 | 甲 | 10:05 | 我回过了\nUNKNOWN | 李四 | 乙 | 10:06 | 你好', // 新会话
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

  assert.equal(wakes.length, 1, '只有新会话那一次该唤醒')
  assert.match(wakes[0].prompt, /李四/)
})

test('wakeMode=fresh：每次唤醒新建会话并直接投递，不经过 schedule', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-fresh-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [{
      id: 'probe',
      name: '探针',
      everySeconds: 30,
      command: 'echo',
      // notifyOnFirstRun 打开：首次也唤醒，这样两次输出变化都该产生一次投递。
      wakeOnChange: { wakeMode: 'fresh', prompt: '新内容：{{output}}', notifyOnFirstRun: true },
    }],
  }))

  const RealDate = Date
  let offset = 0
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])) }
    static now() { return RealDate.now() + offset }
  }

  const { ctx, ticks } = makeCtx(['第一次内容', '第二次内容'])
  // fresh 模式：用 sessionController 造会话 + agents 投递；schedule 若有调用即算回归。
  const created = []
  const delivered = []
  const scheduleCalls = []
  const inner = (name) => {
    if (name === 'sessionController') {
      return {
        create: async (req) => {
          const sessionId = `session-fresh-${created.length + 1}`
          created.push({ sessionId, cwd: req?.cwd })
          return { sessionId }
        },
        resolveAgent: async (sessionId) => ({
          agent: { followup: (message) => delivered.push({ sessionId, message }) },
        }),
      }
    }
    if (name === 'schedule') return { create: async (...a) => { scheduleCalls.push(a); return { id: 'x' } } }
    return undefined
  }
  const baseGet = ctx.get
  ctx.get = (name) => inner(name) ?? baseGet(name)

  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    for (let i = 0; i < 2; i += 1) {
      await ticks[0]()
      await new Promise((r) => setTimeout(r, 150))
      offset += 61_000
    }
  } finally {
    globalThis.Date = RealDate
  }

  assert.equal(created.length, 2, '两次输出变化应各建一个新会话')
  assert.notEqual(created[0].sessionId, created[1].sessionId, '每次都是新会话，不能复用')
  assert.equal(delivered.length, 2, '两次都应投递')
  assert.equal(scheduleCalls.length, 0, 'fresh 模式不应走 schedule 投递')
  assert.match(delivered[0].message.content[0].text, /第一次内容/)
  assert.match(delivered[1].message.content[0].text, /第二次内容/)
  assert.equal(delivered[0].message.role, 'user')
  assert.equal(delivered[0].message.source.kind, 'schedule')
  assert.ok(delivered[0].message.id, '消息必须带 id')
})

test('normalizeJobs：wakeMode=fresh 与 sessionId 互斥，缺少 sessionId 时 session 模式报错', async () => {
  const bad = () => normalizeJobs({
    jobs: [{
      id: 'x', everySeconds: 30, command: 'echo',
      wakeOnChange: { wakeMode: 'fresh', sessionId: 'session-a' },
    }],
  })
  assert.throws(bad, /互斥/)

  const missing = () => normalizeJobs({
    jobs: [{ id: 'y', everySeconds: 30, command: 'echo', wakeOnChange: { prompt: 'x' } }],
  })
  assert.throws(missing, /缺少 sessionId/)

  const ok = normalizeJobs({
    jobs: [{ id: 'z', everySeconds: 30, command: 'echo', wakeOnChange: { wakeMode: 'fresh' } }],
  })
  assert.equal(ok[0].wakeOnChange.wakeMode, 'fresh')
  assert.equal(ok[0].wakeOnChange.sessionId, undefined)
})

test('归档护栏：唤醒目标被归档时不投递，并把失败原因记进 state', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-archived-')
  const jobsFile = `${dir}/jobs.json`
  const workspaceStateFile = `${dir}/workspace.json`
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [{
      id: 'probe',
      name: '探针',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '新内容：{{output}}' },
    }],
  }))
  // 目标会话在归档集合里：投进去只会被 ArchivedSessionGate 拦成 blocked。
  await fs.writeFile(workspaceStateFile, JSON.stringify({
    global: { archivedSessionIds: ['session-abc'] },
  }))

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

  const { ctx, ticks, wakes } = makeCtx(['OWED 0', 'OWED 1 | 张三 | 在吗'])
  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0, workspaceStateFile })
    const tick = async () => {
      await ticks[0]()
      await new Promise((r) => setTimeout(r, 150))
      offset += 61_000
    }
    await tick() // 基线
    await tick() // 内容变了，但目标已归档 → 不能投递
  } finally {
    globalThis.Date = RealDate
  }

  assert.equal(wakes.length, 0, '目标归档时绝不能照常 create，否则是假装成功')
  const state = JSON.parse(await fs.readFile(`${dir}/state.json`, 'utf8'))
  assert.equal(state.jobs.probe.lastWakeError, 'wake_target_archived')
  assert.equal(state.jobs.probe.wakeTargetArchived, true)
  assert.equal(state.jobs.probe.lastWakeAt, undefined, '失败时不应更新 lastWakeAt')
})

test('归档护栏：解除归档后恢复投递并清掉失败原因', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-unarchived-')
  const jobsFile = `${dir}/jobs.json`
  const workspaceStateFile = `${dir}/workspace.json`
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [{
      id: 'probe',
      name: '探针',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '新内容：{{output}}' },
    }],
  }))
  await fs.writeFile(workspaceStateFile, JSON.stringify({
    global: { archivedSessionIds: ['session-abc'] },
  }))

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

  const { ctx, ticks, wakes } = makeCtx(['OWED 0', 'OWED 1 | 张三 | 在吗', 'OWED 2 | 李四 | 你好'])
  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0, workspaceStateFile })
    const tick = async () => {
      await ticks[0]()
      await new Promise((r) => setTimeout(r, 150))
      offset += 61_000
    }
    await tick() // 基线
    await tick() // 归档中 → 不投递
    assert.equal(wakes.length, 0)

    // 解除归档
    await fs.writeFile(workspaceStateFile, JSON.stringify({ global: { archivedSessionIds: [] } }))
    await tick() // 内容又变了 → 恢复投递
  } finally {
    globalThis.Date = RealDate
  }

  assert.equal(wakes.length, 1, '解除归档后应恢复投递')
  assert.equal(wakes[0].sid, 'session-abc')
  const state = JSON.parse(await fs.readFile(`${dir}/state.json`, 'utf8'))
  assert.equal(state.jobs.probe.lastWakeError, undefined, '恢复后不应残留失败原因')
  assert.ok(state.jobs.probe.lastWakeAt, '恢复后应更新 lastWakeAt')
})

test('归档护栏：session-activity provider 拦住依赖本任务的会话归档', async () => {
  const dir = await fs.mkdtemp('/tmp/noagent-guard-')
  const jobsFile = `${dir}/jobs.json`
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [{
      id: 'boss-chat-watch',
      name: 'BOSS 消息探针',
      everySeconds: 120,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', prompt: '有新消息' },
    }],
  }))

  const handlers = new Map()
  const ctx = {
    logger: { info() {} },
    effect: (fn) => fn(),
    interval: () => () => {},
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get: () => undefined,
    subprocess: { spawn: () => { throw new Error('本测试不跑脚本') } },
  }
  apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
  // apply 内部是异步初始化，等一拍让 provider 注册完
  await new Promise((r) => setTimeout(r, 150))

  const provider = handlers.get('workspace/session-activity')
  assert.ok(provider, '必须注册 workspace/session-activity，否则归档无人拦截')

  // 依赖它的会话：报出 job，让 archiveSession 抛 WorkspaceActiveSessionError
  const blocked = await provider({ sessionId: 'session-abc' }, () => Promise.resolve([]))
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].kind, 'noagent')
  assert.match(blocked[0].items[0].label, /BOSS 消息探针/)

  // 无关会话：原样透传下游结果，不干扰别人
  const passed = await provider({ sessionId: 'session-other' }, () => Promise.resolve([{ kind: 'schedule' }]))
  assert.deepEqual(passed, [{ kind: 'schedule' }])
})
