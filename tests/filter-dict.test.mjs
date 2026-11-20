// SFW 词表过滤：公开仓那份 data/danbooru 就是这个脚本的产物。
// 这里只用临时 fixture，不读真词表，所以私有仓和公开仓都能跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NSFW_LINE,
  PUBLIC_DICT_FILES,
  checkSfw,
  filterDict,
  filterLines,
  nsfwReason,
  parseArgs,
  sanitizeEntry,
} from '../scripts/tags/filter-dict.mjs'

function entry(tag, names, extra) {
  return JSON.stringify(Object.assign({ tag, kind: 'general', postCount: 10, names: names || [] }, extra || {}))
}

function makeSource() {
  const dir = mkdtempSync(join(tmpdir(), 'sfw-src-'))
  const general = [
    entry('smile', ['微笑', '笑'], { note: '嘴角上扬的表情' }),
    entry('sex', ['性交', '做爱'], { note: '插入式性行为' }),
    entry('shrug_(clothing)', ['披肩式短上衣', '露胸领衫'], { note: '只有袖子、相连成一体的披肩式上衣' }),
    entry('pussy', ['阴部'], { note: '女性外生殖器' }),
    entry('cum_on_face', ['颜射']),
    entry('artist_alias', ['画师'], { note: '常用别名里带 pussy 这个词' }),
    entry('1girl', ['一个女孩', '少女']),
  ]
  // 凑够下限，否则 filterDict 会以 too-few-lines 拒绝
  for (let i = 0; i < 20000; i += 1) general.push(entry('filler_' + i, ['填充' + i]))
  writeFileSync(join(dir, 'general.jsonl'), general.join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, 'characters.jsonl'), [entry('mika', ['米卡'])].join('\n') + '\n', 'utf8')
  writeFileSync(join(dir, 'groups.jsonl'), [
    JSON.stringify({ tag: 'pussy', groups: ['Body parts', 'Pussy'] }),
    JSON.stringify({ tag: 'smile', groups: ['Face tags'] }),
  ].join('\n') + '\n', 'utf8')
  return dir
}

test('判定规则：分组 > tag token > 中文别名 > 备注', () => {
  assert.equal(nsfwReason({ tag: 'pussy', names: [] }, new Map([['pussy', ['Pussy']]])), 'group:Pussy')
  assert.equal(nsfwReason({ tag: 'cum_on_face', names: [] }, new Map()), 'token:cum')
  assert.equal(nsfwReason({ tag: 'friendly', names: [] }, new Map()), '', 'friendly 里的 end 不算 token')
  assert.equal(nsfwReason({ tag: 'classroom', names: [] }, new Map()), '', 'class 里没有 ass 这个 token')
  assert.equal(nsfwReason({ tag: 'smile', names: ['微笑', '露胸领衫'] }, new Map()), 'cn:露胸')
  assert.equal(nsfwReason({ tag: 'smile', names: ['微笑'], note: '带阴部描述' }, new Map()), 'note:阴部')
  // 豁免表：常规人体词不因为 Danbooru 把它们挂在 Nudity 下就丢掉
  assert.equal(nsfwReason({ tag: 'breasts', names: ['乳房'] }, new Map([['breasts', ['Nudity', 'Breasts tags']]])), '')
  // 负向侧的质量词不受影响
  assert.equal(nsfwReason({ tag: 'worst_quality', names: [] }, new Map()), '')
})

test('别名带脏词只摘别名，不整条丢', () => {
  const e = { tag: 'shrug_(clothing)', names: ['披肩式短上衣', '露胸领衫'], note: '披肩式上衣' }
  assert.equal(sanitizeEntry(e), true)
  assert.deepEqual(e.names, ['披肩式短上衣'])
  assert.deepEqual(filterLines(entry('shrug_(clothing)', ['披肩式短上衣', '露胸领衫']), new Map()).kept.length, 1)
  assert.equal(filterLines(entry('cum_on_face', ['颜射']), new Map()).kept.length, 0)
})

test('红线兜底：词条干净但整行命中红线也丢', () => {
  const dirty = entry('harmless_tag', ['pussy'], { note: 'no explicit here' })
  assert.equal(NSFW_LINE.test(dirty), true, '别名里写着红线词，这一行必须丢')
  const { kept, removed } = filterLines(dirty, new Map())
  assert.deepEqual(kept, [])
  assert.equal(removed[0].reason, 'line')
})

