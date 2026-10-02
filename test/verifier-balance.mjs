/**
 * ADVERSARIAL BALANCE PARSING TEST — dsh-live-cost-meter/lib/state.js
 *
 * Ground truth (official `GET /user/balance`):
 *   { is_available: boolean,
 *     balance_infos: [{ currency: 'CNY'|'USD', total_balance: string,
 *                       granted_balance: string, topped_up_balance: string }] }
 *   Money fields are decimal STRINGS. granted + topped_up === total.
 *
 * run: node test/verifier-balance.mjs
 */
import {
  BALANCE_PATH,
  BalanceModel,
  DEFAULT_CONFIG,
  mergeConfig,
  parseBalanceResponse,
  fetchOfficialBalance,
} from '../lib/state.js'
import { check, close, eq, note, report, section } from './_verifier-harness.mjs'

const cny = (total, granted, topped) => ({
  currency: 'CNY',
  total_balance: total,
  granted_balance: granted,
  topped_up_balance: topped,
})

section('E1 documented example and string money')
{
  const r = parseBalanceResponse({ is_available: true, balance_infos: [cny('110.00', '10.00', '100.00')] })
  close('110.00 total parsed', r.total, 110, 0)
  close('10.00 granted parsed', r.granted, 10, 0)
  close('100.00 topped up parsed', r.toppedUp, 100, 0)
  eq('currency kept', r.currency, 'CNY')
  eq('is_available kept', r.available, true)
  close('granted + topped_up === total (documented invariant)', r.granted + r.toppedUp, r.total, 0)
  eq('no float dust on 2-decimal strings', r.total === 110, true)
}

section('E2 multi-currency selection')
{
  const usd = { currency: 'USD', total_balance: '20.00', granted_balance: '0.00', topped_up_balance: '20.00' }
  const payload = { is_available: true, balance_infos: [usd, cny('110.00', '10.00', '100.00')] }
  eq('preferred CNY picks the CNY wallet', parseBalanceResponse(payload, 'CNY').currency, 'CNY')
  eq('preferred USD picks the USD wallet', parseBalanceResponse(payload, 'USD').currency, 'USD')
  close('preferred USD total', parseBalanceResponse(payload, 'USD').total, 20, 0)
  eq('unknown preference falls back to CNY', parseBalanceResponse(payload, 'EUR').currency, 'CNY')
  const usdOnly = { is_available: true, balance_infos: [usd] }
  eq('USD-only payload with CNY preference falls back to first', parseBalanceResponse(usdOnly, 'CNY').currency, 'USD')
  eq('missing currency field falls back to preference', parseBalanceResponse({ balance_infos: [{ total_balance: '5' }] }, 'CNY').currency, 'CNY')
}

section('E3 structural robustness (must return null, never throw, never fabricate)')
{
  const bad = [
    ['null payload', null],
    ['undefined payload', undefined],
    ['string payload', 'junk'],
    ['number payload', 42],
    ['array payload', []],
    ['missing balance_infos', { is_available: true }],
    ['balance_infos not an array', { balance_infos: { currency: 'CNY', total_balance: '1' } }],
    ['empty balance_infos', { balance_infos: [] }],
    ['[null]', { balance_infos: [null] }],
    ['[[]]', { balance_infos: [[]] }],
    ['[5]', { balance_infos: [5] }],
    ['[{}]', { balance_infos: [{}] }],
    ['[{currency:CNY}] no money fields', { balance_infos: [{ currency: 'CNY' }] }],
    ['all money fields unparsable', { balance_infos: [cny('', 'abc', null)] }],
    ['total null and one bucket missing', { balance_infos: [{ currency: 'CNY', total_balance: null, granted_balance: '1.00' }] }],
  ]
  for (const [label, payload] of bad) {
    let threw = null
    let value
    try {
      value = parseBalanceResponse(payload)
    } catch (error) {
      threw = error
    }
    check(`${label} -> null without throwing`, threw === null && value === null,
      threw !== null ? `threw ${String(threw)}` : `returned ${JSON.stringify(value)}`)
  }

  const junkFirst = parseBalanceResponse({ balance_infos: [null, cny('7.00', '7.00', '0.00')] })
  close('[null, valid] skips the junk entry', junkFirst.total, 7, 0)
  const junkOnly = parseBalanceResponse({ balance_infos: [null, 5, 'x'] })
  eq('[null, 5, "x"] -> null', junkOnly, null)
}

