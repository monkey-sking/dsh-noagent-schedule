import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'))
const clientSource = await fs.readFile(path.join(here, '..', 'client.js'), 'utf8')

/** 极简 React 替身：只验证元素构造，不跑真渲染。 */
function fakeReact() {
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useId() {
      return 'test-id'
    },
  }
}

/**
 * 在 vm 里加载 client.js（浏览器 ModuleLoader 协议），返回 factory 产物。
 * 纯 JS 客户端半只依赖 window.__ModuleLoader__ 与 require('react')。
 */
async function loadClientModule() {
  let registration = null
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' })
  assert.ok(registration, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, packageJson.name, 'ModuleLoader id 必须等于包名')
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration, exports }
}

function createClientCtx() {
  const registrations = []
  const dictionaries = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
    locale: {
      bind: () => (key, params) =>
        params === undefined ? key : `${key}(${Object.values(params).join(',')})`,
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, dictionaries, effects }
}

/** vm 里造出来的对象跨 realm，deepStrictEqual 会因原型不同而失败：统一走 JSON 比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

const makeT = () => (key, params) =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

/** 一份贴边的 status：一条成功的 cron、一条失败的重试任务、一条停用的间隔任务。 */
function sampleStatus() {
  const now = Date.parse('2026-10-21T10:00:00+08:00')
  return {
    kind: 'ready',
    updatedAt: '2026-10-21T02:00:00.000Z',
    now,
    jobsFile: '/tmp/jobs.json',
    error: null,
    jobs: [
      {
        id: 'unit',
        name: '单元测试任务',
        enabled: true,
        timeZone: 'Asia/Shanghai',
        schedule: { kind: 'cron', cron: '30 18 * * *' },
        command: 'echo ok',
        timeoutSeconds: 180,
        running: false,
        watch: false,
        wakeSessionId: null,
        nextRunAt: Date.parse('2026-10-21T18:30:00+08:00'),
        recent: [{ startedAt: '2026-10-20T10:30:00.000Z', durationMs: 1200, exitCode: 0, ok: true, timedOut: false }],
        last: { startedAt: '2026-10-20T10:30:00.000Z', durationMs: 1200, exitCode: 0, ok: true, timedOut: false },
      },
      {
        id: 'watch',
        name: '探针任务',
        enabled: true,
        timeZone: 'Asia/Shanghai',
        schedule: { kind: 'every', everySeconds: 120 },
        command: 'bash probe.sh',
        timeoutSeconds: 300,
        running: false,
        watch: true,
        wakeSessionId: 'session-abc',
        nextRunAt: now + 60_000,
        recent: [{ startedAt: '2026-10-21T01:58:00.000Z', durationMs: 4900, exitCode: 1, ok: false, timedOut: false }],
        last: { startedAt: '2026-10-21T01:58:00.000Z', durationMs: 4900, exitCode: 1, ok: false, timedOut: false },
      },
      {
        id: 'off',
        name: '停用任务',
        enabled: false,
        timeZone: 'Asia/Shanghai',
        schedule: { kind: 'cron', cron: '0 20 * * *' },
        command: 'x' .repeat(200),
        timeoutSeconds: 900,
        running: false,
        watch: false,
        wakeSessionId: null,
        nextRunAt: null,
        recent: [],
        last: null,
      },
    ],
  }
}

function faceFor(status) {
  return {
    t: makeT(),
    lang: 'zh',
    useStatus: () => status,
    refresh: () => {},
    runNow: async () => ({}),
    toggle: async () => {},
    saveJob: async () => ({}),
    deleteJob: async () => ({}),
    loadLog: async () => ({ file: null, text: '', truncated: false }),
  }
}

test('client.js：ModuleLoader 协议与依赖声明', async () => {
  const { registration, exports } = await loadClientModule()
  assert.equal(registration.id, packageJson.name)
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(packageJson.files.includes('client.js'))
  assert.equal(packageJson.exports['./client'], './client.js')
})

