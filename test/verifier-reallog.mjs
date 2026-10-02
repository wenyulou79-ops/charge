/**
 * EMPIRICAL EVIDENCE PROBE — real DSH session logs (READ-ONLY).
 *
 * Reads the newest `session.v4.jsonl.zstd` files under DSH_HOME/sessions, decompresses
 * them in memory and inspects the durable `assistant/message` / `assistant/attempt`
 * settlements:
 *   1. the exact shape of `data.stream` records (wrapped or raw usage chunks);
 *   2. whether real provider usage satisfies the DSH disjoint-bucket invariant
 *      totalTokens === inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
 *   3. how often cacheReadTokens exceeds inputTokens — i.e. how often the plugin's
 *      `miss = inputTokens - cacheReadTokens` clamp silently drops tokens.
 * Nothing is written outside the test directory.
 *
 * run: node test/verifier-reallog.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { check, eq, note, report, section } from './_verifier-harness.mjs'
import { sessionsDir } from './_env.mjs'

// 会话日志来自本机 DSH_HOME，不随代码分发；没有样本时下面的 report 会显示 0 条。
const SESSIONS = sessionsDir()

function listSessionFiles(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSessionFiles(full, out)
    else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

const files = listSessionFiles(SESSIONS)
  .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 6)

const ZSTD_MAGIC = 4247762216
/** Frame ranges of a concatenated-zstd session log (mirrors scanZstdFrames). */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let complete = false
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) break
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) {
        complete = true
        break
      }
    }
    if (!complete) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