section('E4 total_balance fallback and mismatch policy')
{
  const noTotal = parseBalanceResponse({ balance_infos: [{ currency: 'CNY', granted_balance: '10.00', topped_up_balance: '100.00' }] })
  close('missing total_balance falls back to granted + topped_up', noTotal.total, 110, 0)

  // mismatch: policy is "total wins" (state.js:294). Confirm it is total, and that
  // the mismatch is silently swallowed (no flag, no error surfaced anywhere).
  const mismatch = parseBalanceResponse({ balance_infos: [cny('50.00', '10.00', '100.00')] })
  close('total wins on mismatch', mismatch.total, 50, 0)
  note('granted+topped_up = 110 while total = 50: parser returns total=50 with no mismatch signal')
}

section('E5 money-string hygiene (a wrong non-null number is worse than null)')
{
  // 官方 schema 规定金额是**纯十进制字符串**，因此千分位 / 单位后缀 / 科学计数
  // 一律判为不可用（null）。绝不能像 parseFloat 那样前缀解析成 1 / 12 / 1000
  // 这种「看似合理」的错值——那会把坏数据当成真余额展示。
  const thousands = parseBalanceResponse({ balance_infos: [cny('1,234.56', '0.00', '1234.56')] })
  check('"1,234.56" must be null (thousands separators are not decimal strings)', thousands === null, `got ${JSON.stringify(thousands)}`)

  const suffix = parseBalanceResponse({ balance_infos: [cny('12abc', '0', '12')] })
  check('"12abc" must be null (malformed, not 12)', suffix === null, `got ${JSON.stringify(suffix)}`)

  const exp = parseBalanceResponse({ balance_infos: [cny('1e3', '0', '1000')] })
  check('"1e3" must be null (exponents are not decimal strings)', exp === null, `got ${JSON.stringify(exp)}`)

  const negative = parseBalanceResponse({ balance_infos: [cny('10.00', '-1.00', '11.00')] })
  check('negative granted_balance is either null or clamped to 0',
    negative === null || negative.granted >= 0,
    `parseMoney accepted "-1.00": granted = ${negative?.granted} (money schema in typert.host.js:52-60 is nonNegative -> the whole getState RPC then fails)`)

  const whitespace = parseBalanceResponse({ balance_infos: [cny('  12.50  ', ' 0 ', ' 12.50 ')] })
  close('surrounding whitespace tolerated', whitespace.total, 12.5, 0)

  const inf = parseBalanceResponse({ balance_infos: [cny('Infinity', '0', '0')] })
  check('"Infinity" is rejected (null total, not Infinity)', inf === null || Number.isFinite(inf.total), `got ${JSON.stringify(inf)}`)

  const absent = parseBalanceResponse({ balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] })
  eq('absent granted/topped_up are reported as 0 (unknown becomes a number)', absent.granted, 0)
  eq('  absent topped_up reported as 0', absent.toppedUp, 0)

  const numeric = parseBalanceResponse({ balance_infos: [{ currency: 'CNY', total_balance: 12.34, granted_balance: 1, topped_up_balance: 11.34 }] })
  close('numeric (non-string) money is accepted leniently', numeric.total, 12.34, 0)
}

section('E6 is_available handling')
{
  eq('is_available absent -> available null', parseBalanceResponse({ balance_infos: [cny('1.00', '1.00', '0.00')] }).available, null)
  eq('is_available false preserved', parseBalanceResponse({ is_available: false, balance_infos: [cny('0.00', '0.00', '0.00')] }).available, false)
  eq('is_available truthy non-boolean -> null', parseBalanceResponse({ is_available: 'yes', balance_infos: [cny('1.00', '1.00', '0.00')] }).available, null)
}

section('E7 BalanceModel extrapolation')
{
  const model = new BalanceModel()
  eq('view() before any commit is null', model.view(0), null)
  // 注意：view() 现在接受 (currentSpend, nowMs, staleAfterMs)。本节的锚点用的是合成
  // 时间戳（at: 1000，即 1970 年），所以必须一并传入 nowMs，否则年龄巨大而被判为陈旧。
  // 真实调用方（index.js）传的是真实时钟。
  const NOW = 1000
  model.commit({ total: 100, granted: 10, toppedUp: 90, currency: 'CNY' }, 1, NOW, true)
  close('view after commit equals the official total', model.view(1, NOW).total, 100, 0)
  close('spend after the anchor is subtracted', model.view(3.5, NOW).total, 97.5, 0)
  close('estSpendSince reports the delta', model.view(3.5, NOW).estSpendSince, 2.5, 0)
  close('negative spend delta clamps to 0', model.view(0.5, NOW).estSpendSince, 0, 0)
  close('view never goes below 0', model.view(1e9, NOW).total, 0, 0)
  eq('stale is false without an error at a fresh reading', model.view(1, NOW).stale, false)
  eq('stale becomes true once the reading is older than the threshold', model.view(1, NOW + 200_000).stale, true)
  model.fail('boom', 2000)
  eq('stale becomes true after a failure', model.view(1, NOW).stale, true)
  close('failure keeps the last official total', model.view(1, NOW).total, 100, 0)
  model.commit({ total: 50, granted: 10, toppedUp: 40, currency: 'CNY' }, 10, 3000, false)
  close('re-anchor resets the extrapolation (no error accumulation)', model.view(10, 3000).total, 50, 0)
  close('re-anchor then spend', model.view(12, 3000).total, 48, 0)
  eq('available recorded on commit and surfaced on the balance view', model.view(10, 3000).available, false)
}

