/**
 * ADVERSARIAL PROJECTION TEST — dsh-live-cost-meter/lib/projection.js (`costUsage`).
 *
 * Contract sources (shipped runtime, @deepseek-ai/dsh-session / dsh-token-meter):
 *  - `apply(state, event)` must return the SAME state reference for events it ignores.
 *  - Session event map (dsh-api-session-controller/lib/typert.host.js:2133):
 *      'assistant/message': { turn, step, message, stream: AssistantStreamRecord[], usage?: TokenUsage, interrupted? }
 *      'assistant/attempt': { turn, step, stream: AssistantStreamRecord[] }
 *  - Stream records are WRAPPED: { type: 'chunk', time, chunk } (dsh-llm/lib/types/assistant-stream.js:72,106)
 *    and the official reader is
 *      lastAssistantStreamChunk(stream, type) => record.type === 'chunk' && record.chunk.type === type
 *    (dsh-llm/lib/types/assistant-stream.js:304-311)
 *  - Official bucket mapping (dsh-token-meter/lib/types/usage-projection.js:14-19):
 *      uncachedInputTokens: usage.inputTokens
 *
 * run: node test/verifier-projection.mjs
 */
import { costViewSchema, createCostUsageProjection } from '../lib/projection.js'
import { check, close, eq, note, report, section } from './_verifier-harness.mjs'

const projection = createCostUsageProjection(() => [])
const HOUR = 3_600_000
// pick a Wednesday 10:00 Beijing = peak, so the tier is deterministic
const PEAK = Date.UTC(2026, 9, 14, 2, 0) // 2026-10-14 10:00 Beijing (Wednesday)

/** one durable settlement event, in the real log shape */
function messageEvent({ seq, turn = 0, step = 0, usage, model = 'deepseek-flash', time = PEAK, stream = [] }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: { content: [], source: { provider: 'deepseek-official', model } },
      ...(usage === undefined ? {} : { usage }),
      stream,
    },
  }
}
function attemptEvent({ seq, turn = 0, step = 0, time = PEAK, stream = [] }) {
  return { type: 'assistant/attempt', seq, time, data: { turn, step, stream } }
}
/** real durable stream record: the chunk is nested under `chunk` */
const wrappedUsageChunk = (usage) => ({ type: 'chunk', time: PEAK, chunk: { type: 'usage', usage } })
/** what the plugin's scanner expects (raw chunk at the top level) */
const rawUsageChunk = (usage) => ({ type: 'usage', usage })

function fold(events, from = projection.init()) {
  let state = from
  for (const event of events) state = projection.apply(state, event)
  return state
}

section('P1 apply() must return the same reference for ignored events')
{
  const state = projection.init()
  const ignored = [
    { type: 'turn/start', seq: 1, time: PEAK, data: { turn: 0 } },
    { type: 'step/start', seq: 2, time: PEAK, data: { turn: 0, step: 0 } },
    { type: 'user/message', seq: 3, time: PEAK, data: {} },
    { type: 'tool/call', seq: 4, time: PEAK, data: { turn: 0, step: 0 } },
    { type: 'tool/result', seq: 5, time: PEAK, data: {} },
    { type: 'step/end', seq: 6, time: PEAK, data: { turn: 0, step: 0 } },
    { type: 'turn/end', seq: 7, time: PEAK, data: { turn: 0 } },
    { type: 'assistant/message', seq: 8, time: PEAK, data: { turn: 0, step: 0, message: { source: { model: 'deepseek-flash' } }, stream: [] } },
    { type: 'assistant/message', seq: 9, time: PEAK, data: { turn: 0, step: 0, message: { source: { model: 'x' } }, usage: null, stream: [] } },
    { type: 'assistant/attempt', seq: 10, time: PEAK, data: { turn: 0, step: 0, stream: [] } },
    { type: 'future/unknown', seq: 11, time: PEAK, data: { usage: { inputTokens: 5, outputTokens: 5 } } },
  ]
  for (const event of ignored) {
    const next = projection.apply(state, event)
    check(`ignored ${event.type} (seq ${event.seq}) returns the same reference`, next === state,
      `returned a new object: ${JSON.stringify(next).slice(0, 120)}`)
  }
}

