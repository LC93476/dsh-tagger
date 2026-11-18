#!/usr/bin/env node
/**
 * scripts/build-tags.mjs — 把本机 danbooru jsonl 归一化到 <dir>/tags/*.jsonl。
 *
 * 为什么要有这一步：插件默认直接读本机原始数据；但如果用户把它挪走、
 * 或者想给别的东西一份干净数据，就得有一个稳定格式。归一化后每行是
 *   {"tag":"1girl","kind":"general","postCount":8314081,"names":["一个女孩",...],"note":"..."}
 * 去掉了 updatedAt、合并了同一个 tag、按 postCount 降序。
 *
 * 用法（本机没有 node 命令，用宿主自带的 node 运行时）：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/build-tags.mjs
 *   ... --from D:/QUARK/dsh-comfyui-workbench/data/danbooru --out D:/tmp/tags
 *   ... --min-post 100 --quiet
 *
 * 纯可选：不跑它插件照样工作（lib/tags.js 会直接读原始 jsonl）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { discoverDataDir, normalizeKind } from '../lib/tags.js'

const OUT_FILES = {
  general: 'general.jsonl',
  character: 'characters.jsonl',
  copyright: 'copyrights.jsonl',
  artist: 'artists.jsonl',
}

function usage() {
  return [
    '用法: build-tags.mjs [--from <dir>] [--out <dir>] [--min-post <n>] [--quiet]',
    '',
    '  --from  源目录（默认自动探测本机 comfyui workbench 的 danbooru 数据）',
    '  --out   输出目录（默认 ~/.dsh-prompt-forge/tags）',
    '  --min-post 低于该 postCount 的 tag 丢掉（默认 0，全收）',
    '  --quiet 只打印结果',
  ].join('\n')
}

function parseArgs(argv) {
  const out = { from: '', out: '', minPost: 0, quiet: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--quiet' || arg === '-q') out.quiet = true
    else if (arg === '--from') out.from = String(argv[++i] ?? '')
    else if (arg === '--out') out.out = String(argv[++i] ?? '')
    else if (arg === '--min-post') out.minPost = Number.parseInt(String(argv[++i] ?? '0'), 10) || 0
    else if (arg.startsWith('--from=')) out.from = arg.slice(7)
    else if (arg.startsWith('--out=')) out.out = arg.slice(6)
    else if (arg.startsWith('--min-post=')) out.minPost = Number.parseInt(arg.slice(11), 10) || 0
    else {
      console.error('不认识的参数: ' + arg)
      console.error(usage())
      process.exit(2)
    }
  }
  if (!Number.isFinite(out.minPost) || out.minPost < 0) out.minPost = 0
  return out
}

function normKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_')
}

function pushName(list, value) {
  if (typeof value !== 'string') return
  const text = value.trim()
  if (text === '' || list.includes(text)) return
  list.push(text)
}

/** 读一个 jsonl 文件，把记录合并进 buckets: Map<kind, Map<tag, record>>。 */
async function readInto(file, buckets, minPost, stats) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  let first = true
  try {
    for await (const line of reader) {
      stats.lines++
      const text = first ? line.replace(/^\uFEFF/, '') : line
      first = false
      if (text.trim() === '') continue
      let record
      try {
        record = JSON.parse(text)
      } catch {
        stats.bad++
        continue
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        stats.bad++
        continue
      }
      const key = normKey(typeof record.tag === 'string' ? record.tag : record.name)
      if (key === '') {
        stats.bad++
        continue
      }
      const kind = normalizeKind(record.kind)
      const postCount = Number.isFinite(record.postCount)
        ? record.postCount
        : Number.isFinite(record.count) ? record.count : 0
      if (postCount < minPost) {
        stats.dropped++
        continue
      }
      const bucket = buckets.get(kind)
      const existing = bucket.get(key)
      const names = existing === undefined ? [] : existing.names
      if (Array.isArray(record.names)) for (const name of record.names) pushName(names, name)
      else if (Array.isArray(record.aliases)) for (const name of record.aliases) pushName(names, name)
      pushName(names, record.cn)
      pushName(names, record.chinese)
      const note =
        typeof record.note === 'string' ? record.note
          : typeof record.description === 'string' ? record.description : ''
      if (existing === undefined) {
        bucket.set(key, { tag: key, kind, postCount, names, note })
        stats.kept++
      } else {
        if (postCount > existing.postCount) existing.postCount = postCount
        if (existing.note === '' && note !== '') existing.note = note
        if (existing.kind === 'general' && kind !== 'general') existing.kind = kind
      }
    }
  } finally {
    reader.close()
    stream.destroy()
  }
}

