/**
 * 计价与余额解析的自检（无依赖，直接 `node test/verify.mjs`）。
 *
 * 覆盖三件最容易算错的事：
 *  1. `inputTokens` 含缓存命中 → 未命中必须用减法，且绝不重复计费缓存前缀；
 *  2. 峰谷档位判定（工作日/周末/法定节假日，半开区间边界）；
 *  3. 余额响应解析（金额为字符串、多币种、total 与两项之和的关系）。
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_HOLIDAYS,
  PRICE_TABLE,
  beijingParts,
  classifyTier,
  computeCost,
  formatCountdown,
  nextTransition,
  ratesFor,
  resolveModelKey,
} from '../lib/pricing.js'
import { parseBalanceResponse } from '../lib/state.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${label}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 构造一个北京时间的毫秒时间戳（用固定 +08:00 反推 UTC）。 */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0)
}

console.log('\n[1] 价格表结构与「谷价 = 峰价 ÷ 2」')

check('两个模型档位齐全', () => {
  assert.deepEqual(Object.keys(PRICE_TABLE).sort(), ['deepseek-flash', 'deepseek-v4-pro'])
})

check('官方公布的六个峰价完全一致（元/百万 tokens）', () => {
  assert.deepEqual(PRICE_TABLE['deepseek-flash'].peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  assert.deepEqual(PRICE_TABLE['deepseek-v4-pro'].peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 })
})

check('每一条谷价都恰好是峰价的一半', () => {
  for (const [model, entry] of Object.entries(PRICE_TABLE)) {
    const off = ratesFor(model, 'offPeak')
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(off[key], entry.peak[key] / 2, `${model}.${key}`)
    }
  }
})

console.log('\n[2] 金额计算：互斥桶口径 + 口径自动判别')

check('官方口径：flash 谷时 1M 未命中输入 × 1 元 + 200k 输出 × 4 元 = 1.8 元', () => {
  const { cost } = computeCost({ inputTokens: 1_000_000, outputTokens: 200_000 }, ratesFor('deepseek-flash', 'offPeak'))
  assert.equal(Number(cost.toFixed(6)), 1.8)
})

check('同一次调用在峰时恰好翻倍（4 元 + 1.6 元 = 3.6 元）', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 200_000 }
  const off = computeCost(usage, ratesFor('deepseek-flash', 'offPeak')).cost
  const peak = computeCost(usage, ratesFor('deepseek-flash', 'peak')).cost
  assert.equal(Number(peak.toFixed(6)), 3.6)
  assert.equal(Number((peak / off).toFixed(9)), 2)
})

check('DSH 实际口径（Anthropic Messages，桶互斥）：缓存命中单独计价且不相减', () => {
  // dsh-llm-deepseek 映射 input_tokens→inputTokens、cache_read_input_tokens→cacheReadTokens，
  // 并合成 totalTokens = input + output + cacheRead + cacheWrite（互斥）。
  const usage = { inputTokens: 100_000, cacheReadTokens: 900_000, outputTokens: 0, totalTokens: 1_000_000 }
  const { cost, missTokens, hitTokens, convention } = computeCost(usage, ratesFor('deepseek-flash', 'peak'))
  assert.equal(convention, 'disjoint')
  assert.equal(missTokens, 100_000)
  assert.equal(hitTokens, 900_000)
  // 100k × 2 + 900k × 0.04 = 0.2 + 0.036 = 0.236 元
  assert.equal(Number(cost.toFixed(6)), 0.236)
})

check('全缓存命中仍有费用（互斥口径下 input 趋 0，缓存读照常计价）', () => {
  const usage = { inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }
  const { cost, convention } = computeCost(usage, ratesFor('deepseek-flash', 'offPeak'))
  assert.equal(convention, 'disjoint')
  // 1M × 0.02 = 0.02 元（旧实现会错误地返回 0）
  assert.equal(Number(cost.toFixed(6)), 0.02)
})

check('OpenAI 风格口径（输入已含缓存）自动做减法，避免重复计费', () => {
  // totalTokens 小于「各桶之和」⇒ input 含缓存 ⇒ 必须相减。
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 900_000, outputTokens: 0, totalTokens: 1_000_000 }
  const { cost, missTokens, hitTokens, convention } = computeCost(usage, ratesFor('deepseek-flash', 'peak'))
  assert.equal(convention, 'inclusive')
  assert.equal(missTokens, 100_000)
  assert.equal(hitTokens, 900_000)
  // 100k × 2 + 900k × 0.04 = 0.236 元；若错写 input×miss + read×hit 会得到 2.036 元
  assert.equal(Number(cost.toFixed(6)), 0.236)
  assert.notEqual(Number(cost.toFixed(6)), 2.036)
})