section('R0 locate real session logs')
note(`sessions root: ${SESSIONS}`)
if (files.length === 0) {
  // 干净机器（或 CI）上没有会话日志是**正常情况**，不是缺陷：本测试依赖的是
  // 运行者自己的历史数据，不随代码分发。因此这里跳过而不是失败，
  // 否则公开仓库的 CI 会一直假红。
  console.log('')
  console.log(`[跳过] ${SESSIONS} 下没有 *.jsonl(.zstd) 会话日志，跳过真实日志取证。`)
  console.log('提示：设置 DSH_HOME 指向含 sessions/ 的目录后重跑，可用真实流量验证计价口径。')
  process.exit(0)
}
check('at least one session log found', true, `${files.length} 个日志文件`)
note(`sessions root: ${SESSIONS}`)
{
  for (const entry of files) note(`${new Date(entry.mtime).toISOString()}  ${(entry.size / 1024).toFixed(1)} KiB  ${path.basename(path.dirname(entry.file))}`)

  const readLines = (file) => {
    const bytes = fs.readFileSync(file)
    let text
    if (file.endsWith('.zstd')) {
      // .jsonl.zstd is a concatenation of independent frames; replicate the official
      // scanner (dsh-session-persistence-jsonl/lib/index.js:1300-1360).
      const frames = scanZstdFrames(bytes)
      text = frames.map((frame) => zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')).join('')
    } else {
      text = bytes.toString('utf8')
    }
    return text.split('\n').filter((line) => line.trim().length > 0).map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        return { __unparsed: index }
      }
    })
  }

  const samples = []
  const samplesAll = []
  const recordShapes = new Map()
  let settlements = 0
  let withUsage = 0
  let cacheReadAboveInput = 0
  let invariantOk = 0
  let invariantBroken = []

  for (const entry of files) {
    let rows = []
    try {
      rows = readLines(entry.file)
    } catch (error) {
      note(`skip ${path.basename(entry.file)}: ${String(error.message)}`)
      continue
    }
    for (const row of rows) {
      const event = row?.event ?? row
      const type = event?.type
      if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
      settlements += 1
      const data = event.data ?? {}
      let usage = data.usage ?? null
      if (Array.isArray(data.stream)) {
        for (const record of data.stream) {
          const shape = [record?.type, record?.chunk?.type].filter(Boolean).join('/')
          recordShapes.set(shape, (recordShapes.get(shape) ?? 0) + 1)
          if (usage === null && record?.chunk?.type === 'usage' && record.chunk.usage != null) usage = record.chunk.usage
          if (usage === null && record?.type === 'usage' && record.usage != null) usage = record.usage
        }
      }
      if (usage === null || typeof usage !== 'object') continue
      withUsage += 1
      const input = usage.inputTokens ?? 0
      const output = usage.outputTokens ?? 0
      const cacheRead = usage.cacheReadTokens ?? 0
      const cacheWrite = usage.cacheWriteTokens ?? 0
      const total = usage.totalTokens
      if (cacheRead > input) cacheReadAboveInput += 1
      if (typeof total === 'number') {
        if (total === input + output + cacheRead + cacheWrite) invariantOk += 1
        else if (invariantBroken.length < 5) invariantBroken.push({ input, output, cacheRead, cacheWrite, total })
      }
      if (samples.length < 8) samples.push({ type, input, output, cacheRead, cacheWrite, total })
      samplesAll.push({ input, output, cacheRead, cacheWrite })
    }
  }

  section('R1 durable stream record shapes')
  check('records are wrapped as {type:"chunk", chunk:{...}}', [...recordShapes.keys()].some((k) => k.startsWith('chunk/')),
    `observed record shapes: ${[...recordShapes.entries()].map(([k, v]) => `${k} x${v}`).join(', ')}`)
  note(`record shapes: ${[...recordShapes.entries()].map(([k, v]) => `${k} x${v}`).join(', ') || '(none)'}`)

  section('R2 real usage samples')
  check('at least one real usage sample found', samples.length > 0, `${settlements} settlements, ${withUsage} with usage`)
  for (const sample of samples) {
    note(`${sample.type}: input=${sample.input} cacheRead=${sample.cacheRead} cacheWrite=${sample.cacheWrite} output=${sample.output} total=${sample.total}`)
  }

  section('R3 DSH disjoint-bucket invariant on real data')
  check('totalTokens === inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
    invariantOk > 0 && invariantBroken.length === 0,
    `${invariantOk} samples satisfy it, ${invariantBroken.length} do not${invariantBroken.length ? `, e.g. ${JSON.stringify(invariantBroken[0])}` : ''}`)
  note('this is the empirical form of dsh-token-meter/lib/types/index.js:16-22 ("Sum disjoint provider usage buckets"): '
    + 'inputTokens is the UNCACHED input, so miss = inputTokens - cacheReadTokens subtracts the cache prefix twice.')

  section('R4 bucket shape in real traffic')
  check('cacheReadTokens may exceed inputTokens — that is the NORMAL disjoint shape',
    cacheReadAboveInput >= 0,
    `${cacheReadAboveInput} of ${withUsage} real samples have cacheReadTokens > inputTokens; `
      + 'under the verified disjoint convention (totalTokens = input + cacheRead + cacheWrite + output) '
      + 'this is expected and must NOT be clamped')
  eq('settlements counted', settlements > 0, true)

  section('R5 quantified cost on this machine\'s real traffic (calls the plugin code)')
  {
    // 直接调用插件真实的 computeCost，而不是在测试里另抄一份公式——
    // 早期版本在测试内重写了「相减 + clamp」的旧公式，于是永远在测一份已不存在的实现。
    const { computeCost, ratesFor } = await import('../lib/pricing.js')
    const PRICES = {
      'deepseek-flash': ratesFor('deepseek-flash', 'peak'),
      'deepseek-v4-pro': ratesFor('deepseek-v4-pro', 'peak'),
    }
    if (samplesAll.length > 0) {
      for (const [model, p] of Object.entries(PRICES)) {
        let billed = 0
        let reported = 0
        for (const u of samplesAll) {
          const usage = {
            inputTokens: u.input,
            outputTokens: u.output,
            cacheReadTokens: u.cacheRead,
            cacheWriteTokens: u.cacheWrite,
          }
          const money = computeCost(usage, p)
          billed += money.missTokens + money.hitTokens + money.outputTokens
          reported += u.input + u.output + u.cacheRead + u.cacheWrite
        }
        note(`${model} peak: billed ${billed.toLocaleString('en-US')} / reported ${reported.toLocaleString('en-US')} tokens `
          + `(${((billed / reported) * 100).toFixed(1)}%) over ${samplesAll.length} real calls`)
      }
      let dropped = 0
      let reported = 0
      for (const u of samplesAll) {
        const money = computeCost(
          { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite },
          PRICES['deepseek-flash'],
        )
        const got = money.missTokens + money.hitTokens + money.outputTokens
        const rep = u.input + u.output + u.cacheRead + u.cacheWrite
        dropped += Math.max(0, rep - got)
        reported += rep
      }
      check('the plugin bills every reported token exactly once', dropped === 0,
        `${dropped.toLocaleString('en-US')} of ${reported.toLocaleString('en-US')} real reported tokens unbilled`)
    }
  }

  report('verifier-reallog')
}
