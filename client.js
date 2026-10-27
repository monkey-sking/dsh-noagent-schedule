/**
 * dsh-noagent-schedule — 浏览器半（设置页 + 侧边栏面板）
 *
 * 结构照 templates/decoration/client.js：window.__ModuleLoader__.load({ id, factory })，
 * id 必须等于包名。纯 JS，无 TS、无构建步骤。
 *
 * 界面参照青龙面板的「定时任务」页（0.4.0 起）：
 *   总览卡（总数 / 启用 / 今日运行 / 近 24h 失败）→ 工具条（搜索、状态筛选、刷新）
 *   → 任务表（状态灯+名称 / 计划 / 上次·下次 / 最近结果 / 操作）→ 展开行编辑 → 日志抽屉。
 *   与青龙不同的是：计划一律用人话（每天 18:30），cron 原文只在悬停时给出。
 *
 * 数据通道：Host 侧用 ctx.connection.fetch 注册了精确路由 `/api/noagent.rpc`。
 * Connection 的 `/api` 前缀处理器先做 Host/Origin 围栏 + 签名 Cookie 鉴权，再把
 * 请求交给我们的 fetch。这里用**相对路径** `api/noagent.rpc` 请求，与内置
 * dsh-session-log-export 的写法一致，因此在带 mount 前缀的部署下也能命中。
 */