check('命中数超过总量时被钳制，不产生负的未命中（含缓存口径）', () => {
  const { missTokens, hitTokens } = computeCost(
    { inputTokens: 100, cacheReadTokens: 500, totalTokens: 200 },
    ratesFor('deepseek-flash', 'peak'),
  )
  assert.equal(missTokens, 0)
  assert.equal(hitTokens, 100)
})

check('reasoningTokens 属于 outputTokens，不再单独计价', () => {
  const withReasoning = computeCost({ inputTokens: 0, outputTokens: 1000, reasoningTokens: 800 }, ratesFor('deepseek-flash', 'peak'))
  const without = computeCost({ inputTokens: 0, outputTokens: 1000 }, ratesFor('deepseek-flash', 'peak'))
  assert.equal(withReasoning.cost, without.cost)
})

check('cacheWriteTokens 无官方价目，计 0', () => {
  const a = computeCost({ inputTokens: 1000, cacheWriteTokens: 999_999 }, ratesFor('deepseek-flash', 'peak'))
  const b = computeCost({ inputTokens: 1000 }, ratesFor('deepseek-flash', 'peak'))
  assert.equal(a.cost, b.cost)
})

check('pro 档位峰价更高：未命中 9 元 / 输出 27 元（对比 flash 的 2 / 8）', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  const flash = computeCost(usage, ratesFor('deepseek-flash', 'peak')).cost
  const pro = computeCost(usage, ratesFor('deepseek-v4-pro', 'peak')).cost
  assert.equal(flash, 2 + 8)
  assert.equal(pro, 9 + 27)
})

check('与官方账单同量级的真实样本：input 226 / cacheRead 51968 / output 1609（峰时）', () => {
  // 取自本机真实会话日志的一条 assistant/message 用量（互斥桶）。
  const usage = { inputTokens: 226, cacheReadTokens: 51_968, outputTokens: 1609, totalTokens: 53_803 }
  const { cost, convention } = computeCost(usage, ratesFor('deepseek-flash', 'peak'))
  assert.equal(convention, 'disjoint')
  // 226×2 + 51968×0.04 + 1609×8 = 0.000452 + 2.07872 + 12.872 = 14.951172 元
  assert.equal(Number(cost.toFixed(6)), Number((226 * 2 / 1e6 + 51_968 * 0.04 / 1e6 + 1609 * 8 / 1e6).toFixed(6)))
})

check('全缓存命中且 output=0 的调用仍要计费（不允许被当成「无 token」跳过）', () => {
  const { cost, missTokens, hitTokens } = computeCost(
    { inputTokens: 0, cacheReadTokens: 100_000, outputTokens: 0, totalTokens: 100_000 },
    ratesFor('deepseek-flash', 'offPeak'),
  )
  assert.equal(missTokens, 0)
  assert.equal(hitTokens, 100_000)
  // 100k × 0.02 = 0.002 元
  assert.equal(Number(cost.toFixed(6)), 0.002)
})

console.log('\n[3] 峰谷档位判定')

check('北京时间换算正确（含跨日）', () => {
  // UTC 2026-10-02 04:00 = 北京 12:00
  const parts = beijingParts(Date.UTC(2026, 9, 2, 4, 0))
  assert.equal(parts.date, '2026-10-02')
  assert.equal(parts.hour, 12)
})

check('工作日 09:00 起为高峰（半开区间含左端）', () => {
  // 2026-10-09 是周五
  assert.equal(classifyTier(beijing(2026, 10, 9, 8, 59)).tier, 'offPeak')
  assert.equal(classifyTier(beijing(2026, 10, 9, 9, 0)).tier, 'peak')
  assert.equal(classifyTier(beijing(2026, 10, 9, 11, 59)).tier, 'peak')
})

check('工作日 12:00 与 18:00 归入空闲（半开区间不含右端）', () => {
  assert.equal(classifyTier(beijing(2026, 10, 9, 12, 0)).tier, 'offPeak')
  assert.equal(classifyTier(beijing(2026, 10, 9, 14, 0)).tier, 'peak')
  assert.equal(classifyTier(beijing(2026, 10, 9, 17, 59)).tier, 'peak')
  assert.equal(classifyTier(beijing(2026, 10, 9, 18, 0)).tier, 'offPeak')
})

check('午休 12:00-14:00 为空闲', () => {
  assert.equal(classifyTier(beijing(2026, 10, 9, 13, 0)).tier, 'offPeak')
})

check('周六周日全天谷价', () => {
  // 2026-10-03 周六、2026-10-04 周日
  for (const hour of [0, 9, 10, 15, 23]) {
    assert.equal(classifyTier(beijing(2026, 10, 3, hour)).tier, 'offPeak', `周六 ${hour} 点`)
    assert.equal(classifyTier(beijing(2026, 10, 4, hour)).tier, 'offPeak', `周日 ${hour} 点`)
  }
})

