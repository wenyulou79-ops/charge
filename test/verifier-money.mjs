/**
 * ADVERSARIAL MONEY MATH TEST — dsh-live-cost-meter/lib/pricing.js `computeCost`.
 *
 * This file encodes TWO billing frames on purpose, because they disagree and the
 * disagreement is the headline defect:
 *
 *  Frame P (provider / Chat-Completions docs): `inputTokens` is the INCLUSIVE
 *    prompt total, so miss = inputTokens - cacheReadTokens.
 *  Frame D (DeepSeek Harness `TokenUsage`, what the plugin actually receives):
 *    `inputTokens` is the UNCACHED input; cache buckets are DISJOINT and additive.
 *    Evidence (shipped runtime, @deepseek-ai/dsh-token-meter 0.2.0-rc.2):
 *      lib/types/usage-projection.js:14-19  bucketsFrom: uncachedInputTokens: usage.inputTokens
 *      lib/types/index.js:16-22             "Sum disjoint provider usage buckets ..."
 *      lib/types/turn-usage.js:32-48        totalTokens - outputTokens === inputTokens + cacheRead + cacheWrite
 *      dsh-llm-deepseek/lib/index.js:1808-1821 (input_tokens -> inputTokens,
 *        cache_read_input_tokens -> cacheReadTokens) and :1993
 *        totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
 *
 * Section [A2] asserts Frame D and therefore FAILS: that failure is defect #1.
 * Every other section must pass.
 *
 * run: node test/verifier-money.mjs
 */
import { PRICE_TABLE, computeCost, ratesFor, resolveModelKey } from '../lib/pricing.js'
import { check, close, eq, note, report, section } from './_verifier-harness.mjs'

const flashPeak = ratesFor('deepseek-flash', 'peak')
const flashOff = ratesFor('deepseek-flash', 'offPeak')
const proPeak = ratesFor('deepseek-v4-pro', 'peak')
const proOff = ratesFor('deepseek-v4-pro', 'offPeak')

console.log('price table under test:', JSON.stringify(PRICE_TABLE))

// ─────────────────────────────────────────────────────────────────────────────
section('A0 price table: official peak prices and exact half-price off-peak')
const OFFICIAL = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
}
for (const [model, peak] of Object.entries(OFFICIAL)) {
  const rates = ratesFor(model, 'peak')
  eq(`${model} peak cacheHit`, rates.cacheHit, peak.cacheHit)
  eq(`${model} peak cacheMiss`, rates.cacheMiss, peak.cacheMiss)
  eq(`${model} peak output`, rates.output, peak.output)
  const off = ratesFor(model, 'offPeak')
  eq(`${model} offPeak = peak/2 (cacheHit)`, off.cacheHit, peak.cacheHit / 2)
  eq(`${model} offPeak = peak/2 (cacheMiss)`, off.cacheMiss, peak.cacheMiss / 2)
  eq(`${model} offPeak = peak/2 (output)`, off.output, peak.output / 2)
}