section('P2 exactly-once: seq dedupe vs legitimate repeats')
{
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 }
  const one = messageEvent({ seq: 10, usage })
  const state1 = fold([one])
  eq('first settlement counted', state1.calls, 1)
  const state2 = projection.apply(state1, one)
  check('re-driving the SAME seq is idempotent (same reference)', state2 === state1, 'a repeated event double counted')
  eq('  calls stay 1', state1.calls, 1)

  // Two DIFFERENT settlements in one step: a failed attempt (assistant/attempt)
  // followed by a successful one (assistant/message). Both cost real money, so both
  // must count. The task brief worried a (turn, step) dedupe could drop one.
  const withAttempt = fold([
    attemptEvent({ seq: 20, turn: 1, step: 0, stream: [rawUsageChunk(usage)] }),
    messageEvent({ seq: 21, turn: 1, step: 0, usage }),
  ])
  check('two distinct seqs in one step are both counted (no wrongful (turn,step) dedupe)', withAttempt.calls === 2,
    `calls=${withAttempt.calls} (brief's suspected bug: NOT present)`)
  eq('  both land in the same turn bucket', withAttempt.turns.length, 1)
  eq('  turn calls', withAttempt.turns[0].calls, 2)

  const twoTurns = fold([
    messageEvent({ seq: 30, turn: 0, usage }),
    messageEvent({ seq: 31, turn: 1, step: 0, usage }),
  ])
  eq('different turns create two buckets', twoTurns.turns.length, 2)
  eq('  ascending turn order', twoTurns.turns.map((t) => t.turn).join(','), '0,1')
}

section('P3 assistant/attempt usage extraction from the real stream record shape')
{
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 }
  const real = fold([attemptEvent({ seq: 40, stream: [wrappedUsageChunk(usage)] })])
  check(
    'assistant/attempt with a REAL {type:"chunk",chunk:{type:"usage"}} record is priced',
    real.calls === 1,
    `calls=${real.calls} cost=${real.cost}: usageOf() must unwrap the durable record `
      + '(official reader: lastAssistantStreamChunk -> record.chunk.type). '
      + 'Regression guard: revision 14:52 read record.type and priced every retried attempt at 0.',
  )
  const raw = fold([attemptEvent({ seq: 41, stream: [rawUsageChunk(usage)] })])
  eq('assistant/attempt with a raw (non-durable) usage chunk also priced (lenient)', raw.calls, 1)
  note('the durable log stores the wrapped shape; both shapes are accepted as of the 15:07 revision')
  const truncated = fold([attemptEvent({ seq: 43, stream: [wrappedUsageChunk({ inputTokens: 10, outputTokens: 1 }), wrappedUsageChunk(usage)] })])
  eq('the LAST usage record wins', truncated.buckets.outputTokens, 100)

  const withMessage = fold([messageEvent({ seq: 42, usage })])
  eq('assistant/message with data.usage is priced', withMessage.calls, 1)
  const bothSources = fold([messageEvent({ seq: 43, usage, stream: [wrappedUsageChunk({ inputTokens: 9, outputTokens: 9 })] })])
  eq('data.usage wins over the stream sample (no double count inside one event)', bothSources.calls, 1)
  eq('  priced from data.usage', bothSources.buckets.outputTokens, 100)
}

section('P4 DSH bucket semantics: uncachedInputTokens must equal usage.inputTokens')
{
  const usage = { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50_000 }
  const state = fold([messageEvent({ seq: 50, usage })])
  eq('buckets.uncachedInputTokens === usage.inputTokens (official bucketsFrom)', state.buckets.uncachedInputTokens, 100)
  eq('buckets.cacheReadTokens === usage.cacheReadTokens', state.buckets.cacheReadTokens, 50_000)
  check('total billed tokens === input + cacheRead + output',
    state.buckets.uncachedInputTokens + state.buckets.cacheReadTokens + state.buckets.outputTokens === 100 + 50_000 + 200,
    `got ${state.buckets.uncachedInputTokens} + ${state.buckets.cacheReadTokens} + ${state.buckets.outputTokens}; `
      + 'computeCost clamps hit to input, dropping every cached token beyond the uncached count',
  )
}