test('parseArgs：开关与未知参数', () => {
  assert.deepEqual(parseArgs(['--from', 'a', '--to', 'b', '--check', '--json']), {
    from: 'a', to: 'b', check: true, stats: false, quiet: false, json: true, force: false,
  })
  assert.equal(parseArgs(['--nope']).error, 'unknown-arg:--nope')
  assert.equal(parseArgs(['--help']).help, true)
})

test('filterDict：写盘、写 manifest、二次跑默认拒绝、--force 覆盖', async () => {
  const src = makeSource()
  const dst = mkdtempSync(join(tmpdir(), 'sfw-dst-'))
  const first = await filterDict({ from: src, to: dst })
  assert.equal(first.ok, true, first.message)
  const manifest = JSON.parse(readFileSync(join(dst, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sfw, true)
  assert.equal(manifest.minGeneralLines, 20000)
  const written = first.files.map((item) => item.name).sort()
  assert.deepEqual(written, ['characters.jsonl', 'general.jsonl'], 'groups.jsonl 不进公开版')
  const general = readFileSync(join(dst, 'general.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).tag)
  assert.equal(general.includes('sex'), false)
  assert.equal(general.includes('pussy'), false)
  assert.equal(general.includes('cum_on_face'), false)
  assert.equal(general.includes('artist_alias'), false, '备注里带 pussy 的整条丢')
  assert.equal(general.includes('smile'), true)
  const shrug = readFileSync(join(dst, 'general.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.tag === 'shrug_(clothing)')
  assert.deepEqual(shrug.names, ['披肩式短上衣'], '脏别名被摘掉')
  assert.equal(manifest.removedBy.group, 1)
  assert.ok(manifest.removedBy.sanitized >= 1)

  const again = await filterDict({ from: src, to: dst })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'exists')
  const forced = await filterDict({ from: src, to: dst, force: true })
  assert.equal(forced.ok, true)
})

test('filterDict：源目录缺 general.jsonl 与过滤后低于下限都拒绝', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'sfw-empty-'))
  const noSource = await filterDict({ from: empty, to: mkdtempSync(join(tmpdir(), 'sfw-x-')) })
  assert.equal(noSource.error, 'no-source')

  const thin = mkdtempSync(join(tmpdir(), 'sfw-thin-'))
  writeFileSync(join(thin, 'general.jsonl'), entry('smile', ['微笑']) + '\n', 'utf8')
  const tooFew = await filterDict({ from: thin, to: mkdtempSync(join(tmpdir(), 'sfw-y-')) })
  assert.equal(tooFew.error, 'too-few-lines')
})

test('checkSfw：SFW 目录通过、混入露骨词条报错、完整快照跳过', async () => {
  const src = makeSource()
  const dst = join(mkdtempSync(join(tmpdir(), 'sfw-ok-')), 'dict')
  await filterDict({ from: src, to: dst })
  const ok = await checkSfw(dst)
  assert.equal(ok.ok, true)
  assert.ok(ok.total > 20000)

  // 手工往产物里塞一条露骨词条：体检必须抓出来
  writeFileSync(join(dst, 'general.jsonl'), readFileSync(join(dst, 'general.jsonl'), 'utf8') + entry('sex', ['性交']) + '\n', 'utf8')
  const dirty = await checkSfw(dst)
  assert.equal(dirty.ok, false)
  assert.equal(dirty.error, 'nsfw-found')
  assert.equal(dirty.dirty[0].tag, 'sex')

  // 完整快照（manifest 没有 sfw 标记）不归这里管
  const full = mkdtempSync(join(tmpdir(), 'sfw-full-'))
  writeFileSync(join(full, 'general.jsonl'), entry('smile', ['微笑']) + '\n', 'utf8')
  writeFileSync(join(full, 'manifest.json'), JSON.stringify({ source: 'x', files: [] }), 'utf8')
  const skipped = await checkSfw(full)
  assert.equal(skipped.ok, true)
  assert.equal(skipped.skipped, true)

  const missing = await checkSfw(join(tmpdir(), 'sfw-nope-' + Date.now()))
  assert.equal(missing.error, 'no-dir')
})

test('公开版词表只带四份主词表，manifest 记着剔除数量', () => {
  assert.deepEqual(PUBLIC_DICT_FILES, ['general.jsonl', 'characters.jsonl', 'copyrights.jsonl', 'artists.jsonl'])
  assert.equal(PUBLIC_DICT_FILES.includes('groups.jsonl'), false)
})
