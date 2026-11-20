#!/usr/bin/env node
/**
 * 把私有版（本仓库）的提示词与词表一键注入到公开版（默认 ../DSh tagger-lite）。
 *
 * 背景：scripts/release/make-public.mjs 生成公开版时会做三件事 ——
 *   1. 整份丢掉 data/tags/general-nsfw.jsonl（SKIP）；
 *   2. 含露骨词的整行丢掉（data/tags/pose-view.jsonl、seed-08-adult.jsonl、lib/zh-intent.js 的体位条目）；
 *   3. 整块替换成不含露骨词的等价结构（lib/purge.js 的提示词、lib/postprocess/rules.js 的分桶表）。
 * 本脚本做的是**反向**：把这几份文件按私有版原样覆盖回公开版，
 * 于是公开版 = 私货全量版（同一套破甲提示词 + 同一套词表）。
 *
 * 用法：
 *   node scripts/release/inject-private.mjs                 # 注入（默认目标 ../DSh tagger-lite）
 *   node scripts/release/inject-private.mjs --dry           # 只列表，不写盘
 *   node scripts/release/inject-private.mjs --check         # 已最新 → 退出码 0；有差异 → 1
 *   node scripts/release/inject-private.mjs --dst <目录>    # 指定目标仓
 *   node scripts/release/inject-private.mjs --only prompt,tags
 *   node scripts/release/inject-private.mjs --verify        # 注入后跑一遍目标仓的词表自检
 *   node scripts/release/inject-private.mjs --restore       # 用最近一次备份还原
 *   node scripts/release/inject-private.mjs --restore <名>  # 用指定备份还原
 *
 * 安全提示：注入后的目录**不要** git push 到公开仓。想回到干净公开版，
 * 就重跑 node scripts/release/make-public.mjs，或者 --restore 回到注入前。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SELF = process.argv[1] ? path.resolve(process.argv[1]) : ''
// 两种布局：仓库里（scripts/release/inject-private.mjs，源在上两级）；打包后（<包>/inject-private.mjs，源在 <包>/payload/）
const PKG_LAYOUT = existsSync(path.join(HERE, 'payload'))
const SRC_ROOT = PKG_LAYOUT ? path.join(HERE, 'payload') : ROOT
const argv = process.argv.slice(2)

/** 取 `--name value` 的值。 @param {string} name @returns {string | undefined} */
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const DST = path.resolve(argOf('--dst') ?? path.join(path.dirname(SRC_ROOT), 'DSh tagger-lite'))
const DRY = argv.includes('--dry')
const CHECK = argv.includes('--check')
const VERIFY = argv.includes('--verify')
const QUIET = argv.includes('--quiet')
const BACKUP_ROOT = path.resolve(argOf('--backup-dir') ?? path.join(PKG_LAYOUT ? HERE : SRC_ROOT, '.inject-backups'))

/**
 * 要注入的文件清单。key 用于 --only 过滤。
 * @type {Array<{ key: string, rel: string, label: string }>}
 */
export const INJECT_FILES = [
  { key: 'prompt', rel: 'lib/purge.js', label: '破甲提示词（提示词模块全文）' },
  { key: 'rules', rel: 'lib/postprocess/rules.js', label: '分桶与上下位表（成人向细节）' },
  { key: 'intent', rel: 'lib/zh-intent.js', label: '中文意图词表（体位/行为条目）' },
  { key: 'tags', rel: 'data/tags/general-nsfw.jsonl', label: 'NSFW 补词表（公开版整份没有）' },
  { key: 'tags', rel: 'data/tags/pose-view.jsonl', label: '姿势 / 视角词表' },
  { key: 'tags', rel: 'data/tags/seed/seed-08-adult.jsonl', label: '成人向种子词' }
]

/** @param {Buffer | string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {string} file */
function readOrNull(file) {
  try { return readFileSync(file) } catch { return null }
}

/** 时间戳目录名：20261119-223501 @param {Date} [d] */
function stamp(d = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/** 计划：逐份比对源与目标的差异。 */
function plan() {
  const only = argOf('--only')
  const wanted = only ? new Set(only.split(',').map(s => s.trim()).filter(Boolean)) : null
  const items = INJECT_FILES.filter(f => !wanted || wanted.has(f.key) || wanted.has(f.rel))
  return items.map(f => {
    const srcPath = path.join(SRC_ROOT, f.rel)
    const dstPath = path.join(DST, f.rel)
    const src = readOrNull(srcPath)
    const dst = readOrNull(dstPath)
    let state = 'update'
    if (src === null) state = 'missing-source'
    else if (dst === null) state = 'new'
    else if (src.equals(dst)) state = 'same'
    return { ...f, srcPath, dstPath, src, dst, state }
  })
}

/** 备份目标文件到 <备份根>/<时间戳>/<rel>。 @param {ReturnType<typeof plan>} items */
function backup(items) {
  const dir = path.join(BACKUP_ROOT, stamp())
  /** @type {Array<{ rel: string, existed: boolean, sha256?: string }>} */
  const entries = []
  for (const it of items) {
    if (it.state === 'same' || it.state === 'missing-source') continue
    if (it.dst === null) { entries.push({ rel: it.rel, existed: false }); continue }
    const out = path.join(dir, it.rel)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, it.dst)
    entries.push({ rel: it.rel, existed: true, sha256: sha256(it.dst) })
  }
  if (entries.length === 0) return null
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), dst: DST, entries }, null, 2) + '\n')
  return dir
}

