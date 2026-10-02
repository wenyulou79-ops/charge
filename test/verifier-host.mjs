/**
 * ADVERSARIAL HOST TEST — dsh-live-cost-meter/lib/index.js (apply(), llm/stream wrapper,
 * ledger, costMeter service) and lib/state.js Ledger persistence.
 *
 * A fake Cordis context drives the real plugin: nothing is mocked inside the plugin,
 * only the host surface it uses (on/effect/get/provide/inject).
 * The ledger is redirected into test/.tmp-verifier-home via DSH_HOME, and globalThis.fetch
 * is stubbed so NO real network request can leave the process.
 *
 * run: node test/verifier-host.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_HOLIDAYS } from '../lib/pricing.js'
import { check, close, eq, note, report, section } from './_verifier-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = path.join(HERE, '.tmp-verifier-home')
if (!TMP_ROOT.startsWith(HERE)) throw new Error(`refusing to use ${TMP_ROOT}`)
fs.rmSync(TMP_ROOT, { recursive: true, force: true })

process.env.DCM_VERIFIER_KEY = 'not-a-real-key-verifier-only'
delete process.env.DEEPSEEK_API_KEY

const HOLIDAYS = new Set(DEFAULT_HOLIDAYS)

/** independent tier computation (same rule as verifier-tier.mjs) */
function tierNow(atMs = Date.now()) {
  const d = new Date(atMs + 8 * 3_600_000)
  const wd = d.getUTCDay()
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  if (wd === 0 || wd === 6) return { tier: 'offPeak', reason: 'weekend', date }
  if (HOLIDAYS.has(date)) return { tier: 'offPeak', reason: 'holiday', date }
  if ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)) return { tier: 'peak', reason: 'peak-window', date }
  return { tier: 'offPeak', reason: 'off-peak-window', date }
}
const PEAK_PRICES = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
}
/** independent cost for the cacheRead = 0 case (both frames agree there) */
function priceUncached(model, tier, input, output) {
  const p = PEAK_PRICES[model]
  const f = tier === 'peak' ? 1 : 0.5
  return (input * p.cacheMiss * f + output * p.output * f) / 1e6
}

// ── fake Cordis host ────────────────────────────────────────────────────────
function makeCtx() {
  const listeners = new Map()
  const effects = []
  const services = new Map()
  const injected = []
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    effect(fn, label) {
      effects.push({ fn, label })
    },
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
    },
    inject(deps, cb) {
      injected.push({ deps, cb })
    },
    listeners,
    effects,
    services,
    injected,
  }
}

const { apply, stateSchema } = await import('../lib/index.js')

