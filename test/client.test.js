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
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
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

test('client.js：ModuleLoader 协议与依赖声明', async () => {
  const { registration, exports } = await loadClientModule()
  assert.equal(registration.id, packageJson.name)
  assert.equal(registration.id, packageJson.name)
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(packageJson.files.includes('client.js'))
  assert.equal(packageJson.exports['./client'], './client.js')
})

test('client.js：注册设置页、侧边栏条目与中央面板，并注册中英文字典', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations, dictionaries, effects } = createClientCtx()
  exports.apply(ctx)

  const bySlot = (slot) => registrations.filter((item) => item.options.name === slot)
  assert.equal(bySlot('settings.section').length, 1)
  assert.equal(bySlot('sidebar.panellist').length, 1)
  assert.equal(bySlot('main').length, 1)

  const section = bySlot('settings.section')[0]
  assert.equal(section.options.id, 'noagent-schedule')
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.locale, 'noagent-schedule')
  assert.equal(typeof section.options.inject, 'function')
  assert.equal(typeof section.component, 'function')

  const panel = bySlot('sidebar.panellist')[0]
  assert.equal(panel.options.id, 'noagent-schedule')
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(typeof panel.component, 'function')

  // main 槽是 keyed 槽：key 必须等于侧边栏条目的 id，外壳靠它选中面板。
  const main = bySlot('main')[0]
  assert.equal(main.options.key, panel.options.id)
  assert.equal(main.options.locale, 'noagent-schedule')
  assert.equal(typeof main.component, 'function')

  // 字典：zh / en 各一份，键完全一致
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'noagent-schedule')
  const { zh, en } = dictionaries[0].dicts
  assert.equal(typeof zh, 'object')
  assert.equal(typeof en, 'object')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())

  // 注入面：hooks.status 会变成 props.useStatus
  const face = section.options.inject()
  assert.ok(face.hooks && typeof face.hooks.status?.getSnapshot === 'function')
  assert.equal(typeof face.runNow, 'function')
  assert.equal(typeof face.loadLog, 'function')
  assert.equal(typeof face.refresh, 'function')

  // 效果都带标签，卸载时能清理
  assert.ok(effects.some((label) => String(label).includes('dictionaries')))
})

test('client.js：组件在给定 props 下可构造（不抛错）', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations } = createClientCtx()
  exports.apply(ctx)

  const t = (key, params) =>
    params === undefined ? key : `${key}(${Object.values(params).join(',')})`
  const status = {
    kind: 'ready',
    updatedAt: '2026-10-19T10:00:00.000Z',
    error: null,
    jobs: [
      {
        id: 'unit',
        name: '单元测试任务',
        enabled: true,
        timeZone: 'Asia/Shanghai',
        schedule: { kind: 'cron', cron: '30 18 * * *' },
        command: 'echo ok',
        running: false,
        lastFiredMinute: null,
        last: { startedAt: '2026-10-19T10:00:00.000Z', durationMs: 1200, exitCode: 0, ok: true, timedOut: false },
      },
      {
        id: 'interval',
        name: '间隔任务',
        enabled: false,
        timeZone: 'Asia/Shanghai',
        schedule: { kind: 'every', everySeconds: 60 },
        command: '',
        running: true,
        lastFiredMinute: null,
        last: null,
      },
    ],
  }

  const section = registrations.find((item) => item.options.name === 'settings.section')
  const tree = section.component({
    t,
    useStatus: () => status,
    refresh: () => {},
    runNow: async () => ({}),
    loadLog: async () => ({ file: null, text: '', truncated: false }),
  })
  assert.equal(typeof tree, 'object')
  assert.equal(tree.type, 'div')

  const icon = registrations.find((item) => item.options.name === 'sidebar.panellist')
  const iconTree = icon.component({ size: 16, active: false })
  assert.equal(iconTree.type, 'svg')

  const panel = registrations.find((item) => item.options.name === 'main')
  const page = panel.component({
    t,
    useStatus: () => ({ kind: 'error', jobs: [], updatedAt: null, error: 'boom' }),
    refresh: () => {},
    runNow: async () => ({}),
    loadLog: async () => ({ file: null, text: '', truncated: false }),
  })
  assert.equal(page.type, 'div')
})

/** 展开函数组件树（不跑真 React），用来把 JobCard 这类子组件也走一遍。 */
function expand(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 25) return node
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1))
  if (typeof node.type === 'function') {
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

test('client.js：任务卡片树完整展开（运行按钮 / 日志按钮 / 上次结果）', async () => {
  const { exports } = await loadClientModule()
  const { ctx, registrations } = createClientCtx()
  exports.apply(ctx)

  const t = (key, params) =>
    params === undefined ? key : `${key}(${Object.values(params).join(',')})`
  const jobs = [
    {
      id: 'unit',
      name: '单元测试任务',
      enabled: true,
      timeZone: 'Asia/Shanghai',
      schedule: { kind: 'cron', cron: '30 18 * * *' },
      command: 'echo ok',
      running: false,
      lastFiredMinute: null,
      last: { startedAt: '2026-10-19T10:00:00.000Z', durationMs: 1200, exitCode: 0, ok: true, timedOut: false },
    },
    {
      id: 'interval',
      name: '间隔任务',
      enabled: false,
      timeZone: 'Asia/Shanghai',
      schedule: { kind: 'every', everySeconds: 60 },
      command: '',
      running: true,
      lastFiredMinute: null,
      last: null,
    },
  ]

  const section = registrations.find((item) => item.options.name === 'settings.section')
  const tree = expand(section.component({
    t,
    useStatus: () => ({ kind: 'ready', jobs, updatedAt: null, error: null }),
    refresh: () => {},
    runNow: async () => ({}),
    loadLog: async () => ({ file: null, text: '', truncated: false }),
  }))
  const nodes = flatten(tree)
  const texts = nodes.flatMap((node) => (node.children ?? []).filter((c) => typeof c === 'string'))
  assert.ok(texts.includes('runNow'), `运行按钮文案缺失：${texts.join('|')}`)
  assert.ok(texts.includes('viewLog'), '日志按钮文案缺失')
  assert.ok(texts.some((text) => String(text).includes('cron(')), 'cron 计划文案缺失')
  assert.ok(texts.some((text) => String(text).includes('everySeconds(')), '间隔计划文案缺失')
  assert.ok(texts.includes('never'), '“从未运行”文案缺失')
  assert.ok(texts.some((text) => String(text).includes('exitCode(')), '退出码文案缺失')
  assert.ok(texts.includes('running'), '运行中文案缺失')
  const buttons = nodes.filter((node) => node.type === 'button')
  assert.ok(buttons.length >= 4, `按钮数量异常：${buttons.length}`)
  assert.ok(buttons.some((button) => button.props.disabled === true), '运行中的任务应禁用按钮')
})