/** 从备份还原。 @param {string} dir */
function restore(dir) {
  const manifestPath = path.join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error('× 备份目录里没有 manifest.json：' + dir)
    process.exitCode = 2
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const entry of manifest.entries ?? []) {
    const target = path.join(DST, entry.rel)
    if (entry.existed) {
      const saved = path.join(dir, entry.rel)
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(saved, target)
      console.log('↩ 还原  ' + entry.rel)
    } else if (existsSync(target)) {
      rmSync(target, { force: true })
      console.log('↩ 删除  ' + entry.rel + '（注入前并不存在）')
    }
  }
}

/** 最近一次备份目录。 */
function latestBackup() {
  if (!existsSync(BACKUP_ROOT)) return null
  const names = readdirSync(BACKUP_ROOT).filter(n => {
    try { return statSync(path.join(BACKUP_ROOT, n)).isDirectory() } catch { return false }
  }).sort()
  return names.length ? path.join(BACKUP_ROOT, names[names.length - 1]) : null
}

/** 注入后跑一遍目标仓的词表自检（只在目标仓有 scripts/tags/check-tags.mjs 时）。 */
function verify() {
  const check = path.join(DST, 'scripts', 'tags', 'check-tags.mjs')
  if (!existsSync(check)) { console.log('· 目标仓没有 scripts/tags/check-tags.mjs，跳过自检'); return true }
  const r = spawnSync(process.execPath, [check], { cwd: DST, encoding: 'utf8' })
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
  if (out) console.log(out)
  return r.status === 0
}

function main() {
const restoreArg = argv.indexOf('--restore')
if (restoreArg >= 0) {
  const named = argOf('--restore')
  const dir = named && !named.startsWith('--') ? path.resolve(named) : latestBackup()
  if (!dir) { console.error('× 还没有任何备份：' + BACKUP_ROOT); process.exitCode = 2 }
  else { console.log('回滚来源：' + dir); restore(dir); console.log('回滚完成。') }
} else {
  if (!existsSync(DST)) { console.error('× 目标仓不存在：' + DST + '（用 --dst 指定）'); process.exitCode = 2 }
  else {
    const items = plan()
    const pending = items.filter(it => it.state === 'new' || it.state === 'update')
    if (!QUIET) {
      console.log('源：' + SRC_ROOT)
      console.log('目标：' + DST)
      console.log('')
      console.log('文件                                        状态      字节')
      for (const it of items) {
        const tagText = it.state === 'same' ? '已最新' : it.state === 'new' ? '新增' : it.state === 'update' ? '覆盖' : '缺源文件'
        const sizes = (it.dst ? it.dst.length : 0) + ' → ' + (it.src ? it.src.length : 0)
        console.log(it.rel.padEnd(44) + tagText.padEnd(8) + sizes.padStart(12) + '  ' + it.label)
      }
      console.log('')
    }
    if (CHECK) {
      console.log(pending.length === 0 ? '✓ 公开版已是私货全量版（无需注入）' : '× 还有 ' + pending.length + ' 份文件没注入')
      process.exitCode = pending.length === 0 ? 0 : 1
    } else if (DRY) {
      console.log(pending.length === 0 ? '（dry run）没有需要改的文件' : '（dry run）将写入 ' + pending.length + ' 份文件，未落盘')
    } else if (pending.length === 0) {
      console.log('✓ 已经是私货全量版，什么都没改')
    } else {
      const dir = backup(items)
      for (const it of pending) {
        if (it.src === null) continue
        mkdirSync(path.dirname(it.dstPath), { recursive: true })
        writeFileSync(it.dstPath, it.src)
      }
      console.log('✓ 注入完成：' + pending.length + ' 份文件' + (dir ? '（原文件已备份到 ' + dir + '）' : ''))
      const hint = PKG_LAYOUT ? 'inject.cmd "' + DST + '" --restore' : 'node scripts/release/inject-private.mjs --restore'
      console.log('  公开版现在是私货全量版 —— 不要 git push 到公开仓；要还原：' + hint)
      if (VERIFY && !verify()) { console.error('× 目标仓词表自检失败'); process.exitCode = 1 }
    }
  }
}
}

if (SELF === path.resolve(fileURLToPath(import.meta.url))) main()
