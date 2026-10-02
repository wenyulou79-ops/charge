/**
 * 宿主侧状态：DSH_HOME 定位、插件配置、以及「官方余额 + 本地账本插值」的余额模型。
 *
 * 余额精度策略：
 *   官方 `GET /user/balance` 是权威值，但它有查询延迟、且金额只有 2 位小数。
 *   若直接用「上次官方值 − 此后本地累计费用」无限外推，舍入误差会逐次累积。
 *   本模块改用**锚点重置**：每次刷新成功就把锚点重置为最新官方值，
 *   中间一律用本地逐笔账本外推，因此误差永不累积，只会回到官方值。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 官方余额端点（相对 baseURL）。 */
export const BALANCE_PATH = '/user/balance'

/** 官方余额端点的默认 baseURL。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 插件配置默认值。 */
export const DEFAULT_CONFIG = {
  /** 追加/覆盖的中国法定节假日（北京日期 `YYYY-MM-DD`）。 */
  holidays: [],
  /**
   * 官方余额自动刷新间隔（毫秒）。
   *
   * 这个值直接决定「显示值与官方真值能差多远」：锚点越旧，本地外推的偏差窗口越长。
   * 30 秒是准确度与请求量之间的折中（官方余额端点很轻，但仍不该每秒打）。
   */
  balanceRefreshMs: 30_000,
  /** 余额端点缓存有效期（毫秒）。 */
  balanceCacheMs: 10_000,
  /** 单次余额查询超时（毫秒）：没有超时会导致刷新永久停摆。 */
  balanceTimeoutMs: 12_000,
  /** 是否把本地账本落盘（关闭后仅内存统计）。 */
  persistLedger: true,
  /** 显示币种。 */
  currency: 'CNY',
  /** 余额查询使用的凭据名（DSH 凭据库 / 环境变量同名引用）。 */
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  /** 余额查询的 API baseURL（仅使用官方域名）。 */
  baseURL: DEFAULT_BASE_URL,
}

/**
 * 解析 DSH_HOME。优先环境变量，其次用户目录下的 `.dsh`。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量表。
 * @param {string} [home] - 用户目录。
 * @returns {string} DSH_HOME 绝对路径。
 */
export function resolveDshHome(env = process.env, home = undefined) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const base = home ?? env?.USERPROFILE ?? env?.HOME ?? process.cwd()
  return path.join(base, '.dsh')
}

/** 本地账本目录。 */
export function ledgerDir(env = process.env) {
  return path.join(resolveDshHome(env), 'storages', 'dsh-live-cost-meter')
}

/** 本地账本文件。 */
export function ledgerFile(env = process.env) {
  return path.join(ledgerDir(env), 'ledger.json')
}

/**
 * 把配置补丁合并到基础配置上。
 *
 * 关键点：结果**逐字段构造**，绝不先展开 `patch`。早期实现先 `{...base, ...patch}`
 * 再逐个覆盖，非法值会残留在结果里；随后 zod 校验读到非法枚举就整对象拒绝，
 * `.default({})` 又把默认值顶上来，于是「写错一个字段」会静默丢掉全部行配置
 * （USD → CNY 就是这么来的）。逐字段构造从根上消除这条路径。
 *
 * `base` 为 undefined/null 时才使用内置默认值；非法字段一律忽略并保留基础值。
 * @param {object | undefined} base - 基础配置。
 * @param {object} patch - 补丁。
 * @returns {object} 合并结果。
 */
