/**
 * dsh-noagent-schedule — 零 token 定时脚本调度（DSH 宿主插件）
 *
 * 设计语义对齐 Hermes 的 `no_agent`：
 *   到点 → 起子进程跑脚本 → 收日志 → 记状态，全程不经过模型。
 *
 * 为什么放在 DSH 宿主里而不是 launchd：
 *   1. 宿主进程带着 DSH 应用自己的 TCC 身份，能访问 launchd 子进程被拦下的位置。
 *   2. 不依赖 Hermes 的 venv / 脚本目录，Hermes 删掉也不影响。
 *   3. 任务定义是一个 JSON 文件，改完下个 tick 生效，不需要重装 plist。
 *
 * 边界：只在 DSH 进程存活时运行，不补跑停机期间错过的时点。
 *      需要 7×24 不依赖 GUI 的看门狗，仍然应该用 launchd。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const name = '@local/dsh-noagent-schedule'

/** 只依赖抽象 subprocess 与 timer 服务；缺任一就不激活，不会静默半死。 */
export const inject = ['subprocess', 'timer']

const MAX_FINGERPRINT_LINES = 200

const DEFAULT_PATH =
  '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

/**
 * 客户端读取任务状态的唯一 HTTP 入口。
 * 走 ctx.connection.fetch：Connection 的 `/api` 前缀处理器先做 Host/Origin 围栏与
 * 签名 Cookie 鉴权，再把请求交给这条精确路由，因此这里不需要自己实现鉴权。
 */
export const RPC_PATH = '/api/noagent.rpc'

/** 单次读日志的上限，避免把大日志整份塞给 UI/模型。 */
const MAX_LOG_BYTES = 64 * 1024

/** 读 runs.jsonl 尾部时最多回退的字节数。 */
const MAX_RUNS_TAIL_BYTES = 512 * 1024

const operationError = (code, message) => Object.assign(new Error(message), { code })

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 校验任务 id：只允许普通文件名片段，避免日志读取逃出 runs/ 目录。 */
export function assertJobId(id) {
  if (typeof id !== 'string' || id === '' || id === '.' || id === '..') {
    throw operationError('invalid_job_id', `任务 id 非法：${String(id)}`)
  }
  if (id.length > 200 || /[\\/\0]/.test(id)) {
    throw operationError('invalid_job_id', `任务 id 非法：${id}`)
  }
  return id
}

const WEEKDAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function resolveNames(token, names) {
  const lower = String(token).toLowerCase()
  return names?.[lower] ?? Number(token)
}

/**
 * 解析单个 cron 字段：支持星号、星号后接步长、单值、区间、区间步长、逗号列表、月/周缩写。
 * 返回 { values:Set<number>, restricted:boolean }。
 */
function parseField(field, min, max, names) {
  if (field === '*') return { values: new Set(rangeOf(min, max)), restricted: false }
  const values = new Set()
  for (const rawPart of field.split(',')) {
    const part = rawPart.trim()
    if (!part) throw new Error(`cron 字段为空：${field}`)
    const [spec, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 步长非法：${part}`)

    if (spec === '*') {
      for (let v = min; v <= max; v += step) values.add(v)
      continue
    }
    const dash = spec.split('-')
    if (dash.length === 2) {
      const start = resolveNames(dash[0], names)
      const end = resolveNames(dash[1], names)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new Error(`cron 区间非法：${part}`)
      }
      for (let v = start; v <= end; v += step) values.add(v)
      continue
    }
    const single = resolveNames(spec, names)
    if (!Number.isInteger(single)) throw new Error(`cron 取值非法：${part}`)
    if (step === 1) values.add(single)
    else for (let v = single; v <= max; v += step) values.add(v)
  }
  for (const v of values) {
    if (v < min || v > max) throw new Error(`cron 取值越界：${v}（允许 ${min}-${max}）`)
  }
  return { values, restricted: true }
}

function rangeOf(min, max) {
  const out = []
  for (let v = min; v <= max; v += 1) out.push(v)
  return out
}

/** 五字段 cron → 可匹配的集合。周日 0/7 都归一为 0。 */
export function parseCron(expression) {
  const fields = String(expression).trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron 需要 5 个字段：${expression}`)
  const minute = parseField(fields[0], 0, 59)
  const hour = parseField(fields[1], 0, 23)
  const dom = parseField(fields[2], 1, 31)
  const month = parseField(fields[3], 1, 12, MONTH_NAMES)
  const dow = parseField(fields[4], 0, 7, WEEKDAY_NAMES)
  if (dow.values.has(7)) {
    dow.values.delete(7)
    dow.values.add(0)
  }
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    // Vixie 语义：dom 与 dow 都被限制时取“或”，否则取“与”。
    dayOr: dom.restricted && dow.restricted,
  }
}

/** 取指定 IANA 时区下的墙上时间分量。 */
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    weekday: 'short',
  })
  const parts = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  const weekday = WEEKDAY_NAMES[String(parts.weekday).toLowerCase()]
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
    weekday,
  }
}

/** 某个时刻是否命中 cron。 */
export function cronMatches(spec, parts) {
  if (!spec.minute.has(parts.minute)) return false
  if (!spec.hour.has(parts.hour)) return false
  if (!spec.month.has(parts.month)) return false
  const domHit = spec.dom.has(parts.day)
  const dowHit = spec.dow.has(parts.weekday)
  return spec.dayOr ? domHit || dowHit : domHit && dowHit
}

function minuteKey(parts) {
  return `${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`
}

/** 下次运行最多往后找多久：要覆盖「每年 2 月 29 日」这类最长 4 年才出现一次的计划。 */
const NEXT_RUN_HORIZON_DAYS = 366 * 4 + 1

/** cron 解析结果缓存：status 每次轮询都会为每个任务算一次，别重复解析。 */
const CRON_SPEC_CACHE = new Map()

const cronSpecOf = (expression) => {
  const key = String(expression)
  if (CRON_SPEC_CACHE.has(key)) return CRON_SPEC_CACHE.get(key)
  let spec = null
  try {
    spec = parseCron(key)
  } catch {
    spec = null
  }
  if (CRON_SPEC_CACHE.size > 500) CRON_SPEC_CACHE.clear()
  CRON_SPEC_CACHE.set(key, spec)
  return spec
}