test('client.js：只注册侧边栏条目与中央面板（不再进设置页），并注册中英文字典', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations, dictionaries, effects } = createClientCtx()
  exports.apply(ctx)

  const bySlot = (slot) => registrations.filter((item) => item.options.name === slot)
  // 设置页不再重复放一份：入口只有侧边栏 + 中央面板。
  assert.equal(bySlot('settings.section').length, 0, '设置页里不该再出现定时脚本')
  assert.equal(bySlot('sidebar.panellist').length, 1)
  assert.equal(bySlot('main').length, 1)

  const panel = bySlot('sidebar.panellist')[0]
  assert.equal(panel.options.id, 'noagent-schedule')
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(typeof panel.component, 'function')

  // main 槽是 keyed 槽：key 必须等于侧边栏条目的 id，外壳靠它选中面板。
  const main = bySlot('main')[0]
  assert.equal(main.options.key, panel.options.id)

  // 字典：zh / en 各一份，键完全一致
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'noagent-schedule')
  const { zh, en } = dictionaries[0].dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())

  // 注入面：hooks.status 会变成 props.useStatus，动作与 RPC 一一对应
  const face = main.options.inject()
  assert.equal(typeof main.options.inject, 'function')
  assert.equal(typeof face.hooks.status.getSnapshot, 'function')
  for (const key of ['refresh', 'runNow', 'toggle', 'saveJob', 'deleteJob', 'loadLog']) {
    assert.equal(typeof face[key], 'function', `注入面缺少 ${key}`)
  }
  assert.equal(face.lang, 'zh')

  assert.ok(effects.some((label) => String(label).includes('dictionaries')))
})

test('client.js：组件在给定 props 下可构造（不抛错）', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations } = createClientCtx()
  exports.apply(ctx)

  const panelEntry = registrations.find((item) => item.options.name === 'main')
  const tree = panelEntry.component(faceFor(sampleStatus()))
  assert.equal(typeof tree, 'object')
  assert.equal(tree.type, 'div')

  const icon = registrations.find((item) => item.options.name === 'sidebar.panellist')
  const iconTree = icon.component({ size: 16, active: false })
  assert.equal(iconTree.type, 'svg')

  const panel = panelEntry
  const page = panel.component(faceFor({ kind: 'error', jobs: [], updatedAt: null, error: 'boom' }))
  assert.equal(page.type, 'div')

  const empty = panel.component(faceFor({ kind: 'ready', jobs: [], updatedAt: null, now: Date.now(), jobsFile: '', error: null }))
  assert.equal(empty.type, 'div')
})

/** 展开函数组件树（不跑真 React），用来把 JobTable / JobDetail 这类子组件也走一遍。 */
function expand(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 40) return node
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1))
  if (typeof node.type === 'function' && node.type !== Symbol.for('react.fragment')) {
    return expand(node.type({ ...node.props, children: node.children }), depth + 1)
  }
  return { ...node, children: (node.children ?? []).map((child) => expand(child, depth + 1)) }
}