// ─────────────────────────────────────────────────────────────────────────────
section('A1 hand-computed money (buckets DISJOINT — the verified DSH convention) — must pass')
// Each expectation is written out arithmetically, independently of the code path.
//
// 注意口径：本节的 `cacheReadTokens` 是**独立的**一桶（Frame D），
// 因此总 prompt token = inputTokens + cacheReadTokens，二者不相减。
{
  // real observed call: 35 prompt / 16 completion / no cache, flash off-peak
  // (35*1 + 0*0.02 + 16*4)/1e6 = 99/1e6 = 0.000099
  const r = computeCost({ inputTokens: 35, outputTokens: 16, cacheReadTokens: 0 }, flashOff)
  close('35 in / 16 out / 0 hit @ flash off-peak = 0.000099 元', r.cost, 99 / 1e6, 0)
  eq('  missTokens', r.missTokens, 35)
  eq('  hitTokens', r.hitTokens, 0)

  // flash peak: 1000 uncached + 900 cache-hit + 500 out
  // (1000*2 + 900*0.04 + 500*8)/1e6 = (2000+36+4000)/1e6 = 0.006036
  const a = computeCost({ inputTokens: 1000, cacheReadTokens: 900, outputTokens: 500 }, flashPeak)
  close('1000 in / 900 hit / 500 out @ flash peak = 0.006036 元', a.cost, (2000 + 36 + 4000) / 1e6, 0)
  eq('  every bucket billed exactly once', a.hitTokens + a.missTokens, 1000 + 900)

  // pro off-peak: 1M uncached + 250k cached + 100k out
  // (1e6*4.5 + 250000*0.15 + 100000*13.5)/1e6 = (4500000+37500+1350000)/1e6 = 5.8875
  const b = computeCost({ inputTokens: 1_000_000, cacheReadTokens: 250_000, outputTokens: 100_000 }, proOff)
  close('1M in / 250k hit / 100k out @ pro off-peak = 5.8875 元', b.cost, 5_887_500 / 1e6, 0)

  // 2M uncached + 2M cached, flash peak: (2e6*2 + 2e6*0.04)/1e6 = 4.08
  const c = computeCost({ inputTokens: 2_000_000, cacheReadTokens: 2_000_000, outputTokens: 0 }, flashPeak)
  close('2M in / 2M hit / 0 out @ flash peak = 4.08 元', c.cost, 4.08, 0)

  // pro peak, 1536 uncached + 1024 hit + 300 out
  // (1536*9 + 1024*0.3 + 300*27)/1e6 = (13824+307.2+8100)/1e6 = 0.0222312
  const d = computeCost({ inputTokens: 1536, cacheReadTokens: 1024, outputTokens: 300 }, proPeak)
  close('1536 in / 1024 hit / 300 out @ pro peak = 0.0222312 元', d.cost, (13_824 + 307.2 + 8100) / 1e6, 0)

  // reasoning is a subset of output: identical cost with/without the field
  const withReasoning = computeCost({ inputTokens: 1000, outputTokens: 800, reasoningTokens: 800 }, flashPeak)
  const withoutReasoning = computeCost({ inputTokens: 1000, outputTokens: 800 }, flashPeak)
  close('reasoningTokens must not be added again', withReasoning.cost, (1000 * 2 + 800 * 8) / 1e6, 0)
  eq('  cost identical with/without reasoningTokens', withReasoning.cost, withoutReasoning.cost)
  eq('  reasoningTokens clamped to output', withReasoning.reasoningTokens, 800)

  // cacheWriteTokens has no official price -> contributes 0
  const write = computeCost({ inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 1_000_000 }, flashPeak)
  close('cacheWriteTokens contributes 0', write.cost, (1000 * 2) / 1e6, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
section('A2 the DISJOINT case that used to under-bill (was defect #1) — now must pass')
note('Frame D is the contract of the object the plugin is fed; verified by 2878/2878 real log samples.')
note('run test/convention-lock.mjs for the real-log guard.')
{
  // realistic steady-state multi-turn call (cache is warm)
  // correct: (100*1 + 50000*0.02 + 200*4)/1e6 = (100+1000+800)/1e6 = 0.0019
  const u = { inputTokens: 100, cacheReadTokens: 50_000, outputTokens: 200, totalTokens: 50_300 }
  const got = computeCost(u, flashOff)
  close('100 uncached / 50k hit / 200 out @ flash off-peak = 0.0019 元 (DSH semantics)', got.cost, (100 + 1000 + 800) / 1e6, 0)
  check(
    'every reported token is billed exactly once (missTokens + hitTokens === uncached + cacheRead)',
    got.missTokens + got.hitTokens === 100 + 50_000,
    `missTokens=${got.missTokens} + hitTokens=${got.hitTokens} = ${got.missTokens + got.hitTokens}, `
      + `but the provider reported 100 uncached + 50000 cache-read = 50100 tokens; `
      + `the clamp min(cacheRead, input) silently drops ${50_000 - got.hitTokens} tokens`,
  )

  // fully cached prompt
  const fully = computeCost({ inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 }, flashPeak)
  close('fully cached 1M prompt @ flash peak = 0.04 元 (DSH semantics)', fully.cost, 0.04, 0)

  // pro peak, 512 uncached + 120k cached + 300 out
  // correct: (512*9 + 120000*0.3 + 300*27)/1e6 = (4608+36000+8100)/1e6 = 0.048708
  const pro = computeCost({ inputTokens: 512, cacheReadTokens: 120_000, outputTokens: 300 }, proPeak)
  close('512 uncached / 120k hit / 300 out @ pro peak = 0.048708 元 (DSH semantics)', pro.cost, (4608 + 36000 + 8100) / 1e6, 0)

  // the two frames only agree when there is no cache read at all
  const noCache = computeCost({ inputTokens: 5000, outputTokens: 100 }, flashPeak)
  close('frame P === frame D when cacheReadTokens = 0', noCache.cost, (5000 * 2 + 100 * 8) / 1e6, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
section('A3 robustness edges (must never produce NaN / negative / Infinity)')
{
  const zero = computeCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, flashPeak)
  eq('all-zero usage costs 0', zero.cost, 0)

  const junk = computeCost(
    { inputTokens: NaN, outputTokens: -5, cacheReadTokens: '100', cacheWriteTokens: undefined, reasoningTokens: Infinity },
    flashPeak,
  )
  eq('NaN / negative / string / undefined fields cost 0', junk.cost, 0)

  const huge = computeCost({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, flashPeak)
  close(
    'MAX_SAFE_INTEGER input @ flash peak stays finite and exact',
    huge.cost,
    (Number.MAX_SAFE_INTEGER * 2) / 1e6,
    1e-15,
  )
  check('MAX_SAFE_INTEGER cost is finite', Number.isFinite(huge.cost), `got ${huge.cost}`)

  // 互斥口径（Frame D）下 cacheRead 与 input 是两桶，真实流量里 cacheRead > input
  // 是常态，因此**不应**把它钳到 input——那会丢掉绝大多数缓存 token。
  const overHit = computeCost({ inputTokens: 100, cacheReadTokens: 1_000_000, outputTokens: 0 }, flashPeak)
  eq('cacheRead is an independent bucket (not clamped to input)', overHit.hitTokens, 1_000_000)
  eq('disjoint input is billed in full', overHit.missTokens, 100)
  check('cost is finite and positive', Number.isFinite(overHit.cost) && overHit.cost > 0, `got ${overHit.cost}`)

  // 含缓存口径（提供方用 OpenAI 语义时）仍必须钳制，绝不产生负的未命中。
  const inclusiveOverHit = computeCost(
    { inputTokens: 100, cacheReadTokens: 1_000_000, outputTokens: 0, totalTokens: 200 },
    flashPeak,
  )
  eq('inclusive convention clamps hit to input', inclusiveOverHit.hitTokens, 100)
  eq('inclusive convention never yields negative miss', inclusiveOverHit.missTokens, 0)

  eq('undefined usage costs 0', computeCost(undefined, flashPeak).cost, 0)
  eq('null usage costs 0', computeCost(null, flashPeak).cost, 0)

  const frac = computeCost({ inputTokens: 10.9, outputTokens: 3.7 }, flashOff)
  close('fractional counts floor before pricing', frac.cost, (10 * 1 + 3 * 4) / 1e6, 0)

  const withTotal = computeCost({ inputTokens: 100, outputTokens: 0, totalTokens: 1_000_000 }, flashPeak)
  close('totalTokens is ignored (not a second charge source)', withTotal.cost, (100 * 2) / 1e6, 0)
}

section('A4 model alias resolution')
{
  eq('deepseek-flash exact', resolveModelKey('deepseek-flash').key, 'deepseek-flash')
  eq('deepseek-v4-pro exact', resolveModelKey('deepseek-v4-pro').key, 'deepseek-v4-pro')
  eq('unknown model falls back to flash', resolveModelKey('gpt-4o').key, 'deepseek-flash')
  eq('empty model falls back to flash', resolveModelKey('').key, 'deepseek-flash')
  eq('undefined model falls back to flash', resolveModelKey(undefined).key, 'deepseek-flash')
  eq('claude opus maps to pro', resolveModelKey('claude-3-opus').key, 'deepseek-v4-pro')
}

report('verifier-money')