/**
 * 从现在起下一个命中 cron 的分钟（毫秒时间戳），找不到返回 null。
 *
 * 先按天筛（日期/月/周几），命中那一天再在候选小时里逐个试，避免最坏情况
 * （例如每年 2 月 29 日）要逐分钟走四年。只服务于 UI 的「下次运行」，
 * 不参与调度；非法 cron 返回 null 让 UI 显示「计划无效」。
 */
export function nextRunAt(expression, fromMs = Date.now(), timeZone = 'Asia/Shanghai') {
  const spec = cronSpecOf(expression)
  if (!spec) return null
  const hours = [...spec.hour].sort((a, b) => a - b)
  const minutes = [...spec.minute].sort((a, b) => a - b)
  const start = Math.ceil(Number(fromMs) / 60_000) * 60_000
  let dayStart = null
  let lastDayKey = null
  for (let day = 0; day < NEXT_RUN_HORIZON_DAYS; day += 1) {
    const probe = new Date(start + day * 86_400_000)
    let parts
    try {
      parts = zonedParts(probe, timeZone)
    } catch {
      return null
    }
    const dayKey = `${parts.month}-${parts.day}`
    if (!spec.month.has(parts.month) || dayKey === lastDayKey) continue
    const domHit = spec.dom.has(parts.day)
    const dowHit = spec.dow.has(parts.weekday)
    if (!(spec.dayOr ? domHit || dowHit : domHit && dowHit)) continue
    lastDayKey = dayKey
    // 用「当天本地 00:00」作为锚点：按天推进可能跨夏令时，所以要重新对齐。
    dayStart = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate())
    for (const hour of hours) {
      for (const minute of minutes) {
        const at = localTimeToMs(parts.year, parts.month, parts.day, hour, minute, timeZone)
        if (at !== null && at >= start) return at
      }
    }
    // 当天没有晚于 now 的点，继续下一天（dayStart 只用于调试，不参与逻辑）。
    void dayStart
  }
  return null
}

/**
 * 把「某时区的墙上时间」换成毫秒时间戳。
 *
 * 先按 UTC 猜一个时刻，再用该时区回读墙上时间，用差值修正一次即可覆盖时区偏移；
 * 夏令时跳变处对不上就返回 null（该分钟在本地不存在）。
 */
function localTimeToMs(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const back = zonedParts(new Date(guess), timeZone)
  const offset =
    Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute) - guess
  const at = guess - offset
  const check = zonedParts(new Date(at), timeZone)
  if (check.hour !== hour || check.minute !== minute || check.day !== day) return null
  return at
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export function normalizeJobs(document) {
  const raw = Array.isArray(document) ? document : document?.jobs
  if (!Array.isArray(raw)) throw new Error('jobs 文件格式错误：需要 { "jobs": [...] } 或数组')
  return raw.map((job, index) => {
    const id = String(job.id ?? `job-${index + 1}`)
    const hasCron = typeof job.cron === 'string' && job.cron.trim() !== ''
    const hasEvery = Number.isFinite(job.everySeconds) && job.everySeconds >= 30
    if (!hasCron && !hasEvery) {
      throw new Error(`任务 ${id} 缺少 cron 或 everySeconds`)
    }
    const command = typeof job.command === 'string' ? job.command : undefined
    const argv = Array.isArray(job.argv) ? job.argv.map(String) : undefined
    if (!command && !argv) throw new Error(`任务 ${id} 缺少 command 或 argv`)

    // 事件型任务：仅当输出指纹变化时才唤醒会话。必须指明投给哪个会话。
    let wakeOnChange
    if (job.wakeOnChange && typeof job.wakeOnChange === 'object') {
      const sessionId = job.wakeOnChange.sessionId
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new Error(`任务 ${id} 的 wakeOnChange 缺少 sessionId`)
      }
      const keyPattern =
        typeof job.wakeOnChange.keyPattern === 'string' && job.wakeOnChange.keyPattern.trim()
          ? job.wakeOnChange.keyPattern.trim()
          : undefined
      if (keyPattern) {
        try {
          new RegExp(keyPattern)
        } catch (error) {
          throw new Error(`任务 ${id} 的 wakeOnChange.keyPattern 不是合法正则：${messageOf(error)}`)
        }
      }
      wakeOnChange = {
        sessionId: sessionId.trim(),
        title: typeof job.wakeOnChange.title === 'string' ? job.wakeOnChange.title : undefined,
        prompt: typeof job.wakeOnChange.prompt === 'string' ? job.wakeOnChange.prompt : undefined,
        ignoreLines: Array.isArray(job.wakeOnChange.ignoreLines)
          ? job.wakeOnChange.ignoreLines.map(String)
          : [],
        notifyOnFirstRun: job.wakeOnChange.notifyOnFirstRun === true,
        onlyOnNew: job.wakeOnChange.onlyOnNew === true,
        keyPattern,
      }
    }

    return {
      id,
      name: job.name ?? id,
      enabled: job.enabled !== false,
      cron: hasCron ? job.cron.trim() : undefined,
      everySeconds: hasEvery ? Math.floor(job.everySeconds) : undefined,
      timeZone: job.timeZone ?? 'Asia/Shanghai',
      cwd: job.cwd ?? os.homedir(),
      command,
      argv,
      env: job.env && typeof job.env === 'object' ? job.env : {},
      timeoutSeconds: Number.isFinite(job.timeoutSeconds) ? job.timeoutSeconds : 300,
      quietWhenEmpty: job.quietWhenEmpty !== false,
      wakeOnChange,
    }
  })
}

/** 把任务定义压成 UI/模型都需要的展示信息（不含 env，避免泄漏密钥）。 */
export function publicJob(job, stateEntry, lastRecord, running) {
  const last = lastRecord
    ? {
        startedAt: lastRecord.startedAt ?? null,
        finishedAt: null,
        durationMs: lastRecord.durationMs ?? null,
        exitCode: lastRecord.exitCode ?? null,
        signal: lastRecord.signal ?? null,
        timedOut: lastRecord.timedOut === true,
        ok: lastRecord.ok === true,
        stderrTail: typeof lastRecord.stderrTail === 'string' ? lastRecord.stderrTail : '',
      }
    : stateEntry?.lastStartedAt
      ? {
          startedAt: stateEntry.lastStartedAt,
          finishedAt: stateEntry.lastFinishedAt ?? null,
          durationMs: stateEntry.lastDurationMs ?? null,
          exitCode: stateEntry.lastExitCode ?? null,
          signal: null,
          timedOut: false,
          ok: stateEntry.lastOk === true,
          stderrTail: '',
        }
      : null
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled !== false,
    timeZone: job.timeZone,
    schedule: job.cron
      ? { kind: 'cron', cron: job.cron }
      : { kind: 'every', everySeconds: job.everySeconds },
    command: describeCommand(job),
    cwd: job.cwd,
    timeoutSeconds: job.timeoutSeconds,
    // 事件型探针：脚本跑完只在输出变化时唤醒会话。UI 需要它来区分两类任务。
    watch: Boolean(job.wakeOnChange),
    wakeSessionId: job.wakeOnChange?.sessionId ?? null,
    wakeTitle: job.wakeOnChange?.title ?? null,
    running: running === true,
    lastFiredMinute: stateEntry?.lastFiredMinute ?? null,
    lastWakeAt: stateEntry?.lastWakeAt ?? null,
    nextRunAt: null,
    last,
  }
}

