/**
 * 测试共用的环境解析。
 *
 * 这里刻意**不写死任何绝对路径**：本插件是公开分发的，测试里出现作者机器的
 * 固定路径既无意义也暴露目录结构。全部改为环境变量驱动，并在缺失时给出可操作的
 * 提示或优雅跳过。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** DSH_HOME：与 dsh 本身一致，优先环境变量，其次 `~/.dsh`。 */
export const dshHome = () => process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 会话日志目录。 */
export const sessionsDir = () => path.join(dshHome(), 'sessions')

/**
 * 从环境变量或 CLI 参数取「DSH 包所在的 node_modules 目录」。
 *
 * DSH 的包在桌面版里是打进 app.asar 的，磁盘上没有稳定位置，所以无法给出通用默认值。
 * 需要时用 `DSH_NODE_MODULES=<dir>` 或第一个 CLI 参数告知。
 * @returns {string | null} 目录，或 null（调用方应优雅跳过）。
 */
export function dshNodeModules() {
  const fromEnv = process.env.DSH_NODE_MODULES
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const fromArgv = process.argv[2]
  if (typeof fromArgv === 'string' && fromArgv.length > 0) return fromArgv
  return null
}

/**
 * 解析一个 DSH 包的入口路径。
 * @param {string} dir - DSH 包的 node_modules 目录。
 * @param {string} specifier - 包名。
 * @param {string} [entry] - 包内入口（默认 lib/index.js）。
 * @returns {string} 可 import 的 file:// URL。
 */
export function dshPackageUrl(dir, specifier, entry = 'lib/index.js') {
  const full = path.join(dir, specifier, entry)
  return new URL(`file:///${full.replace(/\\/g, '/')}`).href
}

/**
 * 缺依赖时打印可操作的提示并退出 0（跳过而非失败）。
 * @param {string} reason - 跳过原因。
 */
export function skip(reason) {
  console.log(`\n[跳过] ${reason}`)
  console.log('提示：设置 DSH_NODE_MODULES=<DSH 包所在 node_modules> 后重跑，或把该目录作为第一个参数传入。')
  process.exit(0)
}

/** 目录是否含有指定 DSH 包。 */
export function hasDshPackages(dir) {
  if (dir === null) return false
  try {
    return fs.existsSync(path.join(dir, '@deepseek-ai'))
  } catch {
    return false
  }
}
