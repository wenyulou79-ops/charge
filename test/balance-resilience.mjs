// 回归测试：余额刷新绝不能被「悬挂请求」「持续失败」「读数陈旧」卡死。
//
// 这一组测试对应一个真实故障：官方余额一直在降，插件却纹丝不动。
// 根因是 fetch 没有超时 → 一次悬挂让 single-flight 永久占位 → 之后每次刷新都短路。
//
// usage: node test/balance-resilience.mjs
import assert from 'node:assert/strict'
import { BalanceModel, fetchOfficialBalance } from '../lib/state.js'

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

const realFetch = globalThis.fetch
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'ERR',
  json: async () => payload,
})

/**
 * 模拟一个「永不响应」的端点。
 *
 * 注意必须用一个**未 unref 的定时器保活**：`AbortSignal.timeout()` 的内部定时器是
 * unref 的，而一个只返回裸 promise 的 mock 不产生任何 I/O，事件循环会立刻变空并让
 * Node 直接退出——abort 永远等不到。真实 fetch 持有 socket，所以不存在这个问题。
 */
const hangingFetch = (url, init) => new Promise((resolve, reject) => {
  const keepAlive = setTimeout(() => reject(new Error('mock: 请求悬挂且未被超时中断')), 60_000)
  init.signal.addEventListener('abort', () => {
    clearTimeout(keepAlive)
    reject(new Error('aborted'))
  })
})

/** 带看门狗的检查器：夹具自身出问题时也要失败而不是挂住整个套件。 */
const withWatchdog = async (promise, ms = 10_000) => {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`检查超时（>${ms} ms）`)), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

console.log('\n[A] 查询超时')

await check('悬挂的请求会在超时后失败，而不是永不落定', async () => {
  globalThis.fetch = hangingFetch
  const started = Date.now()
  await withWatchdog(assert.rejects(
    () => fetchOfficialBalance({ apiKey: 'not-a-real-key-test-only', timeoutMs: 1_000 }),
    /超时/,
    '应当以超时错误失败',
  ))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5_000, `超时应在 1 秒左右触发，实际 ${elapsed} ms`)
  globalThis.fetch = realFetch
})

await check('超时错误信息里带上限值，便于排查', async () => {
  globalThis.fetch = hangingFetch
  await withWatchdog(assert.rejects(() => fetchOfficialBalance({ apiKey: 'not-a-real-key-test-only', timeoutMs: 1_000 }), /1000 ms/))
  globalThis.fetch = realFetch
})

await check('正常响应仍然照常解析', async () => {
  globalThis.fetch = async () => jsonResponse({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }],
  })
  const value = await fetchOfficialBalance({ apiKey: 'not-a-real-key-test-only' })
  assert.equal(value.total, 12.34)
  assert.equal(value.available, true)
  globalThis.fetch = realFetch
})

await check('HTTP 错误被如实抛出', async () => {
  globalThis.fetch = async () => jsonResponse({}, 401)
  await assert.rejects(() => fetchOfficialBalance({ apiKey: 'not-a-real-key-test-only' }), /HTTP 401/)
  globalThis.fetch = realFetch
})

console.log('\n[B] 锚点与外推')

await check('commit 重置锚点：展示值随本地花费下降', () => {
  const model = new BalanceModel()
  model.commit({ total: 10, granted: 0, toppedUp: 10, currency: 'CNY' }, 1.0, 1_000, true)
  assert.equal(model.view(1.0, 1_000).total, 10)
  assert.equal(Number(model.view(1.5, 1_000).total.toFixed(6)), 9.5)
  assert.equal(model.view(1.5, 1_000).estSpendSince, 0.5)
})

await check('再次 commit 会把误差归零，不累积', () => {
  const model = new BalanceModel()
  model.commit({ total: 10, granted: 0, toppedUp: 10, currency: 'CNY' }, 0, 1_000, true)
  // 本地多记了 0.3：展示值偏低
  assert.equal(Number(model.view(0.3, 1_000).total.toFixed(6)), 9.7)
  // 重新读数后锚点重置，偏低立即被纠正
  model.commit({ total: 9.8, granted: 0, toppedUp: 9.8, currency: 'CNY' }, 0.3, 2_000, true)
  assert.equal(Number(model.view(0.3, 2_000).total.toFixed(6)), 9.8)
})