check('法定节假日的整点高峰时段也按谷价（2026-10-02 国庆）', () => {
  assert.ok(DEFAULT_HOLIDAYS.includes('2026-10-02'))
  // 2026-10-02 是周五；10:00 本属高峰窗口，但节假日全天谷价。
  const result = classifyTier(beijing(2026, 10, 2, 10, 0))
  assert.equal(result.tier, 'offPeak')
  assert.equal(result.reason, 'holiday')
})

check('春节 2/23（2026 年周一）也是节假日，不能按高峰计费', () => {
  // 国务院办公厅 2026 年放假安排：春节 2 月 15 日至 23 日，2/23 为周一。
  assert.ok(DEFAULT_HOLIDAYS.includes('2026-02-23'), '2026-02-23 必须在节假日表内')
  const monday = beijing(2026, 2, 23, 10, 0) // 周一 10:00，本属高峰窗口
  const result = classifyTier(monday)
  assert.equal(result.tier, 'offPeak')
  assert.equal(result.reason, 'holiday')
})

check('节假日表只含合法日期，且都落在周一至周五（周末无需列）', () => {
  for (const date of DEFAULT_HOLIDAYS) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `非法日期 ${date}`)
    const [year, month, day] = date.split('-').map(Number)
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    assert.ok(weekday !== 0 && weekday !== 6, `${date} 落在周末，无需列入（周末本来就全天谷价）`)
  }
  assert.equal(new Set(DEFAULT_HOLIDAYS).size, DEFAULT_HOLIDAYS.length, '节假日表不应有重复项')
})

check('自定义节假日表可覆盖默认表（调休等场景）', () => {
  // 把某个普通周五加成节假日
  const result = classifyTier(beijing(2026, 10, 9, 10, 0), ['2026-10-09'])
  assert.equal(result.tier, 'offPeak')
  assert.equal(result.reason, 'holiday')
})

check('倒计时：高峰中指向窗口结束', () => {
  const at = beijing(2026, 10, 9, 10, 0) // 周五 10:00 高峰，12:00 结束
  const transition = nextTransition(at, DEFAULT_HOLIDAYS)
  assert.equal(transition.tier, 'peak')
  assert.equal(transition.untilMinutes, 120)
})

check('倒计时：谷时指向下一次高峰开始', () => {
  const at = beijing(2026, 10, 9, 8, 0) // 周五 08:00 谷时，09:00 进高峰
  const transition = nextTransition(at, DEFAULT_HOLIDAYS)
  assert.equal(transition.tier, 'offPeak')
  assert.equal(transition.untilMinutes, 60)
})

check('倒计时：周五 18:00 之后的下一次高峰是下周一 09:00', () => {
  const at = beijing(2026, 10, 9, 18, 0)
  const transition = nextTransition(at, DEFAULT_HOLIDAYS)
  assert.equal(transition.tier, 'offPeak')
  assert.equal(transition.untilMinutes, 3 * 24 * 60 - 18 * 60 + 9 * 60) // 周五18:00 → 周一09:00
})

check('倒计时文案可读', () => {
  assert.equal(formatCountdown(0), '0 分')
  assert.equal(formatCountdown(45), '45 分')
  assert.equal(formatCountdown(120), '2 小时')
  assert.equal(formatCountdown(138), '2 小时 18 分')
})

console.log('\n[4] 模型名归一')

check('官方两个模型名精确命中', () => {
  assert.equal(resolveModelKey('deepseek-flash').key, 'deepseek-flash')
  assert.equal(resolveModelKey('deepseek-v4-pro').key, 'deepseek-v4-pro')
})

check('已下线的旧模型名按 Flash 计费', () => {
  assert.equal(resolveModelKey('deepseek-v4-flash').key, 'deepseek-flash')
  assert.equal(resolveModelKey('deepseek-v4-flash-vision-exp').key, 'deepseek-flash')
  assert.equal(resolveModelKey('deepseek-chat').key, 'deepseek-flash')
  assert.equal(resolveModelKey('deepseek-reasoner').key, 'deepseek-flash')
})

check('Anthropic 兼容端点映射：opus → pro，其余 → flash', () => {
  assert.equal(resolveModelKey('claude-opus-4-1').key, 'deepseek-v4-pro')
  assert.equal(resolveModelKey('claude-sonnet-4-5').key, 'deepseek-flash')
  assert.equal(resolveModelKey('claude-haiku-4').key, 'deepseek-flash')
})

