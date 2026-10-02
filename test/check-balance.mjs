// 用本机真实凭据验证官方余额查询链路：原始端点、插件解析器、插件封装。
//
// 隐私说明：本脚本只输出余额数值与结构，**不打印任何密钥片段**。
// 余额属于你自己的账户数据，输出仅到你的终端，不写任何文件。
//
// 需要 DEEPSEEK_API_KEY（环境变量，或 DSH 凭据库里的同名引用）。
// usage: node test/check-balance.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fetchOfficialBalance, parseBalanceResponse, resolveDshHome, ledgerFile } from '../lib/state.js'

/** 从 DSH 凭据库读 DEEPSEEK_API_KEY 引用（返回值本身，永不打印）。 */
function readApiKeyFromCredentials() {
  try {
    const text = fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8')
    const match = text.match(/DEEPSEEK_API_KEY\s*:\s*([^\s{}]+)/)
    if (match === null) return null
    return match[1].replace(/^["']|["']$/g, '')
  } catch {
    return null
  }
}

const key = process.env.DEEPSEEK_API_KEY ?? readApiKeyFromCredentials()
if (key === null || key === undefined || key.length === 0) {
  console.log('[跳过] 未找到 DEEPSEEK_API_KEY（环境变量或 DSH 凭据库）。')
  console.log('提示：本脚本会向官方端点发起一次真实余额查询，因此需要真实密钥。')
  process.exit(0)
}
// 只报告「有没有、多长」，不报告内容。
console.log(`API key 已解析（len=${key.length}，值不打印）`)

// 1. 原始端点
const response = await fetch('https://api.deepseek.com/user/balance', {
  headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
})
console.log(`GET /user/balance -> HTTP ${response.status}`)
const payload = await response.json()
console.log('raw payload:', JSON.stringify(payload))

// 2. 走插件自己的解析器
const parsed = parseBalanceResponse(payload, 'CNY')
console.log('parsed:', JSON.stringify(parsed))
if (parsed !== null) {
  const sum = parsed.granted + parsed.toppedUp
  console.log(`granted + topped_up = ${sum.toFixed(2)} ; total = ${parsed.total.toFixed(2)} ; match=${Math.abs(sum - parsed.total) < 0.005}`)
}

// 3. 走插件的封装
const viaHelper = await fetchOfficialBalance({ apiKey: key })
console.log('fetchOfficialBalance:', JSON.stringify(viaHelper))

// 4. 插件使用的账本位置
console.log('ledger file:', ledgerFile())