export function mergeConfig(base, patch) {
  const source = base === undefined || base === null ? DEFAULT_CONFIG : base
  const patchObject = patch !== null && typeof patch === 'object' ? patch : {}
  /** 补丁里该字段是否存在（存在才尝试覆盖）。 */
  const has = (key) => Object.hasOwn(patchObject, key)

  /**
   * 校验一个补丁字段：合法则采用，非法则**回退到基础值**（基础值再非法才用内置默认）。
   * @param {string} key - 字段名。
   * @param {(value: unknown) => boolean} valid - 合法性判定。
   * @param {(value: unknown) => object} coerce - 合法值的归一化。
   * @returns {unknown} 最终取值。
   */
  const resolveField = (key, valid, coerce) => {
    if (has(key) && valid(patchObject[key])) return coerce(patchObject[key])
    const fallback = source[key]
    if (fallback !== undefined && valid(fallback)) return coerce(fallback)
    return DEFAULT_CONFIG[key]
  }

  const next = { ...DEFAULT_CONFIG }

  // holidays：部分非法只采纳合法项；整批非法保留基础值；空数组表示清空。
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const holidaysValue = has('holidays') ? patchObject.holidays : source.holidays
  if (Array.isArray(holidaysValue)) {
    const kept = holidaysValue.filter(isDate)
    const baseHolidays = Array.isArray(source.holidays) ? source.holidays : []
    next.holidays = kept.length > 0 || holidaysValue.length === 0 ? kept : baseHolidays
  }

  for (const key of ['balanceRefreshMs', 'balanceCacheMs', 'balanceTimeoutMs']) {
    next[key] = resolveField(key, (value) => Number.isFinite(Number(value)) && Number(value) >= 5_000, (value) => Math.floor(Number(value)))
  }
  // 缓存窗口不该大于刷新间隔，否则自动刷新会被自己的缓存挡掉。
  if (next.balanceCacheMs > next.balanceRefreshMs) next.balanceCacheMs = Math.floor(next.balanceRefreshMs / 2)
  next.persistLedger = resolveField('persistLedger', (value) => typeof value === 'boolean', (value) => value)
  next.currency = resolveField('currency', (value) => value === 'CNY' || value === 'USD', (value) => value)
  next.apiKeyEnv = resolveField(
    'apiKeyEnv',
    (value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
    (value) => value,
  )
  next.baseURL = resolveField('baseURL', (value) => typeof value === 'string' && /^https?:\/\//.test(value), (value) => value)

  return next
}

/**
 * 本地账本：逐笔记录每次调用的 token 与金额，并按「日期 + 会话」聚合。
 *
 * 结构刻意保持扁平，便于直接 JSON 落盘与增量追加。
 */
export class Ledger {
  /**
   * @param {object} [options] - 账本选项。
   * @param {string} [options.file] - 账本文件路径；省略则只保留在内存。
   * @param {boolean} [options.persist] - 是否落盘。
   */
  constructor({ file, persist = true } = {}) {
    this.file = file
    this.persist = persist && typeof file === 'string' && file.length > 0
    /** @type {Array<object>} 逐笔记录。 */
    this.entries = []
    /** @type {Record<string, number>} 按北京日期累计金额。 */
    this.byDate = {}
    /** @type {Record<string, { cost: number, calls: number, tokens: number }>} 按会话累计。 */
    this.bySession = {}
    /** 累计总金额（元）。 */
    this.totalCost = 0
    /** 累计调用次数。 */
    this.totalCalls = 0
    this.#dirty = false
    this.#timer = null
  }

  #dirty
  #timer

  /** 从磁盘载入账本；文件缺失或损坏时静默从空账本开始。 */
  load() {
    if (!this.persist) return this
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        if (Array.isArray(parsed.entries)) this.entries = parsed.entries
        if (parsed.byDate !== null && typeof parsed.byDate === 'object') this.byDate = parsed.byDate
        if (parsed.bySession !== null && typeof parsed.bySession === 'object') this.bySession = parsed.bySession
        if (Number.isFinite(parsed.totalCost)) this.totalCost = parsed.totalCost
        if (Number.isFinite(parsed.totalCalls)) this.totalCalls = parsed.totalCalls
      }
    } catch {
      // 首次运行或文件损坏：从空账本开始，不影响宿主启动。
    }
    return this
  }

  /**
   * 记一笔调用。
   * @param {object} entry - 一次调用的计费事实。
   * @param {string} entry.date - 北京日期 `YYYY-MM-DD`。
   * @param {string} [entry.sessionId] - 会话 id。
   * @param {string} entry.model - 归一后的价格档位键。
   * @param {'peak' | 'offPeak'} entry.tier - 计费档位。
   * @param {number} entry.cost - 金额（元）。
   */
  add(entry) {
    this.entries.push(entry)
    // 内存中只保留最近 5000 笔明细，聚合值不受影响。
    if (this.entries.length > 5000) this.entries.splice(0, this.entries.length - 5000)
    const date = entry.date
    this.byDate[date] = (this.byDate[date] ?? 0) + entry.cost
    const sessionKey = typeof entry.sessionId === 'string' && entry.sessionId.length > 0 ? entry.sessionId : '(none)'
    const bucket = this.bySession[sessionKey] ?? { cost: 0, calls: 0, tokens: 0 }
    bucket.cost += entry.cost
    bucket.calls += 1
    bucket.tokens += (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)
    this.bySession[sessionKey] = bucket
    this.totalCost += entry.cost
    this.totalCalls += 1
    this.#markDirty()
  }

  /** 取某北京日期的累计金额。 */
  costOfDate(date) {
    return this.byDate[date] ?? 0
  }

  /** 取某会话的累计统计。 */
  sessionStats(sessionId) {
    return this.bySession[sessionId] ?? { cost: 0, calls: 0, tokens: 0 }
  }

  #markDirty() {
    this.#dirty = true
    if (!this.persist || this.#timer !== null) return
    // 合并 2 秒内的写入，避免每轮对话都同步落盘。
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.flush()
    }, 2000)
    this.#timer.unref?.()
  }

  /** 立即把账本写入磁盘（原子替换）。 */
  flush() {
    // 注意：`resetLedger()` 会清空内容后主动置脏再调用本方法，
    // 因此这里不能以 `#dirty` 为前置条件提前返回，否则清空结果不落盘。
    if (!this.persist) return
    this.#dirty = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        totalCost: this.totalCost,
        totalCalls: this.totalCalls,
        byDate: this.byDate,
        bySession: this.bySession,
        entries: this.entries,
      })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, this.file)
    } catch {
      // 落盘失败不应影响对话：内存统计仍然可用。
    }
  }

  /** 释放定时器并落盘。 */
  dispose() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#dirty = true
    this.flush()
  }
}

