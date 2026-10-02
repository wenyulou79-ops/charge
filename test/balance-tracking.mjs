// 端到端验收测试：**官方余额持续下降时，插件显示值必须跟着下降。**
//
// 这是用户报告症状的回归测试：
//   「官方平台显示 8.69，插件显示 8.77，差距太大了」
// 根因是余额查询没有超时 → 一次悬挂请求让 single-flight 永久占位 → 之后每次自动
// 刷新都短路 → 锚点冻结在插件加载那一刻 → 显示值与官方真值越差越远。
//
// 本测试用假 Cordis 上下文驱动真实的 apply()，并 stub fetch 扮演官方端点：
// 让官方余额随「插件记录的账本」同步下降，然后断言：
//   (1) 显示值跟随官方值收敛（而不是停在旧锚点上）；
//   (2) 一次悬挂请求之后，后续刷新仍能恢复（不再永久冻结）。
//
// usage: node test/balance-tracking.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const TMP_HOME = path.join(HERE, '.tmp-tracking-home')
fs.rmSync(TMP_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TMP_HOME
delete process.env.DEEPSEEK_API_KEY
process.env.DCM_TRACKING_KEY = 'not-a-real-key-tracking-only'

/** 极简假 Cordis 上下文：只实现插件实际用到的那几个面。 */
function makeCtx() {
  const listeners = new Map()
  const effects = []
  const services = new Map()
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    get: (name) => services.get(name),
    provide(name, value) {
      services.set(name, value)
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    inject(deps, cb) {
      // 依赖缺席时 Cordis 不会调用回调；保持同样语义。
      if (deps.every((d) => services.has(d))) cb(this)
    },
    listeners,
    effects,
    services,
  }
}

// ── 扮演官方余额端点 ────────────────────────────────────────────────────────
/** 官方总额由测试驱动：等于起始值减去「插件账本记录的花费」。 */
const state = {
  /** 起始官方余额（元）。 */
  startTotal: 10,
  /** 官方额外观测不到的花费（模拟同一个 Key 在别处使用）。 */
  unobserved: 0,
  /** 由测试从账本读取的真实花费。 */
  ledgerSpend: () => 0,
  /** 令下一次请求悬挂。 */
  hangNext: false,
  /** 令下一次请求返回 500。 */
  failNext: false,
  requests: 0,
}
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  state.requests += 1
  if (state.hangNext) {
    state.hangNext = false
    return new Promise((resolve, reject) => {
      // 未 unref 的定时器保活：否则只返回裸 promise 会让事件循环变空。
      const keepAlive = setTimeout(() => reject(new Error('mock: 悬挂未被超时中断')), 30_000)
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(new Error('aborted'))
      })
    })
  }
  if (state.failNext) {
    state.failNext = false
    return { ok: false, status: 500, statusText: 'ERR', json: async () => ({}) }
  }
  const total = Math.max(0, state.startTotal - state.ledgerSpend() - state.unobserved)
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: total.toFixed(2),
        granted_balance: '0.00',
        topped_up_balance: total.toFixed(2),
      }],
    }),
  }
}

const { apply } = await import('../lib/index.js')

const ctx = makeCtx()
apply(ctx, {
  apiKeyEnv: 'DCM_TRACKING_KEY',
  persistLedger: false,
  balanceRefreshMs: 20_000, // 让 maybeRefreshBalance 的新鲜度判断可控
  balanceCacheMs: 5_000,
  balanceTimeoutMs: 800,
})

const service = ctx.services.get('costMeter')
assert.ok(service !== undefined, '插件必须 provide costMeter 服务')

