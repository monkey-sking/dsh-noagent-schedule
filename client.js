/**
 * dsh-noagent-schedule — 浏览器半（设置页 + 侧边栏面板）
 *
 * 结构照 templates/decoration/client.js：window.__ModuleLoader__.load({ id, factory })，
 * id 必须等于包名。纯 JS，无 TS、无构建步骤。
 *
 * 数据通道：Host 侧用 ctx.connection.fetch 注册了精确路由 `/api/noagent.rpc`。
 * Connection 的 `/api` 前缀处理器先做 Host/Origin 围栏 + 签名 Cookie 鉴权，再把
 * 请求交给我们的 fetch。这里用**相对路径** `api/noagent.rpc` 请求，与内置
 * dsh-session-log-export 的写法一致，因此在带 mount 前缀的部署下也能命中。
 * 不猜 API：见交付说明里附的 inspect / 源码证据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-noagent-schedule',
  factory(require) {
    const React = require('react')
    const h = React.createElement

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
      nav: 'Scheduled scripts',
      panel: 'Scheduled scripts',
      title: 'Scheduled scripts',
      intro:
        'Scripts this Host runs on a schedule without calling the model. Run one now or read its last log.',
      loading: 'Loading…',
      empty: 'No scheduled scripts are configured.',
      refresh: 'Refresh',
      runNow: 'Run now',
      running: 'Running…',
      viewLog: 'View last log',
      hideLog: 'Hide log',
      lastRun: 'Last run',
      schedule: 'Schedule',
      never: 'Never ran',
      exitCode: 'exit {code}',
      timeout: 'timed out',
      enabled: 'enabled',
      disabled: 'disabled',
      everySeconds: 'every {n}s',
      cron: 'cron {expression}',
      timeZone: 'time zone',
      updated: 'Updated {time}',
      command: 'Command',
      logTitle: 'Last run log',
      logTruncated: 'Showing the tail of a larger log.',
      noLog: 'No run log recorded yet.',
      runAccepted: 'Run started.',
      runFailed: 'Could not start the run.',
      logFailed: 'Could not read the log.',
      loadFailed: 'Could not load scheduled scripts.',
      jobId: 'ID',
    }

    const zh = {
      nav: '定时脚本',
      panel: '定时脚本',
      title: '定时脚本',
      intro: '宿主按计划直接运行、不经过模型的脚本。可立即运行一次，或查看最近一次日志。',
      loading: '加载中…',
      empty: '还没有配置任何定时脚本。',
      refresh: '刷新',
      runNow: '立即运行一次',
      running: '运行中…',
      viewLog: '查看最近日志',
      hideLog: '收起日志',
      lastRun: '上次运行',
      schedule: '计划',
      never: '从未运行',
      exitCode: '退出码 {code}',
      timeout: '已超时',
      enabled: '已启用',
      disabled: '已停用',
      everySeconds: '每 {n} 秒',
      cron: 'cron {expression}',
      timeZone: '时区',
      updated: '更新于 {time}',
      command: '命令',
      logTitle: '最近一次日志',
      logTruncated: '日志较大，只显示尾部。',
      noLog: '还没有运行日志。',
      runAccepted: '已开始运行。',
      runFailed: '无法启动这次运行。',
      logFailed: '无法读取日志。',
      loadFailed: '无法加载定时脚本。',
      jobId: 'ID',
    }

    // -------------------------------------------------------------------------
    // 极小的快照 store：不依赖宿主 store 服务，getSnapshot 保持引用稳定。
    // -------------------------------------------------------------------------
    function createStatusStore(call) {
      let state = { kind: 'loading', jobs: [], updatedAt: null, error: null }
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
    // 展示辅助
    // -------------------------------------------------------------------------
    const formatTime = (iso) => {
      if (!iso) return ''
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString()
    }

    const formatDuration = (ms) => {
      if (!Number.isFinite(ms)) return ''
      return `${(ms / 1000).toFixed(1)}s`
    }

    /** 样式全部走宿主主题 token；不使用字面色值。 */
    const CSS = `
      .noagent-root { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
      .noagent-page { padding: 24px; height: 100%; box-sizing: border-box; overflow: auto; }
      .noagent-section { max-width: 760px; }
      .noagent-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .noagent-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
      .noagent-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
      .noagent-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .noagent-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
      .noagent-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-2); }
      .noagent-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .noagent-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
      .noagent-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary); }
      .noagent-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary); }
      .noagent-dot[data-state="running"] { background: var(--dsw-alias-state-business-primary); }
      .noagent-name { font-size: 14px; font-weight: 600; }
      .noagent-badge { font-size: 11px; padding: 1px 6px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); }
      .noagent-badge[data-off="true"] { color: var(--dsw-alias-state-warn-label); }
      .noagent-rows { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .noagent-rows dt { color: var(--dsw-alias-label-tertiary); }
      .noagent-rows dd { margin: 0; }
      .noagent-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .noagent-button { font: inherit; font-size: 12px; cursor: pointer; padding: 4px 10px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-primary); }
      .noagent-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .noagent-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .noagent-button[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); }
      .noagent-button[data-primary="true"]:hover { background: var(--dsw-alias-button-primary-hover); }
      .noagent-button[disabled] { cursor: default; opacity: 0.55; }
      .noagent-notice { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .noagent-notice[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
      .noagent-log { margin: 0; max-height: 320px; overflow: auto; padding: 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-l1); border: 1px solid var(--dsw-alias-border-l2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; }
      .noagent-empty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
    `

    function StyleTag() {
      return h('style', { key: 'noagent-style' }, CSS)
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

    function stateOf(job) {
      if (job.running) return 'running'
      if (!job.last) return 'idle'
      return job.last.ok ? 'ok' : 'error'
    }

    function JobCard({ job, t, runNow, loadLog }) {
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [log, setLog] = React.useState(null)

      const schedule =
        job.schedule && job.schedule.kind === 'cron'
          ? t('cron', { expression: job.schedule.cron })
          : t('everySeconds', { n: job.schedule ? job.schedule.everySeconds : '' })

      const last = job.last
      const lastText = last
        ? [
            formatTime(last.startedAt),
            t('exitCode', { code: last.exitCode === null ? '—' : last.exitCode }),
            formatDuration(last.durationMs),
            last.timedOut ? t('timeout') : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : t('never')

      const onRun = async () => {
        setBusy(true)
        setNotice(null)
        try {
          await runNow(job.id)
          setNotice({ state: 'ok', text: t('runAccepted') })
        } catch (error) {
          setNotice({
            state: 'error',
            text: t('runFailed') + ' ' + (error instanceof Error ? error.message : String(error)),
          })
        } finally {
          setBusy(false)
        }
      }

      const onToggleLog = async () => {
        if (log) {
          setLog(null)
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          const value = await loadLog(job.id)
          setLog(value)
        } catch (error) {
          setNotice({
            state: 'error',
            text: t('logFailed') + ' ' + (error instanceof Error ? error.message : String(error)),
          })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'li',
        { className: 'noagent-card' },
        h(
          'div',
          { className: 'noagent-card-head' },
          h('span', { className: 'noagent-dot', 'data-state': stateOf(job) }),
          h('span', { className: 'noagent-name' }, job.name || job.id),
          h('span', { className: 'noagent-badge', 'data-off': job.enabled ? 'false' : 'true' },
            job.enabled ? t('enabled') : t('disabled')),
          h('span', { className: 'noagent-badge' }, `${t('jobId')} ${job.id}`),
        ),
        h(
          'dl',
          { className: 'noagent-rows' },
          h('dt', null, t('lastRun')), h('dd', null, lastText),
          h('dt', null, t('schedule')), h('dd', null, schedule),
          h('dt', null, t('timeZone')), h('dd', null, job.timeZone),
          h('dt', null, t('command')), h('dd', null, job.command || '—'),
        ),
        h(
          'div',
          { className: 'noagent-actions' },
          h('button', {
            type: 'button',
            className: 'noagent-button',
            'data-primary': 'true',
            disabled: busy || job.running,
            onClick: onRun,
          }, job.running ? t('running') : t('runNow')),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            disabled: busy,
            onClick: onToggleLog,
          }, log ? t('hideLog') : t('viewLog')),
          notice
            ? h('span', { className: 'noagent-notice', 'data-state': notice.state }, notice.text)
            : null,
        ),
        log
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'noagent-meta' },
                `${t('logTitle')}${log.file ? ' · ' + log.file : ''}${log.truncated ? ' · ' + t('logTruncated') : ''}`),
              h('pre', { className: 'noagent-log' }, log.text || t('noLog')),
            )
          : null,
      )
    }

    function JobsView({ t, status, runNow, loadLog }) {
      if (status.kind === 'loading' && status.jobs.length === 0) {
        return h('p', { className: 'noagent-empty' }, t('loading'))
      }
      if (status.kind === 'error') {
        return h('p', { className: 'noagent-empty' }, `${t('loadFailed')} ${status.error || ''}`)
      }
      if (status.jobs.length === 0) {
        return h('p', { className: 'noagent-empty' }, t('empty'))
      }
      return h(
        'ul',
        { className: 'noagent-list' },
        status.jobs.map((job) =>
          h(JobCard, { key: job.id, job, t, runNow, loadLog }),
        ),
      )
    }

    /** 设置页的一页（settings.section 是 list 槽，一条目 = 一页）。 */
    function SettingsSection(props) {
      const status = props.useStatus((value) => value)
      return h(
        'div',
        { className: 'noagent-root noagent-section' },
        h(StyleTag),
        h('h2', { className: 'noagent-title' }, props.t('title')),
        h('p', { className: 'noagent-intro' }, props.t('intro')),
        h(
          'div',
          { className: 'noagent-head' },
          h('span', { className: 'noagent-meta' },
            status.updatedAt ? props.t('updated', { time: formatTime(status.updatedAt) }) : ''),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            onClick: () => { void props.refresh() },
          }, props.t('refresh')),
        ),
        h(JobsView, {
          t: props.t,
          status,
          runNow: props.runNow,
          loadLog: props.loadLog,
        }),
      )
    }

    /** 侧边栏点开后占据中央面板的一页。 */
    function PanelPage(props) {
      const status = props.useStatus((value) => value)
      return h(
        'div',
        { className: 'noagent-root noagent-page' },
        h(StyleTag),
        h(
          'div',
          { className: 'noagent-head' },
          h('h2', { className: 'noagent-title' }, props.t('title')),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            onClick: () => { void props.refresh() },
          }, props.t('refresh')),
        ),
        h('p', { className: 'noagent-intro' }, props.t('intro')),
        h(JobsView, {
          t: props.t,
          status,
          runNow: props.runNow,
          loadLog: props.loadLog,
        }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'noagent-schedule: dictionaries')

        const store = createStatusStore(callHost)
        ctx.effect(() => () => store.dispose(), 'noagent-schedule: status store')

        const hooks = () => ({ hooks: { status: store } })
        const runNow = async (id) => {
          const value = await callHost({ op: 'run', id, wait: false })
          await store.refresh()
          return value
        }
        const loadLog = (id) => callHost({ op: 'log', id })

        // 设置页：一条 settings.section 条目 = 一页。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 45,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ ...hooks(), refresh: store.refresh, runNow, loadLog }),
        }, SettingsSection))

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
          inject: () => ({ ...hooks(), refresh: store.refresh, runNow, loadLog }),
        }, PanelPage))
      },
    }
  },
})