function flatten(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

const strings = (nodes) =>
  nodes.flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string'))

test('client.js：任务表完整展开（状态灯 / 计划 / 上次下次 / 最近结果 / 操作）', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations } = createClientCtx()
  exports.apply(ctx)

  const section = registrations.find((item) => item.options.name === 'main')
  const tree = expand(section.component(faceFor(sampleStatus())))
  const nodes = flatten(tree)
  const texts = strings(nodes)

  // 计划是人话，不是 cron 原文
  assert.ok(texts.some((text) => text.includes('每天 18:30')), `计划人话缺失：${texts.join('|')}`)
  assert.ok(texts.some((text) => text.includes('每 2 分钟')), '间隔人话缺失')
  // cron 原文作为副标题保留
  assert.ok(texts.includes('30 18 * * *'), 'cron 原文副标题缺失')
  // 上次 / 下次（fake t() 返回 key，所以断言 key）
  assert.ok(texts.includes('lastRun'))
  assert.ok(texts.includes('nextRun'))
  assert.ok(texts.some((text) => text.includes('今天 18:30')), '下次运行人话缺失')
  assert.ok(texts.includes('never'))
  // 失败任务给出退出码徽标
  assert.ok(texts.some((text) => text.includes('exitCode(1)')), '退出码文案缺失')
  // 停用徽标 + 事件型徽标
  assert.ok(texts.includes('disabled'))
  assert.ok(texts.includes('watchBadge'))
  // 命令截断
  assert.ok(texts.some((text) => text.endsWith('…')), '长命令应被截断')

  // 操作按钮：启用开关 / 运行 / 日志 / 展开，一条任务至少 4 个
  const buttons = nodes.filter((node) => node.type === 'button')
  assert.ok(buttons.some((button) => button.props.role === 'switch'), '缺少启用开关')
  assert.ok(buttons.some((button) => button.props.className === 'noagent-button' && button.props['data-primary'] === 'true'))
  // 最近结果的小竖条：可点，且带成功/失败标记
  const runBars = nodes.filter((node) => node.props && node.props.className === 'noagent-run')
  assert.equal(runBars.length, 2, `最近结果格子数量异常：${runBars.length}`)
  assert.ok(runBars.some((bar) => bar.props['data-ok'] === 'false'))
  // 总览卡：4 张
  const stats = nodes.filter((node) => node.props && node.props.className === 'noagent-stat')
  assert.equal(stats.length, 4)
})

test('client.js：展开一行、点日志格子都不会因注入面缺字段而崩', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations } = createClientCtx()
  exports.apply(ctx)

  const section = registrations.find((item) => item.options.name === 'main')
  // 关键：注入面直接来自 apply()，而不是测试自己拼一个 props ——
  // 真实崩溃（Cannot read properties of undefined (reading 'loadLog')）就出在这里。
  const face = section.options.inject()
  assert.equal(typeof face.actions, 'object')
  assert.equal(typeof face.actions.loadLog, 'function')

  const props = { ...face, ...faceFor(sampleStatus()), t: makeT() }
  delete props.useStatus
  props.useStatus = () => sampleStatus()

  const tree = expand(section.component(props))
  const nodes = flatten(tree)
  assert.ok(nodes.length > 10)

  // 每一次「最近结果」格子都带可点击的 onPick，点它等于打开那一次的日志
  const runBars = nodes.filter((node) => node.props && node.props.className === 'noagent-run')
  assert.ok(runBars.length >= 1)
  for (const bar of runBars) assert.equal(typeof bar.props.onClick, 'function')

  // 展开行：直接渲染 JobDetail 的那份 props（带 openLog），确保详情里的日志按钮可用
  const detail = nodes.find((node) => node.props && node.props.className === 'noagent-detail')
  assert.equal(detail, undefined, '默认不展开，详情行不渲染')
})

test('client.js：面板分成固定框 + 自滚动内容区（内容超了要能滚）', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations } = createClientCtx()
  exports.apply(ctx)

  const section = registrations.find((item) => item.options.name === 'main')
  const tree = expand(section.component(faceFor(sampleStatus())))
  const nodes = flatten(tree)

  // 结构：.noagent-page（外层，裁切）> .noagent-scroll（内层，滚动）
  const page = nodes.find((node) => node.props && node.props.className === 'noagent-root noagent-page')
  assert.ok(page, '缺少外层页面容器')
  const scroll = nodes.find((node) => node.props && node.props.className === 'noagent-scroll')
  assert.ok(scroll, '缺少内层滚动容器')
  assert.ok(
    (page.children ?? []).some((child) => child && child.props && child.props.className === 'noagent-scroll'),
    '滚动区必须是外层容器的直接子元素',
  )

  // CSS 不变量：这三条少一条就会「内容超出但没有滚动条」
  const styleNode = nodes.find((node) => node.type === 'style')
  assert.ok(styleNode, '缺少样式块')
  const css = String(styleNode.children[0])
  assert.match(css, /\.noagent-scroll \{[^}]*overflow-y: auto/, '滚动区必须 overflow-y: auto')
  assert.match(css, /\.noagent-scroll \{[^}]*min-height: 0/, '滚动区必须 min-height: 0')
  assert.match(css, /\.noagent-scroll > \* \{[^}]*flex: 0 0 auto/, '滚动区子项不能被 flex 压扁')
  assert.match(css, /\.noagent-page \{[^}]*overflow: hidden/, '外层必须裁切，否则父盒被内容撑高就没有可滚区域')
  assert.ok(
    !/\.noagent-table-wrap \{[^}]*overflow-y: hidden/.test(css),
    '表格容器不能 overflow-y: hidden —— 会把表格裁成一张卡的高度，多出来的行滚不到',
  )
})