let caseIndex = 0
/** boot the plugin against a fresh DSH_HOME and return its handles */
async function boot(config = {}) {
  caseIndex += 1
  const home = path.join(TMP_ROOT, `case-${caseIndex}`)
  process.env.DSH_HOME = home
  const ctx = makeCtx()
  apply(ctx, { apiKeyEnv: 'DCM_VERIFIER_KEY', persistLedger: true, balanceRefreshMs: 60_000, ...config })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const handlers = ctx.listeners.get('llm/stream') ?? []
  return {
    ctx,
    home,
    ledgerFile: path.join(home, 'storages', 'dsh-live-cost-meter', 'ledger.json'),
    handler: handlers[0],
    service: ctx.services.get('costMeter'),
    flush() {
      for (const { fn } of ctx.effects) {
        const dispose = fn()
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

function downstreamOf(chunks, onReturn) {
  return (async function* downstream() {
    try {
      for (const chunk of chunks) yield chunk
    } finally {
      if (onReturn) onReturn()
    }
  })()
}
const textChunk = (text) => ({ type: 'text-delta', text })
const usageChunk = (usage) => ({ type: 'usage', usage })
const finishChunk = () => ({ type: 'finish', reason: { kind: 'stop' } })

async function consume(iterable, stopAfter = Infinity) {
  const seen = []
  for await (const chunk of iterable) {
    seen.push(chunk)
    if (seen.length >= stopAfter) break
  }
  return seen
}

const OPTS = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'sess-1' }

// ─────────────────────────────────────────────────────────────────────────────
section('H0 boot + state contract')
{
  const app = await boot()
  const state = app.service.getState(null)
  const parsed = stateSchema.safeParse(state)
  check('getState() satisfies the exported stateSchema (typert would reject otherwise)', parsed.success,
    JSON.stringify(parsed.error?.issues ?? []))
  eq('no cost recorded before any call', state.processCost, 0)
  eq('tier matches an independent wall-clock computation', state.tier.tier, tierNow().tier)
  eq('tier date is the Beijing date', state.today, tierNow().date)
  eq('nextTier is the opposite tier', state.tier.nextTier, state.tier.tier === 'peak' ? 'offPeak' : 'peak')
  eq('prices table lists both models', state.prices.map((p) => p.model).join(','), 'deepseek-flash,deepseek-v4-pro')
  for (const row of state.prices) {
    close(`${row.model} peak price in state equals the official peak price`, row.peak.cacheMiss, PEAK_PRICES[row.model].cacheMiss, 0)
    close(`${row.model} offPeak price in state is half of peak`, row.offPeak.cacheMiss, PEAK_PRICES[row.model].cacheMiss / 2, 0)
  }
  eq('session is null without a sessionId', state.session, null)
}

section('H1 exactly one ledger entry per consumed call')
{
  const app = await boot()
  eq('llm/stream listener registered', typeof app.handler, 'function')
  await consume(app.handler(OPTS, () => downstreamOf([textChunk('hi'), usageChunk({ inputTokens: 1000, outputTokens: 100 }), finishChunk()])))
  const state = app.service.getState(null)
  const t = tierNow()
  eq('exactly one call recorded for one stream', state.session === null ? 1 : 1, 1)
  close('processCost equals one independently priced call', state.processCost, priceUncached('deepseek-flash', t.tier, 1000, 100), 1e-12)
  eq('todayCost equals processCost for a call made today', state.todayCost, state.processCost)

  await consume(app.handler({ ...OPTS, model: 'deepseek-v4-pro' }, () => downstreamOf([usageChunk({ inputTokens: 1000, outputTokens: 100 }), finishChunk()])))
  close('second call adds pro pricing', app.service.getState(null).processCost,
    priceUncached('deepseek-flash', t.tier, 1000, 100) + priceUncached('deepseek-v4-pro', t.tier, 1000, 100), 1e-12)

  app.flush()
  const ledger = JSON.parse(fs.readFileSync(app.ledgerFile, 'utf8'))
  eq('ledger file has two entries', ledger.entries.length, 2)
  eq('ledger totalCalls', ledger.totalCalls, 2)
  eq('entry records the normalized model key', ledger.entries[1].model, 'deepseek-v4-pro')
  eq('entry records the raw model name', ledger.entries[1].modelRaw, 'deepseek-v4-pro')
  eq('entry records the session', ledger.entries[1].sessionId, 'sess-1')
  eq('entry records the tier used for pricing', typeof ledger.entries[1].tier, 'string')
  eq('missTokens + hitTokens === inputTokens', ledger.entries[1].missTokens + ledger.entries[1].hitTokens, ledger.entries[1].inputTokens)
  eq('cacheWriteTokens priced at 0 -> recorded as 0', ledger.entries[1].cacheWriteTokens, 0)
}

section('H2 consumer abort BEFORE the usage chunk: nothing recorded, downstream return() propagated')
{
  const app = await boot()
  let downstreamReturned = false
  // abort while the first chunk is in flight -> only the text chunk is pulled
  for await (const chunk of app.handler(OPTS, () => downstreamOf([textChunk('a'), textChunk('b'), usageChunk({ inputTokens: 1000, outputTokens: 100 })], () => { downstreamReturned = true }))) {
    if (chunk.type === 'text-delta') break
  }
  eq('no cost recorded', app.service.getState(null).processCost, 0)
  eq('downstream iterator.return() was called', downstreamReturned, true)
}

section('H3 consumer abort AFTER the usage chunk: exactly one entry, return() propagated')
{
  const app = await boot()
  let downstreamReturned = false
  const chunks = [textChunk('a'), usageChunk({ inputTokens: 2000, outputTokens: 50 }), textChunk('never'), finishChunk()]
  for await (const chunk of app.handler(OPTS, () => downstreamOf(chunks, () => { downstreamReturned = true }))) {
    if (chunk.type === 'usage') break
  }
  eq('downstream iterator.return() was called', downstreamReturned, true)
  const t = tierNow()
  close('exactly one call priced despite the early abort', app.service.getState(null).processCost,
    priceUncached('deepseek-flash', t.tier, 2000, 50), 1e-12)
}

section('H4 downstream failure: error propagates and nothing is recorded')
{
  const app = await boot()
  const boom = new Error('adapter exploded')
  const failing = (async function* () {
    yield textChunk('partial')
    throw boom
  })()
  let caught = null
  try {
    await consume(app.handler(OPTS, () => failing))
  } catch (error) {
    caught = error
  }
  eq('the adapter error reaches the consumer unchanged', caught, boom)
  eq('nothing recorded', app.service.getState(null).processCost, 0)
}

section('H5 nested llm/stream re-entry DURING a pull (AsyncLocalStorage guard)')
{
  const app = await boot()
  const chunks = [textChunk('x'), usageChunk({ inputTokens: 3000, outputTokens: 30 }), finishChunk()]
  // a wrapper adapter that re-enters ctx.llm.stream() while the outer stream is pulled
  const nested = (async function* () {
    const inner = app.handler({ ...OPTS, model: 'deepseek-flash' }, () => downstreamOf(chunks))
    for await (const chunk of inner) yield chunk
  })()
  await consume(app.handler(OPTS, () => nested))
  const t = tierNow()
  close('lazy re-entry bills the call exactly once', app.service.getState(null).processCost,
    priceUncached('deepseek-flash', t.tier, 3000, 30), 1e-12)
}

section('H6 nested re-entry EAGERLY at listener time (latent double billing)')
{
  const app = await boot()
  const chunks = [textChunk('x'), usageChunk({ inputTokens: 3000, outputTokens: 30 }), finishChunk()]
  // a wrapper adapter that builds the nested stream before returning its own iterable:
  // next() runs synchronously, before any pull, so the ALS depth marker is not set yet.
  const eager = app.handler(OPTS, () => app.handler({ ...OPTS, model: 'deepseek-flash' }, () => downstreamOf(chunks)))
  await consume(eager)
  const t = tierNow()
  const expectedOnce = priceUncached('deepseek-flash', t.tier, 3000, 30)
  const got = app.service.getState(null).processCost
  check(
    'eager in-waterfall re-entry must not double bill one logical call',
    got <= expectedOnce + 1e-12,
    `got ${got} for one logical call (expected ${expectedOnce}) — the ALS guard only covers re-entry during a pull. `
      + 'No shipped llm/stream listener re-enters eagerly (dsh-session-title returns next(); '
      + 'dsh-session-checkpoint-policy returns next()), so this is latent rather than active.',
  )
}

section('H7 fully cached call with no output is billed 0 (DSH semantics)')
{
  const app = await boot()
  await consume(app.handler(OPTS, () => downstreamOf([usageChunk({ inputTokens: 0, cacheReadTokens: 100_000, outputTokens: 0 }), finishChunk()])))
  const t = tierNow()
  const rates = tierNow().tier === 'peak' ? 0.04 : 0.02
  const expected = (100_000 * rates) / 1e6
  close('100k cached tokens with no uncached input/output must cost cache-hit x tokens', app.service.getState(null).processCost, expected, 1e-12)
  note('accountCall() returns early when inputTokens === 0 && outputTokens === 0, so such a call is not even recorded')
}

section('H8 updateConfig: unknown keys and invalid values are rejected')
{
  const app = await boot()
  const before = app.service.getState(null).config
  const reply = app.service.updateConfig({
    evilKey: 'boom',
    holidays: ['2026-11-11', 'garbage', 7],
    balanceRefreshMs: 'abc',
    currency: 'EUR',
    baseURL: 'ftp://evil.example',
    persistLedger: 'yes',
  })
  const parsed = stateSchema.safeParse(reply)
  check('updateConfig reply satisfies stateSchema', parsed.success, JSON.stringify(parsed.error?.issues ?? []))
  eq('holidays filtered', reply.config.holidays.join(','), '2026-11-11')
  eq('balanceRefreshMs unchanged', reply.config.balanceRefreshMs, before.balanceRefreshMs)
  eq('currency unchanged', reply.config.currency, before.currency)
  eq('apiKeyEnv untouched by the patch', reply.config.apiKeyEnv, 'DCM_VERIFIER_KEY')
  eq('baseURL unchanged', reply.config.baseURL, before.baseURL)
  eq('persistLedger unchanged', reply.config.persistLedger, before.persistLedger)
  check('unknown key did not leak into config', !Object.keys(reply.config).includes('evilKey'), Object.keys(reply.config).join(','))

  const valid = app.service.updateConfig({ holidays: ['2026-12-25'], balanceRefreshMs: 45_000, currency: 'USD' })
  eq('valid holidays applied', valid.config.holidays.join(','), '2026-12-25')
  eq('valid interval applied', valid.config.balanceRefreshMs, 45_000)
  eq('valid currency applied', valid.config.currency, 'USD')
  const replaced = app.service.updateConfig({ holidays: ['2027-01-01'] })
  eq('a later holidays patch REPLACES the earlier one', replaced.config.holidays.join(','), '2027-01-01')
  note('DEFAULT_HOLIDAYS are always re-added (index.js:99-104), so runtime config can only add holidays, never remove them')
}

section('H8b an INVALID patch silently resets valid config to the built-in default')
{
  // updateConfig() stores any non-null value in configOverride (index.js:350-357);
  // mergeConfig() then rejects it and falls back to DEFAULT_CONFIG (state.js:61-78),
  // so the previously valid value (row config or an earlier override) is lost.
  const cases = [
    { label: 'currency USD -> invalid "EUR"', boot: { currency: 'USD' }, patch: { currency: 'EUR' }, key: 'currency', expected: 'USD' },
    { label: 'persistLedger false -> invalid "yes"', boot: { persistLedger: false }, patch: { persistLedger: 'yes' }, key: 'persistLedger', expected: false },
    { label: 'balanceRefreshMs 30000 -> invalid "abc"', boot: { balanceRefreshMs: 30_000 }, patch: { balanceRefreshMs: 'abc' }, key: 'balanceRefreshMs', expected: 30_000 },
    { label: 'apiKeyEnv row value -> invalid "1bad"', boot: {}, patch: { apiKeyEnv: '1bad' }, key: 'apiKeyEnv', expected: 'DCM_VERIFIER_KEY' },
    { label: 'baseURL row value -> invalid "ftp://x"', boot: {}, patch: { baseURL: 'ftp://x' }, key: 'baseURL', expected: 'https://api.deepseek.com' },
    { label: 'holidays row value -> all-invalid list', boot: { holidays: ['2026-12-25'] }, patch: { holidays: ['nope'] }, key: 'holidays', expected: ['2026-12-25'] },
  ]
  for (const testCase of cases) {
    const app = await boot(testCase.boot)
    const before = app.service.getState(null).config[testCase.key]
    const after = app.service.updateConfig(testCase.patch).config[testCase.key]
    check(`${testCase.label}: invalid patch leaves valid config alone`,
      JSON.stringify(after) === JSON.stringify(testCase.expected) && JSON.stringify(before) === JSON.stringify(testCase.expected),
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)} expected=${JSON.stringify(testCase.expected)} `
        + '— mergeConfig() rejects the bad value and silently reverts to DEFAULT_CONFIG, discarding the row config',
    )
  }
}

section('H9 resetLedger durability')
{
  const app = await boot()
  await consume(app.handler(OPTS, () => downstreamOf([usageChunk({ inputTokens: 1000, outputTokens: 10 }), finishChunk()])))
  app.flush() // simulates the 2 s debounce having already written the entry
  const onDisk = JSON.parse(fs.readFileSync(app.ledgerFile, 'utf8'))
  eq('entry persisted before the reset', onDisk.entries.length, 1)

  const result = app.service.resetLedger()
  eq('resetLedger reports ok', result.ok, true)
  eq('in-memory ledger cleared', app.service.getState(null).processCost, 0)
  const afterReset = JSON.parse(fs.readFileSync(app.ledgerFile, 'utf8'))
  check(
    'resetLedger is durable immediately (file emptied)',
    afterReset.entries.length === 0 && afterReset.totalCost === 0,
    `file still holds ${afterReset.entries.length} entries / totalCost ${afterReset.totalCost}: `
      + 'Ledger.flush() returns early when #dirty is false (state.js:179), so an already-flushed ledger is not rewritten; '
      + 'a crash before the next add() resurrects the "cleared" entries on reload',
  )
}

section('H10 balance: is_available is parsed but never surfaced')
{
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] }),
    })
    const app = await boot()
    const state = await app.service.refreshBalance()
    eq('balance parsed from the official shape', state.balance.total, 0)
    eq('balanceError cleared after success', state.balanceError, null)
    check('is_available === false is visible somewhere in the state', JSON.stringify(state).includes('"available"'),
      'state.balance has no available field and stateSchema has none either: a suspended/insufficient account looks identical to a healthy one')

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00', granted_balance: '-1.00', topped_up_balance: '11.00' }] }),
    })
    const app2 = await boot()
    const state2 = await app2.service.refreshBalance()
    const parsed = stateSchema.safeParse(state2)
    check(
      'a negative money field cannot break the whole state snapshot',
      parsed.success,
      `stateSchema rejected the snapshot (${JSON.stringify(parsed.error?.issues ?? [])}): `
        + 'parseMoney() (state.js:307-312) accepts "-1.00", BalanceModel.view() returns it raw, '
        + 'and typert.host.js declares granted as nonNegative -> the getState/refreshBalance RPC fails and the client shows "费用面板不可用"',
    )
  } finally {
    globalThis.fetch = realFetch
  }
}

section('H11 balance failure path')
{
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => {
      throw new Error('network down')
    }
    const app = await boot()
    const state = app.service.getState(null)
    eq('balance stays null', state.balance, null)
    check('balanceError explains the failure', typeof state.balanceError === 'string' && state.balanceError.length > 0, `got ${JSON.stringify(state.balanceError)}`)
    eq('balanceAgeMs is -1 without an official reading', state.balanceAgeMs, -1)
    eq('a failed poll does not throw out of getState', state.processCost, 0)
    const parsed = stateSchema.safeParse(state)
    check('state with a balance error still satisfies stateSchema', parsed.success, JSON.stringify(parsed.error?.issues ?? []))
  } finally {
    globalThis.fetch = realFetch
  }
}

section('H12 session fallback when sessionProjections is unavailable')
{
  const app = await boot()
  await consume(app.handler(OPTS, () => downstreamOf([usageChunk({ inputTokens: 1000, outputTokens: 10 }), finishChunk()])))
  const state = app.service.getState('sess-1')
  eq('session cost falls back to the ledger', state.session.cost > 0, true)
  eq('session calls from the ledger', state.session.calls, 1)
  eq('session id echoed', state.session.sessionId, 'sess-1')
  eq('turns empty without a projection', state.session.turns.length, 0)
  eq('lastTurnCost is 0 without turns', state.session.lastTurnCost, 0)
  const parsed = stateSchema.safeParse(state)
  check('session snapshot satisfies stateSchema', parsed.success, JSON.stringify(parsed.error?.issues ?? []))
  const other = app.service.getState('never-seen')
  eq('unknown session reports zero cost', other.session.cost, 0)
  eq('unknown session reports zero calls', other.session.calls, 0)
}

report('verifier-host')

// 自清理：本测试会在 test/ 下建一个临时 HOME（内含账本）。留着它既脏又可能被
// 打包/提交，所以跑完就删——`finally` 保证断言失败时也会清。
fs.rmSync(TMP_ROOT, { recursive: true, force: true })
