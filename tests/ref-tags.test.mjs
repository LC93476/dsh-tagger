/**
 * 参考卡 → tag 映射（lib/ref-tags.js）：表结构 / 纯函数行为 / 真词表与真卡片核对。
 * 词表或图库不在干净机器上时，相关用例 skip 而不是变红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COSTUME_CN_TAGS,
  COSTUME_WORD_TAGS,
  PORTRAIT_FRAMING,
  PORTRAIT_HAIR_TAGS,
  PORTRAIT_PARTITION_TAGS,
  PORTRAIT_STYLE_HINTS,
  REF_SOURCES,
  TAG_CN,
  tagListFor,
  tagsForCostume,
  tagsForPortrait,
} from '../lib/ref-tags.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DICT = path.join(REPO, 'data', 'danbooru', 'general.jsonl')

/** 词表里能出现的形态：小写、数字、下划线、连字符。 */
const TAG_SHAPE = /^[a-z0-9][a-z0-9_-]*$/

/** 卡片数据不在本仓库里，按候选路径找；找不到就 skip。 */
const COSTUME_CATALOGS = [
  path.join(REPO, 'data', 'costumes', 'catalog.json'),
  path.join('D:', 'QUARK', 'dsh-comfyui-workbench', 'data', 'costumes', 'catalog.json'),
  path.join('D:', 'QUARK', 'dsh-comfyui-workbench', 'data', 'costumes-anime', 'catalog.json'),
]
const PORTRAIT_CATALOGS = [
  path.join(REPO, 'data', 'portrait', 'catalog.csv'),
  path.join('D:', 'QUARK', 'ComfyUI-aki-v3.2', 'ComfyUI', 'custom_nodes', 'ai-pose-gallery-zh', 'skills', 'portrait-reference', 'references', 'catalog.csv'),
]

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 表里所有产出的 tag（去重）。 */
function allMappedTags() {
  const set = new Set()
  for (const key of Object.keys(REF_SOURCES)) {
    const table = REF_SOURCES[key]
    if (Array.isArray(table)) {
      for (const hint of table) for (const tag of hint.tags) set.add(tag)
      continue
    }
    for (const value of Object.values(table)) for (const tag of value) set.add(tag)
  }
  return set
}

