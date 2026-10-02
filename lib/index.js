/**
 * dsh-live-cost-meter —— 宿主机半。
 *
 * 职责：
 *  1. `llm/stream` 瀑布包裹：以**请求发起时刻**判定峰谷档位，逐笔记录 token 与金额；
 *  2. 注册 `costUsage` 会话投影：逐轮 / 逐次调用的费用与 token 明细（供客户端 `useProjection` 读取）；
 *  3. 提供 `costMeter` 服务 + `./typert` 清单：客户端经 `remote.costMeter.*` 读余额与配置；
 *  4. 官方余额查询（`GET {baseURL}/user/balance`）与「官方锚点 + 本地外推」的余额模型。
 *
 * 计价口径全部来自官方文档：`inputTokens` **含**缓存命中，故
 * `未命中 = inputTokens − cacheReadTokens`，绝不重复计费缓存前缀。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createCostUsageProjection, costViewSchema } from './projection.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_BASE_URL,
  Ledger,
  BalanceModel,
  fetchOfficialBalance,
  ledgerFile,
  mergeConfig,
} from './state.js'
import {
  DEFAULT_HOLIDAYS,
  PRICE_TABLE,
  classifyTier,
  computeCost,
  nextTransition,
  ratesFor,
  resolveModelKey,
} from './pricing.js'
import { stateSchema } from './typert.host.js'
import { Config } from './config.js'

/** 插件名（Cordis 行标识）。 */
export const name = 'cost-meter'

/** 配置 schema：loader 在激活前校验并归一化行配置。 */
export { Config }

/**
 * 宿主依赖。`credentials` / `sessionProjections` / `typert` 都按可选处理
 * （下面用 `ctx.inject` 惰性挂载），因此这里不声明硬依赖，避免缺一个就整行不激活。
 */
export const inject = []

const VERSION = '1.1.0'

/** 嵌套调用的 AsyncLocalStorage 标记：包装路由再入 `ctx.llm.stream()` 时不重复记账。 */
const billingDepth = new AsyncLocalStorage()

/**
 * 取北京日期 `YYYY-MM-DD`。
 * @param {number} atMs - 毫秒时间戳。
 * @returns {string} 北京日期。
 */
function beijingDate(atMs) {
  const shifted = new Date(atMs + 8 * 60 * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * 从一次 LLM 流的 usage 块里取出用量桶。
 * @param {object} usage - `TokenUsage`。
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number }} 归一后的桶。
 */
function normalizeUsage(usage) {
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
  return {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheReadTokens: count(usage?.cacheReadTokens),
    cacheWriteTokens: count(usage?.cacheWriteTokens),
    reasoningTokens: count(usage?.reasoningTokens),
  }
}

/**
 * 插件主体。
 *
 * Cordis 以 `apply(ctx, config)` 调用插件，config 是 loader 行经过 `Config`
 * schema 校验后的对象（没有 schema 时原样传入）。因此这里直接用第二个参数，
 * 不需要也不应该去 `ctx.config` 取（那会要求一个并不存在的服务注入）。
 * @param {object} ctx - Cordis 宿主插件上下文。
 * @param {object} [rawConfig] - 已校验的插件配置。
 */