check('未知模型名回退到 Flash（宁可高估不漏计）', () => {
  assert.equal(resolveModelKey('some-local-model').key, 'deepseek-flash')
  assert.equal(resolveModelKey(undefined).key, 'deepseek-flash')
})

console.log('\n[5] 余额响应解析')

check('官方示例：110.00 = 10.00 赠金 + 100.00 充值', () => {
  const parsed = parseBalanceResponse({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  })
  assert.equal(parsed.total, 110)
  assert.equal(parsed.granted, 10)
  assert.equal(parsed.toppedUp, 100)
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.available, true)
})

check('金额是字符串也能解析，且保留小数', () => {
  const parsed = parseBalanceResponse({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '15.03', granted_balance: '0.03', topped_up_balance: '15.00' }],
  })
  assert.equal(parsed.total, 15.03)
})

check('多币种时优先选中指定币种', () => {
  const parsed = parseBalanceResponse({
    balance_infos: [
      { currency: 'USD', total_balance: '3.00', granted_balance: '0.00', topped_up_balance: '3.00' },
      { currency: 'CNY', total_balance: '21.00', granted_balance: '1.00', topped_up_balance: '20.00' },
    ],
  }, 'CNY')
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.total, 21)
})

check('total_balance 缺失时用赠金 + 充值兜底', () => {
  const parsed = parseBalanceResponse({
    balance_infos: [{ currency: 'CNY', granted_balance: '1.50', topped_up_balance: '2.25' }],
  })
  assert.equal(parsed.total, 3.75)
})

check('结构不可解析时返回 null，不抛异常', () => {
  assert.equal(parseBalanceResponse(null), null)
  assert.equal(parseBalanceResponse({}), null)
  assert.equal(parseBalanceResponse({ balance_infos: [] }), null)
  assert.equal(parseBalanceResponse({ balance_infos: [{ currency: 'CNY' }] }), null)
})

check('脏金额一律判为不可用，绝不解析出看似合理的错值', () => {
  // parseFloat 会把这些变成 1 / 12 / 10，比直接判 null 危险得多。
  for (const junk of ['1,234.56', '12abc', '¥10', '', ' ', '1e3', 'Infinity', '0x10']) {
    assert.equal(parseBalanceResponse({ balance_infos: [{ currency: 'CNY', total_balance: junk }] }), null, `应拒绝 ${JSON.stringify(junk)}`)
  }
})

check('负数余额被钳到 0，不会让 nonNegative 结果 schema 拒绝整次 RPC', () => {
  const parsed = parseBalanceResponse({
    balance_infos: [{ currency: 'CNY', total_balance: '-5.00', granted_balance: '-1.00', topped_up_balance: '-4.00' }],
  })
  assert.equal(parsed.total, 0)
  assert.equal(parsed.granted, 0)
  assert.equal(parsed.toppedUp, 0)
})

check('is_available 缺失时为 null，为 false 时如实透传', () => {
  assert.equal(parseBalanceResponse({ balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }).available, null)
  assert.equal(
    parseBalanceResponse({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }).available,
    false,
  )
})

check('nextTransition 必须落在真实的档位切换点，或如实报告未找到', () => {
  const probes = [
    beijing(2026, 10, 9, 8, 0), beijing(2026, 10, 9, 10, 0), beijing(2026, 10, 9, 12, 30),
    beijing(2026, 10, 9, 15, 0), beijing(2026, 10, 9, 18, 30), beijing(2026, 10, 3, 11, 0),
    beijing(2026, 10, 2, 11, 0),
  ]
  for (const at of probes) {
    const transition = nextTransition(at, DEFAULT_HOLIDAYS)
    assert.equal(transition.found, true, `应找到切换点 @ ${new Date(at).toISOString()}`)
    const before = classifyTier(transition.untilMs - 60000, DEFAULT_HOLIDAYS).tier
    const after = classifyTier(transition.untilMs, DEFAULT_HOLIDAYS).tier
    assert.equal(before, transition.tier, '切换前一分钟应仍是当前档位')
    assert.notEqual(after, transition.tier, '切换时刻应已换档')
  }
})

check('极端连续假期下如实返回「未找到」，不伪造切换点', () => {
  // 造 200 天连续节假日：120 天探测预算内不可能切换。
  const holidays = []
  const start = Date.UTC(2026, 10, 2)
  for (let i = 0; i < 200; i += 1) {
    const d = new Date(start + i * 86400000)
    const pad = (v) => String(v).padStart(2, '0')
    holidays.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`)
  }
  const transition = nextTransition(start, holidays)
  assert.equal(transition.found, false)
  assert.equal(transition.untilMs, start)
})

console.log(`\n${passed} 项通过，${failed} 项失败\n`)
if (failed > 0) process.exitCode = 1
