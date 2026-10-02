/**
 * 会话投影单元：把「逐轮 token 用量」在**请求发起时刻**按当时峰谷档位计价，
 * 得到可直接展示的金额。
 *
 * 为什么必须在宿主侧投影里计价：一次会话常常跨越峰谷边界，客户端只拿到累计
 * token 就无法还原「哪一段是在峰时跑的」。本单元在事件上按 event.time 判档，
 * 因此跨档会话的金额天然正确。状态严格遵循 `apply(state, event)` 纯同步折叠、
 * 无关事件返回同一引用的约定。
 */

import { z } from 'zod'
import { classifyTier, computeCost, nextTransition, ratesFor, resolveModelKey } from './pricing.js'

const nonNegative = z.number().nonnegative()
const count = z.number().int().nonnegative()

/** 一个 token 桶组：未命中输入 / 输出 / 缓存命中 / 缓存写入。 */
const bucketsSchema = z.object({
  uncachedInputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
}).strict()

const emptyBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

const bucketsEqual = (left, right) =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

/** 一轮对话的成本明细。 */
const turnCostSchema = z.object({
  turn: count,
  cost: nonNegative,
  calls: count,
  peakCost: nonNegative,
  offPeakCost: nonNegative,
  buckets: bucketsSchema,
  /** 该轮内出现过的计费档位（跨档时两者都有）。 */
  tiers: z.array(z.enum(['peak', 'offPeak'])),
}).strict()

/** 对外视图：客户端直接消费的完整金额与用量。 */
export const costViewSchema = z.object({
  /** 本会话累计金额（元）。 */
  cost: nonNegative,
  /** 本会话累计调用次数。 */
  calls: count,
  /** 累计 token 桶。 */
  buckets: bucketsSchema,
  /** 峰时/谷时金额拆分，便于解释「为什么这轮贵」。 */
  peakCost: nonNegative,
  offPeakCost: nonNegative,
  /** 逐轮明细（按轮次升序）。 */
  turns: z.array(turnCostSchema),
}).strict()

/** 折叠状态：视图 + 增量定位所需的边界字段。 */
const costStateSchema = costViewSchema.extend({
  lastTurn: count.nullable(),
  lastStep: count.nullable(),
  /** 已计入的最后一条日志事件 seq，用于对同一条事件幂等去重。 */
  lastSeq: count.nullable(),
}).strict()

const zeroTurn = (turn) => ({
  turn,
  cost: 0,
  calls: 0,
  peakCost: 0,
  offPeakCost: 0,
  buckets: emptyBuckets(),
  tiers: [],
})

/**
 * 从一次 assistant 结算事件中取出用量样本。
 *
 * 会话日志里的 `stream` 是 `AssistantStreamRecord[]`，用量块藏在
 * `{ type: 'chunk', time, chunk: { type: 'usage', usage } }` 这一层里
 * （早期实现直接读 `record.type === 'usage'`，因此永远取不到样本、金额恒为 0）。
 * `assistant/message` 也可能直接带 `data.usage`，优先用它。
 * 样本缺失时不算钱（不猜）。
 * @param {object} event - 会话事件。
 * @returns {object | undefined} 用量样本。
 */
function usageOf(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== undefined && data.usage !== null) return data.usage
  const stream = data.stream
  if (Array.isArray(stream)) {
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      const record = stream[index]
      if (record === null || typeof record !== 'object') continue
      const chunk = record.chunk ?? record
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage != null) {
        return chunk.usage
      }
    }
  }
  return undefined
}

/**
 * 取该次调用的模型名。
 * @param {object} event - 会话事件。
 * @returns {string | undefined} 模型名。
 */
function modelOf(event) {
  const source = event?.data?.message?.source
  if (source !== null && typeof source === 'object' && typeof source.model === 'string') return source.model
  return undefined
}