export function apply(ctx, rawConfig) {
  let config = mergeConfig(DEFAULT_CONFIG, rawConfig)
  const ledger = new Ledger({ file: ledgerFile(), persist: config.persistLedger }).load()
  const balance = new BalanceModel()
  /** 官方读数缓存时间戳。 */
  let balanceFetchedAt = 0
  /** 余额查询是否在进行中（single-flight）。 */
  let balanceInflight = null
  /** 当前占位请求的发起时刻，用于兜底放弃病态悬挂的占位。 */
  let balanceInflightStartedAt = 0
  /** 当前生效的节假日集合。 */
  let holidays = new Set(DEFAULT_HOLIDAYS)

  const rebuildHolidays = () => {
    const extra = Array.isArray(config.holidays) ? config.holidays : []
    holidays = new Set([...DEFAULT_HOLIDAYS, ...extra])
  }

  /** 运行时覆盖（经 updateConfig 写入）。 */
  let configOverride = {}

  /**
   * 应用生效配置：**以行配置为基底**叠加运行时覆盖。
   *
   * 这里必须把 `rawConfig` 当作 base 传给 mergeConfig：早期实现传的是
   * `DEFAULT_CONFIG`，于是 `updateConfig` 里任何一个非法字段都会让基础值退化成
   * 内置默认（USD → CNY），把整份行配置悄悄丢掉。mergeConfig 自身已经负责补齐
   * 缺省字段，因此不需要外层再兜一层默认值。
   */
  const readConfig = () => {
    config = mergeConfig(rawConfig, configOverride)
    rebuildHolidays()
  }
  readConfig()

  // ── 1. 逐笔计费：llm/stream 瀑布包裹 ───────────────────────────────────────
  const accountCall = ({ usage, model, provider, sessionId, atMs }) => {
    const buckets = normalizeUsage(usage)
    // 只跳过「完全没有 token」的调用。注意不能只看 input/output：
    // 桶互斥口径下，一次**全部命中缓存**的调用可以是 input=0、output=0，
    // 但 cacheRead 很大，漏掉它就会把真实花费记成 0。
    const billable = buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
    if (billable === 0) return
    const { tier, reason } = classifyTier(atMs, holidays)
    const { key: modelKey } = resolveModelKey(model)
    const rates = ratesFor(modelKey, tier)
    const money = computeCost(buckets, rates)
    const date = beijingDate(atMs)
    ledger.add({
      at: atMs,
      date,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      provider: typeof provider === 'string' ? provider : undefined,
      model: modelKey,
      modelRaw: typeof model === 'string' ? model : undefined,
      tier,
      tierReason: reason,
      cost: money.cost,
      inputTokens: buckets.inputTokens,
      outputTokens: buckets.outputTokens,
      cacheReadTokens: buckets.cacheReadTokens,
      cacheWriteTokens: buckets.cacheWriteTokens,
      reasoningTokens: buckets.reasoningTokens,
      missTokens: money.missTokens,
      hitTokens: money.hitTokens,
    })
  }

  ctx.on('llm/stream', (options, next) => {
    // 包装路由在上层计费流的消费上下文中再发起的 llm/stream：外层已记账，直接透传。
    if (billingDepth.getStore() !== undefined) return next()
    const atMs = Date.now()
    // 在深度标记内取得下游流：某些包装适配器会在「返回可迭代对象之前」就调用
    // ctx.llm.stream()（急切再入），若只在迭代时才进标记，那种调用会被当成外层
    // 重复记账。把 next() 也纳入标记即可覆盖两种再入形态。
    const downstream = billingDepth.run(1, () => next())
    return (async function* costMeterStream() {
      let usage = null
      const iterator = downstream[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          const result = await billingDepth.run(1, () => iterator.next())
          if (result.done) break
          const chunk = result.value
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage != null) {
            usage = chunk.usage
          }
          yield chunk
        }
        completed = true
      } finally {
        // 手写 for(;;) 没有 for-await 的自动关闭语义：消费方提前中断时必须显式
        // 向下游传播 return()，否则上游 HTTP 流会继续跑完却无人读取。
        if (!completed) {
          try {
            await iterator.return?.()
          } catch {
            // 下游关闭失败不影响本次记账。
          }
        }
        if (usage !== null) {
          try {
            accountCall({ usage, model: options?.model, provider: options?.provider, sessionId: options?.sessionId, atMs })
          } catch (error) {
            console.warn(`[dsh-live-cost-meter] 记账失败：${String(error)}`)
          }
        }
      }
    })()
  })

  // ── 2. 会话投影：逐轮费用（客户端 useProjection('costUsage')） ──────────────
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const definition = createCostUsageProjection(() => holidays)
    projectionCtx.effect(() => projectionCtx.sessionProjections.register(definition), 'cost-meter: costUsage projection')
  })

  // ── 3. 余额查询 ───────────────────────────────────────────────────────────
  /**
   * 解析 API Key：先查 DSH 凭据库，再回退到进程环境变量。
   *
   * `@deepseek-ai/dsh-credentials` 用动态 import 惰性加载：该包是宿主的同伴依赖，
   * 缺它时插件仍应可用（只是拿不到凭据库里的密钥），不能因为一个可选依赖整行不激活。
   * @returns {Promise<string | null>} API Key 或 null。
   */
  const resolveApiKey = async () => {
    const refName = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : 'DEEPSEEK_API_KEY'
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        const hit = await credentials.resolve(credentialRef(refName))
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      } catch {
        // 凭据库或同伴包不可用时继续走环境变量。
      }
    }
    const fromEnv = process.env?.[refName]
    return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null
  }

  /**
   * 刷新官方余额（single-flight + 缓存窗口）。
   *
   * 三重防悬挂，缺一不可：
   *  1. `fetchOfficialBalance` 自带超时，请求一定落定；
   *  2. 这里再放一道「占位超时」——万一底层因故没有按超时结束，
   *     超过 30 秒就放弃旧占位，允许下一次重试，绝不永久卡死；
   *  3. 即使失败也保留上一次成功读数（界面会标注陈旧），而不是清空。
   * @param {boolean} force - 忽略缓存窗口强制刷新。
   * @returns {Promise<void>}
   */
  const refreshBalance = async (force = false) => {
    const now = Date.now()
    if (!force && balanceFetchedAt !== 0 && now - balanceFetchedAt < config.balanceCacheMs) return
    if (balanceInflight !== null) {
      // 病态悬挂的兜底：占位太久就直接放弃，换新的请求。
      if (now - balanceInflightStartedAt < 30_000) return balanceInflight
      balanceInflight = null
    }
    balanceInflightStartedAt = now
    balanceInflight = (async () => {
      try {
        const apiKey = await resolveApiKey()
        if (apiKey === null) {
          balance.fail(`未找到 API Key（凭据 ${config.apiKeyEnv || 'DEEPSEEK_API_KEY'} 未配置）`, Date.now())
          return
        }
        const value = await fetchOfficialBalance({
          apiKey,
          baseURL: typeof config.baseURL === 'string' && config.baseURL.length > 0 ? config.baseURL : DEFAULT_BASE_URL,
          currency: config.currency,
          timeoutMs: config.balanceTimeoutMs,
        })
        balance.commit(value, ledger.totalCost, Date.now(), value.available)
        balanceFetchedAt = Date.now()
      } catch (error) {
        balance.fail(error instanceof Error ? error.message : String(error), Date.now())
      } finally {
        balanceInflight = null
      }
    })()
    return balanceInflight
  }

  /**
   * 机会式刷新：读数已经超过一个刷新间隔就补一次。
   *
   * 这是**独立于 setInterval 的兜底**：客户端的 30 秒轮询本来就会调用 `getState`，
   * 于是即使定时器因事件循环退避、fiber 重载或异常而失效，读数也不会长期冻结。
   * @returns {void}
   */
  const maybeRefreshBalance = () => {
    const now = Date.now()
    const age = balance.official === null ? Number.POSITIVE_INFINITY : now - balance.official.at
    if (age <= config.balanceRefreshMs) return
    // 失败重试的下限：避免接口持续报错时被轮询打成高频请求。
    const floor = Math.max(10_000, Math.floor(config.balanceRefreshMs / 2))
    if (now - balance.attemptedAt < floor) return
    void refreshBalance(true)
  }

  // 首帧就把余额打出来，并按其配置间隔自动刷新（定时器随 fiber 卸载自动清理）。
  void refreshBalance()
  ctx.effect(() => {
    const interval = Math.max(15_000, Number(config.balanceRefreshMs) || DEFAULT_CONFIG.balanceRefreshMs)
    const timer = setInterval(() => {
      void refreshBalance()
    }, interval)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'cost-meter: balance poll')

  // ── 4. 对外快照与 costMeter 服务 ──────────────────────────────────────────
  /**
   * 汇总当前状态。
   * @param {string | null} [sessionId] - 需要附带费用的会话 id。
   * @returns {object} 与 `stateSchema` 一致的快照。
   */
  const buildState = (sessionId = null) => {
    const now = Date.now()
    const tier = nextTransition(now, holidays)
    // 每次取状态都检查一次读数新鲜度：客户端的 30 秒轮询因此成为定时器之外的
    // 第二条保活路径，读数不会被单点故障（悬挂请求 / 定时器失效）冻住。
    maybeRefreshBalance()
    let session = null
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const projections = ctx.get('sessionProjections')
      const sessions = ctx.get('sessions')
      let view = null
      if (projections !== undefined && sessions !== undefined) {
        try {
          const target = sessions.get?.(sessionId)
          if (target !== undefined && target !== null) {
            const snapshot = projections.snapshot(target, ['costUsage'])
            const raw = snapshot?.values?.costUsage
            if (raw !== undefined && raw !== null) view = costViewSchema.parse(raw)
          }
        } catch {
          // 会话尚未在宿主侧物化（例如刚打开的历史会话）：退回逐笔账本。
        }
      }
      const fromLedger = ledger.sessionStats(sessionId)
      const turns = view?.turns ?? []
      session = {
        sessionId,
        cost: view?.cost ?? fromLedger.cost,
        calls: view?.calls ?? fromLedger.calls,
        buckets: view?.buckets ?? { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        peakCost: view?.peakCost ?? 0,
        offPeakCost: view?.offPeakCost ?? 0,
        turns,
        lastTurnCost: turns.length > 0 ? turns[turns.length - 1].cost : 0,
        lastTurn: turns.length > 0 ? turns[turns.length - 1].turn : null,
      }
    }
    const today = beijingDate(now)
    return {
      version: VERSION,
      tier: {
        tier: tier.tier,
        reason: tier.reason,
        date: beijingDate(now),
        untilMs: tier.untilMs,
        untilMinutes: tier.untilMinutes,
        nextTier: tier.tier === 'peak' ? 'offPeak' : 'peak',
        // 极端自定义节假日表下可能 120 天内都不切换；此时如实告知，
        // 由界面显示「—」而不是假装一个倒计时。
        transitionKnown: tier.found !== false,
      },
      balance: balance.view(ledger.totalCost, now, Math.max(90_000, config.balanceRefreshMs * 3)),
      balanceError: balance.error,
      balanceAgeMs: balance.official === null ? -1 : Math.max(0, now - balance.official.at),
      balanceAvailable: balance.available,
      // 对账：官方余额的下降 vs 本地账本同期记录。drift > 0 即为本机没观察到的花费
      // （同一个 Key 在别处使用时必然出现），把它显示出来，而不是靠调参掩盖差异。
      unobservedSpend: balance.unobservedSpend,
      reconcile: balance.lastReconcile,
      todayCost: ledger.costOfDate(today),
      today,
      processCost: ledger.totalCost,
      session,
      config: {
        holidays: Array.isArray(config.holidays) ? config.holidays : [],
        balanceRefreshMs: config.balanceRefreshMs,
        balanceCacheMs: config.balanceCacheMs,
        balanceTimeoutMs: config.balanceTimeoutMs,
        persistLedger: config.persistLedger,
        currency: config.currency,
        apiKeyEnv: config.apiKeyEnv,
        baseURL: config.baseURL,
      },
      prices: Object.entries(PRICE_TABLE).map(([model, entry]) => ({
        model,
        peak: { ...entry.peak },
        offPeak: ratesFor(model, 'offPeak'),
      })),
    }
  }

  /**
   * 创建 costMeter 服务对象。
   *
   * `typertRemote` 绑定满足 Typert 网关的 validateBinding 校验（service / serviceKey /
   * namespace）；方法按清单里的参数顺序位置调用。
   * @returns {object} 服务对象。
   */
  const createService = () => {
    const service = {
      getState(sessionId) {
        return buildState(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null)
      },
      async refreshBalance() {
        await refreshBalance(true)
        return buildState(null)
      },
      updateConfig(patch) {
        const accepted = {}
        if (patch !== null && typeof patch === 'object') {
          for (const key of ['holidays', 'balanceRefreshMs', 'balanceCacheMs', 'balanceTimeoutMs', 'persistLedger', 'currency', 'apiKeyEnv', 'baseURL']) {
            if (patch[key] !== undefined && patch[key] !== null) accepted[key] = patch[key]
          }
        }
        configOverride = { ...configOverride, ...accepted }
        readConfig()
        return buildState(null)
      },
      resetLedger() {
        ledger.entries = []
        ledger.byDate = {}
        ledger.bySession = {}
        ledger.totalCost = 0
        ledger.totalCalls = 0
        ledger.flush()
        return { ok: true, message: null }
      },
    }
    Object.defineProperty(service, 'typertRemote', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: { service, serviceKey: 'costMeter', namespace: 'costMeter' },
    })
    return service
  }

  ctx.provide('costMeter', createService())

  // 注意：`./typert` 清单由 typert-loader 自动扫描并注册（见其 README/实现），
  // 这里**不能**再手动 register，否则会抛出
  // `package face "dsh-live-cost-meter#host" is already registered`。

  // 卸载时落盘，避免丢掉最后几笔。
  ctx.effect(() => () => {
    ledger.dispose()
  }, 'cost-meter: ledger flush')
}

/** 供测试直接复用的导出。 */
export { stateSchema }
