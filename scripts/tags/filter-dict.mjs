#!/usr/bin/env node
// 公开版词表过滤：把 Danbooru 快照里的露骨词条剔掉，产出一份可以直接进公开仓的 SFW 快照。
//
// 为什么要有它：私有仓的 data/danbooru 是完整快照（99447 条），里面有大量露骨词；
// 公开仓不能整份带过去，也不能只靠「按行正则」碰运气 —— 这里按「tag token + 中文别名 +
// 标签分组」三条规则判定，露骨的整行丢掉，剩下的原样保留（字段一个不改，加载器不用动）。
//
// 判定顺序：分组命中 > 英文 token 命中 > 中文别名命中 > 备注命中；命中即丢，记原因。
// 用法：
//   node scripts/tags/filter-dict.mjs                       # data/danbooru -> data/danbooru-sfw
//   node scripts/tags/filter-dict.mjs --from D:/QUARK/dsh-comfyui-workbench/data/danbooru --to ../dsh-tagger-lite/data/danbooru
//   node scripts/tags/filter-dict.mjs --check --to data/danbooru-sfw
//   node scripts/tags/filter-dict.mjs --stats

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')

export const DICT_FILES = ['general.jsonl', 'characters.jsonl', 'copyrights.jsonl', 'artists.jsonl', 'groups.jsonl']
// 进公开版的只有这四份：groups.jsonl 只是「tag → 分组名」的映射，分组名里本身就写着
// Pussy / Nudity / Sex acts，而运行时加载器根本不读它（lib/tags/loader.js 只读主词表四份）。
export const PUBLIC_DICT_FILES = ['general.jsonl', 'characters.jsonl', 'copyrights.jsonl', 'artists.jsonl']
export const MIN_GENERAL_LINES = 20000

// 最后一道兜底：逐行套与公开版生成脚本完全相同的红线正则，命中就整行丢掉。
// 判定规则挡的是「词条本身露骨」，这条挡的是「词条不露骨、但别名/备注里带了露骨词」。
export const NSFW_LINE = new RegExp(
  [
    '\\b(?:penis|penes|pussy|pussies|vagina|vaginal|vulva|anus|anal|anally|clitoris|clit|labia',
    '|areola|areolae|nipples?|cum|cum_\\w+|_cum|cums|cumming|cumshot|semen|sperm|ejaculat\\w*',
    '|creampie|nakadashi|squirt\\w*|orgasm\\w*|fellatio|blowjob|paizuri|handjob|footjob',
    '|masturbat\\w*|fingering|cunnilingus|penetrat\\w*|spread_pussy|exposed_pussy',
    '|penis_in_\\w+|hand_on_own_pussy)\\b',
    '|阴部|阴道|阴茎|龟头|肛交|口交|乳头|乳晕|精液|射精|内射|潮吹|中出|性交|肉棒|私处|性器|淫液'
  ].join(''),
  'i'
)

// 整个分组都不要：这些分组里的词条按定义就是露骨内容
export const SFW_BLOCKED_GROUPS = [
  'Sex acts',
  'Simulated sex acts',
  'Sexual positions',
  'Sex objects',
  'Sexual attire',
  'Nudity',
  'BDSM and torture',
  'Pussy',
  'Ass',
  'Censorship',
]

// 英文 tag 按 _ 和 - 切 token 后整词比对，避免 class/glass 这类误伤
export const NSFW_TOKENS = new Set([
  'sex', 'sexual', 'sexually', 'cum', 'cums', 'cumming', 'cumshot', 'cumshots', 'semen', 'sperm',
  'precum', 'ejaculating', 'ejaculation', 'penis', 'penises', 'cock', 'cocks', 'dick', 'dicks',
  'phallus', 'balls', 'testicles', 'testicle', 'scrotum', 'foreskin', 'glans',
  'pussy', 'pussies', 'vagina', 'vaginal', 'vulva', 'clitoris', 'clit', 'labia', 'urethra', 'cervix',
  'anus', 'anal', 'asshole', 'assholes',
  'nipple', 'nipples', 'areola', 'areolae', 'areolas', 'lactating', 'lactation',
  'underboob', 'sideboob', 'downblouse',
  'orgasm', 'orgasms', 'masturbating', 'masturbation', 'masturbate', 'handjob', 'handjobs',
  'blowjob', 'blowjobs', 'fellatio', 'deepthroat', 'irrumatio', 'cunnilingus', 'anilingus',
  'paizuri', 'titfuck', 'titjob', 'penetration', 'penetrated', 'dildo', 'dildos', 'vibrator',
  'onahole', 'fleshlight', 'bukkake', 'creampie', 'creampies', 'gangbang', 'orgy', 'orgies',
  'bondage', 'shibari', 'bdsm', 'torture', 'tortured', 'urine', 'urination', 'peeing', 'piss',
  'pissing', 'scat', 'feces', 'enema', 'incest', 'rape', 'raped', 'bestiality', 'zoophilia',
  'ahegao', 'loli', 'lolicon', 'shota', 'shotacon', 'toddlercon',
  'nude', 'nudes', 'nudity', 'naked', 'topless', 'bottomless', 'undressed', 'nudist',
  'fingering', 'fingered', 'squirting', 'squirt', 'urinating', 'exhibitionism', 'sexless',
  'footjob', 'footjobs', 'nakadashi', 'hand_on_own_pussy', 'exposed_pussy',
])

