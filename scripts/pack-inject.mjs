#!/usr/bin/env node
/**
 * scripts/pack-inject.mjs — 打「注入包」：把私货提示词 + 注入脚本装成一个能拷走的 zip。
 *
 * 为什么要单独打一个包：注入脚本原本只认仓库布局（tools/ 上一级就是私有仓）。
 * 换台机器、或者只想把「注入能力」交给别人时，光拷一个 .mjs 没用 —— 六份私货文件也得跟着走。
 * 所以包里的布局是：
 *   dsh-tagger-inject-<版本>/
 *     inject-private.mjs        注入脚本（认 payload/ 布局）
 *     payload/<rel>             六份私货文件，保持仓库里的相对路径
 *     inject.cmd / inject.sh    双击/命令行入口（自动找 node，找不到就用 DSH 的 electron 当 node）
 *     README.txt                用法与还原说明
 *     MANIFEST.txt              每份文件的 sha256 前 16 位
 *
 * 用法：
 *   node scripts/pack-inject.mjs                 # 出 dist/dsh-tagger-inject-<版本>/ 与同名 zip
 *   node scripts/pack-inject.mjs --out /tmp/x    # 换输出目录
 *   node scripts/pack-inject.mjs --no-zip        # 只要目录
 *   node scripts/pack-inject.mjs --quiet         # 只报结果
 */
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { INJECT_FILES } from '../tools/inject-private.mjs'
import { makeZip, readVersion, ROOT } from './pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 递归列目录，返回 posix 相对路径（相对 root） @param {string} root @param {string} [rel] */
function walk(root, rel = '') {
  const out = []
  const abs = rel === '' ? root : path.join(root, rel)
  for (const name of readdirSync(abs).sort()) {
    const childRel = rel === '' ? name : rel + '/' + name
    const st = statSync(path.join(root, childRel))
    if (st.isDirectory()) out.push(...walk(root, childRel))
    else if (st.isFile()) out.push(childRel)
  }
  return out
}

/** @param {number} bytes */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

const CMD_SCRIPT = [
  '@echo off',
  'setlocal',
  'set "HERE=%~dp0"',
  'if "%~1"=="" goto usage',
  'set "TARGET=%~1"',
  'set "EXTRA="',
  'shift',
  ':collect',
  'if "%~1"=="" goto findnode',
  'set "EXTRA=%EXTRA% %1"',
  'shift',
  'goto collect',
  ':findnode',
  'set "NODE="',
  'where node >nul 2>nul',
  'if not errorlevel 1 set "NODE=node"',
  'if not defined NODE if exist "%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" set "NODE=%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe"',
  'if not defined NODE if exist "%USERPROFILE%\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" set "NODE=%USERPROFILE%\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe"',
  'if not defined NODE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
  'if not defined NODE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE=%ProgramFiles(x86)%\\nodejs\\node.exe"',
  'if not defined NODE goto nonode',
  'set ELECTRON_RUN_AS_NODE=1',
  '"%NODE%" "%HERE%inject-private.mjs" --dst "%TARGET%"%EXTRA%',
  'set "CODE=%ERRORLEVEL%"',
  'endlocal & exit /b %CODE%',
  ':usage',
  'echo Usage: inject.cmd TARGET_DIR [--dry ^| --check ^| --verify ^| --restore]',
  'echo Example: inject.cmd "D:\\DSh tagger-lite"',
  'endlocal & exit /b 1',
  ':nonode',
  'echo No node found. Install Node.js 20+ or put this package next to a DeepSeek Harness install.',
  'endlocal & exit /b 3',
].join('\r\n') + '\r\n'

const SH_SCRIPT = [
  '#!/bin/sh',
  'set -e',
  'HERE=$(cd "$(dirname "$0")" && pwd)',
  'if [ $# -lt 1 ]; then',
  '  echo "用法: ./inject.sh <目标目录> [--dry|--check|--verify|--restore]"',
  '  echo "例: ./inject.sh \"/home/me/dsh-tagger-lite\""',
  '  exit 1',
  'fi',
  'TARGET=$1',
  'shift',
  'exec node "$HERE/inject-private.mjs" --dst "$TARGET" "$@"',
].join('\n') + '\n'

