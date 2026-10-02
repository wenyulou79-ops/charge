// Integration harness: boots a real Cordis tree with the official DeepSeek adapter
// plus dsh-live-cost-meter, performs ONE real model call, and prints what the plugin recorded.
//
// 需要两样东西，缺任意一样就优雅跳过：
//   - DSH 包目录：DSH_NODE_MODULES=<dir> 或第一个参数
//   - DeepSeek API Key：环境变量 DEEPSEEK_API_KEY，或 DSH 凭据库里的同名引用
// usage: node test/integration.mjs [dshNodeModulesDir]
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, dshNodeModules, dshPackageUrl, hasDshPackages, skip } from './_env.mjs'

const DSH_NODE_MODULES = dshNodeModules()
if (!hasDshPackages(DSH_NODE_MODULES)) {
  skip('未提供 DSH 包目录（本测试需要真实的 @deepseek-ai/dsh-llm 与 DeepSeek 适配器）。')
}

/** Import a DSH package by resolving it from the provided node_modules. */
const load = async (specifier) => import(dshPackageUrl(DSH_NODE_MODULES, specifier))

/** 依次尝试：环境变量 → DSH 凭据库里的 DEEPSEEK_API_KEY 引用。 */
function resolveApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    const yaml = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8')
    const hit = yaml.match(/DEEPSEEK_API_KEY\s*:\s*([^\s{}]+)/)?.[1]?.replace(/^["']|["']$/g, '')
    if (typeof hit === 'string' && hit.length > 0) return hit
  } catch {
    // 凭据库不可读时按缺密钥处理。
  }
  return null
}

const apiKey = resolveApiKey()
if (apiKey === null) {
  skip('未找到 DEEPSEEK_API_KEY（环境变量或 DSH 凭据库都没有）。本测试会发起一次真实模型调用，因此需要真实密钥。')
}
process.env.DEEPSEEK_API_KEY = apiKey
// 账本写到 DSH_HOME（默认 ~/.dsh），不碰仓库内任何文件。

const { Context } = await load('@deepseek-ai/cordis')
const llmPlugin = await load('@deepseek-ai/dsh-llm')
const deepseekKey = await load('@deepseek-ai/dsh-llm-deepseek-api-key')
const credentialsLocal = await load('@deepseek-ai/dsh-credentials-local')
const costMeter = await import('../lib/index.js')

const ctx = new Context()

// 1. credentials store (so apiKeyEnv resolves through the documented path)
ctx.plugin(credentialsLocal.default ?? credentialsLocal, { path: path.join(dshHome(), '.credentials.yaml') })
// 2. the llm service (owns the llm/stream waterfall)
ctx.plugin(llmPlugin.default ?? llmPlugin, {})
// 3. the official DeepSeek API-key route
ctx.plugin(deepseekKey.default ?? deepseekKey, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
// 4. our plugin under test
ctx.plugin(costMeter, {})

await ctx.lifecycle?.ready?.().catch?.(() => {})
await new Promise((resolve) => setTimeout(resolve, 1500))

console.log('providers:', ctx.llm.listProviders())

let capturedUsage = null
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
  maxTokens: 16,
})) {
  if (chunk.type === 'usage') capturedUsage = chunk.usage
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
}
console.log('\n--- usage reported by the provider ---')
console.log(JSON.stringify(capturedUsage, null, 2))

await new Promise((resolve) => setTimeout(resolve, 2500))

const ledgerPath = path.join(dshHome(), 'storages', 'dsh-live-cost-meter', 'ledger.json')
console.log('\n--- cost ledger the plugin wrote ---')
if (fs.existsSync(ledgerPath)) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  console.log(JSON.stringify({ totalCost: ledger.totalCost, totalCalls: ledger.totalCalls, byDate: ledger.byDate, lastEntry: ledger.entries?.at(-1) }, null, 2))
} else {
  console.log('(no ledger file — nothing was recorded)')
}

process.exit(0)