/**
 * 余额模型：官方锚点 + 本地外推。
 *
 * `official` 是最近一次成功查询到的官方总额（元）；`anchorSpend` 是该次查询
 * 发生时的本地累计费用。任何时刻的展示余额 = official − (当前累计 − anchorSpend)。
 */
export class BalanceModel {
  constructor() {
    /** @type {{ total: number, granted: number, toppedUp: number, currency: string, at: number } | null} */
    this.official = null
    /** 官方值对应的本地累计费用锚点。 */
    this.anchorSpend = 0
    /** 最近一次查询失败原因。 */
    this.error = null
    /** 最近一次查询返回的 `is_available`。 */
    this.available = null
    /** 最近一次尝试查询的时刻。 */
    this.attemptedAt = 0
    /**
     * 最近一次「对账」结果：官方读数下降了多少 vs 本地账本同期记录了多少。
     *
     * `drift > 0` 表示官方余额掉得比本地账本记的多——即**本进程没观察到的花费**
     * （同一个 API Key 在别处使用、或其他客户端）。这是差异的诚实解释，
     * 而不是靠调参把数字凑上去。
     * @type {{ at: number, observedDrop: number, ledgerDelta: number, drift: number } | null}
     */
    this.lastReconcile = null
    /** 累计未观察到的差额（自插件加载起）。 */
    this.unobservedSpend = 0
  }

  /**
   * 记录一次成功的官方查询，重置锚点，并做一次对账。
   * @param {{ total: number, granted: number, toppedUp: number, currency: string }} value - 官方读数。
   * @param {number} currentSpend - 当前本地累计费用。
   * @param {number} at - 查询时刻。
   * @param {boolean | null} available - 官方 `is_available`。
   */
  commit(value, currentSpend, at, available) {
    const previous = this.official
    if (previous !== null) {
      // 官方余额只给 2 位小数，单次差值可能被四舍五入放大；只在跨过可辨阈值时计数。
      const observedDrop = previous.total - value.total
      const ledgerDelta = currentSpend - this.anchorSpend
      const drift = observedDrop - ledgerDelta
      this.lastReconcile = { at, observedDrop, ledgerDelta, drift }
      if (drift > 0.01) this.unobservedSpend += drift
    }
    this.official = { ...value, at }
    this.anchorSpend = currentSpend
    this.error = null
    this.available = available
    this.attemptedAt = at
  }

  /** 记录一次失败的查询，保留上一次成功值。 */
  fail(message, at) {
    this.error = message
    this.attemptedAt = at
  }

  /**
   * 计算当前展示余额。
   * @param {number} currentSpend - 当前本地累计费用。
   * @param {number} [nowMs] - 当前时刻，用于计算读数年龄。
   * @param {number} [staleAfterMs] - 超过多久算「读数陈旧」。
   * @returns {{ total: number, granted: number, toppedUp: number, currency: string, at: number, ageMs: number, stale: boolean, estSpendSince: number, available: boolean | null } | null} 展示用余额。
   */
  view(currentSpend, nowMs = Date.now(), staleAfterMs = 180_000) {
    if (this.official === null) return null
    const estSpendSince = Math.max(0, currentSpend - this.anchorSpend)
    const ageMs = Math.max(0, nowMs - this.official.at)
    return {
      total: Math.max(0, this.official.total - estSpendSince),
      granted: this.official.granted,
      toppedUp: this.official.toppedUp,
      currency: this.official.currency,
      at: this.official.at,
      ageMs,
      // 「陈旧」有两个独立来源：最近一次查询失败，或读数已经太久没更新
      // （例如网络悬挂导致自动刷新停摆）。两者都必须让界面看得见。
      stale: this.error !== null || ageMs > staleAfterMs,
      estSpendSince,
      // 官方 is_available：false 表示账户当前不可调用（余额可能仍大于 0），
      // 必须让界面能看到，否则「已停用」与「健康」长得一模一样。
      available: this.available,
    }
  }
}

