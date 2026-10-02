/**
 * `./typert` 导出：本插件 Host 面的 Typert 清单。
 *
 * typert-loader 会自动扫描包的 `./typert` 导出并注册，客户端因此可以通过
 * `ctx.get('remote.costMeter')` 调用下面的方法。
 *
 * 两个硬约束（照抄官方产物的写法）：
 *  1. codec 必须是 strict 对象形态 `{ mode, typeSymbol, schema, create }`；
 *     裸 zod schema 会被 typert-loader 以「parameter codec must use a strict codec」拒绝注册。
 *  2. 可选参数必须带 `acceptsUndefined: true`，否则客户端省略该字段时网关按
 *     arguments-invalid 拒绝整次调用。
 */

import { z } from 'zod'

const num = z.number()
const nonNegative = z.number().nonnegative()
const count = z.number().int().nonnegative()

const bucketsSchema = z.object({
  uncachedInputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
}).strict()

const turnSchema = z.object({
  turn: count,
  cost: nonNegative,
  calls: count,
  peakCost: nonNegative,
  offPeakCost: nonNegative,
  buckets: bucketsSchema,
  tiers: z.array(z.enum(['peak', 'offPeak'])),
}).strict()

/** 当前档位与其切换时刻。 */
export const tierViewSchema = z.object({
  tier: z.enum(['peak', 'offPeak']),
  reason: z.enum(['weekend', 'holiday', 'peak-window', 'off-peak-window']),
  /** 北京日期 `YYYY-MM-DD`。 */
  date: z.string(),
  /** 当前档位结束的毫秒时间戳。 */
  untilMs: num,
  /** 距切换的剩余分钟数。 */
  untilMinutes: count,
  /** 下一档位（用于「进入高峰 / 转入平价」文案）。 */
  nextTier: z.enum(['peak', 'offPeak']),
  /** 是否找到了真实的切换时刻（极端自定义节假日表下可能为 false）。 */
  transitionKnown: z.boolean().optional(),
}).strict()

/** 余额视图。 */
const balanceViewSchema = z.object({
  total: nonNegative,
  granted: nonNegative,
  toppedUp: nonNegative,
  currency: z.string(),
  at: num,
  /** 读数年龄（毫秒）：界面据此判断是否需要提示「读数陈旧」。 */
  ageMs: nonNegative.optional(),
  /** 最近一次查询失败，或读数已太久没更新。 */
  stale: z.boolean(),
  estSpendSince: nonNegative,
  /** 官方 `is_available`：false 表示账户当前不可调用。 */
  available: z.boolean().nullable().optional(),
}).strict().nullable()

/** 一次官方读数与本地账本的对账结果。 */
const reconcileSchema = z.object({
  at: num,
  /** 官方余额较上一次读数下降了多少。 */
  observedDrop: num,
  /** 同期本地账本记录了多少。 */
  ledgerDelta: num,
  /** 差额：> 0 表示本进程没观察到的花费（例如同一个 Key 在别处使用）。 */
  drift: num,
}).strict().nullable()

/** 本会话费用。 */
const sessionCostSchema = z.object({
  sessionId: z.string(),
  cost: nonNegative,
  calls: count,
  buckets: bucketsSchema,
  peakCost: nonNegative,
  offPeakCost: nonNegative,
  turns: z.array(turnSchema),
  /** 最近一轮的费用（无轮次时为 0）。 */
  lastTurnCost: nonNegative,
  lastTurn: count.nullable(),
}).strict()

/** 客户端 `getState` 的完整快照。 */
export const stateSchema = z.object({
  /** 本插件版本。 */
  version: z.string(),
  /** 当前档位与倒计时。 */
  tier: tierViewSchema,
  /** 官方余额（含本地外推）。 */
  balance: balanceViewSchema,
  /** 余额查询的最近错误（无错误为 null）。 */
  balanceError: z.string().nullable(),
  /** 官方 `is_available`：false 表示账户已不可调用（余额可能仍大于 0）。 */
  balanceAvailable: z.boolean().nullable().optional(),
  /** 官方读数距今毫秒数。 */
  balanceAgeMs: num,
  /** 累计「本机没观察到」的差额（元）。 */
  unobservedSpend: nonNegative.optional(),
  /** 最近一次对账结果。 */
  reconcile: reconcileSchema.optional(),
  /** 当日（北京日期）本地累计费用。 */
  todayCost: nonNegative,
  /** 当日日期。 */
  today: z.string(),
  /** 进程内累计费用（自插件加载起）。 */
  processCost: nonNegative,
  /** 会话费用，按请求的 sessionId 返回；未提供时为 null。 */
  session: sessionCostSchema.nullable(),
  /** 生效中的配置。 */
  config: z.object({
    holidays: z.array(z.string()),
    balanceRefreshMs: num,
    balanceCacheMs: num,
    balanceTimeoutMs: num.optional(),
    persistLedger: z.boolean(),
    currency: z.string(),
    apiKeyEnv: z.string(),
    baseURL: z.string(),
  }).strict(),
  /** 官方价格表（元 / 百万 tokens），供界面展示与核对。 */
  prices: z.array(z.object({
    model: z.string(),
    peak: z.object({ cacheHit: num, cacheMiss: num, output: num }).strict(),
    offPeak: z.object({ cacheHit: num, cacheMiss: num, output: num }).strict(),
  }).strict()),
}).strict()