/** 读词表 tag → postCount；文件不在返回 null。 */
let dictMap
function readDict() {
  if (dictMap !== undefined) return dictMap
  if (!fs.existsSync(DICT)) {
    dictMap = null
    return dictMap
  }
  const map = new Map()
  for (const line of fs.readFileSync(DICT, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (row && typeof row.tag === 'string') map.set(row.tag, Number(row.postCount) || 0)
  }
  dictMap = map
  return dictMap
}

test('表结构：款式词 / 中文词 / 人像三表 / 风格提示都有足够的键', () => {
  assert.ok(Object.keys(COSTUME_WORD_TAGS).length >= 90, '英文关键词表太少')
  assert.ok(Object.keys(COSTUME_CN_TAGS).length >= 60, '中文兜底表太少')
  assert.deepEqual(Object.keys(PORTRAIT_HAIR_TAGS).sort(), ['中发', '中长发', '短发', '长发'].sort())
  assert.deepEqual(Object.keys(PORTRAIT_FRAMING).sort(), ['正脸参考', '造型氛围'].sort())
  assert.deepEqual(Object.keys(PORTRAIT_PARTITION_TAGS).sort(), Object.keys(PORTRAIT_FRAMING).sort())
  assert.ok(PORTRAIT_STYLE_HINTS.length >= 20, '发型提示太少')

  for (const [word, tags] of Object.entries(COSTUME_WORD_TAGS)) {
    assert.ok(word === word.toLowerCase(), '关键词要小写：' + word)
    assert.ok(Array.isArray(tags) && tags.length >= 1, word + ' 没有 tag')
    for (const tag of tags) assert.match(tag, TAG_SHAPE, word + ' → ' + tag)
  }
  for (const [word, tags] of Object.entries(COSTUME_CN_TAGS)) {
    assert.ok(Array.isArray(tags) && tags.length >= 1, word + ' 没有 tag')
    for (const tag of tags) assert.match(tag, TAG_SHAPE, word + ' → ' + tag)
  }
  for (const hint of PORTRAIT_STYLE_HINTS) {
    assert.ok(hint.re instanceof RegExp, '缺少 re')
    assert.ok(hint.re.global !== true, '正则不能带 g 标志（lastIndex 会串台）')
    assert.ok(typeof hint.why === 'string' && hint.why !== '', '缺少 why')
    for (const tag of hint.tags) assert.match(tag, TAG_SHAPE)
  }
})

test('每个产出的 tag 都有中文名', () => {
  const missing = []
  for (const tag of allMappedTags()) {
    const cn = TAG_CN[tag]
    if (typeof cn !== 'string' || cn.trim() === '') missing.push(tag)
  }
  assert.deepEqual(missing, [], '缺中文：' + missing.join(', '))
})

test('服装卡：英文关键词按词转 tag，去重且带中文', () => {
  const card = {
    id: 'SPR-0001',
    category: '春季穿搭',
    name: '象牙白荷叶边针织衫・牛仔迷你半身裙・大衣・短袜・白色运动鞋',
    tags: ['象牙白', '荷叶边', '针织', '牛仔', '迷你', '半身裙', '大衣', '短袜', '白色', '运动鞋'],
    keywords: 'ivory frill knit denim mini skirt coat socks white sneakers',
  }
  const picked = tagsForCostume(card)
  const names = picked.tags.map(entry => entry.tag)
  assert.deepEqual(names.slice(0, 4), ['frills', 'sweater', 'denim', 'miniskirt'])
  for (const expected of ['coat', 'socks', 'sneakers']) assert.ok(names.includes(expected), '缺 ' + expected)
  assert.equal(new Set(names).size, names.length, 'tag 重复')
  for (const entry of picked.tags) assert.equal(entry.cn, TAG_CN[entry.tag])
  assert.equal(picked.tags.length, picked.reasons.length, '每条 tag 都要有一条理由')
})

test('服装卡：两词短语优先，不重复出单词，也不把 mini dress 拆成半身裙', () => {
  const skirt = tagListFor('costume', { keywords: 'white pleated mini skirt' })
  assert.deepEqual(skirt, ['pleated_skirt', 'miniskirt'])

  const dress = tagListFor('costume', { keywords: 'floral mini dress' })
  assert.deepEqual(dress, ['floral_print', 'short_dress'])

  const tights = tagListFor('costume', { keywords: 'black tights loafers' })
  assert.deepEqual(tights, ['pantyhose', 'loafers'])
})

test('服装卡：只有中文时走中文兜底表，认不出的卡回空数组和原因', () => {
  const cnOnly = tagListFor('costume', { name: '奶油色女衫・蝴蝶结・米色连裤袜', tags: ['奶油色', '女衫', '蝴蝶结', '连裤袜'] })
  assert.deepEqual(cnOnly.sort(), ['blouse', 'bow', 'pantyhose'].sort())

  const unknown = tagsForCostume({ name: '某种不存在的款式', keywords: 'nonexistent fabric' })
  assert.deepEqual(unknown.tags, [])
  assert.equal(unknown.reasons.length, 1)

  const empty = tagsForCostume(null)
  assert.deepEqual(empty, { tags: [], reasons: [] })
})

test('人像卡：分区给取景、发长给长度、中长发不虚标成及腰', () => {
  const front = tagListFor('portrait', { partition: '正脸参考', hair: '中长发' })
  assert.deepEqual(front, ['portrait', 'upper_body', 'facing_viewer', 'long_hair'])

  const mood = tagListFor('portrait', { partition: '造型氛围', hair: '长发' })
  assert.deepEqual(mood, ['portrait', 'very_long_hair'])

  const unknown = tagsForPortrait({ partition: '未知分区', hair: '未知发长' })
  assert.deepEqual(unknown.tags, [])
  // 分区一条 + 发长一条 + 兜底一条
  assert.equal(unknown.reasons.length, 3)
  assert.match(unknown.reasons[2], /没有能映射成真词/) 
})

test('人像卡：发型名称补发型 tag，同义提示只命中一次', () => {
  const tags = tagListFor('portrait', { partition: '正脸参考', hair: '长发', style: '收腰长发・低双马尾・空气刘海' })
  assert.ok(tags.includes('low_twintails'))
  assert.ok(tags.includes('swept_bangs'))
  assert.equal(tags.filter(tag => tag === 'twintails').length, 0, '低双马尾不应再出 twintails')

  const plain = tagListFor('portrait', { partition: '正脸参考', hair: '短发', style: '标准基础款' })
  assert.deepEqual(plain, ['portrait', 'upper_body', 'facing_viewer', 'short_hair'])
})

test('真词表：所有产出的 tag 都在 general.jsonl 里且 postCount > 0', t => {
  const dict = readDict()
  if (dict === null) return t.skip('词表不在：' + DICT)
  const missing = []
  const zero = []
  for (const tag of allMappedTags()) {
    if (dict.has(tag) === false) {
      missing.push(tag)
      continue
    }
    if (dict.get(tag) <= 0) zero.push(tag)
  }
  assert.deepEqual(missing, [], '词库里没有：' + missing.join(', '))
  assert.deepEqual(zero, [], 'postCount 为 0：' + zero.join(', '))
})

test('真卡片冒烟：整份服装库与人像库跑一遍都出词、不造词', t => {
  const dict = readDict()
  const costumePath = firstExisting(COSTUME_CATALOGS)
  const portraitPath = firstExisting(PORTRAIT_CATALOGS)
  if (costumePath === null && portraitPath === null) return t.skip('服装/人像图库都不在')

  const seen = new Set()
  const check = (tags, label) => {
    for (const entry of tags) {
      assert.match(entry.tag, TAG_SHAPE, label + ' → ' + entry.tag)
      assert.ok(entry.cn !== '', label + ' → ' + entry.tag + ' 缺中文')
      if (dict !== null) assert.ok(dict.has(entry.tag), label + ' 造了库外的词：' + entry.tag)
      seen.add(entry.tag)
    }
  }

  if (costumePath !== null) {
    const catalog = JSON.parse(fs.readFileSync(costumePath, 'utf8'))
    const items = Array.isArray(catalog) ? catalog : catalog.items
    assert.ok(Array.isArray(items) && items.length > 500, '服装库条目太少')
    let covered = 0
    for (const item of items) {
      const picked = tagsForCostume(item)
      check(picked.tags, 'costume ' + item.id)
      if (picked.tags.length > 0) covered += 1
    }
    const rate = covered / items.length
    assert.ok(rate >= 0.85, '服装卡出词率太低：' + rate.toFixed(3) + '（' + covered + '/' + items.length + '）')
  }

  if (portraitPath !== null) {
    const lines = fs.readFileSync(portraitPath, 'utf8').split('\n').filter(line => line.trim() !== '')
    assert.ok(lines.length > 1000, '人像库条目太少')
    const head = lines[0].split(',')
    const index = name => head.indexOf(name)
    let covered = 0
    for (const line of lines.slice(1)) {
      const cells = line.split(',')
      const picked = tagsForPortrait({
        partition: cells[index('分区')],
        hair: cells[index('发长')],
        style: cells[index('发型名称')],
        title: cells[index('标题')],
      })
      check(picked.tags, 'portrait ' + cells[0])
      if (picked.tags.length > 0) covered += 1
    }
    assert.equal(covered, lines.length - 1, '有 ' + (lines.length - 1 - covered) + ' 张人像卡没出词')
  }

  assert.ok(seen.size >= 60, '整库跑下来只用到 ' + seen.size + ' 个 tag，覆盖太窄')
})
