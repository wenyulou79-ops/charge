/**
 * 峰谷分时计价引擎（纯函数，零依赖，可独立测试）。
 *
 * 规则来源：官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *   北京时间周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00 为高峰时段；
 *   其余时段，包括周末及中国法定节假日全天均为空闲时段。
 *   空闲时段价格 = 高峰时段价格的一半。
 *
 * 计价口径（依据官方 Chat Completions 文档）：
 *   prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
 *   故 DSH 的 `inputTokens 是**含缓存命中**的提示词总量，cacheReadTokens 是其中命中的子集。
 *   金额 = (miss × 未命中价 + hit × 命中价 + output × 输出价) / 1e6
 *   - reasoningTokens ⊆ outputTokens，按普通输出计价，**不得另行相加**；
 *   - cacheWriteTokens 官方无对应价目，计 0。
 */

/** 北京时区固定偏移（中国无夏令时）。 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 高峰时段（北京时间，半开区间 [start, end)）。 */
export const PEAK_WINDOWS = [
  { startHour: 9, endHour: 12 },
  { startHour: 14, endHour: 18 },
]

/**
 * 中国法定节假日（全天按谷价计费），键为北京日期 `YYYY-MM-DD`。
 *
 * 该表可在插件配置的 `holidays` 中覆盖/追加（`YYYY-MM-DD` 数组）。周末本来就
 * 全谷价，因此这里只需列**落在周一至周五的法定节假日**；调休上班的周六周日
 * 官方同样全天谷价，故「周末一律谷价」的判断永远安全。
 *
 * 依据国务院办公厅《关于 2026 年部分节假日安排的通知》：春节为 2 月 15 日至
 * 23 日，其中 2 月 23 日（周一）是工作日形态的假日，必须列入，否则会被按高峰计费。
 */
export const DEFAULT_HOLIDAYS = [
  // 2026 年
  '2026-01-01', '2026-01-02', // 元旦
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', // 春节（2/15–2/23）
  '2026-04-06', // 清明节
  '2026-05-01', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', // 端午节
  '2026-09-25', // 中秋节
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆节
]

/**
 * 官方价格表：人民币 / 百万 tokens。
 * 高峰价为真源，谷价 = 高峰价 ÷ 2（官方声明）。
 */