/** 配置补丁（全部可选）。 */
export const configPatchSchema = z.object({
  holidays: z.array(z.string()).optional(),
  balanceRefreshMs: num.optional(),
  balanceCacheMs: num.optional(),
  balanceTimeoutMs: num.optional(),
  persistLedger: z.boolean().optional(),
  currency: z.enum(['CNY', 'USD']).optional(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().optional(),
}).strict()

/** 操作结果。 */
const actionSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
}).strict()

/**
 * strict codec 工厂：同时提供新宿主的 `create()` 与旧宿主的 `schema`。
 * @param {string} name - 类型符号后缀（用于教学报错）。
 * @param {object} schema - zod schema。
 * @returns {object} Typert strict codec。
 */
const codec = (name, schema) => ({
  mode: 'strict',
  typeSymbol: `dsh-live-cost-meter#${name}`,
  schema,
  create: () => schema,
})

/** 可选参数包装：允许客户端省略该 wire 字段。 */
const optionalParam = (name, typeName, schema) => ({
  name,
  wire: name,
  source: 'json',
  codec: codec(typeName, schema),
  acceptsUndefined: true,
})

/** 必填参数。 */
const param = (name, typeName, schema) => ({
  name,
  wire: name,
  source: 'json',
  codec: codec(typeName, schema),
})

/** 本插件注册到 Typert 网关的完整 Host 清单。 */
export const TYPERT = {
  package: 'dsh-live-cost-meter',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-live-cost-meter#costMeter/getState',
      service: 'costMeter',
      namespace: 'costMeter',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [
        optionalParam('sessionId', 'SessionIdArg', z.string().nullable()),
      ],
      result: codec('CostState', stateSchema),
    },
    {
      id: 'dsh-live-cost-meter#costMeter/refreshBalance',
      service: 'costMeter',
      namespace: 'costMeter',
      method: 'refreshBalance',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('CostState', stateSchema),
    },
    {
      id: 'dsh-live-cost-meter#costMeter/updateConfig',
      service: 'costMeter',
      namespace: 'costMeter',
      method: 'updateConfig',
      invocation: { kind: 'direct' },
      parameters: [
        param('patch', 'ConfigPatch', configPatchSchema),
      ],
      result: codec('CostState', stateSchema),
    },
    {
      id: 'dsh-live-cost-meter#costMeter/resetLedger',
      service: 'costMeter',
      namespace: 'costMeter',
      method: 'resetLedger',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('ActionResult', actionSchema),
    },
  ],
  model: {
    services: [
      {
        description: 'dsh-live-cost-meter 的费用与余额服务（ctx.costMeter）：按请求发起时刻的峰谷档位逐笔计价，聚合当日/进程累计费用，并给出官方余额读数与本地外推。dsh-live-cost-meter cost & balance service.',
        summary: '费用与官方余额服务 (cost & balance service)。',
        tags: [],
        jsDoc: '/** dsh-live-cost-meter 的费用与余额服务（ctx.costMeter）。dsh-live-cost-meter cost & balance service (ctx.costMeter). */',
        key: 'costMeter',
        exportName: 'CostMeterService',
        members: [
          {
            kind: 'method',
            name: 'getState',
            signature: 'getState(sessionId?: string | null): CostState',
            summary: '读取当前峰谷档位与倒计时、官方余额、当日与进程累计费用，以及指定会话的逐轮费用。Read the current tier with countdown, official balance, daily/process totals, and one session\'s per-turn cost.',
            jsDoc: '/**\n * 读取当前峰谷档位与倒计时、官方余额、当日与进程累计费用，以及指定会话的逐轮费用。\n * @param sessionId - 需要附带逐轮费用的会话 id；省略则为 null。\n * @returns 完整状态快照。\n */',
          },
          {
            kind: 'method',
            name: 'refreshBalance',
            signature: 'refreshBalance(): Promise<CostState>',
            summary: '强制向官方 GET /user/balance 取一次余额并重置外推锚点，返回最新状态。Force one official balance query and reset the extrapolation anchor.',
            jsDoc: '/**\n * 强制刷新官方余额（跳过缓存窗口）。\n * @returns 刷新后的状态快照。\n */',
          },
          {
            kind: 'method',
            name: 'updateConfig',
            signature: 'updateConfig(patch: ConfigPatch): CostState',
            summary: '合并运行期配置（节假日表、刷新间隔、币种、凭据名与 baseURL）。Merge runtime config (holidays, refresh interval, currency, credential name, baseURL).',
            jsDoc: '/**\n * 合并运行期配置覆盖。\n * @param patch - 配置补丁。\n * @returns 应用后的状态快照。\n */',
          },
          {
            kind: 'method',
            name: 'resetLedger',
            signature: 'resetLedger(): ActionResult',
            summary: '清空本地账本（当日/进程累计与逐笔记录）。Clear the local ledger.',
            jsDoc: '/**\n * 清空本地账本。\n * @returns 操作结果。\n */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