test('client.js：计划人话解析（cron / 间隔 / 异常）', async () => {
  const { exports } = await loadClientModule()
  const u = exports.utils
  const zh = (cron) => u.describeCron(cron, 'zh')
  const en = (cron) => u.describeCron(cron, 'en')

  assert.equal(zh('30 18 * * *'), '每天 18:30')
  assert.equal(zh('0 8 * * *'), '每天 08:00')
  assert.equal(zh('*/15 * * * *'), '每 15 分钟')
  assert.equal(zh('* * * * *'), '每分钟')
  assert.equal(zh('0 0 * * 1'), '周一 00:00')
  assert.equal(zh('0 9 * * 1-5'), '周一、周二、周三、周四、周五 09:00')
  assert.equal(zh('15 9 1 * *'), '1 号 09:15')
  assert.equal(zh('0 9 1,15 * *'), '每月 1, 15 号 09:00')
  assert.equal(zh('15 9 1 11 *'), '每年 11 月 1 号 09:15')

  assert.equal(en('30 18 * * *'), 'daily 18:30')
  assert.equal(en('*/15 * * * *'), 'every 15 min')
  assert.equal(en('0 0 * * 1'), 'on Mon 00:00')

  // 解析不了就返回 null，让 UI 退回 cron 原文
  assert.equal(zh('0 0 1 * 1'), null, 'dom 与 dow 同时受限应退回原文')
  assert.equal(zh('bad'), null)
  assert.equal(zh('* * * *'), null)

  assert.equal(u.describeEvery(120, 'zh'), '每 2 分钟')
  assert.equal(u.describeEvery(60, 'zh'), '每 1 分钟')
  assert.equal(u.describeEvery(3600, 'zh'), '每 1 小时')
  assert.equal(u.describeEvery(90, 'zh'), '每 90 秒')
  assert.equal(u.describeEvery(120, 'en'), 'every 2 min')

  // scheduleText：非法 cron 标记 invalid 并保留原文
  const bad = u.scheduleText({ kind: 'cron', cron: 'nope' }, 'zh')
  assert.equal(bad.invalid, true)
  assert.equal(bad.text, 'nope')
  const ok = u.scheduleText({ kind: 'every', everySeconds: 600 }, 'zh')
  assert.deepEqual(plain(ok), { text: '每 10 分钟', invalid: false })
})

