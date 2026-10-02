// 回归护栏：把「DSH 的 TokenUsage 桶是互斥的」这一实测结论固化下来。
//
// 背景：这曾经是最严重的计价错误。DSH 的 DeepSeek 适配器走 Anthropic Messages
// 协议（https://api.deepseek.com/anthropic），把 `input_tokens` 映射为 `inputTokens`
// （**只含未命中前缀**）、`cache_read_input_tokens` 映射为 `cacheReadTokens`
// （独立一桶），并显式合成
//     totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
// 早期实现按 OpenAI 口径把 cacheRead 从 input 里减掉，导致 98% 的 token 漏计。
//
// 本测试读本机真实会话日志（zstd 多帧拼接）来验证该恒等式，任何再次引入
// 「相减」或「含缓存」假设的改动都会被这里拦住。
//
// 只看得到 DSH_HOME 下的会话日志，且日志不随代码分发；本机没有样本时优雅跳过。
//
// usage: node test/convention-lock.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'
import { computeCost, ratesFor } from '../lib/pricing.js'
import { sessionsDir } from './_env.mjs'

const SESSIONS = sessionsDir()

/** 递归收集会话日志（`.jsonl` 或 zstd 压缩的 `.jsonl.zstd`）。 */
function collect(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.name.includes('.jsonl')) out.push(full)
  }
  return out
}

/**
 * 解压一份会话日志。
 * 日志由**多个 zstd 帧顺序拼接**而成（每个追加批次一帧），只解第一帧会漏掉
 * 绝大多数事件——这正是最初误判「没有样本」的原因。这里按魔数切帧后逐帧解压。
 * @param {string} file - 日志路径。
 * @returns {string} JSONL 文本。
 */
function readLog(file) {
  const raw = fs.readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let cursor = raw.indexOf(MAGIC, 0)
  while (cursor !== -1) {
    starts.push(cursor)
    cursor = raw.indexOf(MAGIC, cursor + 4)
  }
  if (starts.length === 0) return raw.toString('utf8')
  let out = ''
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : raw.length
    try {
      out += zlib.zstdDecompressSync(raw.subarray(from, to)).toString('utf8')
    } catch {
      // 单帧损坏时跳过，其余帧仍然可用。
    }
  }
  return out
}

/** 从一条 assistant/message 事件里取出用量样本。 */
function usageOf(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage != null) return data.usage
  if (Array.isArray(data.stream)) {
    for (let index = data.stream.length - 1; index >= 0; index -= 1) {
      const chunk = data.stream[index]?.chunk ?? data.stream[index]
      if (chunk?.type === 'usage' && chunk.usage != null) return chunk.usage
    }
  }
  return undefined
}

const files = collect(SESSIONS)
let samples = 0
let disjointIdentity = 0
let inclusiveIdentity = 0
let billedTokens = 0
let reportedTokens = 0
let cacheHeavierThanInput = 0

for (const file of files) {
  const text = readLog(file)
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes('assistant/message')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const event = record?.event ?? record
    if (event?.type !== 'assistant/message') continue
    const usage = usageOf(event)
    if (usage === undefined) continue
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    samples += 1
    if (cacheRead > input) cacheHeavierThanInput += 1
    if (usage.totalTokens !== undefined) {
      if (usage.totalTokens === input + output) inclusiveIdentity += 1
      if (usage.totalTokens === input + cacheRead + cacheWrite + output) disjointIdentity += 1
    }
    const money = computeCost(usage, ratesFor('deepseek-flash', 'peak'))
    billedTokens += money.missTokens + money.hitTokens + money.outputTokens
    reportedTokens += input + output + cacheRead + cacheWrite
  }
}

console.log(`session logs: ${files.length}; usage samples: ${samples}`)
console.log(`  totalTokens === input + output                        : ${inclusiveIdentity}`)
console.log(`  totalTokens === input + cacheRead + cacheWrite + output: ${disjointIdentity}`)
console.log(`  samples where cacheRead > input                        : ${cacheHeavierThanInput}`)
console.log(`  billed / reported tokens                               : ${billedTokens} / ${reportedTokens}`)

if (samples === 0) {
  // 没有会话日志（全新机器）时跳过：这不是失败，只是没有可用证据。
  console.log('\n没有可用的会话日志样本，跳过恒等式断言。')
  process.exit(0)
}

let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${label}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('')
check('真实日志满足互斥桶恒等式（totalTokens = input + cacheRead + cacheWrite + output）', () => {
  assert.equal(disjointIdentity, samples, `${disjointIdentity}/${samples} 条满足互斥口径`)
  assert.ok(inclusiveIdentity < samples, '不应恰好全部满足「含缓存」恒等式')
})

check('插件必须为每个上报的 token 计费（不允许丢桶）', () => {
  assert.equal(billedTokens, reportedTokens, `计费 ${billedTokens} vs 上报 ${reportedTokens}`)
})

check('cacheRead 超过 input 是常态，不得据此判定「含缓存口径」', () => {
  assert.ok(cacheHeavierThanInput > 0, '样本中应存在 cacheRead > input 的情况')
})

console.log(failed === 0 ? '\n0 项失败\n' : `\n${failed} 项失败\n`)
if (failed > 0) process.exitCode = 1