console.log('\n[C] 陈旧判定（读数冻结必须看得见）')

await check('刚读到的值不算陈旧', () => {
  const model = new BalanceModel()
  model.commit({ total: 10, granted: 0, toppedUp: 10, currency: 'CNY' }, 0, 1_000, true)
  const view = model.view(0, 1_000, 180_000)
  assert.equal(view.stale, false)
  assert.equal(view.ageMs, 0)
})

await check('读数超过阈值即标记陈旧（即使没有任何错误）', () => {
  const model = new BalanceModel()
  model.commit({ total: 10, granted: 0, toppedUp: 10, currency: 'CNY' }, 0, 1_000, true)
  const view = model.view(0, 1_000 + 200_000, 180_000)
  assert.equal(view.stale, true, '读数 200 秒没更新必须算陈旧')
  assert.equal(view.ageMs, 200_000)
})

await check('查询失败也标记陈旧，且保留上一次成功读数', () => {
  const model = new BalanceModel()
  model.commit({ total: 10, granted: 0, toppedUp: 10, currency: 'CNY' }, 0, 1_000, true)
  model.fail('网络错误', 2_000)
  const view = model.view(0.5, 2_000, 180_000)
  assert.equal(view.stale, true)
  assert.equal(view.total, 9.5, '失败不应清空余额')
})

console.log('\n[D] 对账：把「本机没观察到的花费」显式算出来')

await check('官方下降多于本地记账时，差额被记为未观察花费', () => {
  const model = new BalanceModel()
  model.commit({ total: 10.0, granted: 0, toppedUp: 10.0, currency: 'CNY' }, 0, 1_000, true)
  // 本地记了 0.20，但官方从 10.00 掉到 9.70（掉了 0.30）→ 有 0.10 是本机没看到的。
  model.commit({ total: 9.7, granted: 0, toppedUp: 9.7, currency: 'CNY' }, 0.2, 60_000, true)
  assert.equal(Number(model.lastReconcile.observedDrop.toFixed(6)), 0.3)
  assert.equal(Number(model.lastReconcile.ledgerDelta.toFixed(6)), 0.2)
  assert.equal(Number(model.lastReconcile.drift.toFixed(6)), 0.1)
  assert.equal(Number(model.unobservedSpend.toFixed(6)), 0.1)
})

await check('本地记账多于官方下降时（四舍五入噪声）不计入未观察花费', () => {
  const model = new BalanceModel()
  model.commit({ total: 10.0, granted: 0, toppedUp: 10.0, currency: 'CNY' }, 0, 1_000, true)
  // 官方只给 2 位小数：本地 0.20，官方 10.00 → 9.90（只掉 0.10），差额为负。
  model.commit({ total: 9.9, granted: 0, toppedUp: 9.9, currency: 'CNY' }, 0.2, 60_000, true)
  assert.ok(model.lastReconcile.drift < 0)
  assert.equal(model.unobservedSpend, 0, '负差额不得累加')
})

await check('微小正差额（低于 0.01）不累加，避免舍入噪声堆积', () => {
  const model = new BalanceModel()
  model.commit({ total: 10.0, granted: 0, toppedUp: 10.0, currency: 'CNY' }, 0, 1_000, true)
  for (let i = 0; i < 10; i += 1) {
    model.commit({ total: 10.0 - (i + 1) * 0.005, granted: 0, toppedUp: 10, currency: 'CNY' }, (i + 1) * 0.005, 2_000 + i, true)
  }
  assert.equal(model.unobservedSpend, 0)
})

console.log(failed === 0 ? `\n${passed} 项通过，0 项失败\n` : `\n${passed} 项通过，${failed} 项失败\n`)
if (failed > 0) process.exitCode = 1
