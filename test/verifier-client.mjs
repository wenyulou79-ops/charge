/**
 * ADVERSARIAL CLIENT TEST — dsh-live-cost-meter/lib/client.js (plain-CJS browser bundle).
 *
 * Shell contract verified in the shipped runtime:
 *  - `slots` binds an inject face's `hooks` map into `use<Name>` props:
 *    dsh-client-ui-renderer/lib/client.js:424-439 (bindInjectSources) +
 *    dsh-client-ui-slots/lib/index.js:7-9 (standardHookPropName) -> `{cost}` => props.useCost.
 *    So this harness passes real injected hooks, as the shell does.
 *  - The bundle is loaded with a stub `window.__ModuleLoader__`, a stub `document` and a
 *    fake `react`; host snapshots are validated by the host's own `stateSchema`.
 *
 * run: node test/verifier-client.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, eq, note, report, section } from './_verifier-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

// ─────────────────────────────────────────────────────────────────────────────
section('G1 node --check parses the bundle')
{
  const result = spawnSync(process.execPath, ['--check', CLIENT], { encoding: 'utf8' })
  if (result.error) {
    note(`spawnSync unavailable (${result.error.code ?? result.error.message}); skipping this check`)
  } else {
    check('node --check lib/client.js', result.status === 0, `status=${result.status}\n${result.stderr ?? ''}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const cssNodes = []
globalThis.document = {
  createElement(tag) {
    const node = { tag, dataset: {}, textContent: '', removed: false, remove() { this.removed = true } }
    cssNodes.push(node)
    return node
  },
  head: { appendChild() {} },
  hidden: false,
}

let loadedSpec = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loadedSpec = spec
    },
  },
}

function makeReact() {
  const record = { hookSequence: [], setStateDuringRender: [], effectCallbacks: [] }
  const React = {
    createElement(type, props, ...children) {
      const kept = []
      for (const child of children) {
        if (Array.isArray(child)) kept.push({ __arrayChild: true, items: child })
        else if (child !== null && child !== undefined && child !== false) kept.push(child)
      }
      return { __el: true, type, props: props ?? {}, children: kept }
    },
    useState(initial) {
      record.hookSequence.push('useState')
      let current = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        if (record.rendering) record.setStateDuringRender.push('setState during render')
        current = typeof next === 'function' ? next(current) : next
      }
      return [current, setter]
    },
    useEffect(fn, deps) {
      record.hookSequence.push('useEffect')
      record.effectCallbacks.push({ fn, deps })
    },
    useRef(value) {
      record.hookSequence.push('useRef')
      return { current: value }
    },
  }
  return { React, record }
}

await import(new URL(`file:///${CLIENT.replace(/\\/g, '/')}`).href)

check('bundle registered itself with window.__ModuleLoader__', loadedSpec !== null)
eq('bundle id', loadedSpec?.id, 'dsh-live-cost-meter')

const { React, record } = makeReact()
const remoteCalls = []
let mountedDescriptors = null
const fakeComponents = new Map()
const faces = new Map()
const injectedKeys = []

const fakeSlots = {
  inject(key, callback) {
    injectedKeys.push(key)
    callback()
    return () => {}
  },
  register(spec, Component) {
    fakeComponents.set(spec.name ?? spec.id, Component)
    faces.set(spec.name ?? spec.id, typeof spec.inject === 'function' ? spec.inject() : null)
    return () => {}
  },
}

/** emulates the shell's observableHook(source): useSyncExternalStore + optional selector */
function makeInjectedHook(label, source) {
  return function injectedHook(selector) {
    record.hookSequence.push(label)
    if (typeof source.subscribe !== 'function' || typeof source.getSnapshot !== 'function') {
      throw new Error(`${label}: injected hook source must be { subscribe, getSnapshot }`)
    }
    const snapshot = source.getSnapshot()
    return typeof selector === 'function' ? selector(snapshot) : snapshot
  }
}

