import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { apply, normalizeJobs } from '../index.js'

/**
 * 唤醒前钉权限：BOSS 这类任务必须写工作区外的台账目录，而常驻会话创建时被钉成
 * workspace-write + approval=ask，于是每次唤醒都挂在 sandbox 升级审批上
 * （2026-10-27 实测 10:11 → 10:37 挂了 26 分钟，turn 一直不结束）。
 *
 * 这里验证三件事：
 *   1. 配了 permission 就在投递前写满三条事件（少一条会出现「显示已放开但仍弹审批」）；
 *   2. 没配就一条都不写（默认行为完全不变，不能偷偷给所有唤醒目标提权）；
 *   3. 未知预设直接报错，不静默降级成不提权。
 */
function makeCtx({ outputs, session }) {
  const ticks = []
  const wakes = []
  const appended = []
  const logs = []
  let index = 0
  const ctx = {
    logger: { info() {} },
    effect: (fn) => fn(),
    interval: (cb) => {
      ticks.push(cb)
      return () => {}
    },
    get: (name) => {
      if (name === 'schedule') {
        return {
          create: async (sid, req) => {
            wakes.push({ sid, ...req })
            return { id: `sched-${wakes.length}` }
          },
          delete: async () => {},
          list: async () => [],
        }
      }
      if (name === 'sessions') {
        if (session === undefined) return undefined
        return {
          get: (id) => ({
            id,
            append: (type, data) => {
              appended.push({ type, data })
            },
          }),
        }
      }
      return undefined
    },
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
    warn: (m) => logs.push(m),
  }
  return { ctx, ticks, wakes, appended, logs }
}

/** 跑一遍「基线 → 未变 → 变了（唤醒）」，返回唤醒时的副作用。 */
async function runWake({ permission, session = true } = {}) {
  const dir = await fs.mkdtemp('/tmp/noagent-wakeperm-')
  const jobsFile = `${dir}/jobs.json`
  const wakeOnChange = { sessionId: 'session-abc', prompt: '新内容：{{output}}' }
  if (permission !== undefined) wakeOnChange.permission = permission
  await fs.writeFile(jobsFile, JSON.stringify({
    jobs: [{ id: 'probe', name: '探针', everySeconds: 30, command: 'echo', wakeOnChange }],
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

  const { ctx, ticks, wakes, appended, logs } = makeCtx({
    outputs: ['OWED 0', 'OWED 0', 'OWED 1 | 张三 | 在吗', 'OWED 1 | 张三 | 在吗'],
    session: session ? {} : undefined,
  })
  try {
    apply(ctx, { jobsFile, stateDir: dir, tickSeconds: 1, jobsReloadMs: 0 })
    const tick = async () => {
      await ticks[0]()
      await new Promise((r) => setTimeout(r, 150))
      offset += 61_000
    }
    await tick()
    await tick()
    await tick() // 这一次内容变了 → 唤醒
    await tick()
  } finally {
    globalThis.Date = RealDate
  }
  return { wakes, appended, logs }
}

test('默认不钉权限：配了 wakeOnChange 但没配 permission 时一条事件都不写', async () => {
  const { wakes, appended } = await runWake({})
  assert.equal(wakes.length, 1, '仍然应该正常唤醒一次')
  assert.equal(appended.length, 0, '没配 permission 时不能碰目标会话的权限')
})

test('permission=danger-full-access：投递前写满 approval/sandbox/preset 三条', async () => {
  const { wakes, appended } = await runWake({ permission: 'danger-full-access' })
  assert.equal(wakes.length, 1)
  assert.deepEqual(
    appended.map((e) => e.type),
    ['approval/policy', 'sandbox/mode', 'permission/preset'],
    '三条必须齐全：只写 preset 会让显示的预设和实际旋钮错位',
  )
  assert.deepEqual(appended[0].data, { policy: 'never' })
  assert.deepEqual(appended[1].data, { mode: 'danger-full-access' })
  assert.deepEqual(appended[2].data, { preset: 'danger-full-access' })
})

test('sessions 服务不可用：只记日志，不阻断唤醒', async () => {
  const { wakes, appended } = await runWake({ permission: 'danger-full-access', session: false })
  assert.equal(appended.length, 0)
  assert.equal(wakes.length, 1, '钉权限失败不能让任务彻底不唤醒')
})

test('未知预设直接报错，不静默降级', () => {
  assert.throws(
    () => normalizeJobs({
      jobs: [{
        id: 'probe',
        everySeconds: 30,
        command: 'echo',
        wakeOnChange: { sessionId: 'session-abc', permission: 'god-mode' },
      }],
    }),
    /未知：god-mode/,
  )
})

test('permission 空串等于未配置', () => {
  const jobs = normalizeJobs({
    jobs: [{
      id: 'probe',
      everySeconds: 30,
      command: 'echo',
      wakeOnChange: { sessionId: 'session-abc', permission: '' },
    }],
  })
  assert.equal(jobs[0].wakeOnChange.permission, '')
})