window.__ModuleLoader__.load({
  id: 'dsh-noagent-schedule',
  factory(require) {
    const React = require('react')
    const h = React.createElement

function createUiKit(React) {
  const h = React.createElement
  const { useState, useEffect, useRef, useCallback } = React

  // -------------------------------------------------------------------------
  // CSS  (mirrors primitives' *.module.css, class names renamed to dp-*)
  // -------------------------------------------------------------------------
  const CSS = `
/* ===== dsh-panel ui-kit v1 (copied from dsh-client-ui-primitives) ===== */

.dp-btn {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; border: none; border-radius: var(--dsw-radius-md); cursor: pointer;
  font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary);
  background: transparent; padding: 0 14px;
}
.dp-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dp-btn-md { height: 36px; }
.dp-btn-sm { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: var(--dsw-radius-sm); }
.dp-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dp-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dp-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dp-btn-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dp-btn-outline { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; }
.dp-btn-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dp-btn-toolbar { background: var(--dsw-alias-button-tool-bar-fill); }
.dp-btn-toolbar:hover:not(:disabled) { background: var(--dsw-alias-button-tool-bar-hover); }
.dp-btn-danger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.dp-btn-danger:hover:not(:disabled) { filter: brightness(0.92); }
.dp-btn-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
.dp-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

/* Tag — capsule, tone varies */
.dp-tag {
  display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px;
  font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
}
.dp-tag[data-tone='outline'] { border: 0.5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-tertiary); }
.dp-tag[data-tone='solid'] { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dp-tag[data-tone='neutral'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dp-tag[data-tone='quiet'] { color: var(--dsw-alias-label-tertiary); }
.dp-tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.dp-tag[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.dp-tag[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dp-tag[data-tone='danger'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }

/* Pill — filter chip */
.dp-pill {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px;
  border: none; border-radius: 999px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
}
.dp-pill-interactive { cursor: pointer; }
.dp-pill-interactive:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dp-pill-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-button-ghost-active-fill); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }

/* StateDot */
.dp-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; }
.dp-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }
.dp-dot[data-state='done'] { color: var(--dsw-alias-state-success-primary); }
.dp-dot[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.dp-dot[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.dp-dot[data-state='idle'] { color: var(--dsw-alias-state-idle-primary); }
.dp-dot[data-state='info'] { color: var(--dsw-alias-state-business-primary); }
.dp-spinner { flex: none; color: var(--dsw-alias-label-tertiary); }
.dp-spinner-motion { transform-origin: center; animation: dp-spin 1.5s linear infinite; }
.dp-spinner-track, .dp-spinner-arc { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.dp-spinner-track { opacity: 0.25; }
.dp-spinner-arc { stroke-dasharray: 12 150; animation: dp-dash 1.5s ease-in-out infinite; }
@keyframes dp-spin { to { transform: rotate(360deg); } }
@keyframes dp-dash { 0% { stroke-dasharray: 12 150; stroke-dashoffset: 0; } 50% { stroke-dasharray: 24 150; stroke-dashoffset: -6; } 100% { stroke-dasharray: 12 150; stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) { .dp-spinner-motion, .dp-spinner-arc { animation: none; } .dp-spinner-arc { stroke-dasharray: 18 150; stroke-dashoffset: -3; } }

/* SegmentedTabs */
.dp-tabs { position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: max-content; width: fit-content; max-width: 100%; padding: 4px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
    .dp-tabs-full { display: grid; grid-auto-columns: 1fr; }
.dp-tabs-indicator { position: absolute; top: 4px; bottom: 4px; left: 4px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); transition: transform 180ms ease, width 180ms ease; pointer-events: none; }
.dp-tab { position: relative; justify-content: center; height: 34px; padding: 0 12px; border-radius: var(--dsw-radius-md); border: none; background: transparent; color: var(--dsw-alias-label-secondary); transition: color 180ms ease; cursor: pointer; font: inherit; }
.dp-tab:hover, .dp-tab[aria-selected='true'] { background: transparent; color: var(--dsw-alias-label-primary); }
.dp-tab[aria-selected='true'] { font-weight: 600; }
.dp-tab:focus-visible { outline: none; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
@media (prefers-reduced-motion: reduce) { .dp-tabs-indicator, .dp-tab { transition: none; } }

/* SearchInput */
.dp-input-wrap { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.dp-input-wrap:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.dp-input-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); }
.dp-input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dp-input::placeholder { color: var(--dsw-alias-label-dimmed); }

/* Switch */
.dp-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.dp-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dp-switch:disabled { cursor: default; opacity: 0.5; }
.dp-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dp-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.dp-switch[aria-checked='false'] .dp-switch-thumb { background: var(--dsw-alias-switch-thumb); }
.dp-switch[aria-checked='true'] .dp-switch-thumb { transform: translateX(16px); }

/* Modal */
.dp-modal-root { pointer-events: auto; position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px; }
.dp-modal-mask { position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0; backdrop-filter: var(--dsw-mask-blur); }
.dp-modal-mask::after { content: ''; position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); animation: dp-modal-enter var(--ds-transition-duration, 160ms) var(--ds-ease-in-out, ease); }
.dp-modal-dialog { box-sizing: border-box; position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(560px, 100%); max-height: 100%; padding: 0 0 24px; overflow: hidden; border: 0; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); animation: dp-modal-enter var(--ds-transition-duration, 160ms) var(--ds-ease-in-out, ease); }
.dp-modal-dialog[data-size='sm'] { width: min(380px, 100%); }
.dp-modal-dialog[data-size='lg'] { width: min(760px, 100%); }
@keyframes dp-modal-enter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dp-modal-mask::after, .dp-modal-dialog { animation: none; } }
.dp-modal-dialog:focus { outline: none; }
.dp-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dp-modal-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dp-modal-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.dp-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dp-modal-description { margin: 0; padding: 0 24px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dp-modal-body { display: flex; flex-direction: column; min-width: 0; margin-top: 20px; padding: 0 24px; overflow: auto; }
.dp-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }

/* Toast */
.dp-toast { position: fixed; top: 40px; left: 50%; z-index: 1100; pointer-events: none; display: flex; align-items: center; gap: 10px; width: max-content; max-width: min(640px, calc(100vw - 48px)); padding: 12px 16px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label); font-size: 14px; line-height: 22px; box-shadow: var(--dsw-shadow-lv3); transform: translateX(-50%); animation: dp-toast-in 160ms ease-out, dp-toast-fade 1000ms ease var(--dp-toast-hold, 3000ms) forwards; }
.dp-toast-icon { display: grid; place-items: center; flex: none; color: var(--dsw-alias-state-warn-label); }
.dp-toast-icon[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.dp-toast-icon[data-tone='info'] { color: var(--dsw-alias-state-business-primary); }
.dp-toast-text { min-width: 0; }
@keyframes dp-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes dp-toast-fade { to { opacity: 0; visibility: hidden; } }
@media (prefers-reduced-motion: reduce) { .dp-toast { animation: dp-toast-fade 1000ms ease var(--dp-toast-hold, 3000ms) forwards; } }

/* Layout helpers (not from primitives; pure token layout) */
.dp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px 16px; color: var(--dsw-alias-label-tertiary); font-size: 13px; text-align: center; }
.dp-statcard { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l3); }
.dp-statcard-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dp-statcard-value { font-size: 20px; line-height: 28px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dp-statcard-value[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.dp-statcard-value[data-tone='warning'] { color: var(--dsw-alias-state-warn-primary); }
.dp-statcard-value[data-tone='danger'] { color: var(--dsw-alias-state-error-primary); }
.dp-section-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: 0.01em; }
`

  // -------------------------------------------------------------------------
  // Icons (inline SVG, 16x16, currentColor)
  // -------------------------------------------------------------------------
  const svg = (pathD, opts = {}) =>
    h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
      stroke: 'currentColor', 'stroke-width': opts.w || 1.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': true, ...opts.extra },
      h('path', { d: pathD }))
  const IconSearch = () => svg('M7 13A6 6 0 1 0 7 1a6 6 0 0 0 0 12ZM11.5 11.5 14 14')
  const IconClose = () => svg('M4 4l8 8M12 4l-8 8')
  const IconWarn = () => svg('M8 1.5 15 14H1ZM8 6v3M8 11.5v.5')
  const IconInfo = () => svg('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 7v3.5M8 4.5v.5')
  const IconCheck = () => svg('M3 8.5 6.5 12 13 4')

  // -------------------------------------------------------------------------
  // Atoms
  // -------------------------------------------------------------------------
  function Button({ variant = 'ghost', size = 'md', icon, type = 'button', children, ...rest }) {
    return h('button', { type, className: `dp-btn dp-btn-${variant} dp-btn-${size}`, ...rest },
      icon != null && h('span', { className: 'dp-btn-icon' }, icon),
      children)
  }

  function Tag({ tone = 'outline', children, ...rest }) {
    return h('span', { className: 'dp-tag', 'data-tone': tone, ...rest }, children)
  }

  function Pill({ active = false, onClick, type = 'button', children }) {
    const cls = `dp-pill${onClick ? ' dp-pill-interactive' : ''}${active ? ' dp-pill-active' : ''}`
    return h('button', { type, className: cls, onClick }, children)
  }

  function StateDot({ state = 'idle' }) {
    if (state === 'ongoing') {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, className: 'dp-spinner', 'aria-hidden': true },
        h('g', { className: 'dp-spinner-motion' },
          h('circle', { className: 'dp-spinner-track', cx: 12, cy: 12, r: 9 }),
          h('circle', { className: 'dp-spinner-arc', cx: 12, cy: 12, r: 9 })))
    }
    return h('span', { className: 'dp-dot', 'data-state': state, 'aria-hidden': true })
  }

  function SegmentedTabs({ tabs, value, onChange, ariaLabel }) {
    const ref = useRef(null)
    const [ind, setInd] = useState({ x: 0, w: 0 })

    useEffect(() => {
      const el = ref.current
      if (!el) return
      const measure = () => {
        const sel = el.querySelector('.dp-tab[aria-selected="true"]')
        if (sel) setInd({ x: sel.offsetLeft, w: sel.offsetWidth })
      }
      measure()
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
      if (ro) ro.observe(el)
      return () => { if (ro) ro.disconnect() }
    }, [value, tabs])

    return h('div', { className: 'dp-tabs', role: 'tablist', 'aria-label': ariaLabel, ref },
      h('div', { className: 'dp-tabs-indicator',
        style: { transform: `translateX(${ind.x - 4}px)`, width: ind.w ? `${ind.w}px` : undefined } }),
      tabs.map(t => h('button', {
        key: t.value, role: 'tab', type: 'button',
        className: 'dp-tab', 'aria-selected': t.value === value,
        onClick: () => onChange(t.value),
      }, t.label)))
  }

  function SearchInput({ value, onChange, placeholder, ...rest }) {
    return h('div', { className: 'dp-input-wrap' },
      h('span', { className: 'dp-input-icon' }, h(IconSearch)),
      h('input', {
        className: 'dp-input', type: 'text', value, placeholder,
        onChange: e => onChange(e.target.value), ...rest,
      }))
  }

  function Switch({ checked, onChange, disabled, 'aria-label': ariaLabel }) {
    return h('button', {
      type: 'button', role: 'switch', className: 'dp-switch',
      'aria-checked': checked ? 'true' : 'false', 'aria-label': ariaLabel,
      disabled, onClick: () => { if (!disabled) onChange(!checked) },
    }, h('span', { className: 'dp-switch-thumb' }))
  }

  // Modal — focus+Esc+outside-click+restore, copied behavior from primitives
  function Modal({ open, title, onClose, children, footer, description, size = 'md' }) {
    const dialogRef = useRef(null)
    const prevFocus = useRef(null)

    useEffect(() => {
      if (!open) return
      prevFocus.current = document.activeElement
      const el = dialogRef.current
      if (el) {
        const f = el.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ;(f || el).focus?.()
      }
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('keydown', onKey, true)
        try { prevFocus.current?.focus?.() } catch { /* ignore */ }
      }
    }, [open, onClose])

    if (!open) return null
    const closeOnBackdrop = (e) => { if (e.target === e.currentTarget) onClose() }
    return h('div', { className: 'dp-modal-root', onPointerDown: closeOnBackdrop },
      h('div', { className: 'dp-modal-mask', onPointerDown: closeOnBackdrop }),
      h('div', {
        className: 'dp-modal-dialog', 'data-size': size, role: 'dialog', 'aria-modal': 'true',
        tabIndex: -1, ref: dialogRef,
      },
        title && h('div', { className: 'dp-modal-header' },
          h('h2', { className: 'dp-modal-title' }, title),
          h('button', { type: 'button', className: 'dp-modal-close', 'aria-label': '关闭', onClick: onClose },
            h(IconClose))),
        description && h('p', { className: 'dp-modal-description' }, description),
        h('div', { className: 'dp-modal-body' }, children),
        footer && h('div', { className: 'dp-modal-footer' }, footer),
      ))
  }

  // useToast — returns { show, node }; render `node` once at the panel root.
  function useToast() {
    const [items, setItems] = useState([])
    const idc = useRef(0)
    const show = useCallback((text, opts = {}) => {
      const id = ++idc.current
      const tone = opts.tone || 'info'
      const hold = opts.hold || 3000
      setItems(xs => [...xs, { id, text, tone, hold }])
      setTimeout(() => setItems(xs => xs.filter(x => x.id !== id)), hold + 1100)
      return id
    }, [])
    const dismiss = useCallback((id) => setItems(xs => xs.filter(x => x.id !== id)), [])
    const iconFor = (tone) => tone === 'success' ? h(IconCheck) : tone === 'info' ? h(IconInfo) : h(IconWarn)
    const node = items.map(it =>
      h('div', { key: it.id, className: 'dp-toast', style: { '--dp-toast-hold': `${it.hold}ms` } },
        h('span', { className: 'dp-toast-icon', 'data-tone': it.tone }, iconFor(it.tone)),
        h('span', { className: 'dp-toast-text' }, it.text)))
    return { show, dismiss, node }
  }

  function EmptyState({ icon, children }) {
    return h('div', { className: 'dp-empty' }, icon != null ? h('span', { className: 'dp-empty-icon' }, icon) : null, children)
  }

  function StatCard({ label, value, tone }) {
    const valueProps = { className: 'dp-statcard-value' }
    if (tone) valueProps['data-tone'] = tone
    return h('div', { className: 'dp-statcard' },
      h('span', { className: 'dp-statcard-label' }, label),
      h('span', valueProps, value))
  }

  function SectionTitle({ children, ...rest }) {
    return h('h3', { className: 'dp-section-title', ...rest }, children)
  }

  return {
    CSS,
    Button, Tag, Pill, StateDot, SegmentedTabs, SearchInput, Switch,
    Modal, useToast, EmptyState, StatCard, SectionTitle,
    icons: { IconSearch, IconClose, IconWarn, IconInfo, IconCheck },
  }
}

    const UI = createUiKit(React)

    /** 与 Host 的 RPC_PATH 对应；相对路径让 mount 前缀自动生效。 */
    const ROUTE = 'api/noagent.rpc'
    /** Client locale 命名空间。 */
    const NS = 'noagent-schedule'
    /** 侧边栏条目 id，同时是 main 槽的 key（外壳按 id 选中中央面板）。 */
    const PANEL_ID = 'noagent-schedule'
    /** 面板打开期间的状态轮询间隔。 */
    const POLL_MS = 5000

    // -------------------------------------------------------------------------
    // 文案：Client locale 字典（zh/en 都在这里注册；locale/*.json 是包级元数据）
    // -------------------------------------------------------------------------
    const en = {
      panel: 'Scheduled scripts',
      title: 'Scheduled scripts',
      intro:
        'Scripts this Host runs on a schedule without calling the model. Run one now, read its log, or change when it runs.',
      loading: 'Loading…',
      empty: 'No scheduled scripts are configured.',
      emptyFiltered: 'No task matches the current filter.',
      refresh: 'Refresh',
      runNow: 'Run',
      running: 'Running…',
      viewLog: 'Log',
      lastRun: 'Last',
      nextRun: 'Next',
      never: 'never ran',
      exitCode: 'exit {code}',
      timeout: 'timed out',
      enabled: 'Enabled',
      disabled: 'Disabled',
      cron: 'cron {expression}',
      invalidCron: 'invalid cron',
      timeZone: 'Time zone',
      updated: 'Updated {time}',
      command: 'Command',
      logTitle: 'Run log',
      logTruncated: 'Showing the tail of a larger log.',
      noLog: 'No run log recorded yet.',
      runAccepted: 'Run started.',
      runFailed: 'Could not start the run.',
      logFailed: 'Could not read the log.',
      loadFailed: 'Could not load scheduled scripts.',
      jobId: 'ID',
      statTotal: 'Tasks',
      statEnabled: 'Enabled',
      statDueToday: 'Ran today',
      statFailed: 'Failed (24h)',
      searchPlaceholder: 'Search name, id or command',
      filterAll: 'All',
      filterEnabled: 'Enabled',
      filterDisabled: 'Disabled',
      filterFailing: 'Failing',
      colTask: 'Task',
      colSchedule: 'Schedule',
      colRuns: 'Recent',
      colActions: 'Actions',
      runsCompact: 'Last {n} runs',
      edit: 'Edit',
      save: 'Save',
      cancel: 'Cancel',
      saving: 'Saving…',
      saved: 'Saved.',
      saveFailed: 'Could not save.',
      deleteJob: 'Delete',
      deleteConfirm: 'Delete this task from jobs.json? A backup is written first.',
      deleteYes: 'Delete it',
      deleteDone: 'Deleted.',
      deleteFailed: 'Could not delete.',
      fieldName: 'Name',
      fieldMode: 'Type',
      modeCron: 'Cron',
      modeEvery: 'Interval',
      fieldCron: 'Cron expression',
      fieldEvery: 'Interval (seconds)',
      fieldTimeout: 'Timeout (s)',
      fieldCommand: 'Command',
      toggleFailed: 'Could not change the state.',
      watchBadge: 'Event',
      watchHint: 'Runs every cycle; wakes a session only when its output changes.',
      formInvalid: 'Fix the highlighted fields first.',
      closeLog: 'Close',
      logFor: 'Run {time}',
      latestRun: 'Latest run',
      groupBy: 'Group by category',
      groupUngrouped: 'Ungrouped',
      groupCollapse: 'Collapse',
      groupExpand: 'Expand',
      groupCount: '{n} tasks',
      groupAlerts: '{n} need attention',
      categories: 'Categories',
      allCategories: 'All categories',
      sortLabel: 'Sort tasks',
      sortAttention: 'Needs attention first',
      sortName: 'Name',
      sortNext: 'Next run',
      sortRecent: 'Recently run',
      compact: 'Compact rows',
      resetFilters: 'Clear filters',
      resultCount: '{n} matching / {total} tasks',
      pageInfo: '{from}–{to} of {n} · Page {page}/{pages}',
      previousPage: 'Previous',
      nextPage: 'Next',
      pageSize: 'Tasks per page',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
    }

    const zh = {
      panel: '定时脚本',
      title: '定时脚本',
      intro: '宿主按计划直接运行、不经过模型的脚本。可以立即运行、看日志，也可以改运行时间。',
      loading: '加载中…',
      empty: '还没有配置任何定时脚本。',
      emptyFiltered: '没有符合当前筛选的任务。',
      refresh: '刷新',
      runNow: '运行',
      running: '运行中…',
      viewLog: '日志',
      lastRun: '上次',
      nextRun: '下次',
      never: '从未运行',
      exitCode: '退出码 {code}',
      timeout: '已超时',
      enabled: '已启用',
      disabled: '已停用',
      cron: 'cron {expression}',
      invalidCron: 'cron 无效',
      timeZone: '时区',
      updated: '更新于 {time}',
      command: '命令',
      logTitle: '运行日志',
      logTruncated: '日志较大，只显示尾部。',
      noLog: '还没有运行日志。',
      runAccepted: '已开始运行。',
      runFailed: '无法启动这次运行。',
      logFailed: '无法读取日志。',
      loadFailed: '无法加载定时脚本。',
      jobId: 'ID',
      statTotal: '任务总数',
      statEnabled: '启用中',
      statDueToday: '今日运行',
      statFailed: '近 24h 失败',
      searchPlaceholder: '搜索名称、ID 或命令',
      filterAll: '全部',
      filterEnabled: '启用',
      filterDisabled: '停用',
      filterFailing: '异常',
      colTask: '任务',
      colSchedule: '计划',
      colRuns: '最近',
      colActions: '操作',
      runsCompact: '最近 {n} 次',
      edit: '编辑',
      save: '保存',
      cancel: '取消',
      saving: '保存中…',
      saved: '已保存。',
      saveFailed: '保存失败。',
      deleteJob: '删除',
      deleteConfirm: '从 jobs.json 删除这个任务？删除前会先写一份备份。',
      deleteYes: '确认删除',
      deleteDone: '已删除。',
      deleteFailed: '删除失败。',
      fieldName: '名称',
      fieldMode: '计划方式',
      modeCron: 'Cron 表达式',
      modeEvery: '固定间隔',
      fieldCron: 'Cron 表达式',
      fieldEvery: '间隔（秒）',
      fieldTimeout: '超时（秒）',
      fieldCommand: '命令',
      toggleFailed: '无法切换状态。',
      watchBadge: '事件型',
      watchHint: '按间隔运行，只有输出变化时才唤醒会话。',
      formInvalid: '请先修正标红的字段。',
      closeLog: '关闭',
      logFor: '运行于 {time}',
      latestRun: '最近一次',
      groupBy: '按分类分组',
      groupUngrouped: '未分类',
      groupCollapse: '收起',
      groupExpand: '展开',
      groupCount: '{n} 个任务',
      groupAlerts: '{n} 个需处理',
      categories: '任务分类',
      allCategories: '全部分类',
      sortLabel: '任务排序',
      sortAttention: '异常优先',
      sortName: '按名称',
      sortNext: '按下次运行',
      sortRecent: '按最近运行',
      compact: '紧凑列表',
      resetFilters: '清除筛选',
      resultCount: '匹配 {n} / 共 {total} 个任务',
      pageInfo: '第 {from}–{to} 项，共 {n} 项 · 第 {page}/{pages} 页',
      previousPage: '上一页',
      nextPage: '下一页',
      pageSize: '每页任务数',
      collapseAll: '全部收起',
      expandAll: '全部展开',
    }

    // -------------------------------------------------------------------------
    // 纯函数：计划的人话、相对时间、总览统计。导出到 utils 供测试直接调用。
    // -------------------------------------------------------------------------

    const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const WEEKDAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const MONTH_SHORT = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    }
    const DOW_SHORT = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

    const pad2 = (n) => String(n).padStart(2, '0')

    /** cron 单项 → { values } 或 { invalid }；返回 null 表示「任意」。 */
    function parseCronField(raw, min, max, names) {
      const field = String(raw).trim()
      if (field === '*') return null
      const values = new Set()
      const nameOf = (token) => {
        const lower = String(token).toLowerCase()
        return names && names[lower] !== undefined ? names[lower] : Number(token)
      }
      for (const piece of field.split(',')) {
        if (!piece) return { invalid: true }
        const [spec, stepText] = piece.split('/')
        const step = stepText === undefined ? 1 : Number(stepText)
        if (!Number.isInteger(step) || step <= 0) return { invalid: true }
        if (spec === '*') {
          for (let v = min; v <= max; v += step) values.add(v)
          continue
        }
        const range = spec.split('-')
        const start = nameOf(range[0])
        const end = range.length === 2 ? nameOf(range[1]) : start
        if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < min || end > max) {
          return { invalid: true }
        }
        for (let v = start; v <= end; v += step) values.add(v)
      }
      return { values: [...values].sort((a, b) => a - b) }
    }

    /** 小时×分钟 → `HH:MM`；组合太复杂就返回 null（交给 describeTimeWindow）。 */
    function timePart(hour, minute) {
      if (!minute || !hour) return null
      if (minute.values.length > 4 || hour.values.length > 3) return null
      return hour.values
        .map((hh) => minute.values.map((m) => `${pad2(hh)}:${pad2(m)}`).join(', '))
        .join(', ')
    }

    /** 等差序列的步长；不是等差返回 0（交给列举）。 */
    function evenStep(values) {
      if (!values || values.length < 2) return 1
      const step = values[1] - values[0]
      return values.every((v, i) => v === values[0] + i * step) ? step : 0
    }

    /**
     * 小时×分钟的组合太多（超过 timePart 的枚举上限）时，压缩成一句人话，
     * 而不是让 UI 误报「cron 无效」：
     *   `*​/30 9-23 * * *` → 9–23 点 · 每 30 分钟
     *   `5 9-22 * * *`    → 9–22 点 · 第 05 分
     *   `* 9-23 * * *`    → 9–23 点 · 每分钟
     * 实在描述不了返回 null。
     */
    function describeTimeWindow(hour, minute, lang) {
      const isEn = lang === 'en'
      const list = (values, unit) => (isEn ? `${values.join(', ')} ${unit}` : `${values.join('、')} ${unit}`)

      let minuteText = null
      if (!minute) {
        minuteText = isEn ? 'every minute' : '每分钟'
      } else {
        const m = minute.values
        const step = evenStep(m)
        if (m.length === 1) {
          minuteText = m[0] === 0
            ? (isEn ? 'on the hour' : '整点')
            : (isEn ? `at :${pad2(m[0])}` : `第 ${pad2(m[0])} 分`)
        } else if (step && m[0] === 0) {
          minuteText = isEn ? `every ${step} min` : `每 ${step} 分钟`
        } else if (step) {
          minuteText = isEn
            ? `every ${step} min from :${pad2(m[0])}`
            : `每 ${step} 分钟（从 ${pad2(m[0])} 分起）`
        } else if (m.length <= 6) {
          minuteText = list(m.map(pad2), isEn ? 'min' : '分')
        }
      }
      if (!minuteText) return null

      // 小时全天：分钟说法本身已经完整（「每 30 分钟」「00、05、20 分」）。
      if (!hour) {
        // 步长从 0 起（*/30）本身就是完整节奏；单个/列举分钟要补「每小时」，
        // 否则 `0 * * * *` 会被读成「每 1 分钟」（每小时整点是它的真实含义）。
        const m = minute ? minute.values : null
        const step = m ? evenStep(m) : 0
        if (!m || (m.length > 1 && step > 0 && m[0] === 0)) return minuteText
        if (isEn) return `hourly ${minuteText}`
        return minuteText === '整点' ? '每小时整点' : `每小时 ${minuteText}`
      }

      const h = hour.values
      const step = evenStep(h)
      const span = `${h[0]}–${h[h.length - 1]}`
      let hourText = null
      if (h.length === 1) hourText = isEn ? `at ${pad2(h[0])} h` : `${h[0]} 点`
      else if (step === 1) hourText = isEn ? `${span} h` : `${span} 点`
      else if (step) hourText = isEn ? `every ${step} h (${span})` : `每 ${step} 小时（${span} 点）`
      else if (h.length <= 6) hourText = list(h, isEn ? 'h' : '点')
      if (!hourText) return null

      return isEn ? `${minuteText} · ${hourText}` : `${hourText} · ${minuteText}`
    }

    /**
     * cron 五段 → 一段人话：
     *   `30 18 * * *` → 每天 18:30      `*​/15 * * * *` → 每 15 分钟
     *   `0 0 * * 1`   → 周一 00:00       `15 9 1 * *`  → 1 号 09:15
     * 解析不了返回 null，由调用方退回 cron 原文。
     */
    function describeCron(expression, lang = 'zh') {
      const fields = String(expression ?? '').trim().split(/\s+/)
      if (fields.length !== 5) return null
      const minute = parseCronField(fields[0], 0, 59)
      const hour = parseCronField(fields[1], 0, 23)
      const dom = parseCronField(fields[2], 1, 31)
      const month = parseCronField(fields[3], 1, 12, MONTH_SHORT)
      const dowRaw = parseCronField(fields[4], 0, 7, DOW_SHORT)
      if ([minute, hour, dom, month, dowRaw].some((part) => part && part.invalid)) return null

      const short = lang === 'en' ? WEEKDAY_SHORT_EN : WEEKDAY_SHORT
      const isEn = lang === 'en'

      // 「每分钟 / 每 N 分钟」：分钟有规律、其余全是任意
      if (!hour && !dom && !month && !dowRaw) {
        if (!minute) return isEn ? 'every minute' : '每分钟'
        if (minute.values.length === 60) return isEn ? 'every minute' : '每分钟'
        if (minute.values.length === 1) {
          // 单个分钟值不是「每 1 分钟」：`0 * * * *` 是每小时的整点。
          const m = minute.values[0]
          if (isEn) return m === 0 ? 'hourly on the hour' : `hourly at :${pad2(m)}`
          return m === 0 ? '每小时整点' : `每小时第 ${pad2(m)} 分`
        }
        const step = minute.values.length > 1 ? minute.values[1] - minute.values[0] : 1
        if (minute.values.every((v, i) => v === minute.values[0] + i * step)) {
          return isEn ? `every ${step} min` : `每 ${step} 分钟`
        }
      }

      if (month) {
        const time = timePart(hour, minute)
        if (month.values.length === 1 && dom && dom.values.length === 1 && time) {
          return isEn
            ? `yearly on ${month.values[0]}/${dom.values[0]} ${time}`
            : `每年 ${month.values[0]} 月 ${dom.values[0]} 号 ${time}`
        }
        // 月份 + 日/星期 + 时间窗的其它组合也逐段拼出来，别让合法 cron 退回「无效」。
        const window = time ?? describeTimeWindow(hour, minute, lang)
        if (!window) return null
        const monthText = month.values.length === 1
          ? (isEn ? `month ${month.values[0]}` : `${month.values[0]} 月`)
          : (isEn ? `months ${month.values.join(', ')}` : `${month.values.join('、')} 月`)
        if (dom && dowRaw) return null // Vixie 的「或」语义，人话容易误导
        let dayText = null
        if (dom) {
          if (dom.values.length > 6) return null
          dayText = isEn ? `day ${dom.values.join(', ')}` : `${dom.values.join('、')} 号`
        } else if (dowRaw) {
          const days = [...new Set(dowRaw.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b)
          const label = days.map((v) => short[v]).join(isEn ? ', ' : '、')
          dayText = isEn ? `on ${label}` : label
        } else {
          dayText = isEn ? 'every day' : '每天'
        }
        if (isEn) return `${dayText} of ${monthText} · ${window}`
        return dom || dowRaw ? `${monthText} ${dayText} ${window}` : `${monthText}${dayText} ${window}`
      }

      let prefix = null
      if (dom && !dowRaw) {
        if (dom.values.length > 6) return null
        prefix = isEn
          ? `day ${dom.values.join(', ')}`
          : dom.values.length === 1 ? `${dom.values[0]} 号` : `每月 ${dom.values.join(', ')} 号`
      } else if (!dom && dowRaw) {
        const days = [...new Set(dowRaw.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b)
        if (days.length > 7) return null
        const label = days.map((v) => short[v]).join(isEn ? ', ' : '、')
        prefix = isEn ? `on ${label}` : label
      } else if (dom && dowRaw) {
        return null // Vixie 的「或」语义，人话容易误导，直接显示原文
      }

      const time = timePart(hour, minute)
      if (!time) {
        // 组合太多不是「非法」：用区间/步长的说法兜底，真解析不了才退回 cron 原文。
        const window = describeTimeWindow(hour, minute, lang)
        if (!window) return null
        return prefix === null ? window : `${prefix} ${window}`
      }
      if (prefix === null) return isEn ? `daily ${time}` : `每天 ${time}`
      return `${prefix} ${time}`
    }

    /** 间隔秒 → 人话：60 叫「每 1 分钟」，3600 叫「每 1 小时」。 */
    function describeEvery(seconds, lang = 'zh') {
      const n = Number(seconds)
      if (!Number.isFinite(n) || n <= 0) return null
      const zhUnit = (value, unit) => `每 ${value} ${unit}`
      if (n >= 3600 && n % 3600 === 0) {
        return lang === 'en' ? `every ${n / 3600} h` : zhUnit(n / 3600, '小时')
      }
      if (n >= 60 && n % 60 === 0) {
        return lang === 'en' ? `every ${n / 60} min` : zhUnit(n / 60, '分钟')
      }
      return lang === 'en' ? `every ${n}s` : zhUnit(n, '秒')
    }

    /** cron 是否真的合法（只校验字段，不管能不能说成人话）。 */
    function isValidCron(expression) {
      const fields = String(expression ?? '').trim().split(/\s+/)
      if (fields.length !== 5) return false
      const parts = [
        parseCronField(fields[0], 0, 59),
        parseCronField(fields[1], 0, 23),
        parseCronField(fields[2], 1, 31),
        parseCronField(fields[3], 1, 12, MONTH_SHORT),
        parseCronField(fields[4], 0, 7, DOW_SHORT),
      ]
      return !parts.some((part) => part && part.invalid)
    }

    /** 任务的计划人话；说不出人话时保留原文，只有 cron 真的非法才标 invalid。 */
    function scheduleText(schedule, lang = 'zh') {
      if (!schedule) return { text: '', invalid: false }
      if (schedule.kind === 'every') {
        const text = describeEvery(schedule.everySeconds, lang)
        return { text: text ?? '', invalid: false }
      }
      const text = describeCron(schedule.cron, lang)
      if (text) return { text, invalid: false }
      return { text: String(schedule.cron ?? ''), invalid: !isValidCron(schedule.cron) }
    }

    /** 同一时区下两个时刻相差几个自然日（按 yyyy-mm-dd 比，不受夏令时影响）。 */
    function dayGap(fromMs, toMs, timeZone) {
      let fmt
      try {
        fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      } catch {
        return 0
      }
      const toUtc = (text) => {
        const [y, m, d] = text.split('-').map(Number)
        return Date.UTC(y, m - 1, d)
      }
      return Math.round((toUtc(fmt.format(new Date(toMs))) - toUtc(fmt.format(new Date(fromMs)))) / 86_400_000)
    }

    /**
     * 「上次 / 下次」的人话：
     *   过去 → 刚刚 / N 分钟前 / N 小时前 / 昨天 18:30 / 10-19 08:40
     *   未来 → 今天 18:30 / 明天 08:40 / N 天后 09:15
     */
    function humanTime(ms, lang, timeZone, nowMs) {
      const when = Number(ms)
      if (!Number.isFinite(when)) return ''
      const now = Number.isFinite(nowMs) ? nowMs : Date.now()
      const zone = timeZone || 'Asia/Shanghai'
      let fmt
      try {
        fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return new Date(when).toLocaleString()
      }
      const parts = {}
      for (const p of fmt.formatToParts(new Date(when))) parts[p.type] = p.value
      const hm = `${pad2(Number(parts.hour) % 24)}:${pad2(Number(parts.minute))}`
      const diff = when - now
      const gap = dayGap(now, when, zone)
      const isEn = lang === 'en'

      if (diff <= 0) {
        const ago = -diff
        if (ago < 60_000) return isEn ? 'just now' : '刚刚'
        if (gap === 0) {
          const mins = Math.floor(ago / 60_000)
          if (mins < 60) return isEn ? `${mins} min ago` : `${mins} 分钟前`
          const hours = Math.floor(mins / 60)
          return isEn ? `${hours} h ago` : `${hours} 小时前`
        }
        if (gap === -1) return isEn ? `yesterday ${hm}` : `昨天 ${hm}`
        if (gap > -7) {
          const days = -gap
          return isEn ? `${days} d ago ${hm}` : `${days} 天前 ${hm}`
        }
        return `${Number(parts.month)}-${Number(parts.day)} ${hm}`
      }

      if (gap === 0) return isEn ? `today ${hm}` : `今天 ${hm}`
      if (gap === 1) return isEn ? `tomorrow ${hm}` : `明天 ${hm}`
      if (gap > 1 && gap <= 30) return isEn ? `in ${gap} days ${hm}` : `${gap} 天后 ${hm}`
      return `${Number(parts.month)}-${Number(parts.day)} ${hm}`
    }

    /** 毫秒 → `0.4s` / `7s` / `1m 07s`。 */
    function humanDuration(ms) {
      if (!Number.isFinite(ms)) return ''
      if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`
      const total = Math.round(ms / 1000)
      return `${Math.floor(total / 60)}m ${pad2(total % 60)}s`
    }

    /** 状态灯：running > error > ok > idle。 */
    function stateOf(job) {
      if (job.running) return 'running'
      if (!job.last) return 'idle'
      return job.last.ok ? 'ok' : 'error'
    }

    /**
     * 总览卡的数字，全部从 status.jobs 现算，不额外请求：
     *   今日运行 = 上次运行在「今天」（任务时区）
     *   近 24h 失败 = 最近一次失败且发生在 24 小时内
     */
    function summarize(jobs, nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now()
      let enabled = 0
      let ranToday = 0
      let failed24h = 0
      let running = 0
      for (const job of jobs) {
        if (job.enabled) enabled += 1
        if (job.running) running += 1
        const startedAt = job.last && job.last.startedAt ? Date.parse(job.last.startedAt) : NaN
        if (!Number.isFinite(startedAt)) continue
        if (dayGap(now, startedAt, job.timeZone || 'Asia/Shanghai') === 0) ranToday += 1
        if (job.last.ok === false && now - startedAt <= 86_400_000) failed24h += 1
      }
      return { total: jobs.length, enabled, ranToday, failed24h, running }
    }

    /** 工具条筛选：all / enabled / disabled / failing。 */
    /**
     * 按 category 把任务分组。分组顺序按「组内有多少个需处理的任务」降序，
     * 再有问题的组里任务多的优先 —— 打开面板第一眼看到的就是该管的。
     * 没有 category 的任务归到「未分类」，排最后。
     */
    function buildGroups(jobs, t) {
      const buckets = new Map()
      for (const job of jobs) {
        const key = job.category || '__ungrouped__'
        const list = buckets.get(key) ?? []
        list.push(job)
        buckets.set(key, list)
      }
      const alertOf = (job) => (job.enabled && job.last && job.last.ok === false ? 1 : 0)
      const groups = []
      for (const [key, list] of buckets) {
        groups.push({
          key,
          label: key === '__ungrouped__' ? t('groupUngrouped') : key,
          jobs: list,
          alertCount: list.reduce((sum, job) => sum + alertOf(job), 0),
        })
      }
      groups.sort((a, b) => {
        if (a.key === '__ungrouped__') return 1
        if (b.key === '__ungrouped__') return -1
        if (b.alertCount !== a.alertCount) return b.alertCount - a.alertCount
        if (b.jobs.length !== a.jobs.length) return b.jobs.length - a.jobs.length
        return a.label.localeCompare(b.label)
      })
      return groups
    }

    function filterJobs(jobs, filter, query, category = '') {
      const needle = String(query ?? '').trim().toLowerCase()
      return jobs.filter((job) => {
        if (category && (job.category || '__ungrouped__') !== category) return false
        if (filter === 'running' && !job.running) return false
        if (filter === 'enabled' && !job.enabled) return false
        if (filter === 'disabled' && job.enabled) return false
        if (filter === 'failing' && (job.last?.ok !== false || job.enabled === false)) return false
        if (!needle) return true
        const haystack = `${job.name ?? ''} ${job.id ?? ''} ${job.command ?? ''} ${job.category ?? ''}`.toLowerCase()
        return needle.split(/\s+/).every((word) => haystack.includes(word))
      })
    }

    function sortJobs(jobs, sort = 'attention') {
      const priority = (job) => job.enabled && job.last?.ok === false ? 0 : job.running ? 1 : job.enabled ? 2 : 3
      const nextTime = (job) => job.enabled && Number.isFinite(job.nextRunAt) ? job.nextRunAt : Infinity
      const lastTime = (job) => Date.parse(job.last?.startedAt) || 0
      return [...jobs].sort((a, b) => {
        let diff = 0
        if (sort === 'attention') diff = priority(a) - priority(b)
        if (sort === 'next') {
          const left = nextTime(a), right = nextTime(b)
          diff = left === right ? 0 : left < right ? -1 : 1
        }
        if (sort === 'recent') diff = lastTime(b) - lastTime(a)
        return diff || String(a.name || a.id).localeCompare(String(b.name || b.id)) || String(a.id).localeCompare(String(b.id))
      })
    }

    function paginateJobs(jobs, requestedPage, size) {
      const pageSize = [15, 30, 50].includes(Number(size)) ? Number(size) : 15
      const pages = Math.max(1, Math.ceil(jobs.length / pageSize))
      const page = Math.min(pages, Math.max(1, Math.floor(Number(requestedPage)) || 1))
      const offset = (page - 1) * pageSize
      return {
        jobs: jobs.slice(offset, offset + pageSize), page, pages,
        from: jobs.length ? offset + 1 : 0, to: Math.min(offset + pageSize, jobs.length), n: jobs.length,
      }
    }

    /**
     * 命令摘要：表格里要能一眼看出「跑的是哪个脚本」。
     * 做法是抹掉每次都一样的噪声 —— 家目录前缀、venv 里的 python 绝对路径、
     * 过长的中间目录（只留文件名），再按长度截断。完整命令在悬停时给出。
     */
    /**
     * 一行摘要：这个任务「实际在跑什么」。
     *
     * 本机 46 个任务全都经过同一个投递 wrapper，`shortenCommand` 截出来的第二行
     * 是 46 份一模一样的 `--retry 2 --retry-delay 20 --stdout-log`，等于没写。
     * 这里跳过 wrapper 的公共参数，只留两样有用的：真正执行的脚本 + 发到哪个通道。
     */
    function describePayload(command) {
      const text = String(command ?? '').trim()
      if (!text) return ''
      const channel = (text.match(/--target\s+(\S+)/) || [])[1] || ''
      // wrapper 之后的部分才是真正的负载：`... -- bash foo.sh` / `... -- python bar.py`
      const tail = text.includes(' -- ') ? text.slice(text.lastIndexOf(' -- ') + 4) : text
      let payload = tail
      // 去掉 shell 关键字与解释器路径，只留脚本名
      payload = payload.replace(/^(bash|sh|zsh|env)\s+/, '')
      const tokens = payload.split(/\s+/).filter(Boolean)
      const baseName = (p) => String(p).split('/').filter(Boolean).pop() || String(p)
      // python/bash/node … 是解释器，不是任务本体；跳过它们找真正的脚本。
      const INTERPRETERS = new Set(['python', 'python2', 'python3', 'bash', 'sh', 'zsh', 'node', 'env', 'npx', 'ruby', 'perl'])
      const isInterp = (tok) => INTERPRETERS.has(baseName(tok).replace(/\.exe$/, ''))
      // 优先找带扩展名的脚本；找不到就退回第一个非选项参数的 basename
      // （cronctl 这类无扩展名的可执行文件走这一支，否则整条绝对路径会露出来）。
      const script = tokens.find((tok) => /\.[a-z0-9]+$/i.test(tok) && !tok.startsWith('-') && !isInterp(tok))
      const firstArg = tokens.find((tok) => !tok.startsWith('-') && !isInterp(tok))
      let main = baseName(script || firstArg || '')
      if (main.length > 42) main = `…${main.slice(-41)}`
      // 没有 wrapper 的任务（探针等）：同样跳过解释器，只留脚本
      if (!channel) {
        const rest = tokens.filter((tok) => !isInterp(tok) && !tok.startsWith('-'))
        if (!rest.length) return shortenCommand(payload, 96)
        return baseName(rest[0])
      }
      return channel ? `${main} → ${channel}` : main
    }

    function shortenCommand(command, max = 96) {
      let text = String(command ?? '').trim()
      // venv 里的解释器只留 python
      text = text.replace(/\/Users\/[^/\s]+\/\.local\/share\/dsh-runtime\/venv\/bin\/(python[0-9.]*)/g, '$1')
      // 其余绝对路径：短路径缩成 ~/…，长路径只留最后一段文件名
      text = text.replace(/(^|\s)(\/[^\s]*)/g, (whole, lead, abs) => {
        const base = abs.split('/').filter(Boolean).pop() || abs
        return `${lead}${abs.length > 28 ? base : abs}`
      })
      if (text.length <= max) return text
      return `${text.slice(0, max)}…`
    }

    /** 保存前在本地挡一次明显的错：错误按字段挂在 errors 上。 */
    function validateForm(form) {
      const errors = {}
      if (form.mode === 'cron') {
        const fields = String(form.cron ?? '').trim().split(/\s+/)
        if (fields.length !== 5 || fields.some((field) => field === '')) errors.cron = true
      } else {
        const every = Number(form.everySeconds)
        if (!Number.isInteger(every) || every < 30) errors.everySeconds = true
      }
      const timeout = Number(form.timeoutSeconds)
      if (!Number.isFinite(timeout) || timeout < 10 || timeout > 86_400) errors.timeoutSeconds = true
      if (!String(form.command ?? '').trim()) errors.command = true
      return errors
    }

    // -------------------------------------------------------------------------
    // 极小的快照 store：不依赖宿主 store 服务，getSnapshot 保持引用稳定。
    // -------------------------------------------------------------------------
    function createStatusStore(call) {
      let state = { kind: 'loading', jobs: [], updatedAt: null, now: null, jobsFile: '', error: null }
      const listeners = new Set()
      let timer = null
      let refreshing = false

      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const set = (patch) => {
        state = { ...state, ...patch }
        emit()
      }
      const refresh = async () => {
        if (refreshing) return
        refreshing = true
        try {
          const value = await call({ op: 'status' })
          set({
            kind: 'ready',
            jobs: Array.isArray(value?.jobs) ? value.jobs : [],
            updatedAt: value?.updatedAt ?? null,
            now: Number.isFinite(value?.now) ? value.now : Date.now(),
            jobsFile: typeof value?.jobsFile === 'string' ? value.jobsFile : '',
            error: null,
          })
        } catch (error) {
          set({ kind: 'error', error: error instanceof Error ? error.message : String(error) })
        } finally {
          refreshing = false
        }
      }
      const stop = () => {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          if (listeners.size === 1) {
            void refresh()
            timer = setInterval(() => {
              void refresh()
            }, POLL_MS)
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        refresh,
        dispose: stop,
      }
    }

    // -------------------------------------------------------------------------
    // RPC：POST /api/noagent.rpc，body { op, ... }，返回 { ok, value|error }。
    // -------------------------------------------------------------------------
    async function callHost(payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!data || typeof data !== 'object') {
        throw new Error(`HTTP ${response.status}`)
      }
      if (data.ok !== true) {
        const error = data.error && typeof data.error === 'object' ? data.error : {}
        const failure = new Error(error.message || `HTTP ${response.status}`)
        failure.code = error.code
        throw failure
      }
      return data.value
    }

    // -------------------------------------------------------------------------
    // 样式：全部走宿主主题 token；不在注入清单里的 token 都带兜底，绝不写字面色值。
    // -------------------------------------------------------------------------
    const CSS = `
      .noagent-root { display: flex; flex-direction: column; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
      /* 滚动区里的每一块都按内容高度排，绝不参与 flex 收缩 ——
         否则内容一多，表格会被压扁到视口高，既不溢出也就没有滚动条。 */
      .noagent-scroll > * { flex: 0 0 auto; }

      /* 外层：撑满宿主给的高度。关键是一起写 overflow:hidden + min-height:0 ——
         只写 min-height:0 而不裁，内容是 flex 子项时父盒会被撑高，内层就没有可滚区域了。 */
      .noagent-page { display: flex; flex-direction: column; height: 100%; max-height: 100%; width: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; }
      /* 内层：真正滚动的那个盒子。显式 min-height:0 + flex:1，内容超了才出滚动条。 */
      .noagent-scroll { flex: 1 1 auto; min-height: 0; width: 100%; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 14px; padding: 24px; box-sizing: border-box; overscroll-behavior: contain; scrollbar-gutter: stable; }
      .noagent-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .noagent-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
      .noagent-intro { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; }

      .noagent-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; flex: 0 0 auto; }
      .noagent-stat { display: flex; flex: 1 1 0; min-width: 0; flex-direction: column; align-items: flex-start; gap: 2px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; text-align: left; cursor: default; }
      .noagent-stat[data-clickable="true"] { cursor: pointer; }
      .noagent-stat[data-clickable="true"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .noagent-stat-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
      .noagent-stat-value { font-size: 20px; font-weight: 600; line-height: 28px; font-variant-numeric: tabular-nums; }
      .noagent-stat-value[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
      .noagent-stat-value[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
      .noagent-stat[data-active="true"] { border-color: var(--dsw-alias-brand-primary); }

      .noagent-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .noagent-controls { position: sticky; top: -1px; z-index: 3; background: var(--dsw-alias-bg-base); padding: 12px 0; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .noagent-categories { display: flex; flex-wrap: wrap; gap: 6px; }
      .noagent-category { display: inline-flex; align-items: center; gap: 7px; }
      .noagent-category[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
      .noagent-category-count { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
      .noagent-select { width: auto; max-width: 100%; }
      .noagent-results, .noagent-pagination { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .noagent-results > :first-child, .noagent-pagination > :first-child { margin-right: auto; }
      .noagent-pagination { padding: 10px 0; }
      .noagent-table-wrap[data-compact="true"] .noagent-table td { padding-top: 6px; padding-bottom: 6px; }
      .noagent-table-wrap[data-compact="true"] .noagent-group-row > td { padding: 0; }
      .noagent-seg > button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      @media (max-width: 640px) {
        .noagent-scroll { padding: 12px; gap: 10px; }
        .noagent-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .noagent-search { flex-basis: 100%; min-width: 0; }
        .noagent-toolbar { gap: 6px; }
        .noagent-head { flex-wrap: wrap; }
        .noagent-controls { position: static; }
        .noagent-pagination > :first-child { flex-basis: 100%; }
      }
      .noagent-search { flex: 1 1 220px; min-width: 160px; }
      .noagent-toolbar .dp-input-wrap { flex: 1 1 220px; min-width: 160px; }
      .noagent-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); overflow: hidden; }
      .noagent-seg > button { font: inherit; font-size: 12px; cursor: pointer; padding: 4px 10px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); }
      .noagent-seg > button + button { border-left: 1px solid var(--dsw-alias-border-l2); }
      .noagent-seg > button[data-on="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 600; }
      .noagent-seg > button:hover { background: var(--dsw-alias-interactive-bg-hover); }

      /* 圆角裁切只作用在横向：overflow-y 必须是 visible，否则表格被裁成一张卡的高度，
         多出来的行既看不见也滚不到（0.4.2 的顶部没滚动条就是这个）。圆角改用 clip-path。 */
      .noagent-table-wrap { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); overflow-x: auto; overflow-y: visible; clip-path: inset(0 round var(--dsw-radius-lg)); }
      .noagent-table { width: 100%; min-width: 720px; border-collapse: collapse; table-layout: fixed; }
      .noagent-table th { text-align: left; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary); padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); white-space: nowrap; }
      .noagent-table td { padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
      .noagent-table tr:last-child td { border-bottom: 0; }
      .noagent-table tr[data-detail-row="true"] > td { background: var(--dsw-alias-bg-layer-2); }
      .noagent-table th[data-w="dot"], .noagent-table td[data-w="dot"] { width: 32px; padding-left: 12px; padding-right: 0; }
      .noagent-table th[data-w="sched"], .noagent-table td[data-w="sched"] { width: 168px; }
      .noagent-table th[data-w="time"], .noagent-table td[data-w="time"] { width: 200px; }
      .noagent-table th[data-w="actions"], .noagent-table td[data-w="actions"] { width: 180px; }

      .noagent-task { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
      .noagent-dot { display: block; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
      .noagent-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary); }
      .noagent-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary); }
      .noagent-dot[data-state="running"] { background: var(--dsw-alias-brand-primary); }
      .noagent-task-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .noagent-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .noagent-link { font: inherit; font-weight: 600; color: inherit; background: transparent; border: 0; padding: 0; cursor: pointer; text-align: left; }
      .noagent-link:hover { text-decoration: underline; }
      .noagent-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .noagent-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .noagent-badge { display: inline-block; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); vertical-align: 1px; }
      .noagent-badge[data-tone="off"] { color: var(--dsw-alias-state-warn-primary); }
      .noagent-badge[data-tone="err"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }

      .noagent-sched { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .noagent-sched-main { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .noagent-sched-sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .noagent-sched-sub[data-invalid="true"] { color: var(--dsw-alias-state-error-primary); }

      .noagent-runs { display: inline-flex; align-items: center; gap: 2px; vertical-align: middle; }
      .noagent-run { display: block; width: 5px; height: 12px; border: 0; padding: 0; border-radius: 1px; background: var(--dsw-alias-state-idle-primary); cursor: pointer; opacity: 0.45; }
      .noagent-run[data-ok="true"] { background: var(--dsw-alias-state-success-primary); opacity: 0.85; }
      .noagent-run[data-ok="false"] { background: var(--dsw-alias-state-error-primary); opacity: 0.95; }
      .noagent-run:hover { opacity: 1; }
      .noagent-norun { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

      .noagent-actions { display: flex; gap: 6px; align-items: center; }
      .noagent-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer; }
      .noagent-button:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover); }
      .noagent-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .noagent-button[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
      .noagent-button[data-primary="true"]:hover:not([disabled]) { background: var(--dsw-alias-button-primary-hover); }
      .noagent-button[data-danger="true"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .noagent-button[data-inline="true"] { border: 0; padding: 0 4px; color: var(--dsw-alias-label-secondary); }
      .noagent-button[disabled] { cursor: not-allowed; opacity: 0.4; }
      .noagent-table .noagent-button[data-primary="true"] { background: transparent; border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
      .noagent-table .noagent-button[data-primary="true"]:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover); }

      .noagent-switch { position: relative; display: inline-block; width: 30px; height: 18px; flex: 0 0 auto; border: 0; padding: 0; cursor: pointer; border-radius: 9px; background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
      .noagent-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 120ms ease; }
      .noagent-switch[data-on="true"] { background: var(--dsw-alias-state-success-primary); }
      .noagent-switch[data-on="true"]::after { transform: translateX(12px); }
      .noagent-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
      .noagent-switch[disabled] { cursor: default; opacity: 0.55; }

      .noagent-detail { display: flex; flex-direction: column; gap: 10px; }
      .noagent-detail-row { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; align-items: baseline; }
      .noagent-detail-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .noagent-detail-value { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
      .noagent-pre { margin: 0; max-height: 160px; overflow: auto; padding: 8px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; }
      .noagent-notice { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .noagent-notice[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
      .noagent-notice[data-state="ok"] { color: var(--dsw-alias-state-success-primary); }

      .noagent-form { display: flex; flex-direction: column; gap: 10px; }
      .noagent-form-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; align-items: start; }
      .noagent-form-label { color: var(--dsw-alias-label-secondary); font-size: 12px; padding-top: 5px; }
      .noagent-input { box-sizing: border-box; font: inherit; font-size: 14px; line-height: 22px; height: 32px; padding: 0 8px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .noagent-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
      .noagent-input::placeholder { color: var(--dsw-alias-label-dimmed); }
      .noagent-input[rows] { height: auto; padding: 6px 8px; line-height: 20px; }
      .noagent-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
      .noagent-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
      .noagent-input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
      textarea.noagent-input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; min-height: 64px; resize: vertical; }
      .noagent-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .noagent-form-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .noagent-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .noagent-hint[data-invalid="true"] { color: var(--dsw-alias-state-error-primary); }

      .noagent-empty { margin: 0; padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; }

      /* 分组标题行：粘在表头下面，滚很长的列表时也知道自己在哪一组。 */
      .noagent-group-row > td { padding: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .noagent-group-row:hover > td { background: transparent; }
      .noagent-group-head { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; text-align: left; cursor: pointer; border: 0; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); padding: 6px 12px; }
      .noagent-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .noagent-group-head:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
      .noagent-group-caret { width: 10px; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
      .noagent-group-name { font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
      .noagent-group-count { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
      .noagent-group-head .noagent-badge { margin-left: auto; }

      .noagent-drawer-mask { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: flex-end; background: var(--dsw-alias-bg-mask-2, transparent); }
      .noagent-drawer { width: min(760px, 92vw); height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: var(--dsw-shadow-lv3, none); }
      .noagent-drawer-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .noagent-drawer-title { margin: 0; font-size: 15px; font-weight: 600; }
      .noagent-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
      .noagent-drawer-pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); }
    `

    function StyleTag() {
      return h(
        React.Fragment,
        null,
        h('style', { key: 'noagent-style' }, UI.CSS + '\n' + CSS),
      )
    }

    /** 侧边栏图标：只画图标，点击切换由外壳按 id 处理。 */
    function PanelIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M12 7.5v5l3.2 1.9' }),
      )
    }

    const DOT_STATE = { ok: 'done', error: 'error', running: 'ongoing', idle: 'idle' }

    function Switch({ checked, disabled, onChange, label }) {
      return h(UI.Switch, {
        checked,
        disabled: disabled === true,
        'aria-label': label,
        onChange: () => onChange(),
      })
    }

    /** 总览卡：四个数字；启用 / 异常卡可点击，等于切到对应筛选。 */
    function StatsBar({ t, jobs, now, filter, onPickFilter }) {
      const summary = summarize(jobs, now)
      const cards = [
        { key: 'total', label: t('statTotal'), value: summary.total, tone: null, pick: null },
        { key: 'enabled', label: t('statEnabled'), value: summary.enabled, tone: 'success', pick: 'enabled' },
        { key: 'today', label: t('statDueToday'), value: summary.ranToday, tone: null, pick: null },
        { key: 'failed', label: t('statFailed'), value: summary.failed24h, tone: summary.failed24h > 0 ? 'error' : null, pick: 'failing' },
      ]
      return h(
        'div',
        { className: 'noagent-stats' },
        cards.map((card) =>
          h(
            'button',
            {
              key: card.key,
              type: 'button',
              className: 'noagent-stat',
              'data-clickable': card.pick ? 'true' : 'false',
              'data-active': card.pick && filter === card.pick ? 'true' : 'false',
              onClick: card.pick ? () => onPickFilter(card.pick) : undefined,
            },
            h('span', { className: 'noagent-stat-label' }, card.label),
            h('span', { className: 'noagent-stat-value', 'data-tone': card.tone ?? undefined }, String(card.value)),
          ),
        ),
      )
    }

    /** 最近几次运行：一条一根小竖条，绿=成功、红=失败，点开看那一次的日志。 */
    function RunsStrip({ t, job, onPick }) {
      const recent = Array.isArray(job.recent) ? job.recent : []
      if (recent.length === 0) return h('span', { className: 'noagent-norun' }, '—')
      return h(
        'div',
        { className: 'noagent-runs', title: t('runsCompact', { n: recent.length }) },
        recent.map((run, index) =>
          h('button', {
            key: `${run.startedAt ?? index}-${index}`,
            type: 'button',
            className: 'noagent-run',
            'data-ok': run.ok ? 'true' : 'false',
            title: `${run.startedAt ?? ''} · ${t('exitCode', { code: run.exitCode === null ? '—' : run.exitCode })} · ${humanDuration(run.durationMs)}`,
            onClick: () => onPick(job, run),
          }),
        ),
      )
    }

    function ScheduleCell({ t, lang, job }) {
      const schedule = scheduleText(job.schedule, lang)
      const sub = job.schedule && job.schedule.kind === 'cron' ? job.schedule.cron : t('colSchedule')
      return h(
        'div',
        { className: 'noagent-sched' },
        h(
          'span',
          { className: 'noagent-sched-main', title: job.schedule && job.schedule.kind === 'cron' ? job.schedule.cron : '' },
          schedule.text || '—',
          job.watch
            ? h(UI.Tag, { tone: 'info', style: { marginLeft: 6 }, title: t('watchHint') }, t('watchBadge'))
            : null,
        ),
        h(
          'span',
          { className: 'noagent-sched-sub', 'data-invalid': schedule.invalid ? 'true' : 'false' },
          schedule.invalid ? t('invalidCron') : sub,
        ),
      )
    }

    /** 上次 / 下次：两行；第二行右侧跟一组「最近几次」的小竖条。 */
    function TimingCell({ t, lang, job, now, onPick }) {
      const last = job.last
      const lastText = last && last.startedAt
        ? humanTime(Date.parse(last.startedAt), lang, job.timeZone, now)
        : t('never')
      const nextText = job.enabled && Number.isFinite(job.nextRunAt)
        ? humanTime(job.nextRunAt, lang, job.timeZone, now)
        : job.enabled
          ? '—'
          : t('disabled')
      const result =
        last && last.ok === false
          ? h(UI.Tag, { tone: 'danger', style: { marginLeft: 6 } },
              last.timedOut ? t('timeout') : t('exitCode', { code: last.exitCode === null ? '—' : last.exitCode }))
          : null
      return h(
        'div',
        { className: 'noagent-sched' },
        h('span', { className: 'noagent-sched-main' }, h('span', { className: 'noagent-hint', style: { marginRight: 4 } }, t('lastRun')), lastText, result),
        h(
          'span',
          { className: 'noagent-sched-sub', style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', { style: { marginRight: 4 } }, t('nextRun')),
          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, nextText),
          h(RunsStrip, { t, job, onPick }),
        ),
      )
    }

    /** 展开行：命令 + 编辑表单 + 启停 / 运行 / 日志 / 删除。 */
    function JobDetail({ t, lang, job, actions }) {
      const [editing, setEditing] = React.useState(false)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const initialMode = job.schedule && job.schedule.kind === 'every' ? 'every' : 'cron'
      const [form, setForm] = React.useState({
        name: job.name ?? '',
        mode: initialMode,
        cron: initialMode === 'cron' ? job.schedule.cron : '',
        everySeconds: initialMode === 'every' ? String(job.schedule.everySeconds) : '60',
        timeoutSeconds: String(job.timeoutSeconds ?? 300),
        command: job.command ?? '',
      })
      const [errors, setErrors] = React.useState({})
      const schedule = scheduleText(job.schedule, lang)

      const run = async (fn, okText, failText) => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
          if (okText) setNotice({ state: 'ok', text: okText })
        } catch (error) {
          setNotice({
            state: 'error',
            text: `${failText} ${error instanceof Error ? error.message : String(error)}`,
          })
        } finally {
          setBusy(false)
        }
      }

      const submit = async () => {
        const next = validateForm(form)
        setErrors(next)
        if (Object.keys(next).length > 0) {
          setNotice({ state: 'error', text: t('formInvalid') })
          return
        }
        await run(
          async () => {
            await actions.saveJob(job.id, {
              name: form.name,
              mode: form.mode,
              cron: form.cron,
              everySeconds: Number(form.everySeconds),
              timeoutSeconds: Number(form.timeoutSeconds),
              command: form.command,
            })
            setEditing(false)
          },
          t('saved'),
          t('saveFailed'),
        )
      }

      const preview = editing
        ? form.mode === 'cron'
          ? scheduleText({ kind: 'cron', cron: form.cron }, lang)
          : scheduleText({ kind: 'every', everySeconds: Number(form.everySeconds) }, lang)
        : null

      const detailRow = (label, value) =>
        h(
          'div',
          { className: 'noagent-detail-row' },
          h('span', { className: 'noagent-detail-label' }, label),
          h('span', { className: 'noagent-detail-value' }, value),
        )

      const formRow = (label, control, hint, invalid) =>
        h(
          'div',
          { className: 'noagent-form-row' },
          h('span', { className: 'noagent-form-label' }, label),
          h(
            'div',
            null,
            control,
            hint
              ? h('span', {
                  className: 'noagent-hint',
                  'data-invalid': invalid ? 'true' : 'false',
                  style: { display: 'block', marginTop: 2 },
                }, hint)
              : null,
          ),
        )

      if (editing) {
        return h(
          'div',
          { className: 'noagent-detail' },
          h(
            'div',
            { className: 'noagent-form' },
            formRow(t('fieldName'), h('input', {
              className: 'noagent-input',
              value: form.name,
              onChange: (event) => setForm({ ...form, name: event.target.value }),
            })),
            formRow(t('fieldMode'), h(UI.SegmentedTabs, {
              tabs: ['cron', 'every'].map((key) => ({
                value: key,
                label: key === 'cron' ? t('modeCron') : t('modeEvery'),
              })),
              value: form.mode,
              onChange: (key) => setForm({ ...form, mode: key }),
            })),
            form.mode === 'cron'
              ? formRow(
                  t('fieldCron'),
                  h('input', {
                    className: 'noagent-input noagent-mono',
                    'data-invalid': errors.cron ? 'true' : 'false',
                    value: form.cron,
                    placeholder: '30 18 * * *',
                    onChange: (event) => setForm({ ...form, cron: event.target.value }),
                  }),
                  preview && !preview.invalid ? preview.text : t('invalidCron'),
                  errors.cron === true,
                )
              : formRow(
                  t('fieldEvery'),
                  h('input', {
                    className: 'noagent-input',
                    'data-invalid': errors.everySeconds ? 'true' : 'false',
                    value: form.everySeconds,
                    inputMode: 'numeric',
                    onChange: (event) => setForm({ ...form, everySeconds: event.target.value }),
                  }),
                  preview && !preview.invalid ? preview.text : t('invalidCron'),
                  errors.everySeconds === true,
                ),
            formRow(t('fieldTimeout'), h('input', {
              className: 'noagent-input',
              'data-invalid': errors.timeoutSeconds ? 'true' : 'false',
              value: form.timeoutSeconds,
              inputMode: 'numeric',
              onChange: (event) => setForm({ ...form, timeoutSeconds: event.target.value }),
            })),
            formRow(
              t('fieldCommand'),
              h('textarea', {
                className: 'noagent-input',
                'data-invalid': errors.command ? 'true' : 'false',
                value: form.command,
                rows: 3,
                onChange: (event) => setForm({ ...form, command: event.target.value }),
              }),
              `${t('timeZone')}: ${job.timeZone} · ${t('jobId')} ${job.id}`,
              errors.command === true,
            ),
            h(
              'div',
              { className: 'noagent-form-actions' },
              h('button', {
                type: 'button',
                className: 'noagent-button',
                'data-primary': 'true',
                disabled: busy,
                onClick: submit,
              }, busy ? t('saving') : t('save')),
              h('button', {
                type: 'button',
                className: 'noagent-button',
                disabled: busy,
                onClick: () => {
                  setEditing(false)
                  setErrors({})
                  setNotice(null)
                },
              }, t('cancel')),
              notice ? h('span', { className: 'noagent-notice', 'data-state': notice.state }, notice.text) : null,
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'noagent-detail' },
        detailRow(t('command'), h('code', { className: 'noagent-pre', style: { display: 'block' } }, job.command || '—')),
        detailRow(
          t('colSchedule'),
          schedule.invalid
            ? `${t('invalidCron')} · ${job.schedule ? job.schedule.cron : ''}`
            : `${schedule.text}${job.schedule && job.schedule.kind === 'cron' ? ` · ${t('cron', { expression: job.schedule.cron })}` : ''}`,
        ),
        detailRow(t('timeZone'), `${job.timeZone} · ${t('fieldTimeout')} ${job.timeoutSeconds}s`),
        job.watch && job.wakeSessionId
          ? detailRow(t('watchBadge'), `${t('watchHint')} · ${job.wakeSessionId}`)
          : null,
        h(
          'div',
          { className: 'noagent-form-actions' },
          h('button', {
            type: 'button',
            className: 'noagent-button',
            'data-primary': 'true',
            disabled: busy || job.running,
            onClick: () => run(() => actions.runNow(job.id), t('runAccepted'), t('runFailed')),
          }, job.running ? t('running') : t('runNow')),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            disabled: busy,
            onClick: () => actions.openLog(job, null),
          }, t('viewLog')),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            disabled: busy,
            onClick: () => {
              setNotice(null)
              setEditing(true)
            },
          }, t('edit')),
          h('span', { className: 'noagent-inline' },
            h(Switch, {
              checked: job.enabled,
              disabled: busy,
              label: job.enabled ? t('enabled') : t('disabled'),
              onChange: () => {
                void run(() => actions.toggle(job.id, !job.enabled), null, t('toggleFailed'))
              },
            }),
            h('span', { className: 'noagent-hint' }, job.enabled ? t('enabled') : t('disabled')),
          ),
          confirmDelete
            ? h('span', { className: 'noagent-inline' },
                h('span', { className: 'noagent-hint' }, t('deleteConfirm')),
                h('button', {
                  type: 'button',
                  className: 'noagent-button',
                  'data-danger': 'true',
                  disabled: busy,
                  onClick: () => {
                    void run(() => actions.deleteJob(job.id), t('deleteDone'), t('deleteFailed'))
                  },
                }, t('deleteYes')),
                h('button', {
                  type: 'button',
                  className: 'noagent-button',
                  disabled: busy,
                  onClick: () => setConfirmDelete(false),
                }, t('cancel')),
              )
            : h('button', {
                type: 'button',
                className: 'noagent-button',
                'data-danger': 'true',
                disabled: busy,
                onClick: () => setConfirmDelete(true),
              }, t('deleteJob')),
          notice ? h('span', { className: 'noagent-notice', 'data-state': notice.state }, notice.text) : null,
        ),
      )
    }

    function JobTable({ t, lang, jobs, groups, collapsed, onToggleGroup, now, actions, openId, setOpenId, openLog, compact }) {
      // groups 为 null 时走原来的平铺渲染；给了 groups 就在表内插入分组标题行，
      // 标题行同样占满 5 列，所以不会和表体错位。
      const rowFor = (job) => {
        const open = openId === job.id
        const rows = [
          h(
            'tr',
            { key: job.id, 'data-open': open ? 'true' : 'false' },
            h('td', { 'data-w': 'dot' }, h(UI.StateDot, { state: DOT_STATE[stateOf(job)] ?? 'idle' })),
            h(
              'td',
              null,
              h(
                'div',
                { className: 'noagent-task' },
                h(
                  'div',
                  { className: 'noagent-task-main' },
                  h(
                    'span',
                    { className: 'noagent-name', title: job.name || job.id },
                    h('button', {
                      type: 'button',
                      className: 'noagent-link',
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: () => setOpenId(open ? null : job.id),
                    }, job.name || job.id),
                    job.enabled
                      ? null
                      : h(UI.Tag, { tone: 'warning', style: { marginLeft: 6 } }, t('disabled')),
                  ),
                  h('span', { className: 'noagent-meta noagent-mono', title: job.command || '' }, describePayload(job.command)),
                ),
              ),
            ),
            h('td', { 'data-w': 'sched' }, h(ScheduleCell, { t, lang, job })),
            h('td', { 'data-w': 'time' }, h(TimingCell, { t, lang, job, now, onPick: openLog })),
            h(
              'td',
              { 'data-w': 'actions' },
              h(
                'div',
                { className: 'noagent-actions' },
                h(Switch, {
                  checked: job.enabled,
                  label: job.enabled ? t('enabled') : t('disabled'),
                  onChange: () => {
                    void actions.toggle(job.id, !job.enabled)
                  },
                }),
                h('button', {
                  type: 'button',
                  className: 'noagent-button',
                  'data-primary': 'true',
                  disabled: job.running,
                  onClick: () => {
                    void actions.runNow(job.id)
                  },
                }, job.running ? t('running') : t('runNow')),
                h('button', {
                  type: 'button',
                  className: 'noagent-button',
                  onClick: () => openLog(job, null),
                }, t('viewLog')),
                h('button', {
                  type: 'button',
                  className: 'noagent-button',
                  'data-inline': 'true',
                  onClick: () => setOpenId(open ? null : job.id),
                }, open ? '▴' : '▾'),
              ),
            ),
          ),
        ]
        if (open) {
          rows.push(
            h(
              'tr',
              { key: `${job.id}-detail`, 'data-detail-row': 'true' },
              h('td', { colSpan: 5 }, h(JobDetail, { t, lang, job, actions: { ...actions, openLog } })),
            ),
          )
        }
        return rows
      }

      const body = groups
        ? groups.flatMap((group) => {
            const isCollapsed = collapsed.has(group.key)
            const head = h(
              'tr',
              { key: `group-${group.key}`, className: 'noagent-group-row' },
              h(
                'td',
                { colSpan: 5 },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'noagent-group-head',
                    'aria-expanded': isCollapsed ? 'false' : 'true',
                    onClick: () => onToggleGroup(group.key),
                  },
                  h('span', { className: 'noagent-group-caret' }, isCollapsed ? '▸' : '▾'),
                  h('span', { className: 'noagent-group-name' }, group.label),
                  h('span', { className: 'noagent-group-count' }, t('groupCount', { n: group.jobs.length })),
                  group.alertCount > 0
                    ? h(UI.Tag, { tone: 'danger' },
                        t('groupAlerts', { n: group.alertCount }))
                    : null,
                ),
              ),
            )
            return isCollapsed ? [head] : [head, ...group.jobs.flatMap(rowFor)]
          })
        : jobs.flatMap(rowFor)

      return h(
        'div',
        { className: 'noagent-table-wrap', 'data-compact': compact ? 'true' : 'false' },
        h(
          'table',
          { className: 'noagent-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { 'data-w': 'dot', 'aria-label': t('colTask') }, ''),
              h('th', null, t('colTask')),
              h('th', { 'data-w': 'sched' }, t('colSchedule')),
              h('th', { 'data-w': 'time' }, `${t('lastRun')} / ${t('nextRun')}`),
              h('th', { 'data-w': 'actions' }, t('colActions')),
            ),
          ),
          h('tbody', null, body),
        ),
      )
    }

    /** 日志抽屉：点最近结果里的某一格看那一次，点「日志」按钮看最近一次。 */
    function LogDrawer({ t, lang, target, onClose }) {
      const [log, setLog] = React.useState(null)
      const [error, setError] = React.useState(null)
      const job = target.job
      const run = target.run
      const loadLog = target.loadLog
      const runAt = run ? run.startedAt : undefined

      React.useEffect(() => {
        let alive = true
        setLog(null)
        setError(null)
        Promise.resolve(loadLog(job.id, runAt))
          .then((value) => {
            if (alive) setLog(value)
          })
          .catch((failure) => {
            if (alive) setError(failure instanceof Error ? failure.message : String(failure))
          })
        return () => {
          alive = false
        }
      }, [job.id, runAt])

      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      const header = run && run.startedAt
        ? t('logFor', { time: humanTime(Date.parse(run.startedAt), lang, job.timeZone, Date.now()) })
        : t('latestRun')
      const meta = `${header}${log && log.file ? ' · ' + log.file : ''}${log && log.truncated ? ' · ' + t('logTruncated') : ''}`
      return h(
        'div',
        {
          className: 'noagent-drawer-mask',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'noagent-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('logTitle') },
          h(
            'div',
            { className: 'noagent-drawer-head' },
            h(
              'div',
              { style: { minWidth: 0, flex: 1 } },
              h('h3', { className: 'noagent-drawer-title' }, `${t('logTitle')} · ${job.name || job.id}`),
              h('span', { className: 'noagent-meta', style: { display: 'block' } }, meta),
            ),
            h('button', { type: 'button', className: 'noagent-button', onClick: onClose }, t('closeLog')),
          ),
          h(
            'div',
            { className: 'noagent-drawer-body' },
            error
              ? h('span', { className: 'noagent-notice', 'data-state': 'error' }, `${t('logFailed')} ${error}`)
              : log === null
                ? h('p', { className: 'noagent-empty' }, t('loading'))
                : h('pre', { className: 'noagent-drawer-pre' }, log.text || t('noLog')),
          ),
        ),
      )
    }

    function JobsView(props) {
      const t = props.t
      const lang = props.lang
      const status = props.status
      // 注入面把动作同时放在顶层和 actions 里；这里两者都认，缺字段时也不炸。
      const actions = props.actions ?? props
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [category, setCategory] = React.useState('')
      const [sort, setSort] = React.useState('attention')
      const [page, setPage] = React.useState(1)
      const [pageSize, setPageSize] = React.useState(15)
      const [compact, setCompact] = React.useState(true)
      const [openId, setOpenId] = React.useState(null)
      const [logTarget, setLogTarget] = React.useState(null)
      // 默认按分类分组：任务多到 40+ 之后，平铺一张表找不到东西。
      const [grouped, setGrouped] = React.useState(false)
      // 折叠状态默认全展开；只记被收起的 key，新增分组自动是展开的。
      const [collapsed, setCollapsed] = React.useState(() => new Set())
      const toggleGroup = (key) => {
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      // 空态 / 错误态也走同一个滚动区，保证任何状态下结构一致。
      const only = (text) => h(UI.EmptyState, null, text)
      if (status.kind === 'loading' && status.jobs.length === 0) return only(t('loading'))
      if (status.kind === 'error') return only(`${t('loadFailed')} ${status.error || ''}`)
      if (status.jobs.length === 0) return only(t('empty'))

      const now = status.now ?? Date.now()
      const visible = sortJobs(filterJobs(status.jobs, filter, query, category), sort)
      const allGroups = buildGroups(status.jobs, t)
      const matchedGroups = grouped ? buildGroups(visible, t) : null
      const ordered = matchedGroups ? matchedGroups.flatMap((group) => group.jobs) : visible
      const pagination = paginateJobs(ordered, page, pageSize)
      const pageIds = new Set(pagination.jobs.map((job) => job.id))
      const groups = matchedGroups
        ? matchedGroups.map((group) => {
            const jobs = group.jobs.filter((job) => pageIds.has(job.id))
            return { ...group, jobs, alertCount: jobs.filter((job) => job.enabled && job.last?.ok === false).length }
          }).filter((group) => group.jobs.length)
        : null
      const change = (setter, value) => { setter(value); setPage(1); setCollapsed(new Set()) }
      const reset = () => { setFilter('all'); setQuery(''); setCategory(''); setPage(1); setCollapsed(new Set()) }
      const filters = [
        { key: 'all', label: t('filterAll') },
        { key: 'enabled', label: t('filterEnabled') },
        { key: 'disabled', label: t('filterDisabled') },
        { key: 'failing', label: t('filterFailing') },
        { key: 'running', label: t('running') },
      ]
      const openLog = (job, run) => setLogTarget({ job, run, loadLog: actions.loadLog })

      return h(
        React.Fragment,
        null,
        h(StatsBar, {
          t,
          jobs: status.jobs,
          now,
          filter,
          onPickFilter: (key) => { reset(); setFilter(key === filter ? 'all' : key) },
        }),
        h('div', { className: 'noagent-controls' },
        h('nav', { className: 'noagent-categories', 'aria-label': t('categories') },
          [{ key: '', label: t('allCategories'), jobs: status.jobs }, ...allGroups].map((group) =>
            h(UI.Pill, {
              key: group.key,
              active: category === group.key,
              onClick: () => change(setCategory, group.key),
            }, group.label, h('span', { className: 'noagent-category-count' }, String(group.jobs.length))),
          ),
        ),
        h(
          'div',
          { className: 'noagent-toolbar' },
          h(UI.SearchInput, {
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            value: query,
            onChange: (value) => change(setQuery, value),
          }),
          h(UI.SegmentedTabs, {
            tabs: filters.map((item) => ({ value: item.key, label: item.label })),
            value: filter,
            onChange: (key) => change(setFilter, key),
            ariaLabel: t('categories'),
          }),
          h('select', {
            className: 'noagent-input noagent-select', 'aria-label': t('sortLabel'),
            value: sort, onChange: (event) => change(setSort, event.target.value),
          }, ['attention', 'name', 'next', 'recent'].map((key) =>
            h('option', { key, value: key }, t({ attention: 'sortAttention', name: 'sortName', next: 'sortNext', recent: 'sortRecent' }[key])))),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            'data-primary': grouped ? 'true' : 'false',
            'aria-pressed': grouped ? 'true' : 'false',
            onClick: () => change(setGrouped, !grouped),
          }, t('groupBy')),
          h('button', {
            type: 'button', className: 'noagent-button', 'aria-pressed': compact ? 'true' : 'false',
            onClick: () => setCompact((value) => !value),
          }, t('compact')),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            onClick: () => {
              void actions.refresh()
            },
          }, t('refresh')),
        ),
        h('div', { className: 'noagent-results' },
          h('span', { className: 'noagent-meta', role: 'status' }, t('resultCount', { n: visible.length, total: status.jobs.length })),
          grouped ? h('button', { type: 'button', className: 'noagent-button',
            onClick: () => setCollapsed(new Set(matchedGroups.map((group) => group.key))),
          }, t('collapseAll')) : null,
          grouped ? h('button', { type: 'button', className: 'noagent-button',
            onClick: () => setCollapsed(new Set()),
          }, t('expandAll')) : null,
          query || category || filter !== 'all'
            ? h('button', { type: 'button', className: 'noagent-button', onClick: reset }, t('resetFilters')) : null,
        )),
        visible.length === 0
          ? h('div', { className: 'noagent-table-wrap' }, h(UI.EmptyState, null, t('emptyFiltered')))
          : h(JobTable, {
              t,
              lang,
              jobs: pagination.jobs,
              compact,
              groups,
              collapsed,
              onToggleGroup: toggleGroup,
              now,
              actions,
              openId,
              setOpenId,
              openLog,
            }),
        h('div', { className: 'noagent-pagination', 'aria-label': t('pageSize') },
          h('span', { className: 'noagent-meta', role: 'status' }, t('pageInfo', pagination)),
          h('select', { className: 'noagent-input noagent-select', 'aria-label': t('pageSize'),
            value: pageSize, onChange: (event) => change(setPageSize, Number(event.target.value)),
          }, [15, 30, 50].map((size) => h('option', { key: size, value: size }, String(size)))),
          h('button', { type: 'button', className: 'noagent-button', disabled: pagination.page <= 1,
            onClick: () => setPage(pagination.page - 1),
          }, t('previousPage')),
          h('button', { type: 'button', className: 'noagent-button', disabled: pagination.page >= pagination.pages,
            onClick: () => setPage(pagination.page + 1),
          }, t('nextPage')),
        ),
        logTarget ? h(LogDrawer, { t, lang, target: logTarget, onClose: () => setLogTarget(null) }) : null,
      )
    }

    /** 侧边栏点开后占据中央面板的一页：标题固定，下面的内容自己滚。 */
    function PanelPage(props) {
      const status = props.useStatus((value) => value)
      return h(
        'div',
        { className: 'noagent-root noagent-page' },
        h(StyleTag),
        h(
          'div',
          { className: 'noagent-scroll' },
          h(
            'div',
            { className: 'noagent-head' },
            h(
              'div',
              null,
              h('h2', { className: 'noagent-title' }, props.t('title')),
              h('p', { className: 'noagent-intro' }, props.t('intro')),
            ),
            h(
              'span',
              { className: 'noagent-meta' },
              status.updatedAt
                ? props.t('updated', { time: humanTime(Date.parse(status.updatedAt), props.lang, 'Asia/Shanghai', Date.now()) })
                : '',
            ),
          ),
          h(JobsView, { ...props, status }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      // 纯函数导出给单元测试用；运行时没人依赖这个字段。
      utils: {
        describeCron,
        describeEvery,
        scheduleText,
        humanTime,
        humanDuration,
        summarize,
        filterJobs,
        sortJobs,
        paginateJobs,
        buildGroups,
        validateForm,
        stateOf,
        shortenCommand,
        describePayload,
      },
      apply(ctx) {
        const localeApi = ctx.locale
        const t = localeApi.bind(NS)
        ctx.effect(() => localeApi.register(NS, { zh, en }), 'noagent-schedule: dictionaries')

        // 计划里的人话按当前 locale 选中文/英文。
        const readLang = () => {
          try {
            const snapshot = typeof localeApi.getSnapshot === 'function' ? localeApi.getSnapshot() : null
            const id = snapshot && (snapshot.locale ?? snapshot.id ?? snapshot.current)
            return typeof id === 'string' && id.toLowerCase().startsWith('en') ? 'en' : 'zh'
          } catch {
            return 'zh'
          }
        }

        const store = createStatusStore(callHost)
        ctx.effect(() => () => store.dispose(), 'noagent-schedule: status store')

        const runNow = async (id) => {
          const value = await callHost({ op: 'run', id, wait: false })
          await store.refresh()
          return value
        }
        const toggle = async (id, enabled) => {
          await callHost({ op: 'toggle', id, enabled: enabled === true })
          await store.refresh()
        }
        const saveJob = async (id, form) => {
          const patch = {
            name: form.name,
            timeoutSeconds: Number(form.timeoutSeconds),
            command: form.command,
          }
          if (form.mode === 'every') {
            patch.mode = 'every'
            patch.everySeconds = Number(form.everySeconds)
          } else {
            patch.mode = 'cron'
            patch.cron = form.cron
          }
          await callHost({ op: 'update', id, patch })
          await store.refresh()
        }
        const deleteJob = async (id) => {
          await callHost({ op: 'delete', id })
          await store.refresh()
        }
        const loadLog = (id, at) => callHost({ op: 'log', id, at })
        const actions = { runNow, toggle, saveJob, deleteJob, loadLog, refresh: store.refresh }

        const face = () => ({
          lang: readLang(),
          hooks: { status: store },
          refresh: store.refresh,
          ...actions,
          actions,
        })

        // 侧边栏条目：只画图标；点击后的选中/切换由外壳按 id 处理。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('panel'),
        }, PanelIcon))

        // 中央面板：key 必须等于侧边栏条目的 id。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: face,
        }, PanelPage))
      },
    }
  },
})
