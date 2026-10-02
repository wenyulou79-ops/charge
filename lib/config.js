/**
 * 插件配置 schema。
 *
 * Cordis 以 `apply(ctx, config)` 传入配置；loader 在激活前用本 schema 校验并
 * 归一化（zod v4 提供 `~standard` 校验接口，与 Cordis 的 `resolveConfig` 兼容）。
 * 所有字段都可选，且整体 `default({})` —— 行里完全不写 `config:` 时校验也会
 * 通过并归一成 `{}`，缺省值由 `mergeConfig` 补齐。
 */

import { z } from 'zod'

export const Config = z.object({
  /** 追加/覆盖的中国法定节假日（北京日期 `YYYY-MM-DD`）。 */
  holidays: z.array(z.string()).optional(),
  /** 官方余额自动刷新间隔（毫秒，>= 5000）。锚点越旧，显示值与官方真值的偏差窗口越长。 */
  balanceRefreshMs: z.number().optional(),
  /** 余额端点缓存有效期（毫秒，>= 5000）；会被钳到不超过刷新间隔的一半。 */
  balanceCacheMs: z.number().optional(),
  /** 单次余额查询超时（毫秒，>= 5000）：没有超时会导致自动刷新永久停摆。 */
  balanceTimeoutMs: z.number().optional(),
  /** 是否把本地账本落盘。 */
  persistLedger: z.boolean().optional(),
  /** 显示币种。 */
  currency: z.enum(['CNY', 'USD']).optional(),
  /** 余额查询使用的凭据名（DSH 凭据库 / 环境变量同名引用）。 */
  apiKeyEnv: z.string().optional(),
  /** 余额查询的 API baseURL（仅应指向官方域名）。 */
  baseURL: z.string().optional(),
}).default({})

export default Config