/**
 * 解析官方余额响应。
 *
 * 官方结构（`GET /user/balance`）：
 *   `{ is_available: boolean, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`
 *   三个金额字段都是**字符串**。
 * @param {unknown} payload - 已解析的响应 JSON。
 * @param {string} [preferredCurrency] - 优先选择的币种。
 * @returns {{ total: number, granted: number, toppedUp: number, currency: string, available: boolean | null } | null} 归一后的余额，无法解析时返回 null。
 */
export function parseBalanceResponse(payload, preferredCurrency = 'CNY') {
  if (payload === null || typeof payload !== 'object') return null
  const infos = payload.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) return null
  const wallet =
    infos.find((item) => item?.currency === preferredCurrency) ??
    infos.find((item) => item?.currency === 'CNY') ??
    infos[0]
  if (wallet === null || typeof wallet !== 'object') return null
  const total = parseMoney(wallet.total_balance)
  const granted = parseMoney(wallet.granted_balance)
  const toppedUp = parseMoney(wallet.topped_up_balance)
  // `total_balance` 缺失时才用「赠金 + 充值」兜底。
  //
  // 注意区分「缺失」与「存在但无法解析」：后者说明接口契约变了或数据脏了，
  // 此时若还用分项相加去凑一个总额，就会把垃圾数据伪装成正常余额展示。
  // 因此只有字段**不存在**（undefined）才走兜底，存在但非法一律判为不可用。
  const totalMissing = wallet.total_balance === undefined || wallet.total_balance === null
  const resolvedTotal = total ?? (totalMissing && granted !== null && toppedUp !== null ? granted + toppedUp : null)
  if (resolvedTotal === null) return null
  // 脏数据（负值、千分位、带单位后缀）一律钳到 0：绝不下发负余额，
  // 否则 typert 的 nonNegative 结果 schema 会在出网前拒绝整次 RPC。
  return {
    total: Math.max(0, resolvedTotal),
    granted: Math.max(0, granted ?? 0),
    toppedUp: Math.max(0, toppedUp ?? 0),
    currency: typeof wallet.currency === 'string' ? wallet.currency : preferredCurrency,
    available: typeof payload.is_available === 'boolean' ? payload.is_available : null,
  }
}

/**
 * 解析金额字符串/数字。
 *
 * 只接受「纯十进制数字」（可带正负号与小数），因此 `'1,234.56'`、`'12abc'`、
 * `'¥10'`、`''` 一律返回 null —— 用 `parseFloat` 会把它们解析成 1 / 12 这种
 * 看似合理的错值，比直接判为不可用危险得多。
 * @param {unknown} value - 原始字段。
 * @returns {number | null} 金额，或 null。
 */
function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null
  const parsed = Number.parseFloat(text)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 查询官方余额。
 *
 * **必须带超时。** 没有超时的一次网络悬挂会让上层的 single-flight 永远占位，
 * 之后的每次自动刷新都短路返回那个永不落地的 promise，余额就永久冻结在旧读数上
 * ——表现为「官方余额一直在降，插件却纹丝不动」。用 AbortSignal.timeout 保证
 * 请求一定在有限时间内落定。
 * @param {object} options - 查询参数。
 * @param {string} options.apiKey - API Key。
 * @param {string} [options.baseURL] - API baseURL。
 * @param {string} [options.currency] - 优先币种。
 * @param {AbortSignal} [options.signal] - 外部取消信号。
 * @param {number} [options.timeoutMs] - 超时毫秒数（默认 12 秒）。
 * @returns {Promise<{ total: number, granted: number, toppedUp: number, currency: string, available: boolean | null }>} 官方余额。
 */
export async function fetchOfficialBalance({
  apiKey,
  baseURL = DEFAULT_BASE_URL,
  currency = 'CNY',
  signal,
  timeoutMs = 12_000,
}) {
  const url = `${String(baseURL).replace(/\/+$/, '')}${BALANCE_PATH}`
  const limit = Math.max(1_000, Number(timeoutMs) || 12_000)
  const timeoutSignal = AbortSignal.timeout(limit)
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: combined,
    })
  } catch (error) {
    // 超时与普通网络错误要区分：前者是「这一次没读到，可重试」，后者是「读不到」。
    if (timeoutSignal.aborted) throw new Error(`余额查询超时（>${limit} ms）`)
    throw error
  }
  if (!response.ok) {
    throw new Error(`余额查询失败：HTTP ${response.status} ${response.statusText}`)
  }
  const payload = await response.json()
  const parsed = parseBalanceResponse(payload, currency)
  if (parsed === null) throw new Error('余额查询失败：响应结构无法解析')
  return parsed
}