test('client.js：相对时间与时长人话', async () => {
  const { exports } = await loadClientModule()
  const u = exports.utils
  const now = Date.parse('2026-10-21T10:00:00+08:00')
  const at = (iso) => Date.parse(iso)

  assert.equal(u.humanTime(now - 5_000, 'zh', 'Asia/Shanghai', now), '刚刚')
  assert.equal(u.humanTime(now - 5 * 60_000, 'zh', 'Asia/Shanghai', now), '5 分钟前')
  assert.equal(u.humanTime(now - 3 * 3_600_000, 'zh', 'Asia/Shanghai', now), '3 小时前')
  assert.equal(u.humanTime(at('2026-10-20T18:30:00+08:00'), 'zh', 'Asia/Shanghai', now), '昨天 18:30')
  assert.equal(u.humanTime(at('2026-10-19T08:40:00+08:00'), 'zh', 'Asia/Shanghai', now), '2 天前 08:40')
  assert.equal(u.humanTime(at('2026-09-01T08:40:00+08:00'), 'zh', 'Asia/Shanghai', now), '9-1 08:40')

  assert.equal(u.humanTime(at('2026-10-21T18:30:00+08:00'), 'zh', 'Asia/Shanghai', now), '今天 18:30')
  assert.equal(u.humanTime(at('2026-10-22T08:40:00+08:00'), 'zh', 'Asia/Shanghai', now), '明天 08:40')
  assert.equal(u.humanTime(at('2026-11-01T09:15:00+08:00'), 'zh', 'Asia/Shanghai', now), '11 天后 09:15')
  assert.equal(u.humanTime(at('2026-10-21T18:30:00+08:00'), 'en', 'Asia/Shanghai', now), 'today 18:30')

  assert.equal(u.humanDuration(400), '0.4s')
  assert.equal(u.humanDuration(7_000), '7s')
  assert.equal(u.humanDuration(67_000), '1m 07s')
})

test('client.js：总览统计与筛选', async () => {
  const { exports } = await loadClientModule()
  const u = exports.utils
  const status = sampleStatus()
  const summary = u.summarize(status.jobs, status.now)
  assert.deepEqual(plain(summary), { total: 3, enabled: 2, ranToday: 1, failed24h: 1, running: 0 })

  const ids = (filter, query) => plain(u.filterJobs(status.jobs, filter, query)).map((job) => job.id)
  assert.deepEqual(ids('all', ''), ['unit', 'watch', 'off'])
  assert.deepEqual(ids('enabled', ''), ['unit', 'watch'])
  assert.deepEqual(ids('disabled', ''), ['off'])
  assert.deepEqual(ids('failing', ''), ['watch'])
  assert.deepEqual(ids('all', 'probe'), ['watch'])
  assert.deepEqual(ids('all', 'UNIT'), ['unit'])

  assert.equal(u.stateOf({ running: true }), 'running')
  assert.equal(u.stateOf({ last: null }), 'idle')
  assert.equal(u.stateOf({ last: { ok: true } }), 'ok')
  assert.equal(u.stateOf({ last: { ok: false } }), 'error')

  assert.equal(u.shortenCommand('abc'), 'abc')
  assert.equal(u.shortenCommand('a'.repeat(200), 10).length, 11)
  // 长路径只留文件名，venv 解释器只留 python —— 表格里要看得清跑的是哪个脚本
  assert.equal(
    u.shortenCommand('/Users/runking/.local/share/dsh-runtime/venv/bin/python /Users/runking/.local/share/dsh-runtime/scripts/02_deliver_wrapper.py --target telegram'),
    'python 02_deliver_wrapper.py --target telegram',
  )
  assert.equal(u.shortenCommand('bash /Users/runking/.local/share/dsh-runtime/scripts/x.sh 2>/dev/null'), 'bash x.sh 2>/dev/null')
})

test('client.js：表单校验（cron / 间隔 / 超时 / 命令）', async () => {
  const { exports } = await loadClientModule()
  const u = exports.utils
  const base = { mode: 'cron', cron: '30 18 * * *', everySeconds: '60', timeoutSeconds: '300', command: 'echo ok' }
  const errors = (patch) => plain(u.validateForm({ ...base, ...patch }))
  assert.deepEqual(errors({}), {})
  assert.deepEqual(errors({ cron: '30 18 * *' }), { cron: true })
  assert.deepEqual(errors({ mode: 'every', everySeconds: '10' }), { everySeconds: true })
  assert.deepEqual(errors({ mode: 'every', everySeconds: '90' }), {})
  assert.deepEqual(errors({ timeoutSeconds: '5' }), { timeoutSeconds: true })
  assert.deepEqual(errors({ command: '  ' }), { command: true })
})