function makeHostState(overrides = {}) {
  return {
    version: '1.0.0',
    tier: { tier: 'offPeak', reason: 'peak-window', date: '2026-10-02', untilMs: Date.now() + 3_600_000, untilMinutes: 60, nextTier: 'peak' },
    balance: { total: 110, granted: 10, toppedUp: 100, currency: 'CNY', at: Date.now(), stale: false, estSpendSince: 0.25 },
    balanceError: null,
    balanceAgeMs: 1000,
    todayCost: 0.000099,
    today: '2026-10-02',
    processCost: 0.000099,
    session: {
      sessionId: 'sess-1',
      cost: 0.000099,
      calls: 1,
      buckets: { uncachedInputTokens: 35, outputTokens: 16, cacheReadTokens: 0, cacheWriteTokens: 0 },
      peakCost: 0,
      offPeakCost: 0.000099,
      turns: [{
        turn: 0,
        cost: 0.000099,
        calls: 1,
        peakCost: 0,
        offPeakCost: 0.000099,
        buckets: { uncachedInputTokens: 35, outputTokens: 16, cacheReadTokens: 0, cacheWriteTokens: 0 },
        tiers: ['offPeak', 'peak'],
      }],
      lastTurnCost: 0.000099,
      lastTurn: 0,
    },
    config: {
      holidays: ['2026-10-01', '2026-10-02'],
      balanceRefreshMs: 60000,
      balanceCacheMs: 30000,
      persistLedger: true,
      currency: 'CNY',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
    },
    prices: [
      { model: 'deepseek-flash', peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }, offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } },
      { model: 'deepseek-v4-pro', peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 } },
    ],
    ...overrides,
  }
}

const { stateSchema } = await import('../lib/index.js')
const VALID_STATE = makeHostState()
check('fixture state satisfies the host stateSchema', stateSchema.safeParse(VALID_STATE).success,
  JSON.stringify(stateSchema.safeParse(VALID_STATE).error?.issues ?? []))

let servedState = null
let failNextCalls = 0
const clientCtx = {
  get(name) {
    if (name === 'slots') return fakeSlots
    if (name === 'remote') return { $mount: async (descriptors) => { mountedDescriptors = descriptors; return () => {} } }
    if (name === 'remote.costMeter') {
      const respond = (method) => async (...args) => {
        remoteCalls.push({ method, args })
        if (failNextCalls > 0) {
          failNextCalls -= 1
          return { ok: false, error: { message: 'RPC 挂了' } }
        }
        return { ok: true, value: servedState }
      }
      return {
        getState: respond('getState'),
        refreshBalance: respond('refreshBalance'),
        updateConfig: respond('updateConfig'),
        resetLedger: respond('resetLedger'),
      }
    }
    return undefined
  },
  effect(fn) {
    clientCtx.effects.push({ fn })
  },
  on(name, fn) {
    clientCtx.listeners.push({ name, fn })
  },
  effects: [],
  listeners: [],
}

const bundle = loadedSpec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}")`)
})

eq('exports.apply is a function', typeof bundle.apply, 'function')
check('exports.inject declares slots and remote', Array.isArray(bundle.inject) && bundle.inject.join(',') === 'slots,remote', JSON.stringify(bundle.inject))

bundle.apply(clientCtx)
eq('three slot components registered', fakeComponents.size, 3)
check('remote.$mount received a 4-descriptor manifest', mountedDescriptors?.descriptors?.length === 4,
  `descriptors: ${JSON.stringify(mountedDescriptors?.descriptors?.map((d) => d.id))}`)
check('a <style> node was injected for the plugin CSS', cssNodes.length === 1 && cssNodes[0].tag === 'style', `cssNodes=${cssNodes.length}`)
eq('client effects registered (state poll + clock + teardown)', clientCtx.effects.length, 3)

await new Promise((resolve) => setTimeout(resolve, 10))

const costHookProps = () => makeInjectedHook('useCost', faces.get('settings.section').hooks.cost)
const clockHookProps = () => makeInjectedHook('useClock', faces.get('settings.section').hooks.clock)

