// Exercise the costUsage projection through the REAL projection registry:
// register the unit, drive committed events, and read the wire view.
//
// 需要能解析 DSH 包：设置 DSH_NODE_MODULES=<dir> 或作为第一个参数传入。
// usage: node test/projection.mjs [dshNodeModulesDir]
import assert from 'node:assert/strict'
import { dshNodeModules, dshPackageUrl, hasDshPackages, skip } from './_env.mjs'

const DSH_NODE_MODULES = dshNodeModules()
if (!hasDshPackages(DSH_NODE_MODULES)) {
  skip('未提供 DSH 包目录（本测试需要真实的 @deepseek-ai/dsh-session 与 dsh-session-projection）。')
}
const load = async (specifier) => import(dshPackageUrl(DSH_NODE_MODULES, specifier))

const { Context } = await load('@deepseek-ai/cordis')
const sessionPlugin = await load('@deepseek-ai/dsh-session')
const projectionPlugin = await load('@deepseek-ai/dsh-session-projection')
const { createCostUsageProjection, costViewSchema } = await import('../lib/projection.js')

const ctx = new Context()
ctx.plugin(sessionPlugin.default ?? sessionPlugin, {})
ctx.plugin(projectionPlugin.default ?? projectionPlugin, {})
await new Promise((resolve) => setTimeout(resolve, 500))

assert.ok(ctx.sessionProjections !== undefined, 'sessionProjections service must exist')
// Pin the holiday set to include 2026-10-02 (2026 National Day), the Beijing date the
// expectations below assume, so the tier is off-peak regardless of when this runs.
ctx.sessionProjections.register(createCostUsageProjection(() => new Set(['2026-10-02'])))

const sessions = ctx.sessions
const session = sessions.create()

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

/** Append one assistant settlement carrying a usage sample. */
const settle = (turn, step, usage) => session.append('assistant/message', {
  turn,
  step,
  message: {
    role: 'assistant',
    id: 'm',
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
    content: [{ type: 'text', text: 'ok' }],
  },
  stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }],
}, { surfaceOp: 'append' })

const view = () => costViewSchema.parse(ctx.sessionProjections.snapshot(session, ['costUsage']).values.costUsage)

check('empty session → zero view', () => {
  const v = view()
  assert.equal(v.cost, 0)
  assert.equal(v.calls, 0)
  assert.deepEqual(v.turns, [])
})

// 2026-10-02 14:00 Beijing = a National Day holiday ⇒ off-peak. 1M miss + 0 out at flash off-peak = 1.0 元
settle(0, 0, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })
check('one call: 1M uncached input at flash off-peak = 1.0 元', () => {
  const v = view()
  assert.equal(Number(v.cost.toFixed(6)), 1)
  assert.equal(v.calls, 1)
  assert.equal(v.offPeakCost, v.cost)
  assert.equal(v.peakCost, 0)
  assert.equal(v.turns.length, 1)
  assert.equal(v.turns[0].turn, 0)
  assert.equal(v.turns[0].calls, 1)
})

// 桶互斥口径（DSH 的 DeepSeek 适配器走 Anthropic Messages）：
// cacheReadTokens 是**独立**的一桶，不再从 inputTokens 中相减。
settle(0, 1, { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 900_000, totalTokens: 1_000_000 })
check('缓存命中单独计价且不相减（0.1M×1 + 0.9M×0.02 = 0.118 元）', () => {
  const v = view()
  assert.equal(Number(v.cost.toFixed(6)), 1.118)
  assert.equal(v.buckets.uncachedInputTokens, 1_100_000)
  assert.equal(v.buckets.cacheReadTokens, 900_000)
})

check('second call in the same turn accumulates into the same turn row', () => {
  const v = view()
  assert.equal(v.turns.length, 1)
  assert.equal(v.turns[0].calls, 2)
  assert.equal(Number(v.turns[0].cost.toFixed(6)), 1.118)
})

// a NEW turn creates a new row
settle(1, 0, { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0 })
check('a new turn creates a new row (100k out at flash off-peak = 0.4 元)', () => {
  const v = view()
  assert.equal(v.turns.length, 2)
  assert.equal(v.turns[1].turn, 1)
  assert.equal(v.turns[1].calls, 1)
  assert.equal(Number(v.turns[1].cost.toFixed(6)), 0.4)
  assert.equal(Number(v.cost.toFixed(6)), 1.518)
})

// idempotence guard is per event seq: a genuinely new event with the SAME (turn, step)
// must still be counted (this is the bug the naive (turn,step) dedupe would drop).
settle(1, 0, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })
check('a second settlement at the SAME (turn,step) is still counted', () => {
  const v = view()
  assert.equal(v.calls, 4)
  assert.equal(v.turns[1].calls, 2)
  assert.equal(Number(v.turns[1].cost.toFixed(6)), 1.4)
})

check('wire view carries no internal fold fields', () => {
  const v = view()
  assert.equal('lastSeq' in v, false)
  assert.equal('lastTurn' in v, false)
  assert.equal('lastStep' in v, false)
})

check('reasoning tokens are inside output, never extra', () => {
  const before = view().cost
  settle(2, 0, { inputTokens: 0, outputTokens: 1000, reasoningTokens: 1000, cacheReadTokens: 0 })
  const v = view()
  assert.equal(Number((v.cost - before).toFixed(8)), Number((1000 * 4 / 1e6).toFixed(8)))
})

check('events of other types leave the state reference untouched', () => {
  const state = ctx.sessionProjections.stateOf(session, 'costUsage')
  session.append('turn/start', { turn: 3 })
  const after = ctx.sessionProjections.stateOf(session, 'costUsage')
  assert.equal(after, state, 'an unrelated event must not produce a new state object')
})

console.log(`\n${passed} 项通过，${failed} 项失败\n`)
if (failed > 0) process.exitCode = 1
process.exit(process.exitCode ?? 0)