// token 切不开的组合词，单独列
export const NSFW_COMBOS = new Set([
  'breasts_out', 'breast_out', 'breasts_apart', 'breasts_squeezed', 'breasts_pressed',
  'sagging_breasts', 'huge_breasts_out', 'nipples_out', 'areola_slip', 'crotch_bulge',
  'camel_toe', 'cameltoe', 'pubic_hair', 'pubic_region', 'groin', 'presenting',
])

// 明确的豁免：这些 tag 本身只是人体/服装的常规描述，Danbooru 把它们挂在 Nudity 或
// 备注里带「乳房」字样，但公开仓保留它们不会引入露骨内容，丢了反而影响打标质量。
export const SFW_ALLOW = new Set([
  'breasts', 'large_breasts', 'medium_breasts', 'small_breasts', 'flat_chest', 'breast_focus', 'cleavage',
  // 姿势词：Danbooru 把「弯腰」挂进了 Sexual positions，但它本身就是个姿势，规则表要用
  'bent_over',
])

// 中文别名按「具体词」比对：不用单字（阴/穴/乳 会命中 阴影/洞穴/乳白）
export const NSFW_CN = [
  '乳头', '乳首', '乳晕', '乳交', '乳房', '露乳', '露胸', '露点', '胸交', '颜射', '内射',
  '阴道', '阴蒂', '阴唇', '阴毛', '阴茎', '阴部', '阴户', '阴核', '龟头', '睾丸', '精液',
  '射精', '精水', '性交', '性爱', '做爱', '口交', '肛交', '肛交', '屁穴', '屁眼', '肛门',
  '插入', '抽插', '高潮', '自慰', '手淫', '淫荡', '淫水', '骚穴', '小穴', '肉穴',
  '全裸', '裸体', '裸身', '兽交', '强奸', '乱伦', '萝莉', '正太', '幼女', '幼齿',
  '失禁', '排泄', '粪便', '尿液', '尿道', '子宫', '阴部',
]