/** render a component body with the shell-injected hooks as props */
function render(name, props = {}, { withHooks = true } = {}) {
  const Component = fakeComponents.get(name)
  const before = record.hookSequence.length
  const effectsBefore = record.effectCallbacks.length
  record.rendering = true
  let element = null
  let error = null
  try {
    element = Component(withHooks ? { useCost: costHookProps(), useClock: clockHookProps(), ...props } : props)
  } catch (caught) {
    error = caught
  }
  record.rendering = false
  return {
    element,
    error,
    hooks: record.hookSequence.slice(before),
    effects: record.effectCallbacks.slice(effectsBefore),
  }
}

function problemsInTree(node, problems = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return problems
  if (node.__arrayChild) {
    for (const item of node.items) {
      if (item && item.__el && item.props.key === undefined && item.key === undefined) {
        problems.push(`array child <${String(item.type)}> without key at depth ${depth}`)
      }
      problemsInTree(item, problems, depth + 1)
    }
    return problems
  }
  if (node.__el) for (const child of node.children) problemsInTree(child, problems, depth + 1)
  return problems
}
const flat = (element) => JSON.stringify(element)

// ─────────────────────────────────────────────────────────────────────────────
section('G2 null / loading / error state must not throw')
{
  servedState = null
  const cases = [
    ['sidebar.footer.action', { sessionId: 'sess-1', wide: true }],
    ['sidebar.footer.action', { sessionId: 'sess-1', wide: false }],
    ['conversation.composer.dock', { sessionId: 'sess-1' }],
    ['settings.section', {}],
  ]
  for (const [name, props] of cases) {
    const result = render(name, props)
    check(`${name} survives a null state`, result.error === null, String(result.error))
    check('  returns an element', result.element !== null, 'returned null')
  }
  eq('settings shows a loading message while state is null', flat(render('settings.section', {}).element).includes('正在读取费用数据'), true)
  check('dock renders ¥0 rather than throwing with a null state', flat(render('conversation.composer.dock', { sessionId: 's' }).element).includes('¥0'), 'no ¥0')

  // cold start: the very first getState fails. refresh() deliberately keeps status
  // 'loading' (client.js:262-266), but the render branch only prints the error when
  // status === 'error' (client.js:332, 407) — which can no longer happen.
  failNextCalls = 99
  for (const [, face] of faces) await face.api.refresh()
  const coldSettings = render('settings.section', {})
  check('settings renders without throwing after a failed first poll', coldSettings.error === null, String(coldSettings.error))
  check('the first-poll error message is visible to the user',
    flat(coldSettings.element).includes('RPC 挂了') || flat(render('sidebar.footer.action', { sessionId: 's', wide: true }).element).includes('不可用'),
    `the panel shows "${flat(coldSettings.element).includes('正在读取费用数据') ? '正在读取费用数据…' : flat(coldSettings.element).slice(0, 120)}" forever: `
      + 'refresh() keeps status "loading" before the first success, so snapshot.error is never rendered')

  // transient failure AFTER a successful snapshot must still surface
  failNextCalls = 0
  servedState = VALID_STATE
  await faces.get('settings.section').api.refresh()
  failNextCalls = 1
  await faces.get('settings.section').api.refresh()
  const transient = render('settings.section', {})
  check('a poll failure after a good snapshot keeps the panel and shows the error',
    flat(transient.element).includes('RPC 挂了') && flat(transient.element).includes('官方余额'),
    flat(transient.element).slice(0, 200))
}