section('E8 fetchOfficialBalance request shape (stubbed fetch, no network)')
{
  const realFetch = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ is_available: true, balance_infos: [cny('110.00', '10.00', '100.00')] }),
      }
    }
    const value = await fetchOfficialBalance({ apiKey: 'not-a-real-key-test-only', baseURL: 'https://api.deepseek.com', currency: 'CNY' })
    close('parsed total', value.total, 110, 0)
    eq('one request issued', calls.length, 1)
    eq('URL is baseURL + /user/balance', calls[0].url, `https://api.deepseek.com${BALANCE_PATH}`)
    globalThis.fetch = async (url) => {
      calls.push({ url })
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ balance_infos: [cny('1.00', '1.00', '0.00')] }) }
    }
    await fetchOfficialBalance({ apiKey: 'k', baseURL: 'https://api.deepseek.com/' })
    eq('trailing slash collapsed', calls.at(-1).url, `https://api.deepseek.com${BALANCE_PATH}`)
    eq('Authorization header', calls[0].init.headers.Authorization, 'Bearer not-a-real-key-test-only')
    eq('GET method', calls[0].init.method, 'GET')

    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })
    let message = ''
    try {
      await fetchOfficialBalance({ apiKey: 'bad' })
    } catch (error) {
      message = String(error.message)
    }
    check('HTTP error is thrown with status', message.includes('401'), `got "${message}"`)

    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ nope: 1 }) })
    message = ''
    try {
      await fetchOfficialBalance({ apiKey: 'k' })
    } catch (error) {
      message = String(error.message)
    }
    check('unparsable body is thrown, not silently zeroed', message.length > 0 && !message.includes('0.00'), `got "${message}"`)
  } finally {
    globalThis.fetch = realFetch
  }
}

section('E9 mergeConfig hardening')
{
  const base = { ...DEFAULT_CONFIG }
  const kept = mergeConfig(base, { holidays: ['2026-02-23'], balanceRefreshMs: 30_000, currency: 'USD', persistLedger: false })
  eq('valid holidays accepted', kept.holidays.join(','), '2026-02-23')
  eq('valid interval accepted', kept.balanceRefreshMs, 30_000)
  eq('USD accepted', kept.currency, 'USD')
  eq('persistLedger accepted', kept.persistLedger, false)

  const junk = mergeConfig(base, {
    holidays: ['2026-02-23', 'not-a-date', 42, null, '20260223'],
    balanceRefreshMs: -1,
    balanceCacheMs: 'abc',
    currency: 'EUR',
    apiKeyEnv: '1bad name',
    baseURL: 'ftp://evil.example',
    unknownKey: 'ignored',
  })
  eq('holiday list filtered to valid dates', junk.holidays.join(','), '2026-02-23')
  eq('negative interval ignored', junk.balanceRefreshMs, DEFAULT_CONFIG.balanceRefreshMs)
  eq('NaN interval ignored', junk.balanceCacheMs, DEFAULT_CONFIG.balanceCacheMs)
  eq('unsupported currency ignored', junk.currency, 'CNY')
  eq('invalid env name ignored', junk.apiKeyEnv, DEFAULT_CONFIG.apiKeyEnv)
  eq('non-http baseURL ignored', junk.baseURL, DEFAULT_CONFIG.baseURL)
  check('unknown keys dropped', !('unknownKey' in junk), `junk config has ${Object.keys(junk).join(',')}`)

  const nullPatch = mergeConfig(base, null)
  eq('null patch returns the base unchanged', nullPatch.balanceRefreshMs, DEFAULT_CONFIG.balanceRefreshMs)
  const stringPatch = mergeConfig(base, 'nope')
  eq('string patch returns the base unchanged', stringPatch.currency, 'CNY')

  // holidays are REPLACED, not merged: a partial runtime patch drops the row config
  const replaced = mergeConfig({ ...DEFAULT_CONFIG, holidays: ['2026-01-01', '2026-01-02'] }, { holidays: ['2026-02-23'] })
  eq('holidays patch REPLACES the base list', replaced.holidays.join(','), '2026-02-23')
  note('updateConfig({holidays}) therefore discards holidays set by the plugin row config (doc says "追加/覆盖")')
}

report('verifier-balance')
