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
      if (!hour) return minuteText

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
        return null
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

    /** 任务的计划人话；解析失败返回 { text: cron 原文, invalid: true }。 */
    function scheduleText(schedule, lang = 'zh') {
      if (!schedule) return { text: '', invalid: false }
      if (schedule.kind === 'every') {
        const text = describeEvery(schedule.everySeconds, lang)
        return { text: text ?? '', invalid: false }
      }
      const text = describeCron(schedule.cron, lang)
      return text ? { text, invalid: false } : { text: String(schedule.cron ?? ''), invalid: true }
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
    function filterJobs(jobs, filter, query) {
      const needle = String(query ?? '').trim().toLowerCase()
      return jobs.filter((job) => {
        if (filter === 'enabled' && !job.enabled) return false
        if (filter === 'disabled' && job.enabled) return false
        if (filter === 'failing' && (job.last?.ok !== false || job.enabled === false)) return false
        if (!needle) return true
        const haystack = `${job.name ?? ''} ${job.id ?? ''} ${job.command ?? ''}`.toLowerCase()
        return haystack.includes(needle)
      })
    }

    /**
     * 命令摘要：表格里要能一眼看出「跑的是哪个脚本」。
     * 做法是抹掉每次都一样的噪声 —— 家目录前缀、venv 里的 python 绝对路径、
     * 过长的中间目录（只留文件名），再按长度截断。完整命令在悬停时给出。
     */
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
      .noagent-stat { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; text-align: left; cursor: default; }
      .noagent-stat[data-clickable="true"] { cursor: pointer; }
      .noagent-stat[data-clickable="true"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .noagent-stat-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .noagent-stat-value { font-size: 22px; font-weight: 600; line-height: 28px; font-variant-numeric: tabular-nums; }
      .noagent-stat-value[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
      .noagent-stat-value[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
      .noagent-stat[data-active="true"] { border-color: var(--dsw-alias-brand-primary); }

      .noagent-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .noagent-search { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); flex: 1 1 220px; min-width: 160px; }
      .noagent-search::placeholder { color: var(--dsw-alias-label-tertiary); }
      .noagent-search:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
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
      .noagent-table th[data-w="sched"], .noagent-table td[data-w="sched"] { width: 140px; }
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
      .noagent-button { font: inherit; font-size: 12px; cursor: pointer; padding: 3px 9px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); white-space: nowrap; }
      .noagent-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .noagent-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
      .noagent-button[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); }
      .noagent-button[data-primary="true"]:hover { background: var(--dsw-alias-button-primary-hover); }
      .noagent-button[data-danger="true"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .noagent-button[data-inline="true"] { border: 0; padding: 2px 4px; color: var(--dsw-alias-label-secondary); }
      .noagent-button[disabled] { cursor: default; opacity: 0.55; }

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
      .noagent-input { font: inherit; font-size: 13px; padding: 4px 8px; width: 100%; box-sizing: border-box; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .noagent-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
      .noagent-input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
      textarea.noagent-input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; min-height: 64px; resize: vertical; }
      .noagent-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .noagent-form-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .noagent-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .noagent-hint[data-invalid="true"] { color: var(--dsw-alias-state-error-primary); }

      .noagent-empty { margin: 0; padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; }

      .noagent-drawer-mask { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: flex-end; background: var(--dsw-alias-bg-mask-2, transparent); }
      .noagent-drawer { width: min(760px, 92vw); height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: var(--dsw-shadow-lv3, none); }
      .noagent-drawer-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .noagent-drawer-title { margin: 0; font-size: 15px; font-weight: 600; }
      .noagent-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
      .noagent-drawer-pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); }
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

    function Switch({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: label,
        className: 'noagent-switch',
        'data-on': checked ? 'true' : 'false',
        disabled: disabled === true,
        onClick: onChange,
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
            ? h('span', { className: 'noagent-badge', style: { marginLeft: 6 }, title: t('watchHint') }, t('watchBadge'))
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
          ? h('span', { className: 'noagent-badge', 'data-tone': 'err', style: { marginLeft: 6 } },
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
            formRow(t('fieldMode'), h(
              'div',
              { className: 'noagent-seg' },
              ['cron', 'every'].map((key) =>
                h('button', {
                  key,
                  type: 'button',
                  'data-on': form.mode === key ? 'true' : 'false',
                  onClick: () => setForm({ ...form, mode: key }),
                }, key === 'cron' ? t('modeCron') : t('modeEvery')),
              ),
            )),
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
              label: job.enabled ? t('disabled') : t('enabled'),
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

    function JobTable({ t, lang, jobs, now, actions, openId, setOpenId, openLog }) {
      return h(
        'div',
        { className: 'noagent-table-wrap' },
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
          h(
            'tbody',
            null,
            jobs.map((job) => {
              const open = openId === job.id
              const rows = [
                h(
                  'tr',
                  { key: job.id, 'data-open': open ? 'true' : 'false' },
                  h('td', { 'data-w': 'dot' }, h('span', { className: 'noagent-dot', 'data-state': stateOf(job) })),
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
                            : h('span', { className: 'noagent-badge', 'data-tone': 'off', style: { marginLeft: 6 } }, t('disabled')),
                        ),
                        h('span', { className: 'noagent-meta noagent-mono', title: job.command || '' }, shortenCommand(job.command)),
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
                        label: job.enabled ? t('disabled') : t('enabled'),
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
            }),
          ),
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
      const [openId, setOpenId] = React.useState(null)
      const [logTarget, setLogTarget] = React.useState(null)

      // 空态 / 错误态也走同一个滚动区，保证任何状态下结构一致。
      const only = (text) => h(React.Fragment, null, h('p', { className: 'noagent-empty' }, text))
      if (status.kind === 'loading' && status.jobs.length === 0) return only(t('loading'))
      if (status.kind === 'error') return only(`${t('loadFailed')} ${status.error || ''}`)
      if (status.jobs.length === 0) return only(t('empty'))

      const now = status.now ?? Date.now()
      const visible = filterJobs(status.jobs, filter, query)
      const filters = [
        { key: 'all', label: t('filterAll') },
        { key: 'enabled', label: t('filterEnabled') },
        { key: 'disabled', label: t('filterDisabled') },
        { key: 'failing', label: t('filterFailing') },
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
          onPickFilter: (key) => setFilter(key === filter ? 'all' : key),
        }),
        h(
          'div',
          { className: 'noagent-toolbar' },
          h('input', {
            className: 'noagent-search',
            type: 'search',
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: 'noagent-seg' },
            filters.map((item) =>
              h('button', {
                key: item.key,
                type: 'button',
                'data-on': filter === item.key ? 'true' : 'false',
                onClick: () => setFilter(item.key),
              }, item.label),
            ),
          ),
          h('span', { className: 'noagent-meta', title: status.jobsFile }, status.jobsFile || ''),
          h('button', {
            type: 'button',
            className: 'noagent-button',
            onClick: () => {
              void actions.refresh()
            },
          }, t('refresh')),
        ),
        visible.length === 0
          ? h('div', { className: 'noagent-table-wrap' }, h('p', { className: 'noagent-empty' }, t('emptyFiltered')))
          : h(JobTable, {
              t,
              lang,
              jobs: visible,
              now,
              actions,
              openId,
              setOpenId,
              openLog,
            }),
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
        validateForm,
        stateOf,
        shortenCommand,
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