let passed = 0
let failed = 0
const check = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 驱动一次 llm/stream，让插件记一笔账。 */
const recordCall = async (usage) => {
  const handler = (ctx.listeners.get('llm/stream') ?? [])[0]
  const downstream = (async function* () {
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  // eslint-disable-next-line no-unused-vars
  for await (const _chunk of handler({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'sess-track' }, () => downstream)) {
    // 消费到底，触发 finally 里的记账
  }
}

// 让 fetch 的官方值跟随账本：先接上一个「账本花费」探针。
let observedSpend = 0
state.ledgerSpend = () => observedSpend

await sleep(60)

console.log('\n[1] 官方余额下降时显示值必须跟随')

await check('首次读数后显示值等于官方值', async () => {
  // 触发一次刷新（此时账本为 0，官方应为 10.00）
  const view = service.getState(null)
  await sleep(200)
  const after = service.getState(null)
  assert.ok(after.balance !== null, '应已取到余额')
  assert.equal(Number(after.balance.total.toFixed(2)), 10.0)
})

await check('产生花费后，显示值随官方下降（不冻结在旧锚点）', async () => {
  // 记 0.50 元花费（1M 未命中输入 @ 谷价 0.5 元/百万… 用 500k 输入 + 输出凑）
  await recordCall({ inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0 })
  observedSpend += 0.5
  // 等待超过刷新间隔，让 maybeRefreshBalance 触发一次新读数
  await sleep(250)
  const view = service.getState(null)
  await sleep(250)
  const after = service.getState(null)
  assert.ok(after.balance !== null, '应已取到余额')
  const shown = after.balance.total
  // 官方此刻 = 10 − 0.5 = 9.5；显示值应由新锚点推出，误差只来自两次刷新之间的外推。
  assert.ok(Math.abs(shown - 9.5) < 0.05, `显示值应接近 9.50，实际 ${shown.toFixed(4)}（差值 ${(shown - 9.5).toFixed(4)}）`)
})

await check('再产生花费后依然跟随，误差不累积', async () => {
  await recordCall({ inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0 })
  observedSpend += 0.5
  await sleep(250)
  service.getState(null)
  await sleep(250)
  const after = service.getState(null)
  const shown = after.balance.total
  // 官方此刻 = 9.0
  assert.ok(Math.abs(shown - 9.0) < 0.05, `显示值应接近 9.00，实际 ${shown.toFixed(4)}`)
})

console.log('\n[2] 悬挂请求之后必须能恢复（不再永久冻结）')

await check('一次悬挂请求会超时失败，并向界面暴露错误', async () => {
  state.hangNext = true
  // 强制刷新：走 force 路径，绕过缓存窗口
  await service.refreshBalance()
  await sleep(1_200) // 超过 balanceTimeoutMs=800
  const view = service.getState(null)
  assert.ok(view.balanceError !== null, `应记录查询错误，实际 ${JSON.stringify(view.balanceError)}`)
  assert.ok(/超时/.test(view.balanceError), `错误应为超时，实际 ${view.balanceError}`)
})

await check('悬挂之后官方余额变化仍能被读到（single-flight 没有被永久占位）', async () => {
  // 官方余额再降 2 元（模拟别处消费）
  state.unobserved = 2
  state.requests = 0
  await service.refreshBalance()
  await sleep(400)
  const after = service.getState(null)
  assert.ok(state.requests > 0, '必须真的重新发起了查询')
  assert.equal(after.balanceError, null, '恢复后不应再有错误')
  // 官方 = 10 − 1.0(账本) − 2(未观察) = 7.00
  assert.ok(Math.abs(after.balance.total - 7.0) < 0.05, `显示值应接近 7.00，实际 ${after.balance.total.toFixed(4)}`)
})

console.log('\n[3] 对账：把未观察到的花费算出来')

await check('官方下降多于本地账本时，报告对账差额', async () => {
  const after = service.getState(null)
  assert.ok(after.unobservedSpend > 1.9, `累计未观察差额应接近 2 元，实际 ${after.unobservedSpend}`)
  assert.ok(after.reconcile !== null && after.reconcile !== undefined, '应带出最近一次对账明细')
  assert.ok(after.reconcile.drift > 1.9, `最近一次 drift 应接近 2，实际 ${after.reconcile.drift}`)
})

console.log('\n[4] 服务端 500 也要能被恢复')

await check('HTTP 500 之后下一次刷新成功即可恢复', async () => {
  state.failNext = true
  await service.refreshBalance()
  await sleep(300)
  const bad = service.getState(null)
  assert.ok(bad.balanceError !== null, '应记录 HTTP 错误')
  await service.refreshBalance()
  await sleep(300)
  const good = service.getState(null)
  assert.equal(good.balanceError, null, '重试成功应清除错误')
})

globalThis.fetch = realFetch
fs.rmSync(TMP_HOME, { recursive: true, force: true })

console.log(failed === 0 ? `\n${passed} 项通过，0 项失败\n` : `\n${passed} 项通过，${failed} 项失败\n`)
if (failed > 0) process.exitCode = 1
