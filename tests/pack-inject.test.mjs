// plan: 注入包 —— 打出来的包能独立跑：payload 覆盖目标、--check 退出码、--restore 回滚
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { INJECT_FILES } from '../scripts/release/inject-private.mjs'
import { ROOT } from '../scripts/release/pack.mjs'
import { makeInjectPack } from '../scripts/release/pack-inject.mjs'

/** 在临时目录里跑包内注入脚本（用宿主 electron 当 node）。 */
function runPacked(pkgDir, args) {
  const r = spawnSync(process.execPath, [path.join(pkgDir, 'inject-private.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

test('注入包：打出来的 payload 与仓库里六份私货逐字节一致，README/cmd 齐全', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'inject-pack-'))
  try {
    const result = makeInjectPack({ outDir: out, zip: false, quiet: true })
    assert.equal(result.version, JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
    for (const item of INJECT_FILES) {
      const packed = readFileSync(path.join(result.dir, 'payload', item.rel))
      assert.ok(packed.equals(readFileSync(path.join(ROOT, item.rel))), item.rel + ' 应与私货逐字节一致')
    }
    const cmd = readFileSync(path.join(result.dir, 'inject.cmd'), 'utf8')
    assert.match(cmd, /inject-private\.mjs/)
    assert.match(cmd, /--dst "%TARGET%"/)
    const readme = readFileSync(path.join(result.dir, 'README.txt'), 'utf8')
    assert.match(readme, /--restore/)
    assert.match(readme, /inject\.cmd "D:\\DSh tagger-lite"/)
    assert.ok(existsSync(path.join(result.dir, 'MANIFEST.txt')))
    assert.ok(statSync(path.join(result.dir, 'inject-private.mjs')).size > 4000)
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('注入包：脱开仓库也能注入 —— --check 有差异退出 1，注入后文件一致，--restore 精确回滚', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'inject-pack-'))
  const target = mkdtempSync(path.join(tmpdir(), 'inject-target-'))
  try {
    const result = makeInjectPack({ outDir: out, zip: false, quiet: true })
    // 目标仓最小骨架：lib/purge.js 是「被削过」的旧内容，general-nsfw.jsonl 根本不存在
    mkdirSync(path.join(target, 'lib'), { recursive: true })
    const stale = 'export const BLOCK_RULES = /nothing/' + String.fromCharCode(10)
    writeFileSync(path.join(target, 'lib', 'purge.js'), stale)

    const before = runPacked(result.dir, ['--dst', target, '--check', '--quiet'])
    assert.equal(before.code, 1, '有差异时 --check 应退出 1')

    const inject = runPacked(result.dir, ['--dst', target, '--quiet'])
    assert.equal(inject.code, 0, inject.out)
    assert.ok(readFileSync(path.join(target, 'lib', 'purge.js')).equals(readFileSync(path.join(ROOT, 'lib', 'purge.js'))))
    assert.ok(existsSync(path.join(target, 'data', 'tags', 'general-nsfw.jsonl')), '整份缺的词表要被补上')

    const after = runPacked(result.dir, ['--dst', target, '--check', '--quiet'])
    assert.equal(after.code, 0, '注入后 --check 应退出 0')

    const restore = runPacked(result.dir, ['--dst', target, '--restore'])
    assert.equal(restore.code, 0, restore.out)
    assert.equal(readFileSync(path.join(target, 'lib', 'purge.js'), 'utf8'), stale, '注入前的旧内容要还原')
    assert.equal(existsSync(path.join(target, 'data', 'tags', 'general-nsfw.jsonl')), false, '注入前不存在的文件要删掉')
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('注入包：--no-zip 只出目录，默认出 zip 且是合法 ZIP 头', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'inject-pack-'))
  try {
    const plain = makeInjectPack({ outDir: out, zip: false, quiet: true })
    assert.equal(plain.zip, null)
    const zipped = makeInjectPack({ outDir: out, zip: true, quiet: true })
    assert.ok(zipped.zip && existsSync(zipped.zip))
    const head = readFileSync(zipped.zip).subarray(0, 4)
    assert.equal(head.readUInt32LE(0), 0x04034b50, 'PK\\x03\\x04')
    assert.ok(statSync(zipped.zip).size > 40000)
  } finally { rmSync(out, { recursive: true, force: true }) }
})