/** 会话投影单元定义（`costUsage`）。 */
export function createCostUsageProjection(getHolidays) {
  return {
    key: 'costUsage',
    stateVersion: 1,
    stateSchema: costStateSchema,
    init: () => ({
      cost: 0,
      calls: 0,
      buckets: emptyBuckets(),
      peakCost: 0,
      offPeakCost: 0,
      turns: [],
      lastTurn: null,
      lastStep: null,
      lastSeq: null,
    }),
    apply: (state, event) => {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
      const usage = usageOf(event)
      if (usage === undefined || usage === null || typeof usage !== 'object') return state
      const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : 0
      const step = Number.isSafeInteger(event.data?.step) ? event.data.step : 0
      const seq = Number.isSafeInteger(event.seq) ? event.seq : null
      // 幂等护栏：只在「同一条日志事件被重复驱动」时跳过（seq 唯一）。
      // 早期版本按 (turn, step) 去重，会误伤同一步骤内合法的第二次结算
      // （例如一次尝试追加了一条 assistant/message 后同一步又有新的用量样本），
      // 那属于漏计，比重复计费更危险，因此改为按 seq 判定。
      if (seq !== null && state.lastSeq === seq) return state

      const atMs = Number.isFinite(event.time) ? event.time : Date.now()
      const { tier } = classifyTier(atMs, getHolidays())
      const { key: modelKey } = resolveModelKey(modelOf(event))
      const rates = ratesFor(modelKey, tier)
      const money = computeCost(usage, rates)

      const bucketDelta = {
        uncachedInputTokens: money.missTokens,
        outputTokens: money.outputTokens,
        cacheReadTokens: money.hitTokens,
        cacheWriteTokens: 0,
      }
      const nextBuckets = {
        uncachedInputTokens: state.buckets.uncachedInputTokens + bucketDelta.uncachedInputTokens,
        outputTokens: state.buckets.outputTokens + bucketDelta.outputTokens,
        cacheReadTokens: state.buckets.cacheReadTokens + bucketDelta.cacheReadTokens,
        cacheWriteTokens: state.buckets.cacheWriteTokens + bucketDelta.cacheWriteTokens,
      }
      const peakCost = state.peakCost + (tier === 'peak' ? money.cost : 0)
      const offPeakCost = state.offPeakCost + (tier === 'offPeak' ? money.cost : 0)

      const lastIndex = state.turns.length - 1
      const previousTurn = lastIndex >= 0 ? state.turns[lastIndex] : undefined
      let nextTurns
      if (previousTurn !== undefined && previousTurn.turn === turn) {
        nextTurns = state.turns.slice()
        nextTurns[lastIndex] = {
          turn,
          cost: previousTurn.cost + money.cost,
          calls: previousTurn.calls + 1,
          peakCost: previousTurn.peakCost + (tier === 'peak' ? money.cost : 0),
          offPeakCost: previousTurn.offPeakCost + (tier === 'offPeak' ? money.cost : 0),
          buckets: {
            uncachedInputTokens: previousTurn.buckets.uncachedInputTokens + bucketDelta.uncachedInputTokens,
            outputTokens: previousTurn.buckets.outputTokens + bucketDelta.outputTokens,
            cacheReadTokens: previousTurn.buckets.cacheReadTokens + bucketDelta.cacheReadTokens,
            cacheWriteTokens: previousTurn.buckets.cacheWriteTokens + bucketDelta.cacheWriteTokens,
          },
          tiers: previousTurn.tiers.includes(tier) ? previousTurn.tiers : [...previousTurn.tiers, tier],
        }
      } else {
        nextTurns = state.turns.concat([{
          turn,
          cost: money.cost,
          calls: 1,
          peakCost: tier === 'peak' ? money.cost : 0,
          offPeakCost: tier === 'offPeak' ? money.cost : 0,
          buckets: bucketDelta,
          tiers: [tier],
        }])
      }
      // 只保留最近 200 轮，避免长会话把视图撑大（累计值不受影响）。
      if (nextTurns.length > 200) nextTurns = nextTurns.slice(nextTurns.length - 200)

      return {
        cost: state.cost + money.cost,
        calls: state.calls + 1,
        buckets: nextBuckets,
        peakCost,
        offPeakCost,
        turns: nextTurns,
        lastTurn: turn,
        lastStep: step,
        lastSeq: seq,
      }
    },
    wire: {
      viewSchema: costViewSchema,
      view: (state) => ({
        cost: state.cost,
        calls: state.calls,
        buckets: state.buckets,
        peakCost: state.peakCost,
        offPeakCost: state.offPeakCost,
        turns: state.turns,
      }),
    },
  }
}

/** 复用的档位查询，供客户端与宿主共用同一份规则。 */
export { classifyTier, nextTransition }
