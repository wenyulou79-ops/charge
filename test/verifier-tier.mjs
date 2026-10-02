/**
 * ADVERSARIAL PEAK/OFF-PEAK + COUNTDOWN + HOLIDAY TABLE TEST.
 *
 * Expectations are derived independently from rule 2 (Beijing UTC+8, no DST,
 * Mon-Fri 09:00-12:00 & 14:00-18:00 half-open = peak, everything else off-peak):
 *  - instants are constructed from a Beijing WALL CLOCK (Date.UTC(y, m-1, d, hh-8, mm)),
 *    never by shifting a timestamp the way lib/pricing.js does;
 *  - weekdays come from a day-number computation, not from the plugin;
 *  - lib/pricing.js `classifyTier` is NEVER used to produce an expectation.
 *
 * run: node test/verifier-tier.mjs
 */
import { DEFAULT_HOLIDAYS, classifyTier, formatCountdown, nextTransition } from '../lib/pricing.js'
import { check, close, eq, note, report, section } from './_verifier-harness.mjs'

const HOLIDAYS = new Set(DEFAULT_HOLIDAYS)

/** weekday of a calendar date, 0=Sunday (independent day-number arithmetic). */
function weekday(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
/** the instant whose BEIJING wall clock is y-m-d hh:mm */
function bj(y, m, d, hh = 0, mm = 0) {
  return Date.UTC(y, m - 1, d, hh - 8, mm)
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** rule 2, applied to a Beijing wall clock. */
function expectTier(y, m, d, hh, mm, holidays = HOLIDAYS) {
  const w = weekday(y, m, d)
  if (w === 0 || w === 6) return 'offPeak'
  if (holidays.has(ymd(y, m, d))) return 'offPeak'
  const mins = hh * 60 + mm
  return (mins >= 9 * 60 && mins < 12 * 60) || (mins >= 14 * 60 && mins < 18 * 60) ? 'peak' : 'offPeak'
}

function tierAt(atMs, holidays) {
  return classifyTier(atMs, holidays).tier
}

// ─────────────────────────────────────────────────────────────────────────────
section('B1 independent calendar sanity (guards the expectations below)')
{
  const cases = [
    [2026, 10, 1, 4], [2026, 10, 2, 5], [2026, 10, 5, 1], [2026, 10, 8, 4],
    [2026, 10, 9, 5], [2026, 10, 10, 6], [2026, 10, 11, 0], [2026, 10, 12, 1],
  ]
  for (const [y, m, d, w] of cases) {
    eq(`${ymd(y, m, d)} is ${WD[w]}`, weekday(y, m, d), w)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('B2 every minute of Mon/Tue/Fri/Sat/Sun + a holiday Monday and Friday')
{
  const days = [
    { y: 2026, m: 10, d: 12, label: 'Monday' },
    { y: 2026, m: 10, d: 13, label: 'Tuesday' },
    { y: 2026, m: 10, d: 9, label: 'Friday' },
    { y: 2026, m: 10, d: 10, label: 'Saturday (调休 working Saturday)' },
    { y: 2026, m: 10, d: 11, label: 'Sunday' },
    { y: 2026, m: 10, d: 5, label: 'Monday holiday (国庆)' },
    { y: 2026, m: 10, d: 2, label: 'Friday holiday (国庆)' },
  ]
  for (const { y, m, d, label } of days) {
    let mismatches = 0
    let firstMismatch = ''
    for (let mins = 0; mins < 1440; mins += 1) {
      const hh = Math.floor(mins / 60)
      const mm = mins % 60
      const at = bj(y, m, d, hh, mm)
      const expected = expectTier(y, m, d, hh, mm)
      const actual = tierAt(at)
      if (actual !== expected) {
        mismatches += 1
        if (firstMismatch === '') {
          firstMismatch = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} expected ${expected} got ${actual}`
        }
      }
    }
    check(`${label} ${ymd(y, m, d)}: all 1440 minutes match rule 2`, mismatches === 0, `${mismatches} mismatches, first: ${firstMismatch}`)
  }
}

section('B3 exact boundary minutes (half-open [09:00,12:00) and [14:00,18:00))')
{
  const table = [
    ['08:59', 'offPeak'], ['09:00', 'peak'], ['11:59', 'peak'], ['12:00', 'offPeak'],
    ['13:59', 'offPeak'], ['14:00', 'peak'], ['17:59', 'peak'], ['18:00', 'offPeak'],
    ['18:01', 'offPeak'], ['00:00', 'offPeak'], ['23:59', 'offPeak'],
  ]
  for (const [clock, expected] of table) {
    const [hh, mm] = clock.split(':').map(Number)
    eq(`Monday 2026-10-12 ${clock} -> ${expected}`, tierAt(bj(2026, 10, 12, hh, mm)), expected)
    eq(`Friday 2026-10-09 ${clock} -> ${expected}`, tierAt(bj(2026, 10, 9, hh, mm)), expected)
    eq(`Saturday 2026-10-10 ${clock} -> offPeak`, tierAt(bj(2026, 10, 10, hh, mm)), 'offPeak')
    eq(`Sunday 2026-10-11 ${clock} -> offPeak`, tierAt(bj(2026, 10, 11, hh, mm)), 'offPeak')
  }
}

section('B4 UTC vs Beijing: the +08:00 shift must drive the decision')
{
  // 2026-10-06 00:30 Beijing == 2026-10-05 16:30 UTC. A UTC-hours implementation
  // would classify this as peak (16:30 in [14,18)); Beijing says off-peak (00:30).
  const at = bj(2026, 10, 6, 0, 30)
  eq('instant is 2026-10-05T16:30:00Z', new Date(at).toISOString(), '2026-10-05T16:30:00.000Z')
  eq('Beijing 00:30 Tue -> offPeak', tierAt(at), 'offPeak')
  // and the reverse: UTC 01:00 is Beijing 09:00 on a working Monday -> peak
  eq('UTC 01:00 Mon == Beijing 09:00 Mon -> peak', tierAt(Date.UTC(2026, 9, 12, 1, 0)), 'peak')
  // Beijing 18:30 Mon == UTC 10:30 Mon -> off-peak, while UTC arithmetic would say peak
  eq('Beijing 18:30 Mon -> offPeak', tierAt(bj(2026, 10, 12, 18, 30)), 'offPeak')
  check('date string follows Beijing, not UTC', classifyTier(bj(2026, 10, 6, 0, 30)).parts.date === '2026-10-06',
    `got ${classifyTier(bj(2026, 10, 6, 0, 30)).parts.date}`)
}

section('B5 other months / other years / custom holiday tables')
{
  eq('2026-03-11 is a Wednesday', weekday(2026, 3, 11), 3)
  eq('2026-03-11 10:00 -> peak', tierAt(bj(2026, 3, 11, 10, 0)), 'peak')
  eq('2026-03-11 12:00 -> offPeak', tierAt(bj(2026, 3, 11, 12, 0)), 'offPeak')
  eq('2027-01-04 is a Monday', weekday(2027, 1, 4), 1)
  eq('2027-01-04 09:00 -> peak (not in table)', tierAt(bj(2027, 1, 4, 9, 0)), 'peak')

  const custom = [...DEFAULT_HOLIDAYS, '2026-10-12']
  const r = classifyTier(bj(2026, 10, 12, 10, 0), custom)
  eq('custom holiday array overrides a working Monday', r.tier, 'offPeak')
  eq('  reason is "holiday"', r.reason, 'holiday')
  const set = new Set(['2026-10-12'])
  eq('Set input works as well as an array', classifyTier(bj(2026, 10, 12, 10, 0), set).tier, 'offPeak')
  eq('an empty holiday set keeps Monday peak', tierAt(bj(2026, 10, 12, 10, 0), []), 'peak')
  eq('reason is "peak-window" inside a window', classifyTier(bj(2026, 10, 12, 10, 0)).reason, 'peak-window')
  eq('reason is "off-peak-window" outside windows', classifyTier(bj(2026, 10, 12, 13, 0)).reason, 'off-peak-window')
  eq('reason is "weekend" on Saturday', classifyTier(bj(2026, 10, 10, 10, 0)).reason, 'weekend')
}

// ─────────────────────────────────────────────────────────────────────────────
section('C1 nextTransition always lands exactly on a real tier change (grid sweep)')
note('grid: every 17 minutes over 21 days from 2026-09-18 (covers 中秋 + 国庆 holidays)')
{
  const start = bj(2026, 9, 18, 0, 0)
  const stepMs = 17 * 60_000
  const samples = Math.floor((21 * 1440) / 17)
  let badChange = 0
  let badBoundary = 0
  let badMinutes = 0
  let badTier = 0
  let badForward = 0
  const examples = []
  for (let i = 0; i < samples; i += 1) {
    const at = start + i * stepMs
    const here = tierAt(at)
    const next = nextTransition(at)
    const there = tierAt(next.untilMs)
    if (next.tier !== here) badTier += 1
    if (there === here) {
      badChange += 1
      if (examples.length < 3) examples.push(`at ${new Date(at).toISOString()} (${here}) -> untilMs ${new Date(next.untilMs).toISOString()} is still ${there}`)
    }
    if (tierAt(next.untilMs - 60_000) !== here) badBoundary += 1
    if (next.untilMs <= at) badForward += 1
    const expectMin = Math.round((next.untilMs - at) / 60_000)
    if (next.untilMinutes !== expectMin) badMinutes += 1
  }
  check(`${samples} samples: returned tier always equals current tier`, badTier === 0, `${badTier} mismatches`)
  check(`${samples} samples: untilMs is always a real tier change`, badChange === 0, `${badChange} bogus transitions; ${examples.join(' | ')}`)
  check(`${samples} samples: minute before untilMs still has the old tier`, badBoundary === 0, `${badBoundary} off-by-one boundaries`)
  check(`${samples} samples: untilMs is in the future`, badForward === 0, `${badForward} non-future untilMs`)
  check(`${samples} samples: untilMinutes matches untilMs - at`, badMinutes === 0, `${badMinutes} inconsistent countdowns`)
}

section('C2 named countdown targets')
{
  // Friday 18:00 -> Monday 09:00
  const fri = bj(2026, 10, 9, 18, 0)
  const n1 = nextTransition(fri)
  eq('Fri 2026-10-09 18:00 -> tier offPeak', n1.tier, 'offPeak')
  eq('  untilMs is Mon 2026-10-12 09:00 Beijing', n1.untilMs, bj(2026, 10, 12, 9, 0))
  eq('  untilMinutes = 63h = 3780', n1.untilMinutes, 3780)

  // Saturday noon -> Monday 09:00
  const sat = bj(2026, 10, 10, 12, 0)
  eq('Sat 2026-10-10 12:00 -> Mon 09:00', nextTransition(sat).untilMs, bj(2026, 10, 12, 9, 0))

  // holding peak -> end of the window
  const inPeak = bj(2026, 10, 12, 10, 30)
  const n2 = nextTransition(inPeak)
  eq('Mon 10:30 (peak) -> 12:00 same day', n2.untilMs, bj(2026, 10, 12, 12, 0))
  eq('  untilMinutes = 90', n2.untilMinutes, 90)
  const n3 = nextTransition(bj(2026, 10, 12, 12, 30))
  eq('Mon 12:30 (off-peak) -> 14:00 same day', n3.untilMs, bj(2026, 10, 12, 14, 0))

  // 春节 run. NOTE: the shipped DEFAULT_HOLIDAYS omits 2026-02-23 (the last
  // statutory day of 春节), so the default call lands one day early. With the
  // authoritative holiday set the next peak is Tue 2026-02-24 09:00.
  const official = new Set([...DEFAULT_HOLIDAYS, '2026-02-23'])
  const spring = nextTransition(bj(2026, 2, 13, 18, 0), official)
  eq('Fri 2026-02-13 18:00 -> Tue 2026-02-24 09:00 (authoritative 春节 set)', spring.untilMs, bj(2026, 2, 24, 9, 0))
  eq('  untilMinutes = 10d15h = 15300', spring.untilMinutes, 15300)
  note('with the SHIPPED table only, the same call returns '
    + new Date(nextTransition(bj(2026, 2, 13, 18, 0)).untilMs).toISOString()
    + ' (one day early because 2026-02-23 is missing)')
  const shipped = nextTransition(bj(2026, 2, 13, 18, 0))
  check('  13860-like gaps stay inside the 14-day probe limit', shipped.untilMinutes < 60 * 24 * 14, `got ${shipped.untilMinutes}`)

  // 国庆 run: Wed 2026-09-30 18:00 -> Thu 2026-10-08 09:00
  const national = nextTransition(bj(2026, 9, 30, 18, 0))
  eq('Wed 2026-09-30 18:00 (国庆前) -> Thu 2026-10-08 09:00', national.untilMs, bj(2026, 10, 8, 9, 0))
}

section('C3 probe-limit fallback: a > 14 day holiday stretch (custom holidays)')
{
  // 25 consecutive Beijing dates starting Mon 2026-11-02 -> next peak is Fri 2026-11-27 09:00,
  // i.e. 27 days 15 h away, beyond the 14-day probe budget in nextTransition().
  const dates = new Set()
  for (let i = 0; i < 25; i += 1) {
    const at = bj(2026, 11, 2, 9, 0) + i * 86_400_000
    const p = classifyTier(at, []).parts.date
    dates.add(p)
  }
  eq('  25 dates generated', dates.size, 25)
  const at = bj(2026, 10, 30, 18, 0)
  const nowTier = classifyTier(at, dates).tier
  const n = nextTransition(at, dates)
  eq('  tier at the probe start is offPeak', nowTier, 'offPeak')
  check(
    '  fallback untilMs still lands on a tier change (never a bogus transition)',
    classifyTier(n.untilMs, dates).tier !== nowTier,
    `untilMs ${new Date(n.untilMs).toISOString()} is still ${classifyTier(n.untilMs, dates).tier} `
      + `(untilMinutes=${n.untilMinutes}); the 14-day fallback returns a non-transition`,
  )
  check(
    '  fallback countdown is honest (untilMinutes === round((untilMs-at)/60000))',
    n.untilMinutes === Math.round((n.untilMs - at) / 60_000),
    `untilMinutes=${n.untilMinutes}, untilMs-at=${(n.untilMs - at) / 60_000} min`,
  )
}

section('C4 formatCountdown')
{
  eq('0 min', formatCountdown(0), '0 分')
  eq('59 min', formatCountdown(59), '59 分')
  eq('60 min', formatCountdown(60), '1 小时')
  eq('90 min', formatCountdown(90), '1 小时 30 分')
  eq('negative clamps to 0', formatCountdown(-5), '0 分')
  eq('NaN -> 0 分', formatCountdown(NaN), '0 分')
}

// ─────────────────────────────────────────────────────────────────────────────
section('D DEFAULT_HOLIDAYS table sanity')
{
  let badFormat = 0
  let badWeekend = 0
  let dupes = 0
  const seen = new Set()
  for (const date of DEFAULT_HOLIDAYS) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      badFormat += 1
      continue
    }
    const [y, m, d] = date.split('-').map(Number)
    const roundTrip = new Date(Date.UTC(y, m - 1, d))
    if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() + 1 !== m || roundTrip.getUTCDate() !== d) badFormat += 1
    const w = weekday(y, m, d)
    if (w === 0 || w === 6) badWeekend += 1
    if (seen.has(date)) dupes += 1
    seen.add(date)
  }
  check('every entry is a valid YYYY-MM-DD calendar date', badFormat === 0, `${badFormat} invalid entries`)
  check('no entry falls on a weekend (ineffective but sloppy)', badWeekend === 0, `${badWeekend} weekend entries: ${DEFAULT_HOLIDAYS.filter((s) => [0, 6].includes(weekday(...s.split('-').map(Number))))}`)
  eq('no duplicate entries', dupes, 0)
  const sorted = [...DEFAULT_HOLIDAYS].sort()
  check('entries are sorted ascending', JSON.stringify(sorted) === JSON.stringify(DEFAULT_HOLIDAYS), `got ${DEFAULT_HOLIDAYS.join(',')}`)
  check('year prefix is 2026 only', DEFAULT_HOLIDAYS.every((s) => s.startsWith('2026-')), 'table claims to cover 2026')

  // Authoritative 2026 arrangement: 国务院办公厅关于2026年部分节假日安排的通知
  // (国办发明电〔2025〕7号, 2025-11-04) https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
  //   元旦 1/1-1/3 | 春节 2/15-2/23 | 清明 4/4-4/6 | 劳动节 5/1-5/5
  //   端午 6/19-6/21 | 中秋 9/25-9/27 | 国庆 10/1-10/7
  // 调休上班日: 1/4(日) 2/14(六) 2/28(六) 5/9(六) 9/20(日) 10/10(六) — weekends, so off-peak anyway.
  const OFFICIAL_HOLIDAY_WEEKDAYS = [
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
    '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  ]
  const uncovered = []
  for (const date of OFFICIAL_HOLIDAY_WEEKDAYS) {
    const [y, m, d] = date.split('-').map(Number)
    const at = bj(y, m, d, 10, 0)
    if (tierAt(at) !== 'offPeak') uncovered.push(`${date} (${WD[weekday(y, m, d)]})`)
  }
  check(
    'every Mon-Fri statutory 2026 holiday bills off-peak',
    uncovered.length === 0,
    `peak-billed holiday days: ${uncovered.join(', ')} — missing from DEFAULT_HOLIDAYS`,
  )
  check('2026-10-02 is covered', DEFAULT_HOLIDAYS.includes('2026-10-02'), 'explicitly required by rule 2')
  check('2026-10-01 is covered', DEFAULT_HOLIDAYS.includes('2026-10-01'), 'National Day')
  check('2026-02-23 is covered (last day of 春节)', DEFAULT_HOLIDAYS.includes('2026-02-23'), '国务院通知: 春节 2月15日至23日')
  // 国庆 is Oct 1-7 (Oct 8 2026 is a normal working Thursday, so peak is CORRECT there)
  eq('2026-10-08 is a working Thursday -> peak at 10:00', tierAt(bj(2026, 10, 8, 10, 0)), 'peak')
  for (const [date, label] of [['2026-10-10', '国庆调休上班的周六'], ['2026-02-14', '春节调休上班的周六'], ['2026-01-04', '元旦调休上班的周日']]) {
    const [y, m, d] = date.split('-').map(Number)
    eq(`${label} ${date} still bills off-peak`, tierAt(bj(y, m, d, 10, 0)), 'offPeak')
  }
}

report('verifier-tier')