// ─────────────────────────────────────────────────────────────────────────────
section('G3 render all three components against a real host state')
{
  failNextCalls = 0
  servedState = VALID_STATE
  eq('slot inject() callbacks ran three times', injectedKeys.length, 3)
  await faces.get('settings.section').api.refresh()

  const wide = render('sidebar.footer.action', { sessionId: 'sess-1', wide: true })
  const rail = render('sidebar.footer.action', { sessionId: 'sess-1', wide: false })
  const dock = render('conversation.composer.dock', { sessionId: 'sess-1' })
  const settings = render('settings.section', {})
  for (const [label, result] of [['wide sidebar', wide], ['rail sidebar', rail], ['dock', dock], ['settings', settings]]) {
    check(`${label} renders`, result.error === null && result.element !== null, String(result.error))
    const problems = problemsInTree(result.element)
    check(`  no missing React keys in the ${label} tree`, problems.length === 0, problems.join('; '))
  }

  const settingsText = flat(settings.element)
  check('settings shows the official balance', settingsText.includes('110.00'), 'balance missing')
  check('settings shows the granted/topped-up split', settingsText.includes('10.00') && settingsText.includes('100.00'), 'split missing')
  check('settings shows the price table rows', settingsText.includes('deepseek-v4-pro') && settingsText.includes('0.3'), 'price rows missing')
  check('settings seeds the holiday editor from config', settingsText.includes('2026-10-01'), 'holidays missing')
  check('settings shows the config footer', settingsText.includes('https://api.deepseek.com'), 'config footer missing')
  check('settings renders the balance bar for a spent balance', settingsText.includes('dcm-bar'), 'bar missing')
  const dockText = flat(dock.element)
  check('dock shows a ¥ amount', dockText.includes('¥'), dockText.slice(0, 200))
  check('dock shows the session total', dockText.includes('本会话'), dockText.slice(0, 200))
  check('dock marks a cross-tier turn', dockText.includes('本轮跨越了峰谷时段'), 'cross-tier hint missing')
  const wideText = flat(wide.element)
  check('sidebar shows the balance and the tier tag', wideText.includes('110.00') && wideText.includes('平价'), wideText.slice(0, 240))
  check('sidebar shows a countdown label', wideText.includes('后转入平价') || wideText.includes('后进入高峰'), wideText.slice(0, 240))
}

// ─────────────────────────────────────────────────────────────────────────────
section('G4 hooks are unconditional and ordered consistently')
{
  failNextCalls = 0
  servedState = VALID_STATE
  await faces.get('settings.section').api.refresh()
  const withData = render('settings.section', {})
  servedState = null
  await faces.get('settings.section').api.refresh()
  const withoutData = render('settings.section', {})
  eq('settings.section calls the same hooks in the same order with and without state',
    withoutData.hooks.join('>'), withData.hooks.join('>'))
  eq('settings.section hook sequence', withData.hooks.join('>'), 'useCost>useClock>useState>useState>useRef>useEffect')
  check('no setState during render in settings.section', record.setStateDuringRender.length === 0, record.setStateDuringRender.join('; '))

  servedState = VALID_STATE
  const wide = render('sidebar.footer.action', { sessionId: 'x', wide: true })
  const rail = render('sidebar.footer.action', { sessionId: 'x', wide: false })
  eq('sidebar row hook sequence is identical for both layouts', rail.hooks.join('>'), wide.hooks.join('>'))
  eq('sidebar hook sequence', wide.hooks.join('>'), 'useCost>useClock>useEffect')
  check('no setState during render in the sidebar row', record.setStateDuringRender.length === 0, record.setStateDuringRender.join('; '))

  const dock = render('conversation.composer.dock', { sessionId: 'x' })
  eq('dock hook sequence', dock.hooks.join('>'), 'useCost>useEffect')
  check('no setState during render in the dock', record.setStateDuringRender.length === 0, record.setStateDuringRender.join('; '))
  check('dock registers a session effect', dock.effects.length === 1 && typeof dock.effects[0].fn === 'function', JSON.stringify(dock.effects.length))
}