export function tokensOf(tag) {
  return String(tag || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function nsfwReason(entry, groups) {
  const tag = String(entry && entry.tag ? entry.tag : '')
  // 豁免表最先判：这几个词哪怕被 Danbooru 挂在 Nudity 下也照留
  if (SFW_ALLOW.has(tag.toLowerCase())) return ''
  // groups 既支持 Map(tag -> 分组数组) 也支持单条目的分组数组
  const list = groups instanceof Map ? groups.get(tag) || [] : Array.isArray(groups) ? groups : []
  for (const name of SFW_BLOCKED_GROUPS) {
    if (list.includes(name)) return 'group:' + name
  }
  const low = tag.toLowerCase()
  if (NSFW_COMBOS.has(low)) return 'combo:' + low
  for (const token of tokensOf(low)) {
    if (NSFW_TOKENS.has(token)) return 'token:' + token
  }
  const names = Array.isArray(entry && entry.names) ? entry.names : []
  for (const raw of names) {
    const text = String(raw || '')
    for (const word of NSFW_CN) {
      if (text.includes(word)) return 'cn:' + word
    }
  }
  const note = String(entry && entry.note ? entry.note : '')
  for (const word of NSFW_CN) {
    if (note.includes(word)) return 'note:' + word
  }
  return ''
}

export const CN_HIT = (text) => NSFW_CN.find((word) => String(text || '').includes(word)) || ''

export function sanitizeEntry(entry) {
  // 别名 / 备注里带脏词的，不整条丢，而是把那几个别名摘掉、备注清空：
  // 词条本身（tag）是常规词，留着对打标更有用（例：shrug_(clothing) 的别名里写着「露胸领衫」）。
  let touched = false
  if (Array.isArray(entry.names)) {
    const kept = entry.names.filter((name) => CN_HIT(name) === '')
    if (kept.length !== entry.names.length) {
      touched = true
      entry.names = kept
    }
  }
  if (typeof entry.note === 'string' && CN_HIT(entry.note) !== '') {
    delete entry.note
    touched = true
  }
  return touched
}

export function filterLines(text, groups) {
  const out = []
  const removed = []
  const sanitized = []
  for (const line of String(text).split('\n')) {
    const raw = line.trim()
    if (raw === '') continue
    let entry
    try {
      entry = JSON.parse(raw)
    } catch {
      removed.push({ tag: '', reason: 'bad-json' })
      continue
    }
    const reason = nsfwReason(entry, groups)
    if (reason !== '' && reason.split(':')[0] !== 'cn' && reason.split(':')[0] !== 'note') {
      removed.push({ tag: String(entry.tag || ''), reason })
      continue
    }
    if (reason !== '') {
      sanitizeEntry(entry)
      sanitized.push({ tag: String(entry.tag || ''), reason })
    }
    const next = reason === '' ? raw : JSON.stringify(entry)
    if (NSFW_LINE.test(next)) {
      removed.push({ tag: String(entry.tag || ''), reason: 'line' })
      continue
    }
    out.push(next)
  }
  return { kept: out, removed, sanitized }
}

export function buildGroupMap(text) {
  const map = new Map()
  for (const line of String(text).split('\n')) {
    const raw = line.trim()
    if (raw === '') continue
    try {
      const entry = JSON.parse(raw)
      if (entry && entry.tag) map.set(String(entry.tag), Array.isArray(entry.groups) ? entry.groups : [])
    } catch {
      /* 分组文件坏行直接跳过，不影响主词表 */
    }
  }
  return map
}

export function tallyReasons(removed) {
  const counts = {}
  for (const item of removed) {
    const key = String(item.reason || 'unknown').split(':')[0]
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

export function parseArgs(argv) {
  const opts = { from: '', to: '', check: false, stats: false, quiet: false, json: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    const take = () => {
      i += 1
      return String(argv[i] === undefined ? '' : argv[i])
    }
    if (arg === '--from') opts.from = take()
    else if (arg === '--to') opts.to = take()
    else if (arg === '--check') opts.check = true
    else if (arg === '--stats') opts.stats = true
    else if (arg === '--quiet') opts.quiet = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else return { error: 'unknown-arg:' + arg }
  }
  return opts
}

export function usageText() {
  return [
    '用法：node scripts/tags/filter-dict.mjs [选项]',
    '',
    '  --from <dir>   源词表目录（默认 data/danbooru）',
    '  --to <dir>     输出目录（默认 data/danbooru-sfw）',
    '  --check        只校验 --to 目录里有没有露骨词条（一致 0 / 有残留 1 / 目录或 manifest 缺失 2）',
    '  --stats        只统计、不写盘',
    '  --force        目标目录已有词表时覆盖',
    '  --json         机器可读输出',
    '  --quiet        只打结论',
    '  --help         本说明',
    '',
    '判定规则：分组命中（Sex acts / Nudity / Sexual positions …）> tag token 命中 > 中文别名命中 > 备注命中。',
    '公开仓用这份 SFW 快照；私有仓保留完整快照。',
  ].join('\n')
}

export function resolveFrom(opts) {
  if (opts.from) return resolve(opts.from)
  const env = process.env.DSH_DANBOORU_DIR || process.env.DSH_COMFYUI_DATA_DIR || ''
  if (env) return resolve(env)
  return join(REPO_ROOT, 'data', 'danbooru')
}

export function resolveTo(opts) {
  if (opts.to) return resolve(opts.to)
  return join(REPO_ROOT, 'data', 'danbooru-sfw')
}

async function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function readText(file) {
  return readFile(file, 'utf8')
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

export async function readGroups(dir) {
  const file = join(dir, 'groups.jsonl')
  if (!(await exists(file))) return new Map()
  return buildGroupMap(await readText(file))
}

export async function filterDict({ from, to, stats = false, force = false, quiet = false }) {
  const source = resolveFrom({ from: from || '' })
  if (!(await exists(join(source, 'general.jsonl')))) {
    return { ok: false, error: 'no-source', message: '源目录里没有 general.jsonl：' + source }
  }
  const groups = await readGroups(source)
  const files = []
  const removedBy = {}
  const planned = []
  for (const name of PUBLIC_DICT_FILES) {
    const file = join(source, name)
    if (!(await exists(file))) continue
    const text = await readText(file)
    const { kept, removed, sanitized } = filterLines(text, groups)
    const payload = kept.join('\n') + (kept.length ? '\n' : '')
    const counts = tallyReasons(removed)
    if (sanitized.length > 0) counts.sanitized = sanitized.length
    for (const [key, value] of Object.entries(counts)) removedBy[key] = (removedBy[key] || 0) + value
    files.push({
      name,
      lines: kept.length,
      removed: removed.length,
      bytes: Buffer.byteLength(payload),
      sha256: createHash('sha256').update(payload).digest('hex'),
    })
    planned.push({ name, payload, sample: removed.slice(0, 5) })
  }
  const general = files.find((item) => item.name === 'general.jsonl')
  if (!general || general.lines < MIN_GENERAL_LINES) {
    return { ok: false, error: 'too-few-lines', message: '过滤后 general.jsonl 只剩 ' + (general ? general.lines : 0) + ' 行，低于下限 ' + MIN_GENERAL_LINES }
  }
  if (stats) {
    return { ok: true, stats: true, from: source, to: resolveTo({ to: to || '' }), files, removedBy }
  }
  const target = resolveTo({ to: to || '' })
  if (!force && (await exists(join(target, 'general.jsonl')))) {
    return { ok: false, error: 'exists', message: '目标目录已有词表：' + target + '（要覆盖加 --force）' }
  }
  await mkdir(target, { recursive: true })
  for (const item of planned) await writeAtomic(join(target, item.name), item.payload)
  const manifest = {
    source,
    filteredAt: new Date().toISOString(),
    sfw: true,
    minGeneralLines: MIN_GENERAL_LINES,
    blockedGroups: SFW_BLOCKED_GROUPS,
    removedBy,
    files,
  }
  await writeAtomic(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { ok: true, from: source, to: target, files, removedBy, samples: planned.map((item) => ({ name: item.name, removed: item.sample })) }
}

export async function checkSfw(dir) {
  const target = resolve(dir || '')
  if (!(await exists(target))) return { ok: false, error: 'no-dir', message: '目录不存在：' + target }
  if (!(await exists(join(target, 'manifest.json')))) return { ok: false, error: 'no-manifest', message: '缺 manifest.json：' + target }
  let manifest = null
  try {
    manifest = JSON.parse(await readText(join(target, 'manifest.json')))
  } catch {
    return { ok: false, error: 'bad-manifest', message: 'manifest.json 不是合法 JSON：' + target }
  }
  // 没打 sfw 标记的是完整快照（私有仓那份），本来就有露骨词，不归这里管
  if (!(manifest && manifest.sfw === true)) return { ok: true, skipped: true, total: 0 }
  const groups = await readGroups(target)
  const dirty = []
  let total = 0
  for (const name of PUBLIC_DICT_FILES) {
    const file = join(target, name)
    if (!(await exists(file))) continue
    const { kept, removed } = filterLines(await readText(file), groups)
    total += kept.length
    for (const item of removed) dirty.push({ file: name, tag: item.tag, reason: item.reason })
  }
  if (dirty.length > 0) {
    return { ok: false, error: 'nsfw-found', total, dirty: dirty.slice(0, 50), count: dirty.length, message: '还有 ' + dirty.length + ' 条露骨词条' }
  }
  return { ok: true, total }
}

export async function main(argv = process.argv.slice(2), io = { out: (line) => console.log(line) }) {
  const opts = parseArgs(argv)
  if (opts.error) {
    io.out('参数错误：' + opts.error)
    io.out(usageText())
    return 2
  }
  if (opts.help) {
    io.out(usageText())
    return 0
  }
  if (opts.check) {
    const result = await checkSfw(resolveTo(opts))
    if (opts.json) io.out(JSON.stringify(result))
    else if (result.ok && result.skipped) io.out('SFW 体检跳过：这份词表是完整快照（manifest 没有 sfw 标记）')
    else if (result.ok) io.out('SFW 体检通过：' + result.total + ' 条，无露骨词条')
    else io.out('SFW 体检失败（' + result.error + '）：' + result.message)
    return result.ok ? 0 : result.error === 'nsfw-found' ? 1 : 2
  }
  const result = await filterDict({
    from: opts.from,
    to: opts.to,
    stats: opts.stats,
    force: opts.force,
    quiet: opts.quiet,
  })
  if (!result.ok) {
    if (opts.json) io.out(JSON.stringify(result))
    else io.out('过滤失败（' + result.error + '）：' + result.message)
    return result.error === 'exists' ? 1 : 2
  }
  const total = result.files.reduce((sum, item) => sum + item.lines, 0)
  const dropped = result.files.reduce((sum, item) => sum + item.removed, 0)
  if (opts.json) io.out(JSON.stringify(result))
  else if (!opts.quiet) {
    io.out('SFW 词表：' + (result.stats ? '（只统计）' : result.to))
    for (const item of result.files) io.out('  ' + item.name.padEnd(18) + item.lines + ' 行（丢 ' + item.removed + '）')
    io.out('合计 ' + total + ' 行，丢 ' + dropped + ' 条；原因 ' + JSON.stringify(result.removedBy))
  }
  return 0
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err && err.stack ? err.stack : err)
    process.exit(1)
  })
}
