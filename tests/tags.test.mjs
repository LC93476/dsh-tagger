/**
 * tests/tags.test.mjs — lib/tags.js 的行为测试。
 *
 * 跑法（本机没有 node 命令）：
 *   ELECTRON_RUN_AS_NODE=1 "C:/Users/34701/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" tests/tags.test.mjs
 *
 * 覆盖：权重/翻转解析、三种格式化语法、WD/Camie 写法、canonicalize 命中与未命中、
 * 中文别名查询、真实数据 ready() 后 general>0、无数据时 seed 兜底、canonicalizeMany。
 * 无外部依赖：node:test + node:assert。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createTagIndex, escapeParens, parseTerm, unescapeTag } from '../lib/tags.js'

const silent = { info() {}, warn() {}, error() {} }
const scratch = path.join(os.tmpdir(), 'dsh-prompt-forge-tags-test-' + process.pid)

// 真实数据索引：默认探测（本机 D:/QUARK/dsh-comfyui-workbench/data/danbooru）。
const live = createTagIndex({ dir: scratch, logger: silent })

test('构造是同步且便宜的：立刻有 seed 可用', () => {
  const stats = live.stats()
  assert.ok(stats.loaded > 100, 'seed 条数 ' + stats.loaded)
  assert.ok(live.search('初音未来', { limit: 3 }).length > 0)
})

test('parseTagString：(tag:1.2) / tag::0.8 / {{tag}} / ((tag)) / [tag] / 纯 tag', () => {
  const rows = live.parseTagString(
    '1girl, ((smile)), [blush], {{long_hair}}, (solo:1.3), long hair::0.8, fate\\(series\\)',
  )
  const byTag = new Map(rows.map(row => [row.tag, row.weight]))
  assert.equal(rows.length, 7)
  assert.equal(byTag.get('1girl'), 1)
  assert.equal(byTag.get('smile'), 1.21)
  assert.equal(byTag.get('blush'), 0.91)
  assert.equal(byTag.get('long_hair'), 1.1)
  assert.equal(byTag.get('solo'), 1.3)
  assert.equal(byTag.get('long hair'), 0.8)
  assert.equal(byTag.get('fate(series)'), 1)
})

test('parseTagString：括号里的逗号不切分', () => {
  const rows = live.parseTagString('(fate:1.2), solo')
  assert.deepEqual(rows, [{ tag: 'fate', weight: 1.2 }, { tag: 'solo', weight: 1 }])
})

test('parseTerm：16:9 是 tag，不是权重', () => {
  assert.deepEqual(parseTerm('16:9'), { tag: '16:9', weight: 1 })
  assert.deepEqual(parseTerm('  '), { tag: '', weight: 1 })
  assert.deepEqual(parseTerm('(smile:1.25)'), { tag: 'smile', weight: 1.25 })
})

test('formatTagString：comfy / a1111 / plain', () => {
  const list = [{ tag: 'smile', weight: 1.2 }, { tag: 'long_hair', weight: 1 }, { tag: 'blush', weight: 0.91 }]
  assert.equal(live.formatTagString(list, { syntax: 'comfy' }), '(smile:1.2), long_hair, (blush:0.91)')
  assert.equal(live.formatTagString(list, { syntax: 'a1111' }), '(smile:1.2), long_hair, (blush:0.91)')
  assert.equal(live.formatTagString(list, { syntax: 'plain' }), 'smile, long_hair, blush')
  assert.equal(live.formatTagString('smile, (long_hair:1.3)', { syntax: 'comfy' }), 'smile, (long_hair:1.3)')
  assert.equal(live.formatTagString([{ tag: 'fate_\\(series\\)', weight: 1 }]), 'fate_\\(series\\)')
})

test('toStandard：WD 下划线 / Camie 空格 / 括号转义', () => {
  assert.equal(live.toStandard('Long Hair', 'wd'), 'long_hair')
  assert.equal(live.toStandard('long_hair', 'camie'), 'long hair')
  assert.equal(live.toStandard('Fate (series)', 'wd'), 'fate_\\(series\\)')
  assert.equal(live.toStandard('Fate (series)', 'camie'), 'fate \\(series\\)')
  assert.equal(live.toStandard('', 'wd'), '')
  assert.equal(escapeParens('a(b)c'), 'a\\(b\\)c')
  assert.equal(unescapeTag('fate_\\(series\\)'), 'fate_(series)')
})

test('canonicalize：命中、大小写、中文名、权重、未命中原样保留', () => {
  const hit = live.canonicalize('1girl')
  assert.equal(hit.matched, true)
  assert.equal(hit.tag, '1girl')
  assert.equal(hit.kind, 'general')

  const upper = live.canonicalize('Long Hair')
  assert.equal(upper.matched, true)
  assert.equal(upper.tag, 'long_hair')

  const cn = live.canonicalize('初音未来')
  assert.equal(cn.matched, true)
  assert.equal(cn.tag, 'hatsune_miku')
  assert.equal(cn.kind, 'character')

  const weighted = live.canonicalize('((smile))')
  assert.equal(weighted.tag, 'smile')
  assert.equal(weighted.weight, 1.21)

  const camie = live.canonicalize('long_hair', { standards: ['camie'] })
  assert.equal(camie.tag, 'long hair')

  const miss = live.canonicalize('zzzz_not_a_real_tag_9999')
  assert.equal(miss.matched, false)
  assert.equal(miss.tag, 'zzzz_not_a_real_tag_9999')
  assert.equal(miss.kind, 'unknown')
  assert.ok(miss.note.length > 0)
})

test('canonicalizeMany：保留 raw 与逐条 matched', () => {
  const rows = live.canonicalizeMany(['1girl', 'zzzz_not_a_real_tag_9999'], { syntax: 'comfy' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].raw, '1girl')
  assert.equal(rows[0].matched, true)
  assert.equal(rows[1].matched, false)
  assert.equal(rows[1].tag, 'zzzz_not_a_real_tag_9999')
})

test('search：中文、别名、前缀、kinds 过滤', () => {
  const byCn = live.search('女孩', { limit: 10 })
  assert.ok(byCn.some(row => row.tag === '1girl'), JSON.stringify(byCn.slice(0, 3)))

  const miku = live.search('初音未来', { limit: 5 })
  assert.equal(miku[0].tag, 'hatsune_miku')
  assert.equal(miku[0].kind, 'character')
  assert.equal(miku[0].cn, '初音未来')

  const prefix = live.search('long_h', { limit: 10 })
  assert.ok(prefix.some(row => row.tag === 'long_hair'))

  const characters = live.search('', { limit: 5, kinds: 'character' })
  assert.equal(characters.length, 5)
  assert.ok(characters.every(row => row.kind === 'character'))
})

test('search：空查询按热度降序', () => {
  const rows = live.search('', { limit: 5 })
  assert.equal(rows.length, 5)
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].postCount >= rows[i].postCount, 'postCount 未降序')
  }
  assert.ok(rows[0].standards.includes('wd'))
})

test('真实数据：ready() 之后 general/character/copyright/artist 都有量', async () => {
  await live.ready()
  const stats = live.stats()
  assert.equal(stats.ready, true)
  assert.ok(stats.general > 1000, 'general ' + stats.general)
  assert.ok(stats.character > 1000, 'character ' + stats.character)
  assert.ok(stats.copyright > 1000, 'copyright ' + stats.copyright)
  assert.ok(stats.artist > 1000, 'artist ' + stats.artist)
  assert.ok(stats.sourceFiles.length >= 3, JSON.stringify(stats.sourceFiles))
  assert.equal(stats.seedOnly, false)
  assert.equal(stats.loaded, stats.total)
  const miku = live.canonicalize('hatsune_miku')
  assert.equal(miku.matched, true)
  assert.ok(miku.cn.length > 0)
  const ba = live.canonicalize('blue archive')
  assert.equal(ba.matched, true)
  assert.equal(ba.kind, 'copyright')
})

test('无数据时用内置 seed 兜底（不探测默认路径）', async () => {
  const seedOnly = createTagIndex({
    dir: path.join(scratch, 'no-data'),
    probeDefaults: false,
    logger: silent,
  })
  await seedOnly.ready()
  const stats = seedOnly.stats()
  assert.equal(stats.seedOnly, true)
  assert.equal(stats.primaryFiles.length, 0)
  // 包内 overlay（data/tags/*.jsonl）永远叠加，所以 sourceFiles 非空但不算「有真实数据」
  assert.ok(stats.overlayFiles.length >= 1, JSON.stringify(stats.overlayFiles))
  assert.ok(stats.general > 100, 'seed general ' + stats.general)
  assert.ok(stats.character >= 20, 'seed character ' + stats.character)
  assert.equal(seedOnly.search('初音未来', { limit: 1 }).length, 1)
  assert.equal(seedOnly.canonicalize('甘雨').tag, 'ganyu_\\(genshin_impact\\)')

  await seedOnly.reload()
  assert.equal(seedOnly.stats().ready, true)
})

test('dataDirs 显式指定：读自己那份归一化数据', async () => {
  const dir = path.join(scratch, 'explicit')
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'characters.jsonl'),
    [JSON.stringify({ tag: 'test_char', kind: 'character', postCount: 123, names: ['测试角色'] }), ''].join('\n'),
    'utf8',
  )
  const index = createTagIndex({
    dir: path.join(scratch, 'explicit-plugin'),
    dataDirs: [dir],
    probeDefaults: false,
    logger: silent,
  })
  await index.ready()
  const stats = index.stats()
  assert.equal(stats.primaryFiles.length, 1)
  assert.equal(stats.seedOnly, false)
  assert.equal(index.canonicalize('测试角色').tag, 'test_char')
})

test('search：多词查询按命中词数优先，不被单个词的热度带偏', async () => {
  const dir = path.join(scratch, 'multi')
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
  // 用 zz_ 前缀的自造 tag，避免和内置 seed 撞名（seed 会一起进索引）。
  const records = [
    { tag: 'zz_long_hair_probe', kind: 'general', postCount: 3000000, names: ['zz长头发'] },
    { tag: 'zz_hair_probe', kind: 'general', postCount: 5000000, names: ['zz头发'] },
    { tag: 'zz_long_probe', kind: 'general', postCount: 4000000, names: ['zz长发'] },
  ]
  await fs.writeFile(
    path.join(dir, 'general.jsonl'),
    records.map(record => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  )
  const index = createTagIndex({
    dir: path.join(scratch, 'multi-plugin'),
    dataDirs: [dir],
    probeDefaults: false,
    logger: silent,
  })
  await index.ready()

  // 'zz' 命中三个，'long' 再加一个，'hair' 再加一个：zz_long_hair_probe 共 3 票排第一，
  // 而热度最高的 zz_hair_probe（5e6）票数少，只能排在后面。
  const byWords = index.search('zz long hair', { limit: 5 })
  assert.equal(byWords[0].tag, 'zz_long_hair_probe')
  assert.ok(byWords.some(row => row.tag === 'zz_hair_probe'), byWords.map(row => row.tag).join(','))

  // 中文逐词查同样合并且都留在结果里。
  const byChinese = index.search('zz长发 微笑', { limit: 10 }).map(row => row.tag)
  assert.ok(byChinese.includes('zz_long_probe'), 'zz_long_probe in ' + byChinese.join(','))
  assert.ok(byChinese.includes('smile'), 'smile in ' + byChinese.join(','))
})

test('overlay：包内 data/tags/*.jsonl 补的 NSFW 词条命中且带中文', async () => {
  await live.ready()
  const stats = live.stats()
  assert.ok(
    stats.overlayFiles.some(file => file.endsWith('general-nsfw.jsonl')),
    JSON.stringify(stats.overlayFiles),
  )

  const row = live.canonicalize('hand_on_own_breast')
  assert.equal(row.matched, true)
  assert.equal(row.cn, '手抚自己的胸')
  assert.equal(row.kind, 'general')

  // 反向：中文也要能查回英文 tag（面板补词、用户直接打中文都走这条）。
  assert.equal(live.canonicalize('手抚自己的胸').tag, 'hand_on_own_breast')
  assert.equal(live.canonicalize('nakadashi').cn, '内射')
  assert.equal(live.canonicalize('desk_lamp').cn, '台灯')

  // 主流数据里本来就有的词，overlay 不许把它的中文挤掉。
  const existing = live.canonicalize('spread_pussy')
  assert.equal(existing.matched, true)
  assert.ok(existing.cn.length > 0, 'spread_pussy 中文被清空了')
})

test('overlay：<dataDir>/tags 的用户词表叠加进主流数据，不替换主流', async () => {
  const dir = path.join(scratch, 'overlay-user')
  const fs = await import('node:fs/promises')
  await fs.mkdir(path.join(dir, 'tags'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'tags', 'my-words.jsonl'),
    JSON.stringify({ tag: 'zz_custom_probe_tag', cn: 'zz自造词', kind: 'general', postCount: 12 }) + '\n',
    'utf8',
  )
  const index = createTagIndex({ dir, logger: silent })
  await index.ready()
  const stats = index.stats()
  assert.equal(stats.seedOnly, false, '主流 workbench 数据还在')
  assert.ok(stats.primaryFiles.length >= 3, JSON.stringify(stats.primaryFiles))
  assert.ok(stats.general > 1000, 'general ' + stats.general)
  assert.ok(
    stats.overlayFiles.some(file => file.endsWith('my-words.jsonl')),
    JSON.stringify(stats.overlayFiles),
  )
  const hit = index.canonicalize('zz自造词')
  assert.equal(hit.matched, true)
  assert.equal(hit.tag, 'zz_custom_probe_tag')
  assert.equal(hit.cn, 'zz自造词')
})

test('NSFW 词表回归：常见露骨 tag 全部命中且都有中文（overlay 生效的证据）', async () => {
  await live.ready()
  const want = ["labia","butt_grab","squatting_sex","penis_in_pussy","penis_in_ass","after_orgasm","hand_on_own_breast","hand_on_own_pussy","hand_on_breast","hand_on_butt","cupping_breasts","squeezing_own_breasts","partially_covered","exposed_breasts","exposed_pussy","transparent_clothes","oiled_skin","sweaty","nude_pose","bath_towel","shower","night_lighting","warm_lighting","close-up_on_crotch","close-up_on_breasts","shaved_pussy","squirting","nakadashi","creampie","grinding","face_sitting","sex_under_blanket","biting_lip","lust","toes_curled","gripping_sheets","clothed_masturbation","sweat_on_skin","white_liquid","pussy_eating","rimming","lewd_clothing","see_through_skirt","wet_panty","desk_lamp"]
  const missing = []
  const noChinese = []
  for (const tag of want) {
    const row = live.canonicalize(tag)
    if (!row.matched) missing.push(tag)
    else if (!row.cn) noChinese.push(tag)
  }
  assert.deepEqual(missing, [], '索引里没有这些词：' + missing.join(','))
  assert.deepEqual(noChinese, [], '这些词没有中文名：' + noChinese.join(','))
})

test('构图/光线词 overlay：半身、全景、特写、逆光都命中且带中文', async () => {
  await live.ready()
  const want = ['medium_shot', 'full_shot', 'close-up', 'light_beam', 'backlighting', 'light_rays', 'depth_of_field']
  const missing = want.filter(tag => !live.canonicalize(tag).matched)
  assert.deepEqual(missing, [], '索引里没有这些构图词：' + missing.join(','))
  assert.equal(live.canonicalize('close_up').tag, 'close-up')
  assert.equal(live.canonicalize('backlight').tag, 'backlighting')
  assert.ok(live.canonicalize('medium_shot').cn.includes('中景'), live.canonicalize('medium_shot').cn)
})

test('ensureFresh：词表文件一改，下一次查就热重载，不用重启', async () => {
  const dir = path.join(scratch, 'hot-reload')
  const fs = await import('node:fs/promises')
  await fs.mkdir(path.join(dir, 'tags'), { recursive: true })
  const index = createTagIndex({ dir, logger: silent })
  await index.ready()
  assert.equal(index.ensureFresh !== undefined, true, 'createTagIndex 要暴露 ensureFresh')

  assert.equal(index.canonicalize('zz_hot_word').matched, false)
  // 没动文件：不该白重建
  assert.equal(await index.ensureFresh(), false)

  await fs.writeFile(
    path.join(dir, 'tags', 'hot.jsonl'),
    JSON.stringify({ tag: 'zz_hot_word', cn: 'hot热词', kind: 'general', postCount: 5 }) + '\n',
    'utf8',
  )
  assert.equal(await index.ensureFresh(), true, '新增文件应触发重载')
  const hit = index.canonicalize('zz_hot_word')
  assert.equal(hit.matched, true)
  assert.equal(hit.cn, 'hot热词')

  // 指纹稳定后再次调用不该反复重建
  assert.equal(await index.ensureFresh(), false)
})