export const PRICE_TABLE = {
  'deepseek-flash': {
    label: 'deepseek-flash',
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  },
  'deepseek-v4-pro': {
    label: 'deepseek-v4-pro',
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
}

/** 模型名归一：旧名/别名/第三方模型名落到实际计费档位。 */
const MODEL_ALIASES = [
  // 官方中文文档：旧模型名仍可调用，但由 V4.1-Flash 提供服务并按 Flash 价格计费。
  [/^deepseek-v4-flash/, 'deepseek-flash'],
  [/^deepseek-v4\.1-flash/, 'deepseek-flash'],
  [/^deepseek-flash/, 'deepseek-flash'],
  [/^deepseek-v4-pro/, 'deepseek-v4-pro'],
  [/^deepseek-pro/, 'deepseek-v4-pro'],
  // Anthropic 兼容端点映射：opus → V4 Pro，其余（sonnet/haiku）→ Flash。
  [/^claude.*opus/i, 'deepseek-v4-pro'],
  [/^claude/i, 'deepseek-flash'],
  // 已下线的历史模型名，一律按 Flash 计费。
  [/^deepseek-(chat|reasoner|coder)/, 'deepseek-flash'],
]

/** 无法识别的模型名回退档位（宁可高估也不要漏计）。 */
export const FALLBACK_MODEL = 'deepseek-flash'

/**
 * 把任意模型名归一到一个价格表键。
 * @param {string | undefined | null} model - 请求使用的模型名。
 * @returns {{ key: string, exact: boolean }} 命中的价格档位键，以及是否为精确匹配。
 */
export function resolveModelKey(model) {
  if (typeof model !== 'string' || model.length === 0) return { key: FALLBACK_MODEL, exact: false }
  const name = model.trim().toLowerCase()
  if (Object.hasOwn(PRICE_TABLE, name)) return { key: name, exact: true }
  for (const [pattern, key] of MODEL_ALIASES) {
    if (pattern.test(name)) return { key, exact: key === name }
  }
  return { key: FALLBACK_MODEL, exact: false }
}

/**
 * 取某模型在某档位的三档单价（元 / 百万 tokens）。
 * @param {string} modelKey - 归一后的价格表键。
 * @param {'peak' | 'offPeak'} tier - 价格档位。
 * @returns {{ cacheHit: number, cacheMiss: number, output: number }} 单价三元组。
 */
export function ratesFor(modelKey, tier) {
  const entry = PRICE_TABLE[modelKey] ?? PRICE_TABLE[FALLBACK_MODEL]
  const peak = entry.peak
  if (tier === 'peak') return { ...peak }
  return { cacheHit: peak.cacheHit / 2, cacheMiss: peak.cacheMiss / 2, output: peak.output / 2 }
}

/**
 * 把毫秒时间戳拆成北京时间的年月日时分与星期。
 * 用固定 +08:00 偏移换算，不依赖运行环境时区，也不用夏令时感知时区。
 * @param {number} atMs - 毫秒时间戳。
 * @returns {{ date: string, minutesOfDay: number, weekday: number, hour: number, minute: number }} 北京本地分量（weekday：0=周日）。
 */
export function beijingParts(atMs) {
  const shifted = new Date(atMs + BEIJING_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const hour = shifted.getUTCHours()
  const minute = shifted.getUTCMinutes()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    minutesOfDay: hour * 60 + minute,
    weekday: shifted.getUTCDay(),
    hour,
    minute,
  }
}

/**
 * 判定某一时刻属于高峰还是空闲档位。
 *
 * 边界约定采用半开区间：09:00 与 14:00 算高峰，12:00 与 18:00 算空闲。
 * 官方文档未明示边界归属，半开是「X - Y」的通行读法，且误差上限只有一瞬。
 * @param {number} atMs - 请求**发起**时刻的毫秒时间戳（官方口径为请求侧计时）。
 * @param {Set<string> | readonly string[]} holidays - 北京日期字符串集合。
 * @returns {{ tier: 'peak' | 'offPeak', reason: string, parts: ReturnType<typeof beijingParts> }} 档位判定结果。
 */
export function classifyTier(atMs, holidays = DEFAULT_HOLIDAYS) {
  const parts = beijingParts(atMs)
  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays)
  if (parts.weekday === 0 || parts.weekday === 6) {
    return { tier: 'offPeak', reason: 'weekend', parts }
  }
  if (holidaySet.has(parts.date)) {
    return { tier: 'offPeak', reason: 'holiday', parts }
  }
  for (const window of PEAK_WINDOWS) {
    if (parts.minutesOfDay >= window.startHour * 60 && parts.minutesOfDay < window.endHour * 60) {
      return { tier: 'peak', reason: 'peak-window', parts }
    }
  }
  return { tier: 'offPeak', reason: 'off-peak-window', parts }
}

/**
 * 计算一次调用的费用（元）。
 *
 * ## 为什么必须自动判别「含缓存」还是「不含缓存」
 *
 * 两种 API 约定的 `input tokens` 含义不同，同一条公式无法同时正确：
 *
 * - **Anthropic Messages 约定（DSH 的 DeepSeek 适配器实际使用的）**：
 *   `input_tokens` 只统计**未命中**前缀，`cache_read_input_tokens` 是另一桶。
 *   适配器据此显式合成 `totalTokens = input + output + cacheRead + cacheWrite`
 *   （见 `dsh-llm-deepseek`：`usage.totalTokens = usage.inputTokens + usage.outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)`），
 *   三条桶因此**互不重叠**，直接各自计价即可，**不能**再相减。
 * - **OpenAI 风格约定**：`prompt_tokens` 已包含缓存命中，此时必须做减法，
 *   否则缓存前缀会被重复计费。
 *
 * 判别依据用 `totalTokens`（两种约定自洽的必要条件）：
 * `input + cacheRead + cacheWrite + output` 若**超过** `totalTokens`，说明
 * input 把缓存读也算了进去（含缓存口径），需要相减；否则各桶互斥，直接计价。
 * 判别不确定时（无 `totalTokens`）按 DSH 实际口径（互斥）处理。
 *
 * reasoning 属 output 子集、cache write 无官方价目，两者都不额外加价。
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number, totalTokens?: number }} usage - 用量桶。
 * @param {{ cacheHit: number, cacheMiss: number, output: number }} rates - 单价三元组（元 / 百万 tokens）。
 * @returns {{ cost: number, missTokens: number, hitTokens: number, outputTokens: number, reasoningTokens: number, convention: 'disjoint' | 'inclusive' }} 费用与归一后的 token 明细。
 */