function readmeText(version, rows) {
  return [
    'DSh Tagger 注入包 ' + version,
    '',
    '把私有版（完整版）的提示词与词表注入到公开版（和谐版），让公开版变成「私货全量版」。',
    '不需要 node_modules、不联网、不改公开版的任何其他文件。',
    '',
    '一、先确认目标目录是公开版仓库的根（里面有 index.js、lib/、data/tags/）。',
    '',
    '二、注入（Windows 双击命令行，或把目录拖进来）：',
    '      inject.cmd "D:\\DSh tagger-lite"',
    '    Linux / macOS：',
    '      ./inject.sh "/home/me/dsh-tagger-lite"',
    '',
    '三、常用开关（加在目标目录后面）：',
    '      --dry        只列表，不写盘',
    '      --check      已最新退出码 0，有差异退出码 1（脚本/CI 用）',
    '      --verify     注完顺手跑目标目录的词表自检',
    '      --only prompt,tags   只注入部分（prompt / rules / intent / tags）',
    '      --restore    用最近一次备份还原（也可 --restore <备份目录名>）',
    '',
    '四、包里注入哪六份：',
    ...rows.map(r => '      ' + r.rel.padEnd(40) + r.label),
    '',
    '五、安全：',
    '  - 写盘前自动备份到本包目录的 .inject-backups\\<时间戳>\\（含 manifest.json，记 sha256 与',
    '    「注入前是否存在」），--restore 能精确回滚，包括删掉注入前本来不存在的文件。',
    '  - 注入后的目标目录不要 git push 到公开仓。想回干净公开版：--restore，或重跑私货仓的',
    '    node tools/make-public.mjs。',
    '  - 包里的 payload/ 是明文私货，别传到公开仓库或网盘公开链接。',
    '',
    '六、找不到 node 时：',
    '  Windows 上 inject.cmd 会依次试 PATH 里的 node → DeepSeek Harness 自带的 electron（当 node 用）',
    '  → C:\\Program Files\\nodejs\\node.exe。都没有就装一个 Node.js 20+ 再跑。',
  ].join('\r\n') + '\r\n'
}

/**
 * 打注入包。
 * @param {{ root?: string, outDir?: string, zip?: boolean, quiet?: boolean }} [options]
 * @returns {{ dir: string, zip: string | null, version: string, files: number, bytes: number }}
 */
export function makeInjectPack(options = {}) {
  const root = options.root ?? ROOT
  const outDir = path.resolve(options.outDir ?? path.join(root, 'dist'))
  const wantZip = options.zip !== false
  const quiet = options.quiet === true
  const version = readVersion(root)
  const name = 'dsh-tagger-inject-' + version
  const dir = path.join(outDir, name)

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const manifest = ['# DSh Tagger 注入包清单 ' + name, '# 路径  sha256  字节']
  let bytes = 0
  let files = 0
  /** @param {string} rel @param {Buffer | string} data */
  const put = (rel, data) => {
    const to = path.join(dir, rel)
    mkdirSync(path.dirname(to), { recursive: true })
    writeFileSync(to, data)
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    bytes += buf.length
    files += 1
    manifest.push(rel + '  ' + createHash('sha256').update(buf).digest('hex').slice(0, 16) + '  ' + buf.length)
  }

  put('inject-private.mjs', readFileSync(path.join(root, 'tools', 'inject-private.mjs')))
  const rows = []
  for (const item of INJECT_FILES) {
    const from = path.join(root, item.rel)
    if (!existsSync(from)) throw new Error('缺源文件：' + from)
    put('payload/' + item.rel, readFileSync(from))
    rows.push(item)
  }
  put('inject.cmd', CMD_SCRIPT)
  put('inject.sh', SH_SCRIPT)
  put('README.txt', readmeText(version, rows))
  manifest.push('', '# 共 ' + files + ' 个文件（含 README/MANIFEST），' + fmtSize(bytes))
  put('MANIFEST.txt', manifest.join('\r\n') + '\r\n')

  if (process.platform !== 'win32') {
    chmodSync(path.join(dir, 'inject.sh'), 0o755)
    chmodSync(path.join(dir, 'inject-private.mjs'), 0o755)
  }

  let zipPath = null
  if (wantZip) {
    const entries = walk(dir).map(rel => ({ name: name + '/' + rel, data: readFileSync(path.join(dir, rel)) }))
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    zipPath = path.join(outDir, name + '.zip')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(zipPath, makeZip(entries))
  }

  if (!quiet) {
    console.log('注入包：' + dir)
    if (zipPath) console.log('压缩包：' + zipPath + '（' + fmtSize(statSync(zipPath).size) + '）')
    console.log('文件 ' + files + ' 个（六份私货 + 脚本 + 说明），' + fmtSize(bytes))
  }
  return { dir, zip: zipPath, version, files, bytes }
}

function parseArgs(argv) {
  const out = { outDir: undefined, zip: true, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--out' && next) { out.outDir = next; i += 1; continue }
    if (token === '--no-zip') { out.zip = false; continue }
    if (token === '--zip') { out.zip = true; continue }
    if (token === '--quiet') { out.quiet = true; continue }
    if (token === '--help' || token === '-h') {
      console.log('用法：node scripts/pack-inject.mjs [--out <目录>] [--no-zip] [--quiet]')
      process.exit(0)
    }
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2))
  const result = makeInjectPack({ outDir: args.outDir, zip: args.zip, quiet: args.quiet })
  process.exitCode = result.files > 0 ? 0 : 1
}