section('P5 tier selection uses event.time, model uses message.source.model')
{
  const offPeak = Date.UTC(2026, 9, 14, 12, 0) // 20:00 Beijing, still Wednesday
  const state = fold([
    messageEvent({ seq: 60, turn: 0, usage: { inputTokens: 1_000_000, outputTokens: 0 }, time: offPeak }),
    messageEvent({ seq: 61, turn: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 }, time: PEAK, model: 'deepseek-v4-pro' }),
  ])
  close('off-peak leg priced at flash off-peak (1M misses = 1.00)', state.offPeakCost, 1.0, 1e-12)
  close('peak leg priced at pro peak (1M misses = 9.00)', state.peakCost, 9.0, 1e-12)
  eq('one tier per turn bucket', state.turns.map((t) => t.tiers.join('+')).join(','), 'offPeak,peak')

  const crossTier = fold([
    messageEvent({ seq: 63, turn: 0, usage: { inputTokens: 1_000_000, outputTokens: 0 }, time: offPeak }),
    messageEvent({ seq: 64, turn: 0, usage: { inputTokens: 1_000_000, outputTokens: 0 }, time: PEAK, model: 'deepseek-v4-pro' }),
  ])
  eq('a turn crossing the boundary records both tiers once', crossTier.turns[0].tiers.join('+'), 'offPeak+peak')
  eq('  no duplicated tier entry', crossTier.turns[0].tiers.length, 2)

  const attemptOnly = fold([attemptEvent({ seq: 62, stream: [rawUsageChunk({ inputTokens: 1_000_000, outputTokens: 0 })] })])
  close('assistant/attempt has no message -> falls back to flash rates (1M misses @ flash peak = 2.00)', attemptOnly.cost, 2.0, 1e-12)
  note('assistant/attempt carries no message, so a retried v4-pro attempt at peak is priced 2.00 instead of 9.00')
}

section('P6 state shape, wire view, and React-free immutability')
{
  const init = projection.init()
  const parsedInit = projection.stateSchema.safeParse(init)
  check('init() satisfies its own stateSchema', parsedInit.success, JSON.stringify(parsedInit.error?.issues ?? []))
  const state = fold([
    messageEvent({ seq: 70, usage: { inputTokens: 10, outputTokens: 5 } }),
    attemptEvent({ seq: 71, turn: 0, step: 1, stream: [rawUsageChunk({ inputTokens: 7, outputTokens: 3 })] }),
  ])
  const parsedState = projection.stateSchema.safeParse(state)
  check('apply() result satisfies stateSchema', parsedState.success, JSON.stringify(parsedState.error?.issues ?? []))
  const view = projection.wire.view(state)
  const parsedView = costViewSchema.safeParse(view)
  check('wire.view() satisfies costViewSchema', parsedView.success, JSON.stringify(parsedView.error?.issues ?? []))
  check('view exposes no internal fields', !('lastSeq' in view) && !('lastStep' in view), `keys: ${Object.keys(view)}`)

  // the session-projection contract may hand out frozen state
  const frozen = Object.freeze({
    ...init,
    buckets: Object.freeze(init.buckets),
    turns: Object.freeze([]),
  })
  let threw = null
  try {
    projection.apply(frozen, messageEvent({ seq: 80, usage: { inputTokens: 10, outputTokens: 5 } }))
  } catch (error) {
    threw = error
  }
  check('apply() does not mutate a frozen input state', threw === null, `threw ${String(threw)}`)

  // lastStep / lastTurn are written but never read
  const stepped = fold([messageEvent({ seq: 90, turn: 2, step: 3, usage: { inputTokens: 1, outputTokens: 1 } })])
  eq('lastTurn recorded', stepped.lastTurn, 2)
  eq('lastStep recorded', stepped.lastStep, 3)
  note('lastTurn/lastStep are write-only: no branch in apply() reads them (dedupe is seq-only)')
}

section('P7 turn cap and cumulative totals')
{
  const events = []
  for (let turn = 0; turn < 250; turn += 1) {
    events.push(messageEvent({ seq: 100 + turn, turn, usage: { inputTokens: 1_000_000, outputTokens: 0 }, time: Date.UTC(2026, 9, 14, 12, 0) }))
  }
  const state = fold(events)
  eq('turns array capped at 200', state.turns.length, 200)
  eq('  keeps the newest turns', state.turns.at(-1).turn, 249)
  eq('  drops the oldest', state.turns[0].turn, 50)
  eq('  cumulative calls not truncated', state.calls, 250)
  close('  cumulative cost not truncated', state.cost, 250 * 1.0, 1e-9)
  note('turns is capped but cost/calls/buckets/peakCost/offPeakCost are cumulative, so the dock (last turn) is right while per-turn history is partial')
}

report('verifier-projection')
