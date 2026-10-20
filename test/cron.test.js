import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCron,
  cronMatches,
  zonedParts,
  normalizeJobs,
  apply,
} from '../index.js'

test('parseCron：基础字段', () => {
  const spec = parseCron('30 18 * * *')
  assert.deepEqual([...spec.minute], [30])
  assert.deepEqual([...spec.hour], [18])
  assert.equal(spec.dom.size, 31)
  assert.equal(spec.dayOr, false)
})

test('parseCron：步长与区间', () => {
  const spec = parseCron('*/15 9-17 * * 1-5')
  assert.deepEqual([...spec.minute], [0, 15, 30, 45])
  assert.equal(spec.hour.size, 9)
  assert.deepEqual([...spec.dow], [1, 2, 3, 4, 5])
  assert.equal(spec.dayOr, false)
})

test('parseCron：周日 7 归一为 0', () => {
  const spec = parseCron('0 0 * * 7')
  assert.deepEqual([...spec.dow], [0])
})

test('parseCron：dom 与 dow 都限制时取或', () => {
  const spec = parseCron('0 0 1 * 1')
  assert.equal(spec.dayOr, true)
  const nov1 = zonedParts(new Date('2026-10-31T16:00:00Z'), 'Asia/Shanghai')
  const oct26 = zonedParts(new Date('2026-10-25T16:00:00Z'), 'Asia/Shanghai')
  assert.equal(cronMatches(spec, nov1), true, '11-01 是 1 号')
  assert.equal(cronMatches(spec, oct26), true, '10-26 是周一')
})

test('cronMatches：命中与不命中', () => {
  const spec = parseCron('30 18 * * *')
  const hit = zonedParts(new Date('2026-10-19T10:30:00Z'), 'Asia/Shanghai')
  const miss = zonedParts(new Date('2026-10-19T10:31:00Z'), 'Asia/Shanghai')
  assert.equal(cronMatches(spec, hit), true)
  assert.equal(cronMatches(spec, miss), false)
})

test('zonedParts：上海时区换算正确', () => {
  const parts = zonedParts(new Date('2026-10-19T12:41:00Z'), 'Asia/Shanghai')
  assert.equal(parts.hour, 20)
  assert.equal(parts.minute, 41)
  assert.equal(parts.day, 19)
  assert.equal(parts.month, 10)
  assert.equal(parts.weekday, 1) // 2026-10-19 是周一
})

test('parseCron：非法输入要报错', () => {
  assert.throws(() => parseCron('61 0 * * *'), /越界/)
  assert.throws(() => parseCron('* * * *'), /5 个字段/)
  assert.throws(() => parseCron('*/0 * * * *'), /步长非法/)
})

test('normalizeJobs：校验与默认值', () => {
  const jobs = normalizeJobs({
    jobs: [
      { id: 'a', cron: '0 1 * * *', command: 'true' },
      { id: 'b', everySeconds: 60, argv: ['/bin/echo', 'hi'], enabled: false },
    ],
  })
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].timeZone, 'Asia/Shanghai')
  assert.equal(jobs[0].timeoutSeconds, 300)
  assert.equal(jobs[1].enabled, false)
  assert.throws(() => normalizeJobs({ jobs: [{ id: 'c', command: 'true' }] }), /缺少 cron/)
  assert.throws(() => normalizeJobs({ jobs: [{ id: 'd', cron: '0 1 * * *' }] }), /缺少 command/)
})

test('apply：到点执行一次并写状态与日志', async () => {
  const ticks = []
  const calls = []
  const stateDir = await import('node:fs/promises').then(async (fs) => {
    const dir = await fs.mkdtemp('/tmp/noagent-test-')
    return dir
  })
  const jobsFile = `${stateDir}/jobs.json`
  const fs = await import('node:fs/promises')
  await fs.writeFile(
    jobsFile,
    JSON.stringify({
      jobs: [{ id: 'unit', name: '单元测试任务', everySeconds: 60, command: 'echo ok' }],
    }),
  )

  const ctx = {
    logger: { info() {} },
    effect(fn) {
      return fn()
    },
    interval(callback) {
      ticks.push(callback)
      return () => {}
    },
    subprocess: {
      spawn(spec) {
        calls.push(spec)
        return {
          collected: {
            stdout: { readFrom: () => ({ text: 'ok\n', nextOffset: 3, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
        }
      },
    },
  }

  apply(ctx, { jobsFile, stateDir, tickSeconds: 1 })
  assert.equal(ticks.length, 1)

  await ticks[0]()
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, ['/bin/bash', '-lc', 'echo ok'])
  const state = JSON.parse(await fs.readFile(`${stateDir}/state.json`, 'utf8'))
  assert.equal(state.jobs.unit.lastExitCode, 0)
  assert.equal(state.jobs.unit.lastOk, true)
  const runs = (await fs.readFile(`${stateDir}/runs.jsonl`, 'utf8')).trim().split('\n')
  assert.equal(runs.length, 1)
  assert.equal(JSON.parse(runs[0]).id, 'unit')
})