// ─────────────────────────────────────────────────────────────────────────────
section('G5 session registration happens in an effect, not during render')
{
  failNextCalls = 0
  servedState = VALID_STATE
  await faces.get('conversation.composer.dock').api.refresh()
  remoteCalls.length = 0
  const dock = render('conversation.composer.dock', { sessionId: 'sess-from-dock' })
  await faces.get('conversation.composer.dock').api.refresh()
  const beforeEffects = remoteCalls.filter((c) => c.method === 'getState').at(-1)
  check('rendering the dock does NOT mutate the active session (no render-phase side effect)',
    beforeEffects !== undefined && beforeEffects.args[0] === null,
    `getState(${JSON.stringify(beforeEffects?.args?.[0])}) — expected null before the effect commits`)

  for (const effect of dock.effects) effect.fn()
  remoteCalls.length = 0
  await faces.get('conversation.composer.dock').api.refresh()
  const afterEffects = remoteCalls.filter((c) => c.method === 'getState').at(-1)
  eq('after the effect commits the session id is used by the next poll', afterEffects.args[0], 'sess-from-dock')

  const reRender = render('conversation.composer.dock', { sessionId: undefined })
  for (const effect of reRender.effects) effect.fn()
  remoteCalls.length = 0
  await faces.get('conversation.composer.dock').api.refresh()
  eq('an empty sessionId keeps the previous session', remoteCalls.filter((c) => c.method === 'getState').at(-1).args[0], 'sess-from-dock')
}

// ─────────────────────────────────────────────────────────────────────────────
section('G6 injected hooks face contract (shell binds hooks -> use<Name> props)')
{
  const face = faces.get('settings.section')
  check('inject face exposes hooks.cost / hooks.clock as bare observable sources',
    typeof face.hooks?.cost?.getSnapshot === 'function' && typeof face.hooks?.cost?.subscribe === 'function'
      && typeof face.hooks?.clock?.getSnapshot === 'function' && typeof face.hooks?.clock?.subscribe === 'function',
    JSON.stringify(Object.keys(face.hooks ?? {})))
  check('inject face exposes api.refresh / api.refreshBalance',
    typeof face.api?.refresh === 'function' && typeof face.api?.refreshBalance === 'function',
    JSON.stringify(Object.keys(face.api ?? {})))

  const seen = []
  const unsubscribe = face.hooks.cost.subscribe(() => seen.push(1))
  const original = face.hooks.cost.getSnapshot()
  face.hooks.cost.set({ ...original, marker: true })
  eq('store notifies subscribers on set', seen.length, 1)
  eq('getSnapshot returns the latest snapshot', face.hooks.cost.getSnapshot().marker, true)
  unsubscribe()
  face.hooks.cost.set(original)
  eq('unsubscribe stops notifications', seen.length, 1)
  eq('snapshot restored for later checks', face.hooks.cost.getSnapshot().marker, undefined)

  // without the shell hook the component silently reads a non-reactive snapshot
  servedState = VALID_STATE
  await face.api.refresh()
  const fallback = render('conversation.composer.dock', { sessionId: 's' }, { withHooks: false })
  eq('without the injected hook the dock still renders', fallback.error, null)
  eq('  and uses only its own effect', fallback.hooks.join('>'), 'useEffect')
  note('useSource() falls back to store.getSnapshot() when props.useCost is absent — the component then '
    + 'never re-renders on store changes (no subscription). The shipped shell always injects use<Name> props, '
    + 'so this is a degraded-but-safe fallback, not an active bug.')
}

// ─────────────────────────────────────────────────────────────────────────────
section('G7 the client trusts the host payload (no local validation)')
{
  const broken = makeHostState({ tier: null })
  check('a tier-less snapshot is schema-invalid (host-side codec would reject it)', stateSchema.safeParse(broken).success === false,
    'fixture unexpectedly valid')
  servedState = broken
  await faces.get('sidebar.footer.action').api.refresh()
  const result = render('sidebar.footer.action', { sessionId: 's', wide: true })
  check('a schema-invalid state throws inside the render (no defensive guard)', result.error !== null, 'render survived a null tier')
  note(`thrown: ${String(result.error).split('\n')[0]}`)
  servedState = VALID_STATE
  await faces.get('sidebar.footer.action').api.refresh()
}

report('verifier-client')