export function computeCost(usage, rates) {
  const rawInput = toCount(usage?.inputTokens)
  const output = toCount(usage?.outputTokens)
  const rawCacheRead = toCount(usage?.cacheReadTokens)
  const cacheWrite = toCount(usage?.cacheWriteTokens)
  const total = toCount(usage?.totalTokens)

  // 含缓存口径时，input + cacheRead + cacheWrite + output 会超过 totalTokens
  // （因为 prompt 已被 input 计过一次），据此判别。
  //
  // 特别提醒：**不能**用「cacheRead > input」当作含缓存的证据。DSH 的 DeepSeek
  // 适配器走 Anthropic Messages 协议，真实流量里缓存读远大于未命中输入是常态
  // （本机 618 条真实样本中 614 条如此），那种判据会把正常的互斥桶误判成含缓存
  // 口径，进而把绝大多数 token 漏计。
  const sumDisjoint = rawInput + rawCacheRead + cacheWrite + output
  const inclusive = total > 0 && sumDisjoint > total

  const hit = inclusive ? Math.min(rawCacheRead, rawInput) : rawCacheRead
  const miss = inclusive ? Math.max(0, rawInput - hit) : rawInput
  const reasoning = Math.min(toCount(usage?.reasoningTokens), output)
  const cost = (miss * rates.cacheMiss + hit * rates.cacheHit + output * rates.output) / 1e6
  return {
    cost,
    missTokens: miss,
    hitTokens: hit,
    outputTokens: output,
    reasoningTokens: reasoning,
    convention: inclusive ? 'inclusive' : 'disjoint',
  }
}

/** 把任意输入归一为非负安全整数。 */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 在当前时刻所处档位的**结束**时刻（毫秒时间戳）。
 *
 * 高峰中 → 本次高峰窗口结束；空闲中 → 下一次高峰窗口开始。
 * 先按天跳到档位可能变化的那一天，再在该天内逐分钟定位，因此即使遇到
 * 连续数十天的节假日（用户自定义 holidays 也可能如此）也能给出**真实的**
 * 切换点，而不是伪造一个并不切换时刻。
 * @param {number} atMs - 基准时刻。
 * @param {Set<string> | readonly string[]} holidays - 北京日期集合。
 * @returns {{ tier: 'peak' | 'offPeak', reason: string, untilMs: number, untilMinutes: number, found: boolean }} 当前档位与其结束时刻。
 */
export function nextTransition(atMs, holidays = DEFAULT_HOLIDAYS) {
  const now = classifyTier(atMs, holidays)
  // 对齐到下一分钟，避免秒级抖动导致倒计时跳字。
  const start = Math.floor(atMs / 60000) * 60000
  const MAX_MINUTES = 120 * 24 * 60 // 120 天：足以覆盖任意真实的连续假期
  for (let minute = 1; minute <= MAX_MINUTES; minute += 1) {
    const probe = start + minute * 60000
    if (classifyTier(probe, holidays).tier !== now.tier) {
      return {
        tier: now.tier,
        reason: now.reason,
        untilMs: probe,
        untilMinutes: Math.round((probe - atMs) / 60000),
        found: true,
      }
    }
  }
  // 120 天内都没有切换（只可能来自极端自定义 holidays）：如实报告未知，
  // 由调用方决定如何呈现，绝不假装出一个切换时刻。
  return { tier: now.tier, reason: now.reason, untilMs: atMs, untilMinutes: 0, found: false }
}

/**
 * 人类可读的倒计时文案，例如 `2 小时 13 分`。
 * 非有限输入按 0 处理（宿主 schema 已保证数值合法，这里只做兜底）。
 * @param {number} minutes - 剩余分钟数。
 * @returns {string} 文案。
 */
export function formatCountdown(minutes) {
  const value = Number(minutes)
  const total = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (hours <= 0) return `${rest} 分`
  if (rest === 0) return `${hours} 小时`
  return `${hours} 小时 ${rest} 分`
}