function describeCommand(job) {
  if (typeof job.command === 'string') return job.command
  if (!Array.isArray(job.argv)) return ''
  return job.argv
    .map((part) => (/^[\w./:@=+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ')
}

/**
 * 把脚本输出规整成可比较的指纹文本。
 * - ignoreLines: 逐行丢弃匹配的行（时间戳、进度条这类每轮都变的噪声）
 * - 默认丢掉首尾空白，保留行序（首行通常是状态汇总，变了就是真变了）
 */
export function normalizeForFingerprint(text, wake = {}) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const ignore = Array.isArray(wake.ignoreLines) ? wake.ignoreLines : []
  const patterns = ignore
    .map((p) => {
      try {
        return new RegExp(p)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const kept = patterns.length
    ? lines.filter((line) => !patterns.some((re) => re.test(line)))
    : lines
  return kept.join('\n').trim()
}

/** 稳定指纹：djb2 变体，够用且不用引 crypto。 */
export function fingerprintOf(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

/**
 * 「新条目」比较用的行身份。
 *
 * 默认整行比较（受 time/timestamp 之类正文变化影响）；给了 keyPattern 时只比较
 * 匹配到的那一段，于是同一会话换了最后一条消息、换了我方回复，都不会再算新条目。
 * 正则无捕获组时取整个匹配；匹配不到就退回整行。
 */
export function makeLineKey(keyPattern) {
  if (typeof keyPattern !== 'string' || !keyPattern.trim()) return (line) => line
  let re
  try {
    re = new RegExp(keyPattern.trim())
  } catch {
    return (line) => line
  }
  return (line) => {
    const match = re.exec(line)
    return match ? match[0] : line
  }
}

/**
 * 渲染唤醒提示词。占位符：
 *   {{job}}   任务名
 *   {{id}}    任务 id
 *   {{output}} 本次输出（截断到 maxOutputChars）
 */
export function renderWakePrompt(template, job, change, maxOutputChars = 4000) {
  const base =
    typeof template === 'string' && template.trim()
      ? template
      : '定时探针 {{id}} 检测到新内容，请按该任务的既定流程处理下面这段输出。'
  const output = String(change?.current ?? '')
  const clipped = output.length > maxOutputChars ? `${output.slice(0, maxOutputChars)}\n…(已截断)` : output
  return base
    .replaceAll('{{job}}', job?.name ?? '')
    .replaceAll('{{id}}', job?.id ?? '')
    .replaceAll('{{output}}', clipped)
}

/** 读 runs.jsonl 尾部并解析成记录数组；文件不存在时返回空数组。 */
async function readRunsTail(runsLog, maxBytes = MAX_RUNS_TAIL_BYTES) {
  let handle
  try {
    handle = await fs.open(runsLog, 'r')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n').filter((line) => line !== '')
    // 从中间开始读时，第一行大概率是被截断的半条记录。
    if (start > 0) lines.shift()
    const records = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch {
        /* 半条记录/人工编辑：跳过而不是整份失败 */
      }
    }
    return records
  } finally {
    await handle.close()
  }
}

/**
 * 列出任务与最近一次结果（jobs.json + state.json + runs.jsonl 三份数据的只读合并）。
 * 不写任何文件，也不改 tick 的内存缓存。
 */
export async function readJobStatus({ jobsFile, stateDir, runningIds }) {
  const document = await readJson(jobsFile)
  if (!document) throw operationError('jobs_missing', `未找到任务清单：${jobsFile}`)
  let jobs
  try {
    jobs = normalizeJobs(document)
  } catch (error) {
    throw operationError('jobs_invalid', `任务清单格式错误：${messageOf(error)}`)
  }
  const state = (await readJson(path.join(stateDir, 'state.json'))) ?? { jobs: {} }
  const runs = await readRunsTail(path.join(stateDir, 'runs.jsonl'))
  const lastById = new Map()
  // 每个任务再留最近 8 条：界面上要画「最近结果」小格子（青龙式），
  // 但不能把整份 runs.jsonl 交给浏览器。
  const recentById = new Map()
  for (const record of runs) {
    if (!record || typeof record.id !== 'string') continue
    lastById.set(record.id, record)
    const list = recentById.get(record.id) ?? []
    list.push({
      startedAt: record.startedAt ?? null,
      durationMs: record.durationMs ?? null,
      exitCode: record.exitCode ?? null,
      ok: record.ok === true,
      timedOut: record.timedOut === true,
    })
    if (list.length > 8) list.shift()
    recentById.set(record.id, list)
  }
  const running = runningIds instanceof Set ? runningIds : new Set(runningIds ?? [])
  const now = Date.now()
  const publicJobs = jobs.map((job) => {
    const row = publicJob(job, state.jobs?.[job.id], lastById.get(job.id), running.has(job.id))
    row.recent = recentById.get(job.id) ?? []
    if (job.enabled === false) return row
    if (job.cron) {
      row.nextRunAt = nextRunAt(job.cron, now, job.timeZone || 'Asia/Shanghai')
    } else if (job.everySeconds) {
      const anchor = state.jobs?.[job.id]?.lastStartedAt
        ? Date.parse(state.jobs[job.id].lastStartedAt)
        : NaN
      const base = Number.isFinite(anchor) ? anchor : now
      const due = base + job.everySeconds * 1000
      row.nextRunAt = due > now ? due : now
    }
    return row
  })
  return {
    updatedAt: state.updatedAt ?? null,
    now,
    jobsFile,
    stateDir,
    jobs: publicJobs,
  }
}

/**
 * 读某个任务某次运行的日志（默认取时间戳最大的那份，只回尾部）。
 *
 * `at` 是 runs.jsonl 里那条记录的 startedAt（界面上点「最近结果」的历史格子时传入）；
 * 日志文件名是把 startedAt 里的 `:` 和 `.` 换成 `-`，所以这里只做同样的替换后按
 * 文件名精确查找，找不到再退回最新一份，避免把别人的日志读回来。
 */
export async function readRunLog({ stateDir, id, limitBytes = MAX_LOG_BYTES, at }) {
  const safe = assertJobId(id)
  const dir = path.join(stateDir, 'runs', safe)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { id: safe, file: null, size: 0, truncated: false, text: '' }
    }
    throw error
  }
  const logs = names.filter((name) => name.endsWith('.log')).sort()
  let file = logs[logs.length - 1]
  if (typeof at === 'string' && at) {
    const wanted = `${at.replace(/[:.]/g, '-')}.log`
    if (logs.includes(wanted)) file = wanted
  }
  if (!file) return { id: safe, file: null, size: 0, truncated: false, text: '' }
  const handle = await fs.open(path.join(dir, file), 'r')
  try {
    const { size } = await handle.stat()
    const budget = Math.max(1, Math.floor(Number(limitBytes) || MAX_LOG_BYTES))
    const start = Math.max(0, size - budget)
    const length = size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
    return { id: safe, file, size, truncated: start > 0, text: buffer.toString('utf8') }
  } finally {
    await handle.close()
  }
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  if (!enabled) return

  const jobsFile = config.jobsFile || path.join(os.homedir(), '.dsh', 'noagent', 'jobs.json')
  const stateDir = config.stateDir || path.join(os.homedir(), '.dsh', 'noagent', 'state')
  const tickMs = Math.max(1000, Number(config.tickSeconds ?? 20) * 1000)
  const maxBytes = Number(config.maxCollectedBytes ?? 256 * 1024)
  const defaultTimeZone = config.timeZone || 'Asia/Shanghai'

  const statePath = path.join(stateDir, 'state.json')
  const runsLog = path.join(stateDir, 'runs.jsonl')
  const state = { jobs: {}, updatedAt: undefined }
  const running = new Set()
  const compiled = new Map()
  let stopped = false

  const log = (message, fields) => {
    ctx.logger?.info?.(`[noagent-schedule] ${message}`, fields ?? '')
  }

  const compile = (job) => {
    const key = `${job.id}|${job.cron ?? ''}`
    if (!compiled.has(key)) {
      compiled.set(key, job.cron ? parseCron(job.cron) : undefined)
    }
    return compiled.get(key)
  }

  const appendRun = async (record) => {
    await fs.mkdir(stateDir, { recursive: true })
    await fs.appendFile(runsLog, `${JSON.stringify(record)}\n`, 'utf8')
  }

  const execute = async (job) => {
    if (running.has(job.id)) {
      log(`跳过 ${job.id}：上一轮仍在运行`)
      return
    }
    running.add(job.id)
    const startedAt = Date.now()
    const startedISO = new Date(startedAt).toISOString()
    const argv = job.argv ?? ['/bin/bash', '-lc', job.command]
    // GUI 启动的宿主进程 PATH 往往只有 /usr/bin:/bin:...，必须把 homebrew 等常用目录前置，
    // 否则任务会在“找不到 git / node”上静默失败。
    const inheritedPath = process.env.PATH ?? ''
    const env = {
      ...process.env,
      PATH: inheritedPath ? `${DEFAULT_PATH}:${inheritedPath}` : DEFAULT_PATH,
      ...job.env,
    }
    let outcome
    let stdoutText = ''
    let stderrText = ''
    let timedOut = false
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: job.cwd,
        env,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes },
          stderr: { maxBytes },
        },
        graceMs: 5000,
      })
      const timer = setTimeout(() => {
        timedOut = true
        try {
          handle.terminate()
        } catch {
          /* provider 可能已自行退出 */
        }
      }, job.timeoutSeconds * 1000)
      try {
        outcome = await handle.done
      } finally {
        clearTimeout(timer)
      }
      stdoutText = handle.collected.stdout?.readFrom(0)?.text ?? ''
      stderrText = handle.collected.stderr?.readFrom(0)?.text ?? ''
    } catch (error) {
      outcome = { exitCode: null, signal: null }
      stderrText = `${stderrText}\n${error instanceof Error ? error.message : String(error)}`
    } finally {
      running.delete(job.id)
    }

    const finishedAt = Date.now()
    const exitCode = outcome?.exitCode ?? null
    const ok = !timedOut && exitCode === 0
    const record = {
      id: job.id,
      name: job.name,
      startedAt: startedISO,
      durationMs: finishedAt - startedAt,
      exitCode,
      signal: outcome?.signal ?? null,
      timedOut,
      ok,
      stdoutBytes: Buffer.byteLength(stdoutText),
      stderrTail: stderrText.trim().split('\n').slice(-8).join('\n').slice(0, 2000),
    }

    // 合并而不是替换：lastFiredMinute / fingerprint 由别处写入，替换会把它们冲掉
    // （前者让同一分钟重复触发，后者让每一轮都被当成“内容变了”而反复唤醒）。
    state.jobs[job.id] = {
      ...(state.jobs[job.id] ?? {}),
      name: job.name,
      lastStartedAt: startedISO,
      lastFinishedAt: new Date(finishedAt).toISOString(),
      lastExitCode: exitCode,
      lastOk: ok,
      lastDurationMs: record.durationMs,
    }
    state.updatedAt = new Date(finishedAt).toISOString()

    // 每轮都留独立日志，方便事后直接看 stdout 原文。
    const stamp = startedISO.replace(/[:.]/g, '-')
    const logFile = path.join(stateDir, 'runs', job.id, `${stamp}.log`)
    try {
      await fs.mkdir(path.dirname(logFile), { recursive: true })
      await fs.writeFile(
        logFile,
        [
          `# ${job.name} (${job.id})`,
          `started: ${startedISO}`,
          `cwd: ${job.cwd}`,
          `argv: ${JSON.stringify(argv)}`,
          `exit: ${exitCode}${timedOut ? ' (timeout)' : ''}`,
          '--- stdout ---',
          stdoutText,
          '--- stderr ---',
          stderrText,
        ].join('\n'),
        'utf8',
      )
    } catch (error) {
      log(`写日志失败 ${job.id}: ${error instanceof Error ? error.message : error}`)
    }
    try {
      await appendRun(record)
      await writeJsonAtomic(statePath, state)
    } catch (error) {
      log(`写状态失败 ${job.id}: ${error instanceof Error ? error.message : error}`)
    }
    log(`${job.name} 退出码 ${exitCode} 用时 ${record.durationMs}ms`)

    // 事件型任务：脚本输出就是“有没有事发生”的指纹。指纹没变就什么都不做（零 token），
    // 变了才把这条输出投进指定会话，让模型只在真有新消息时醒一次。
    const changed = await detectChange(job, stdoutText, ok)
    if (changed) {
      record.wake = await wakeSession(job, changed)
    }

    // 返回记录只给“立即运行一次”用；tick 路径忽略返回值，行为与以前一致。
    return record
  }

  /**
   * 计算本次输出相对上一次的指纹变化。
   * 返回 null 表示不需要唤醒；返回 { previous, current, reason } 表示需要。
   */
  const detectChange = async (job, stdoutText, ok) => {
    const wake = job.wakeOnChange
    if (!wake) return null
    if (!ok) return null // 脚本自己失败时由日志和状态体现，不冒充“有新消息”

    const text = normalizeForFingerprint(stdoutText, wake)
    if (!text.trim()) return null // 空输出按约定表示“无事”

    const entry = state.jobs[job.id] ?? {}
    const previous = typeof entry.fingerprint === 'string' ? entry.fingerprint : null
    const fingerprint = fingerprintOf(text)
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    const previousLines = Array.isArray(entry.fingerprintLines) ? entry.fingerprintLines : []
    const now = new Date().toISOString()
    const nextState = {
      ...entry,
      fingerprint,
      fingerprintAt: now,
      fingerprintLines: lines.slice(0, MAX_FINGERPRINT_LINES),
    }

    // 首轮：只记基线不唤醒，避免首次启动就吵你。
    if (previous === null) {
      state.jobs[job.id] = nextState
      await writeJsonAtomic(statePath, state).catch(() => {})
      if (wake.notifyOnFirstRun !== true) return null
      return { previous: null, current: text, reason: 'first-run' }
    }
    if (previous === fingerprint) return null

    // onlyOnNew：只关心"冒出新条目"，不关心旧条目消失。
    // 这样"我们回复后该会话从待回复列表里消失"就不会再触发第二次唤醒。
    if (wake.onlyOnNew === true) {
      // keyPattern 让「同一会话换了正文/时间」不算新条目，只有真正冒出新身份才唤醒。
      const keyOf = makeLineKey(wake.keyPattern)
      const seen = new Set(previousLines.map(keyOf))
      const fresh = lines.filter((line) => !seen.has(keyOf(line)))
      state.jobs[job.id] = nextState
      await writeJsonAtomic(statePath, state).catch(() => {})
      if (fresh.length === 0) return null
      return { previous: entry.fingerprintText ?? null, current: text, reason: 'new-entries' }
    }

    state.jobs[job.id] = nextState
    await writeJsonAtomic(statePath, state).catch(() => {})
    return { previous: entry.fingerprintText ?? null, current: text, reason: 'changed' }
  }

  /** 唤醒用的任务标题：与 wakeSession 创建时保持同一份渲染结果。 */
  const wakeTitleOf = (job) => {
    const wake = job.wakeOnChange
    if (wake.title) return renderWakePrompt(wake.title, job, { current: '' })
    return `[${job.name}]`
  }

  /**
   * 清理历史唤醒留下的一次性任务行。
   *
   * 每次唤醒都是一次 `after` 一次性任务：投递完成后它变成 inactive 但仍然留在
   * Host 任务表里，因而出现在「自动化任务」页面。探针每几分钟就唤醒一次，一天
   * 就是几十条同名「已结束 · 仅一次」，把真正的定时任务挤出屏幕（2026-10-20 实测
   * 一天 21 条）。这些行只承载一次投递，没有保留价值，投递完就删。
   *
   * 只动「本插件的唤醒行」：同一 Session + 同一标题 + kind=after + 已不在等待投递。
   */
  const sweepWakeSchedules = async (job, { minAgeMs = 60_000 } = {}) => {
    const wake = job.wakeOnChange
    if (!wake) return 0
    const scheduleSvc = typeof ctx.get === 'function' ? ctx.get('schedule') : ctx.schedule
    if (!scheduleSvc || typeof scheduleSvc.catalog !== 'function' || typeof scheduleSvc.delete !== 'function') {
      return 0
    }
    let rows
    try {
      rows = await scheduleSvc.catalog()
    } catch (error) {
      log(`读取任务目录失败（任务 ${job.id}）：${messageOf(error)}`)
      return 0
    }
    if (!Array.isArray(rows)) return 0
    const title = wakeTitleOf(job)
    const now = Date.now()
    let removed = 0
    for (const row of rows) {
      if (!row || row.sessionId !== wake.sessionId) continue
      if (row.kind !== 'after' || row.title !== title) continue
      if (row.status === 'active') continue // 还在等投递，删了就不会唤醒了
      const at = Date.parse(row.lastDelivery?.deliveredAt ?? row.scheduledAt ?? '')
      if (Number.isFinite(at) && now - at < minAgeMs) continue
      try {
        const result = await scheduleSvc.delete({ sessionId: row.sessionId, id: row.id })
        if (result?.deleted) removed += 1
      } catch (error) {
        log(`清理历史唤醒失败（任务 ${job.id} / ${row.id}）：${messageOf(error)}`)
      }
    }
    return removed
  }

  /** 把“有新内容”投递到目标会话（schedule 的一次性 trigger，延迟 1 秒）。 */
  const wakeSession = async (job, change) => {
    const wake = job.wakeOnChange
    const scheduleSvc = typeof ctx.get === 'function' ? ctx.get('schedule') : ctx.schedule
    if (!scheduleSvc || typeof scheduleSvc.create !== 'function') {
      log(`无法唤醒：schedule 服务不可用（任务 ${job.id}）`)
      return { ok: false, error: 'schedule_unavailable' }
    }
    const prompt = renderWakePrompt(wake.prompt, job, change)
    // 新一次唤醒前先收掉上一条已投递的唤醒行，列表里最多只留当前这一条。
    const pruned = await sweepWakeSchedules(job, { minAgeMs: 0 })
    if (pruned > 0) log(`已清理 ${pruned} 条历史唤醒任务（任务 ${job.id}）`)
    try {
      const record = await scheduleSvc.create(wake.sessionId, {
        title: wake.title ? renderWakePrompt(wake.title, job, change) : `[${job.name}]`,
        prompt,
        after_seconds: 1,
      })
      state.jobs[job.id] = {
        ...(state.jobs[job.id] ?? {}),
        fingerprintText: change.current,
        lastWakeAt: new Date().toISOString(),
        lastWakeScheduleId: record?.id ?? null,
      }
      await writeJsonAtomic(statePath, state).catch(() => {})
      log(`已唤醒会话 ${wake.sessionId}（任务 ${job.id}，原因 ${change.reason}）`)
      return { ok: true, scheduleId: record?.id ?? null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`唤醒失败（任务 ${job.id}）：${message}`)
      return { ok: false, error: message }
    }
  }

  const refreshJobs = async () => {
    let document
    try {
      document = await readJson(jobsFile)
    } catch (error) {
      log(`jobs 文件读取失败：${error instanceof Error ? error.message : error}`)
      return []
    }
    if (!document) {
      log(`未找到 jobs 文件：${jobsFile}`)
      return []
    }
    try {
      return normalizeJobs(document)
    } catch (error) {
      log(`jobs 文件格式错误：${error instanceof Error ? error.message : error}`)
      return []
    }
  }

  let jobs = []
  let jobsLoadedAt = 0
  /** 每个任务最近一次清理唤醒行的时间（tick 节流，避免每轮都读目录）。 */
  const wakeSweepAt = new Map()
  // 测试与调试用：允许把任务清单的重新读取间隔调小（生产默认 10 秒）。
  const jobsReloadMs = Math.max(0, Number(config.jobsReloadMs ?? 10_000))

  /**
   * 启动时把上一次的 state.json 读回来。
   *
   * 不读会出两个问题（2026-10-20 实测）：
   *   1. `lastFiredMinute` 丢失 → 同一分钟跨重启可能重复触发；
   *   2. `fingerprint` 丢失 → 重启后的第一次变化被当成“首轮基线”吞掉，
   *      事件型任务在重启后第一次真有新消息时不会唤醒。
   */
  let stateReady = false
  const loadState = (async () => {
    try {
      const previous = await readJson(statePath)
      if (previous && typeof previous === 'object') {
        if (previous.jobs && typeof previous.jobs === 'object') {
          for (const [id, entry] of Object.entries(previous.jobs)) {
            if (entry && typeof entry === 'object') state.jobs[id] = { ...entry }
          }
        }
        if (typeof previous.updatedAt === 'string') state.updatedAt = previous.updatedAt
      }
    } catch (error) {
      log(`读取历史状态失败（按全新启动处理）：${messageOf(error)}`)
    } finally {
      stateReady = true
    }
  })()

  const tick = async () => {
    if (stopped) return
    if (!stateReady) await loadState
    if (Date.now() - jobsLoadedAt >= jobsReloadMs) {
      jobs = await refreshJobs()
      jobsLoadedAt = Date.now()
    }
    const now = new Date()
    // 唤醒行清理：一次性唤醒投递完成后就该从「自动化任务」列表里消失，
    // 否则同名的「已结束 · 仅一次」会一直堆积（见 sweepWakeSchedules）。
    for (const job of jobs) {
      if (!job.enabled || !job.wakeOnChange) continue
      if (now.getTime() - (wakeSweepAt.get(job.id) ?? 0) < 30_000) continue
      wakeSweepAt.set(job.id, now.getTime())
      void sweepWakeSchedules(job).then((removed) => {
        if (removed > 0) log(`已清理 ${removed} 条历史唤醒任务（任务 ${job.id}）`)
      })
    }
    for (const job of jobs) {
      if (!job.enabled) continue
      const zone = job.timeZone || defaultTimeZone
      let parts
      try {
        parts = zonedParts(now, zone)
      } catch {
        log(`时区非法：${zone}（任务 ${job.id}）`)
        continue
      }
      const stateKey = job.id
      const lastFired = state.jobs[stateKey]?.lastFiredMinute
      if (job.cron) {
        const spec = compile(job)
        if (!spec || !cronMatches(spec, parts)) continue
        const key = `${zone}|${minuteKey(parts)}`
        if (lastFired === key) continue
        state.jobs[stateKey] = { ...(state.jobs[stateKey] ?? {}), lastFiredMinute: key }
        void execute(job)
      } else if (job.everySeconds) {
        const last = state.jobs[stateKey]?.lastStartedAt
        const due = !last || now.getTime() - Date.parse(last) >= job.everySeconds * 1000
        if (!due) continue
        void execute(job)
      }
    }
  }

  ctx.effect(() => {
    log(`启动：jobs=${jobsFile} state=${stateDir} tick=${tickMs / 1000}s`)
    const stop = ctx.interval(() => {
      void tick()
    }, tickMs)
    return () => {
      stopped = true
      stop()
    }
  })

  // ---------------------------------------------------------------------------
  // 应用操作（UI 与 agent 工具共用同一份实现）
  //
  // 依据 references/user-actions.md：操作只实现一次，UI 通过 Client 可调的 Host
  // 入口调用，agent 工具调用同一方法。UI 入口是 ctx.connection.fetch 注册的
  // `POST /api/noagent.rpc`（Connection 的 /api 前缀先做 Host/Origin 围栏与签名
  // Cookie 鉴权，再把请求交给这条精确路由）；工具入口是 ctx.tools.register。
  // ---------------------------------------------------------------------------

  const loadJobsStrict = async () => {
    let document
    try {
      document = await readJson(jobsFile)
    } catch (error) {
      throw operationError('jobs_unreadable', `任务清单读取失败：${messageOf(error)}`)
    }
    if (!document) throw operationError('jobs_missing', `未找到任务清单：${jobsFile}`)
    try {
      return normalizeJobs(document)
    } catch (error) {
      throw operationError('jobs_invalid', `任务清单格式错误：${messageOf(error)}`)
    }
  }

  /** 唯一的操作实现：UI 路由与 agent 工具都调这些方法。 */
  const operations = {
    status: () => readJobStatus({ jobsFile, stateDir, runningIds: running }),
    /**
     * 立即运行一次（不受 enabled / cron 时点限制）。
     * @param {string} id 任务 id。
     * @param {{ wait?: boolean }} options wait=false 只启动并立即返回（UI 用轮询看结果）。
     */
    async run(id, options = {}) {
      const safe = assertJobId(id)
      const current = await loadJobsStrict()
      const job = current.find((item) => item.id === safe)
      if (!job) throw operationError('job_not_found', `未找到任务：${safe}`)
      if (running.has(safe)) throw operationError('job_running', `任务 ${safe} 正在运行`)
      const pending = execute(job)
      if (options.wait === false) {
        void pending.catch(() => {})
        return { accepted: true, id: safe, startedAt: new Date().toISOString() }
      }
      const record = await pending
      if (!record) throw operationError('job_running', `任务 ${safe} 正在运行`)
      return { id: safe, record }
    },
    log: (id, options = {}) =>
      readRunLog({
        stateDir,
        id,
        limitBytes: options.limitBytes ?? MAX_LOG_BYTES,
        at: options.at,
      }),
    /**
     * 改一个任务的启停 / 计划 / 超时 / 名称 / 命令。
     *
     * 只改 patch 里出现的字段：jobs.json 是用户手写的文件，可能带 env、wakeOnChange、
     * 注释式字段等本插件不认识的东西，写回时整条原样保留，只覆盖被点的字段。
     * 写前存一份带时间戳的备份（保留最近 10 份），写后用同一个 normalizeJobs 复核，
     * 校验不过就拒绝落盘 —— 界面不可能把 jobs.json 改成加载失败的状态。
     */
    async updateJob(id, patch = {}) {
      const safe = assertJobId(id)
      if (!patch || typeof patch !== 'object') throw operationError('invalid_patch', '修改内容必须是对象')
      const document = await readRawJobs()
      const raw = Array.isArray(document) ? document : document?.jobs
      if (!Array.isArray(raw)) throw operationError('jobs_invalid', '任务清单格式错误：需要 { "jobs": [...] }')
      const index = raw.findIndex((job) => job && String(job.id) === safe)
      if (index < 0) throw operationError('job_not_found', `未找到任务：${safe}`)
      const nextJob = { ...raw[index] }
      if (typeof patch.enabled === 'boolean') nextJob.enabled = patch.enabled
      if (typeof patch.name === 'string' && patch.name.trim()) nextJob.name = patch.name.trim()
      if (typeof patch.command === 'string' && patch.command.trim()) {
        nextJob.command = patch.command.trim()
        delete nextJob.argv
      }
      if (patch.timeoutSeconds !== undefined) {
        const timeout = Number(patch.timeoutSeconds)
        if (!Number.isFinite(timeout) || timeout < 10 || timeout > 86_400) {
          throw operationError('invalid_timeout', '超时必须是 10–86400 秒之间的数')
        }
        nextJob.timeoutSeconds = Math.floor(timeout)
      }
      if (patch.cron !== undefined || patch.everySeconds !== undefined) {
        const mode = patch.mode === 'every' ? 'every' : 'cron'
        if (mode === 'every') {
          const every = Number(patch.everySeconds)
          if (!Number.isInteger(every) || every < 30) {
            throw operationError('invalid_every', '间隔必须是 ≥30 的整数秒')
          }
          delete nextJob.cron
          nextJob.everySeconds = every
        } else {
          const cron = String(patch.cron ?? '').trim()
          try {
            parseCron(cron)
          } catch (error) {
            throw operationError('invalid_cron', `cron 不合法：${messageOf(error)}`)
          }
          delete nextJob.everySeconds
          nextJob.cron = cron
        }
      }
      if (typeof patch.timeZone === 'string' && patch.timeZone.trim()) {
        const zone = patch.timeZone.trim()
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: zone })
        } catch {
          throw operationError('invalid_timezone', `时区不合法：${zone}`)
        }
        nextJob.timeZone = zone
      }
      const nextRaw = raw.slice()
      nextRaw[index] = nextJob
      const nextDocument = Array.isArray(document) ? nextRaw : { ...document, jobs: nextRaw }
      // 用调度器自己的解析器复核：加载不了的清单绝不落盘。
      try {
        normalizeJobs(nextDocument)
      } catch (error) {
        throw operationError('jobs_invalid', `改完的任务无法加载：${messageOf(error)}`)
      }
      await backupJobsFile('update')
      await writeJsonAtomic(jobsFile, nextDocument)
      // 立刻让 tick 用新清单，不必等 10 秒重读。
      jobsLoadedAt = 0
      return { updated: true, id: safe }
    },
    async deleteJob(id) {
      const safe = assertJobId(id)
      if (running.has(safe)) throw operationError('job_running', `任务 ${safe} 正在运行，先停下再删`)
      const document = await readRawJobs()
      const raw = Array.isArray(document) ? document : document?.jobs
      if (!Array.isArray(raw)) throw operationError('jobs_invalid', '任务清单格式错误：需要 { "jobs": [...] }')
      const index = raw.findIndex((job) => job && String(job.id) === safe)
      if (index < 0) throw operationError('job_not_found', `未找到任务：${safe}`)
      const nextRaw = raw.filter((_, i) => i !== index)
      const nextDocument = Array.isArray(document) ? nextRaw : { ...document, jobs: nextRaw }
      await backupJobsFile('delete')
      await writeJsonAtomic(jobsFile, nextDocument)
      jobsLoadedAt = 0
      return { deleted: true, id: safe }
    },
  }

  /** 读 jobs.json 原文（未归一化），写回时才能原样保留未知字段。 */
  const readRawJobs = async () => {
    let document
    try {
      document = await readJson(jobsFile)
    } catch (error) {
      throw operationError('jobs_unreadable', `任务清单读取失败：${messageOf(error)}`)
    }
    if (!document) throw operationError('jobs_missing', `未找到任务清单：${jobsFile}`)
    return document
  }

  /**
   * 写 jobs.json 前留一份备份：jobs.json.bak-<时间戳>-<动作>，只保留最近 10 份。
   * 备份失败就放弃这次写入 —— 改坏了没有退路比不改更糟。
   */
  const backupJobsFile = async (reason) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.dirname(jobsFile)
    // 同一毫秒内连续两次写会撞名，撞上就加序号，保证每次写前都真的留了一份。
    let target = path.join(dir, `jobs.json.bak-${stamp}-${reason}`)
    for (let n = 2; ; n += 1) {
      try {
        await fs.access(target)
      } catch {
        break
      }
      target = path.join(dir, `jobs.json.bak-${stamp}-${reason}-${n}`)
    }
    try {
      await fs.copyFile(jobsFile, target)
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw operationError('backup_failed', `备份任务清单失败，已放弃修改：${messageOf(error)}`)
      }
      return
    }
    try {
      const names = (await fs.readdir(dir)).filter((name) => name.startsWith('jobs.json.bak-')).sort()
      for (const stale of names.slice(0, Math.max(0, names.length - 10))) {
        await fs.rm(path.join(dir, stale), { force: true }).catch(() => {})
      }
    } catch {
      /* 清理旧备份失败不影响本次写入 */
    }
  }

  const jsonResponse = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })

  /** POST /api/noagent.rpc 的请求体：{ op: 'status'|'run'|'log', ... }。 */
  const handleRpcRequest = async (request) => {
    let payload
    try {
      payload = await request.json()
    } catch {
      return jsonResponse(
        { ok: false, error: { code: 'invalid_body', message: '请求体必须是 JSON' } },
        400,
      )
    }
    if (!payload || typeof payload !== 'object') {
      return jsonResponse(
        { ok: false, error: { code: 'invalid_body', message: '请求体必须是 JSON 对象' } },
        400,
      )
    }
    try {
      if (payload.op === 'status') {
        return jsonResponse({ ok: true, value: await operations.status() })
      }
      if (payload.op === 'run') {
        const value = await operations.run(payload.id, { wait: payload.wait === true })
        return jsonResponse({ ok: true, value })
      }
      if (payload.op === 'log') {
        const value = await operations.log(payload.id, {
          limitBytes: Number.isFinite(payload.limitBytes) ? payload.limitBytes : undefined,
          at: typeof payload.at === 'string' ? payload.at : undefined,
        })
        return jsonResponse({ ok: true, value })
      }
      if (payload.op === 'toggle') {
        const value = await operations.updateJob(payload.id, { enabled: payload.enabled === true })
        return jsonResponse({ ok: true, value })
      }
      if (payload.op === 'update') {
        const value = await operations.updateJob(payload.id, payload.patch ?? {})
        return jsonResponse({ ok: true, value })
      }
      if (payload.op === 'delete') {
        const value = await operations.deleteJob(payload.id)
        return jsonResponse({ ok: true, value })
      }
      return jsonResponse(
        { ok: false, error: { code: 'unknown_op', message: `未知操作：${String(payload.op)}` } },
        400,
      )
    } catch (error) {
      return jsonResponse(
        { ok: false, error: { code: error?.code ?? 'internal_error', message: messageOf(error) } },
        200,
      )
    }
  }

  const installWebRoute = (webCtx) => {
    const fetchRegistry =
      (typeof webCtx.get === 'function' ? webCtx.get('connection') : undefined)?.fetch ??
      webCtx.connection?.fetch
    if (!fetchRegistry || typeof fetchRegistry.register !== 'function') return
    webCtx.effect(() => {
      const dispose = fetchRegistry.register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handleRpcRequest,
      })
      return () => {
        try {
          void Promise.resolve(dispose()).catch(() => {})
        } catch {
          /* 已经释放 */
        }
      }
    }, 'noagent-schedule: /api/noagent.rpc')
  }

  const toolOutput = {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }

  const installTools = (toolCtx) => {
    const tools = (typeof toolCtx.get === 'function' ? toolCtx.get('tools') : undefined) ?? toolCtx.tools
    if (!tools || typeof tools.register !== 'function') return
    tools.register({
      name: 'noagent_status',
      description:
        'List the no-agent scheduled scripts configured on this Host with their last run (time, exit code, duration). Pass an id to read one job only.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional exact job id.' },
        },
        additionalProperties: false,
      },
      output: toolOutput,
      async execute(args) {
        const status = await operations.status()
        const id = args && typeof args.id === 'string' ? args.id : undefined
        if (id === undefined) return status
        const job = status.jobs.find((item) => item.id === id)
        if (!job) throw operationError('job_not_found', `未找到任务：${id}`)
        return { updatedAt: status.updatedAt, jobs: [job] }
      },
    })
    tools.register({
      name: 'noagent_run',
      description:
        'Run one no-agent scheduled script immediately, outside its schedule, and return the run record (exit code, duration, stderr tail).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact job id from noagent_status.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: toolOutput,
      async execute(args) {
        if (!args || typeof args.id !== 'string') {
          throw operationError('invalid_job_id', '必须提供任务 id')
        }
        return operations.run(args.id, { wait: true })
      },
    })
    tools.register({
      name: 'noagent_log',
      description:
        'Read the stdout/stderr log of the most recent run of one no-agent scheduled script.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact job id from noagent_status.' },
          limitBytes: {
            type: 'integer',
            description: 'Optional maximum number of trailing bytes to return.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: toolOutput,
      async execute(args) {
        if (!args || typeof args.id !== 'string') {
          throw operationError('invalid_job_id', '必须提供任务 id')
        }
        return operations.log(args.id, {
          limitBytes: Number.isFinite(args.limitBytes) ? args.limitBytes : undefined,
        })
      },
    })
    tools.register({
      name: 'noagent_update',
      description:
        'Change one no-agent job in jobs.json: enable/disable it, set its cron or everySeconds schedule, timeout, name or command. Omitted fields are left untouched (env, wakeOnChange and unknown fields are preserved) and a timestamped backup is written first.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact job id from noagent_status.' },
          enabled: { type: 'boolean', description: 'Enable or disable the job.' },
          cron: { type: 'string', description: 'Five-field cron expression (sets schedule mode to cron).' },
          everySeconds: {
            type: 'integer',
            minimum: 30,
            description: 'Interval in seconds (sets schedule mode to interval).',
          },
          timeZone: { type: 'string', description: 'IANA time zone, e.g. Asia/Shanghai.' },
          timeoutSeconds: { type: 'integer', minimum: 10, description: 'Run timeout in seconds.' },
          name: { type: 'string', description: 'Display name.' },
          command: { type: 'string', description: 'Shell command to run.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: toolOutput,
      async execute(args) {
        if (!args || typeof args.id !== 'string') {
          throw operationError('invalid_job_id', '必须提供任务 id')
        }
        const patch = {}
        for (const key of ['enabled', 'cron', 'everySeconds', 'timeZone', 'timeoutSeconds', 'name', 'command']) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        if (typeof args.cron === 'string') patch.mode = 'cron'
        if (args.everySeconds !== undefined) patch.mode = 'every'
        return operations.updateJob(args.id, patch)
      },
    })
  }

  // 可选服务：没有 Web 载体或 tools 服务的 profile 里插件照常运行。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], installWebRoute)
    ctx.inject(['tools'], installTools)
  } else {
    if (ctx.connection?.fetch) installWebRoute(ctx)
    if (ctx.tools) installTools(ctx)
  }
}