async function writeBucket(file, rows) {
  const temp = file + '.tmp'
  const handle = await fsp.open(temp, 'w')
  try {
    let chunk = []
    let bytes = 0
    for (const row of rows) {
      const line = JSON.stringify(row) + '\n'
      chunk.push(line)
      bytes += line.length
      if (chunk.length >= 2000) {
        await handle.write(chunk.join(''))
        chunk = []
      }
    }
    if (chunk.length > 0) await handle.write(chunk.join(''))
    await handle.close()
    await fsp.rename(temp, file)
    return bytes
  } catch (error) {
    try {
      await handle.close()
    } catch {}
    try {
      await fsp.unlink(temp)
    } catch {}
    throw error
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return 0
  }
  const destination = args.out !== ''
    ? path.resolve(args.out)
    : path.join(os.homedir(), '.dsh-prompt-forge', 'tags')

  const discovery = args.from !== ''
    ? await discoverDataDir({ dataDirs: [args.from], probeDefaults: false })
    : await discoverDataDir({ probeDefaults: true })

  if (discovery.files.length === 0) {
    console.error('没找到 danbooru jsonl。试过的目录：')
    for (const candidate of discovery.candidates) console.error('  - ' + candidate)
    console.error('用 --from 指定目录再试。')
    return 1
  }

  const buckets = new Map(Object.keys(OUT_FILES).map(kind => [kind, new Map()]))
  const stats = { lines: 0, bad: 0, kept: 0, dropped: 0 }
  for (const file of discovery.files) {
    if (!args.quiet) console.log('读 ' + file)
    await readInto(file, buckets, args.minPost, stats)
  }

  await fsp.mkdir(destination, { recursive: true })
  const written = []
  for (const [kind, name] of Object.entries(OUT_FILES)) {
    const bucket = buckets.get(kind)
    if (bucket.size === 0) continue
    const rows = [...bucket.values()].sort((a, b) => b.postCount - a.postCount || a.tag.localeCompare(b.tag))
    const file = path.join(destination, name)
    const bytes = await writeBucket(file, rows)
    written.push({ kind, file, rows: rows.length, bytes })
  }

  const meta = {
    builtAt: new Date().toISOString(),
    source: discovery.dir,
    sourceFiles: discovery.files,
    counts: Object.fromEntries(written.map(item => [item.kind, item.rows])),
    lines: stats.lines,
    badLines: stats.bad,
    dropped: stats.dropped,
    minPost: args.minPost,
  }
  await fsp.writeFile(path.join(destination, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')

  console.log('')
  console.log('源目录: ' + (discovery.dir || discovery.files.join(', ')))
  for (const item of written) {
    console.log('  ' + item.kind.padEnd(10) + String(item.rows).padStart(7) + ' 条  '
      + (item.bytes / 1048576).toFixed(2) + ' MB  ' + path.basename(item.file))
  }
  console.log('合计 ' + written.reduce((sum, item) => sum + item.rows, 0) + ' 条 → ' + destination
    + '（读 ' + stats.lines + ' 行，坏行 ' + stats.bad + '，低于阈值丢弃 ' + stats.dropped + '）')
  return written.length === 0 ? 1 : 0
}

const code = await main()
process.exitCode = code
