/* 三栏工作台：左提示词 / 中参考样式 / 右生成结果。
   零构建、零外链、纯原生 ES 模块；只调用 /tagger/api 下既有接口，不改后端。 */

const API = '/tagger/api'
const LS_KEY = 'dsh-tagger:studio.v1'
const PAGE = 48
const POLL_MS = 1200
const HIST_MAX = 8
const LEVELS = ['off', 'light', 'standard', 'full', 'max']
const LEVEL_LABELS = { off: '关闭', light: '轻度', standard: '标准', full: '全开', max: '极限' }
const PROFILE_LABELS = { tag: 'WD 标准', pony: 'Pony', natural: '自然语序', custom: '自定义' }
const GROUP_LABELS = { look: '风格', light: '光线', scene: '场景', camera: '镜头', mood: '氛围' }
const STAGE_LABELS = { idle: '就绪', queued: '排队中', running: '生成中', done: '完成', failed: '失败', unknown: '状态未知' }

const $ = function (id) { return document.getElementById(id) }

const state = {
  config: null,
  comfy: null,
  llm: { provider: '', model: '', ready: false },
  profiles: { list: [], current: '' },
  ui: { maxTags: 40, level: 'full', solo: false, profile: 'tag', workflowId: '' },
  poses: { groups: [], sets: [], categories: [], angles: [], total: 0, set: 'all', category: '', angle: '', q: '', offset: 0, picked: {}, loading: false },
  styles: { ok: false, message: '', styles: [], groups: [], selected: new Set(), filter: '' },
  refs: {
    costume: { items: [], total: 0, offset: 0, sets: [], categories: [], hairs: [], q: '', set: '', hair: '', popular: false, loading: false, tried: false, ok: false, message: '' },
    portrait: { items: [], total: 0, offset: 0, sets: [], categories: [], hairs: [], q: '', set: 'all', hair: '', popular: false, loading: false, tried: false, ok: false, message: '' },
  },
  dock: { kind: '', id: '', name: '', meta: '', thumb: '', tags: [], note: '' },
  forge: { running: false, positive: '', negative: '', cn: {}, ms: 0, error: '', warning: '' },
  run: { running: false, promptId: '', stage: 'idle', progress: 0, images: [], message: '', timer: 0 },
  history: [],
  ref: { name: '', busy: false },
}

/* ---------------- 小工具 ---------------- */

function textOf(value) { return typeof value === 'string' ? value.trim() : '' }

// 参考库接口回的图是根相对路径（/ref-image?kind=…），要补上 API 前缀才打得开。
function refSrc(value) {
  const src = textOf(value)
  if (src === '' || src.indexOf(API + '/') === 0) return src
  if (src.charAt(0) === '/') return API + src
  return src
}

function intOf(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10)
  const base = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(max, Math.max(min, base))
}

function floatOf(value, fallback, min, max) {
  const parsed = Number.parseFloat(String(value))
  const base = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(max, Math.max(min, base))
}

function el(tag, props) {
  const node = document.createElement(tag)
  if (props) {
    Object.keys(props).forEach(function (key) {
      const value = props[key]
      if (value === undefined || value === null || value === false) return
      if (key === 'text') { node.textContent = String(value); return }
      if (key === 'class') { node.className = String(value); return }
      if (key === 'dataset') { Object.keys(value).forEach(function (k) { node.dataset[k] = String(value[k]) }); return }
      if (key.indexOf('on') === 0 && typeof value === 'function') { node.addEventListener(key.slice(2).toLowerCase(), value); return }
      node.setAttribute(key, String(value))
    })
  }
  for (let i = 2; i < arguments.length; i += 1) {
    const kid = arguments[i]
    if (kid === undefined || kid === null || kid === false) continue
    if (Array.isArray(kid)) {
      kid.forEach(function (item) {
        if (item === undefined || item === null || item === false) return
        node.append(item instanceof Node ? item : document.createTextNode(String(item)))
      })
      continue
    }
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}

function clear(node) {
  if (node === null) return
  while (node.firstChild) node.removeChild(node.firstChild)
}

async function api(path, init) {
  const opts = Object.assign({}, init)
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body)
    opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {})
  }
  if (!opts.method) opts.method = opts.body === undefined ? 'GET' : 'POST'
  try {
    const res = await fetch(API + path, opts)
    const raw = await res.text()
    let data = {}
    if (raw !== '') {
      try { data = JSON.parse(raw) } catch (err) { data = { ok: false, message: '返回不是 JSON' } }
    }
    return { status: res.status, data: data !== null && typeof data === 'object' ? data : {} }
  } catch (err) {
    return { status: 0, data: { ok: false, error: 'network', message: '连不上本地服务（' + API + '）' } }
  }
}

var toastTimer = 0
function flash(message) {
  const box = $('toast')
  if (box === null) return
  box.textContent = String(message)
  box.hidden = false
  if (toastTimer !== 0) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(function () { box.hidden = true }, 1800)
}

async function copyText(value, label) {
  const body = String(value === undefined || value === null ? '' : value)
  if (body === '') { flash('还没有可复制的内容'); return }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(body)
      flash(label + '已复制')
      return
    }
  } catch (err) { /* 落到 textarea 兜底 */ }
  const box = el('textarea', { class: 'sr-only', style: 'position:fixed;left:-9999px;top:0;' })
  box.value = body
  document.body.append(box)
  box.select()
  try { document.execCommand('copy'); flash(label + '已复制') } catch (err) { flash('复制失败，请手动选择') }
  box.remove()
}

/* 拆 tag 串：只按括号外的逗号切，权重 / 转义括号都不拆坏 */
function splitTags(value) {
  const source = typeof value === 'string' ? value : ''
  const out = []
  let depth = 0
  let buf = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim() !== '') out.push(buf)
  return out.map(function (item) { return item.trim() }).filter(function (item) { return item !== '' })
}

function tagCore(token) {
  const match = /^\((.*):[0-9.]+\)$/.exec(String(token).trim())
  if (match !== null) return match[1].trim()
  return String(token).trim()
}

function joinTags(list) { return (Array.isArray(list) ? list : []).join(', ') }

function tagName(item) {
  if (typeof item === 'string') return textOf(item)
  if (item !== null && typeof item === 'object') return textOf(item.tag) || textOf(item.name)
  return ''
}

function tagCn(item) {
  if (item !== null && typeof item === 'object') return textOf(item.cn) || textOf(item.zh) || textOf(item.chinese)
  return ''
}

/* ---------------- 参数记忆 ---------------- */

const UI_IDS = ['maxTags', 'level', 'solo', 'profile', 'workflow', 'width', 'height', 'seed', 'steps', 'cfg']

function readStored() {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (raw === null || raw === '') return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (err) { return {} }
}

function saveUi() {
  const out = { prompt: $('prompt') === null ? '' : $('prompt').value }
  UI_IDS.forEach(function (id) {
    const node = $(id)
    if (node === null) return
    out[id] = node.type === 'checkbox' ? Boolean(node.checked) : node.value
  })
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(out)) } catch (err) { /* 存不下就算了 */ }
}

function applyStored() {
  const saved = readStored()
  if (typeof saved.prompt === 'string') $('prompt').value = saved.prompt
  UI_IDS.forEach(function (id) {
    const node = $(id)
    if (node === null) return
    const value = saved[id]
    if (value === undefined || value === null) return
    if (node.type === 'checkbox') node.checked = value === true || value === 'true'
    else if (node.tagName === 'SELECT') { if (typeof value === 'string') node.dataset.want = value }
    else node.value = String(value)
  })
  state.ui.solo = $('solo').checked
}

function selectWant(id, fallback) {
  const node = $(id)
  if (node === null) return
  const want = node.dataset.want || fallback || ''
  if (want === '') return
  const hit = Array.prototype.some.call(node.options, function (opt) { return opt.value === want })
  if (hit) node.value = want
}

/* ---------------- 顶栏药丸 ---------------- */

function setPill(id, kind, message) {
  const box = $(id)
  const label = $(id + '-text')
  if (box !== null) box.dataset.kind = kind
  if (label !== null) label.textContent = message
}

function paintLlmPill() {
  const info = state.llm
  if (info.ready === false && info.provider === '') { setPill('pill-llm', 'err', 'LLM 未配置'); return }
  const model = info.model === '' ? '' : ' · ' + info.model
  setPill('pill-llm', 'ok', 'LLM ' + (info.provider || '就绪') + model)
}

function paintComfyPill() {
  const comfy = state.comfy
  if (comfy === null || typeof comfy !== 'object') { setPill('pill-comfy', 'err', 'ComfyUI 未知'); return }
  if (comfy.ok === true) { setPill('pill-comfy', 'ok', 'ComfyUI 在线'); return }
  setPill('pill-comfy', 'warn', 'ComfyUI 离线')
}

function paintProfilePill() {
  const id = state.profiles.current
  if (id === '') { setPill('pill-profile', 'idle', '模型档案未知'); return }
  setPill('pill-profile', 'ok', '档案 · ' + (PROFILE_LABELS[id] || id))
}

/* ---------------- 左栏：提示词 ---------------- */

function autoGrow() {
  const box = $('prompt')
  if (box === null) return
  box.style.height = 'auto'
  const line = 22
  const min = line * 8 + 18
  const next = Math.max(min, Math.min(box.scrollHeight, 420))
  box.style.height = next + 'px'
}

function setForgeStatus(message, kind) {
  const node = $('forge-status')
  if (node === null) return
  node.textContent = String(message)
  node.dataset.kind = kind || ''
}

function renderChips() {
  const box = $('chips')
  if (box === null) return
  clear(box)
  const tokens = splitTags(state.forge.positive)
  tokens.forEach(function (token) {
    const core = tagCore(token)
    const cn = state.forge.cn[core] || state.forge.cn[String(token)] || ''
    const chip = el('button', {
      class: 'chip',
      type: 'button',
      title: '点一下从正向里删掉' + (cn === '' ? '' : '（' + cn + '）'),
      dataset: { tag: core },
    })
    chip.append(el('span', { text: token }))
    if (cn !== '') chip.append(el('i', { text: cn }))
    chip.addEventListener('click', function () { removeToken(core) })
    box.append(chip)
  })
  const count = $('pos-count')
  if (count !== null) count.textContent = tokens.length + ' tag'
}

function renderJudge() {
  const pos = $('positive')
  const neg = $('negative')
  if (pos !== null) pos.textContent = state.forge.positive
  if (neg !== null) neg.textContent = state.forge.negative
  const negCount = $('neg-count')
  if (negCount !== null) negCount.textContent = splitTags(state.forge.negative).length + ' tag'
  renderChips()
}

function removeToken(core) {
  const tokens = splitTags(state.forge.positive)
  const kept = tokens.filter(function (token) { return tagCore(token).toLowerCase() !== String(core).toLowerCase() })
  if (kept.length === tokens.length) return
  state.forge.positive = joinTags(kept)
  renderJudge()
}

function appendToPrompt(fragment) {
  const box = $('prompt')
  const add = textOf(fragment)
  if (box === null || add === '') return
  const current = box.value.trim()
  box.value = current === '' ? add : current.replace(/[，,]\s*$/, '') + ', ' + add
  autoGrow()
  saveUi()
  box.focus()
  box.setSelectionRange(box.value.length, box.value.length)
}

async function doForge() {
  if (state.forge.running) return
  const box = $('prompt')
  const raw = box === null ? '' : box.value.trim()
  if (raw === '') { flash('先写点什么'); if (box !== null) box.focus(); return }
  const wrapped = state.ui.solo ? raw + '\n\n（画面里只画一个人）' : raw
  const button = $('btn-forge')
  state.forge.running = true
  if (button !== null) button.disabled = true
  setForgeStatus('锻造中…', 'busy')
  const warn = $('forge-warn')
  if (warn !== null) { warn.hidden = true; warn.textContent = '' }
  const res = await api('/forge', { body: { text: wrapped, options: { maxTags: state.ui.maxTags, purgeLevel: state.ui.level } } })
  state.forge.running = false
  if (button !== null) button.disabled = false
  const data = res.data || {}
  if (res.status === 0 || data.ok !== true) {
    const message = textOf(data.message) || ('锻造失败（HTTP ' + res.status + '）')
    state.forge.error = message
    setForgeStatus(message, 'err')
    return
  }
  state.forge.error = ''
  state.forge.positive = typeof data.positive === 'string' ? data.positive : ''
  state.forge.negative = typeof data.negative === 'string' ? data.negative : ''
  state.forge.ms = Number.isFinite(data.ms) ? data.ms : 0
  state.forge.cn = {}
  const tags = Array.isArray(data.tags) ? data.tags : []
  tags.forEach(function (item) {
    const name = tagName(item)
    const cn = tagCn(item)
    if (name !== '' && cn !== '') state.forge.cn[name] = cn
  })
  renderJudge()
  const count = splitTags(state.forge.positive).length
  setForgeStatus('完成 · ' + count + ' tag · ' + Math.round(state.forge.ms) + 'ms', 'ok')
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(function (item) { return typeof item === 'string' && item !== '' }) : []
  if (warn !== null && warnings.length > 0) { warn.textContent = warnings.join('；'); warn.hidden = false }
}

/* ---------------- 中栏：页签 ---------------- */

const TABS = ['pose', 'costume', 'portrait', 'style']

function showTab(which) {
  const id = TABS.indexOf(which) >= 0 ? which : 'pose'
  TABS.forEach(function (key) {
    const on = key === id
    const tab = $('tab-' + key)
    const panel = $('panel-' + key)
    if (tab !== null) {
      tab.classList.toggle('is-on', on)
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    if (panel !== null) panel.hidden = !on
  })
  // 切页签就把 dock 收掉：它记的是上一页签选中的那条参考，留着会串台（服装卡出现在人像页签下）
  if (state.dock.kind !== '' && state.dock.kind !== id) closeDock()
  // 参考库按需加载：不在启动时把 1400+ 条一起拉下来
  if ((id === 'costume' || id === 'portrait') && state.refs[id].tried !== true) loadRefs(id, true)
}

/* ---------------- 中栏：姿势 ---------------- */

function poseCardVariant(group) {
  const variants = Array.isArray(group.variants) ? group.variants : []
  const want = state.poses.angle
  if (want === '') return variants[0] || null
  const hit = variants.find(function (item) { return item.angle === want })
  return hit || variants[0] || null
}

function renderPoseSets() {
  const box = $('pose-sets')
  if (box === null) return
  clear(box)
  const sets = Array.isArray(state.poses.sets) ? state.poses.sets : []
  sets.forEach(function (item) {
    const key = textOf(item.key) || 'all'
    const button = el('button', {
      class: 'seg-i' + (key === state.poses.set ? ' is-on' : ''),
      type: 'button',
      role: 'tab',
      dataset: { set: key },
      text: (textOf(item.label) || key) + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    })
    button.setAttribute('aria-selected', key === state.poses.set ? 'true' : 'false')
    box.append(button)
  })
}

function renderPoseCategories() {
  const box = $('pose-cats')
  if (box === null) return
  clear(box)
  const list = Array.isArray(state.poses.categories) ? state.poses.categories : []
  const all = el('button', {
    class: 'pill-i' + (state.poses.category === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { category: '' },
    text: '全部分类',
  })
  box.append(all)
  list.forEach(function (item) {
    const key = textOf(item.key)
    if (key === '') return
    box.append(el('button', {
      class: 'pill-i' + (key === state.poses.category ? ' is-on' : ''),
      type: 'button',
      dataset: { category: key },
      text: key + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    }))
  })
}

function renderPoseAngles() {
  const box = $('pose-angles')
  if (box === null) return
  clear(box)
  box.append(el('button', {
    class: 'angle' + (state.poses.angle === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { angle: '' },
    text: '全视角',
  }))
  const list = Array.isArray(state.poses.angles) ? state.poses.angles : []
  list.forEach(function (angle) {
    const key = textOf(angle)
    if (key === '') return
    box.append(el('button', {
      class: 'angle' + (key === state.poses.angle ? ' is-on' : ''),
      type: 'button',
      dataset: { angle: key },
      text: key,
    }))
  })
}

function renderPoseGrid(append) {
  const box = $('pose-grid')
  if (box === null) return
  if (append !== true) clear(box)
  const groups = Array.isArray(state.poses.groups) ? state.poses.groups : []
  groups.forEach(function (group) {
    const variant = poseCardVariant(group)
    if (variant === null) return
    const base = textOf(group.base)
    const picked = state.poses.picked[base] || 0
    const card = el('button', {
      class: 'gcard',
      type: 'button',
      dataset: { base: base, picked: picked > 0 ? '1' : '0' },
      'aria-label': '把「' + (textOf(group.name) || base) + '」的 tag 追加到提示词',
    })
    const thumb = el('div', { class: 'gcard-thumb' })
    thumb.append(el('img', {
      src: textOf(variant.thumb),
      alt: '',
      loading: 'lazy',
      draggable: 'false',
      referrerpolicy: 'no-referrer',
    }))
    thumb.append(el('span', { class: 'gcard-badge', text: picked > 0 ? String(picked) : '' }))
    card.append(thumb)
    card.append(el('div', { class: 'gcard-name', text: textOf(group.name) || base }))
    card.append(el('div', {
      class: 'gcard-meta',
      text: (textOf(group.code) || '') + (Array.isArray(group.variants) && group.variants.length > 1 ? ' · ' + group.variants.length + ' 视角' : ''),
    }))
    box.append(card)
  })
  const empty = $('pose-empty')
  if (empty !== null) empty.hidden = groups.length > 0
  const more = $('pose-more')
  if (more !== null) more.hidden = !(Number.isFinite(state.poses.total) && state.poses.offset + groups.length < state.poses.total)
}

async function loadPoses(reset) {
  const p = state.poses
  if (p.loading) return
  p.loading = true
  const offset = reset === true ? 0 : p.offset
  const params = new URLSearchParams()
  if (p.q !== '') params.set('q', p.q)
  if (p.set !== '' && p.set !== 'all') params.set('set', p.set)
  if (p.category !== '') params.set('category', p.category)
  if (p.angle !== '') params.set('angle', p.angle)
  params.set('limit', String(PAGE))
  params.set('offset', String(offset))
  const res = await api('/pose-gallery?' + params.toString())
  p.loading = false
  const data = res.data || {}
  if (res.status === 0 || data.ok === false || !Array.isArray(data.groups)) {
    const message = textOf(data.message) || '姿势库加载失败'
    const empty = $('pose-empty')
    if (empty !== null) {
      clear(empty)
      empty.append(el('p', { text: message }))
      empty.append(el('p', { class: 'dim', text: '把 ComfyUI 安装目录填好后再试一次。' }))
      empty.hidden = false
    }
    return
  }
  p.sets = Array.isArray(data.sets) ? data.sets : []
  p.categories = Array.isArray(data.categories) ? data.categories : []
  p.angles = Array.isArray(data.angles) ? data.angles : []
  p.total = Number.isFinite(data.total) ? data.total : 0
  p.offset = offset
  p.groups = reset === true ? data.groups : p.groups.concat(data.groups)
  p.offset = offset + data.groups.length
  renderPoseSets()
  renderPoseCategories()
  renderPoseAngles()
  renderPoseGrid(reset !== true)
}

async function pickPose(base, card) {
  const group = state.poses.groups.find(function (item) { return item.base === base })
  if (group === undefined) return
  const variant = poseCardVariant(group)
  if (variant === null) return
  const params = new URLSearchParams()
  params.set('base', base)
  if (textOf(variant.id) !== '') params.set('ids', textOf(variant.id))
  else params.set('angle', textOf(variant.angle))
  const res = await api('/pose-tags?' + params.toString())
  const data = res.data || {}
  if (res.status === 0 || data.ok === false) { flash(textOf(data.message) || '这个姿势取不到 tag'); return }
  const list = Array.isArray(data.tags) ? data.tags.map(tagName).filter(function (item) { return item !== '' }) : []
  if (list.length === 0) { flash('这个姿势没有映射到 tag'); return }
  appendToPrompt(list.join(', '))
  state.poses.picked[base] = (state.poses.picked[base] || 0) + 1
  if (card !== undefined && card !== null) {
    card.dataset.picked = '1'
    const badge = card.querySelector('.gcard-badge')
    if (badge !== null) badge.textContent = String(state.poses.picked[base])
  }
  flash('已追加 ' + list.length + ' 个 tag')
}

/* ---------------- 中栏：服装 / 人像 ---------------- */

const REF_PAGE = 36
const REF_LABELS = { costume: '服装', portrait: '人像' }
const REF_EMPTY = {
  costume: ['没有匹配的服装。', '换个关键词，或点「全部分类」看回来。'],
  portrait: ['没有匹配的人像。', '换个关键词，或把筛选放宽一点。'],
}
const REF_FAIL_HINT = '参考库接口还没就绪时这里会留空；素材目录也要在 ComfyUI 的安装目录里。'
const REF_FAIL_TEXT = '参考库暂时用不了'

function refFailText(message) {
  const text = textOf(message)
  if (text === '' || text.indexOf('/') >= 0 || /^network$/i.test(text)) return REF_FAIL_TEXT
  return text
}

function refGridBox(kind) {
  return $(kind === 'costume' ? 'ref-costume-grid' : 'ref-portrait-grid')
}

function refCountBox(kind) {
  return $('tab-' + kind + '-count')
}

function setRefEmpty(kind, line, hint) {
  const head = $(kind + '-empty-line')
  const tail = $(kind + '-empty-hint')
  if (head !== null) head.textContent = line
  if (tail !== null) {
    tail.textContent = hint
    tail.hidden = hint === ''
  }
  const empty = $(kind + '-empty')
  if (empty !== null) empty.hidden = false
  const more = $(kind + '-more')
  if (more !== null) more.hidden = true
}

function resetRefEmpty(kind) {
  setRefEmpty(kind, REF_EMPTY[kind][0], REF_EMPTY[kind][1])
}

function paintRefCount(kind, total) {
  const box = refCountBox(kind)
  if (box === null) return
  const show = Number.isFinite(total) && total > 0
  box.textContent = show ? String(total) : ''
  box.hidden = !show
}

function renderCostumeCats() {
  const box = $('costume-cats')
  if (box === null) return
  clear(box)
  const ref = state.refs.costume
  box.append(el('button', {
    class: 'pill-i' + (ref.set === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { set: '' },
    text: '全部分类',
  }))
  const list = Array.isArray(ref.categories) ? ref.categories : []
  list.forEach(function (item) {
    const key = textOf(item.key)
    if (key === '') return
    box.append(el('button', {
      class: 'pill-i' + (key === ref.set ? ' is-on' : ''),
      type: 'button',
      dataset: { set: key },
      text: key + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    }))
  })
}

function renderPortraitSets() {
  const box = $('portrait-sets')
  if (box === null) return
  clear(box)
  const ref = state.refs.portrait
  const list = Array.isArray(ref.sets) ? ref.sets : []
  if (list.length === 0) {
    box.append(el('button', {
      class: 'seg-i is-on',
      type: 'button',
      role: 'tab',
      dataset: { set: 'all' },
      text: '全部',
    }))
    return
  }
  list.forEach(function (item) {
    const key = textOf(item.key) || 'all'
    const button = el('button', {
      class: 'seg-i' + (key === ref.set ? ' is-on' : ''),
      type: 'button',
      role: 'tab',
      dataset: { set: key },
      text: (textOf(item.label) || key) + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    })
    button.setAttribute('aria-selected', key === ref.set ? 'true' : 'false')
    box.append(button)
  })
}

function renderPortraitHairs() {
  const box = $('portrait-hairs')
  if (box === null) return
  clear(box)
  const ref = state.refs.portrait
  box.append(el('button', {
    class: 'pill-i' + (ref.hair === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { hair: '' },
    text: '全部发型',
  }))
  const list = Array.isArray(ref.hairs) ? ref.hairs : []
  list.forEach(function (item) {
    const key = textOf(item.key)
    if (key === '') return
    box.append(el('button', {
      class: 'pill-i' + (key === ref.hair ? ' is-on' : ''),
      type: 'button',
      dataset: { hair: key },
      text: key + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    }))
  })
}

function paintPopular() {
  const button = $('portrait-popular')
  if (button === null) return
  const on = state.refs.portrait.popular === true
  button.classList.toggle('is-on', on)
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
}

function refCard(kind, item) {
  const isCostume = kind === 'costume'
  const id = textOf(item.id)
  const title = isCostume ? (textOf(item.name) || id) : (textOf(item.title) || id)
  const corner = isCostume ? textOf(item.category) : textOf(item.hair)
  const meta = isCostume
    ? [id, textOf(item.keywords)].filter(function (part) { return part !== '' }).join(' · ')
    : [textOf(item.partition), textOf(item.style)].filter(function (part) { return part !== '' }).join(' · ')
  const src = refSrc(isCostume ? item.thumb : item.image)
  const card = el('button', {
    class: 'gcard rcard' + (isCostume ? '' : ' rcard-portrait'),
    type: 'button',
    dataset: { refKind: kind, refId: id, picked: '0' },
    'aria-label': '把「' + title + '」的 tag 加到提示词',
  })
  const thumb = el('div', { class: 'gcard-thumb', dataset: { tone: kind } })
  if (src !== '') {
    thumb.append(el('img', {
      src: src,
      alt: '',
      loading: 'lazy',
      draggable: 'false',
      referrerpolicy: 'no-referrer',
    }))
  }
  if (corner !== '') thumb.append(el('span', { class: 'rcard-tag', text: corner }))
  if (kind === 'portrait' && item.popular === true) thumb.append(el('span', { class: 'rcard-hot', text: '热门' }))
  thumb.append(el('span', { class: 'gcard-badge', text: '' }))
  card.append(thumb)
  card.append(el('div', { class: 'gcard-name' + (isCostume ? '' : ' rcard-name-one'), text: title }))
  card.append(el('div', { class: 'gcard-meta', text: meta }))
  return card
}

function renderRefGrid(kind, append) {
  const box = refGridBox(kind)
  if (box === null) return
  if (append !== true) clear(box)
  const ref = state.refs[kind]
  ref.items.forEach(function (item) { box.append(refCard(kind, item)) })
  const empty = $(kind + '-empty')
  if (empty !== null) {
    if (ref.items.length > 0) empty.hidden = true
    else resetRefEmpty(kind)
  }
  const more = $(kind + '-more')
  if (more !== null) more.hidden = !(Number.isFinite(ref.total) && ref.offset < ref.total)
  paintRefCount(kind, ref.total)
}

function refFail(kind, message) {
  const ref = state.refs[kind]
  ref.items = []
  ref.total = 0
  ref.offset = 0
  const box = refGridBox(kind)
  if (box !== null) clear(box)
  setRefEmpty(kind, message === '' ? '参考库加载失败' : message, REF_FAIL_HINT)
  paintRefCount(kind, 0)
}

async function loadRefs(kind, reset) {
  const ref = state.refs[kind]
  if (ref.loading) return
  ref.loading = true
  const offset = reset === true ? 0 : ref.offset
  const params = new URLSearchParams()
  params.set('kind', kind)
  if (ref.q !== '') params.set('q', ref.q)
  if (ref.set !== '' && ref.set !== 'all') params.set('set', ref.set)
  if (kind === 'portrait' && ref.hair !== '') params.set('hair', ref.hair)
  if (kind === 'portrait' && ref.popular === true) params.set('popular', '1')
  params.set('limit', String(REF_PAGE))
  params.set('offset', String(offset))
  const res = await api('/refs?' + params.toString())
  ref.loading = false
  ref.tried = true
  const data = res.data || {}
  if (res.status === 0 || data.ok === false || !Array.isArray(data.items)) {
    ref.ok = false
    ref.message = textOf(data.message)
    refFail(kind, refFailText(ref.message))
    return
  }
  ref.ok = true
  ref.message = ''
  ref.sets = Array.isArray(data.sets) ? data.sets : ref.sets
  ref.categories = Array.isArray(data.categories) ? data.categories : []
  ref.hairs = Array.isArray(data.hairs) ? data.hairs : []
  ref.total = Number.isFinite(data.total) ? data.total : 0
  ref.items = reset === true ? data.items : ref.items.concat(data.items)
  ref.offset = offset + data.items.length
  if (kind === 'costume') renderCostumeCats()
  else {
    if (ref.set === '') ref.set = 'all'
    renderPortraitSets()
    renderPortraitHairs()
    paintPopular()
  }
  renderRefGrid(kind, reset !== true)
}

function dockEmpty() {
  return { kind: '', id: '', name: '', meta: '', thumb: '', tags: [], note: '' }
}

function renderDock() {
  const dock = $('ref-dock')
  if (dock === null) return
  const data = state.dock
  const thumb = $('ref-dock-thumb')
  if (thumb !== null) {
    if (data.thumb !== '') thumb.src = data.thumb
    else thumb.removeAttribute('src')
    thumb.hidden = data.thumb === ''
  }
  const name = $('ref-dock-name')
  if (name !== null) name.textContent = data.name
  const meta = $('ref-dock-meta')
  if (meta !== null) meta.textContent = data.meta
  const box = $('ref-dock-tags')
  if (box !== null) {
    clear(box)
    data.tags.forEach(function (item, index) {
      box.append(el('button', {
        class: 'rdock-tag',
        type: 'button',
        dataset: { index: String(index) },
        title: '点掉这个 tag',
        text: item.tag + (item.cn !== '' ? ' ' + item.cn : ''),
      }))
    })
  }
  const note = $('ref-dock-note')
  if (note !== null) {
    note.textContent = data.note
    note.hidden = data.note === ''
  }
  const has = data.tags.length > 0
  const copy = $('ref-dock-copy')
  if (copy !== null) copy.disabled = !has
  const fill = $('ref-dock-fill')
  if (fill !== null) fill.disabled = !has
}

function openDock(kind, item) {
  const isCostume = kind === 'costume'
  state.dock = {
    kind: kind,
    id: textOf(item.id),
    name: isCostume ? (textOf(item.name) || textOf(item.id)) : (textOf(item.title) || textOf(item.id)),
    meta: isCostume
      ? [textOf(item.category), textOf(item.id)].filter(function (part) { return part !== '' }).join(' · ')
      : [textOf(item.partition), textOf(item.hair), textOf(item.style)].filter(function (part) { return part !== '' }).join(' · '),
    thumb: refSrc(isCostume ? item.thumb : item.image),
    tags: [],
    note: '',
  }
  const dock = $('ref-dock')
  if (dock !== null) dock.hidden = false
  renderDock()
}

function dockTagText() {
  return state.dock.tags.map(function (item) { return item.tag }).join(', ')
}

function fillDockTags() {
  if (state.dock.tags.length === 0) { flash('这个参考还没有可用的 tag'); return }
  appendToPrompt(dockTagText())
  flash('已追加 ' + state.dock.tags.length + ' 个 tag')
}

function closeDock() {
  state.dock = dockEmpty()
  const dock = $('ref-dock')
  if (dock !== null) dock.hidden = true
}

async function pickRef(kind, id) {
  const ref = state.refs[kind]
  const item = ref.items.find(function (entry) { return textOf(entry.id) === id })
  if (item === undefined) return
  openDock(kind, item)
  const params = new URLSearchParams()
  params.set('kind', kind)
  params.set('id', id)
  const res = await api('/ref-tags?' + params.toString())
  if (state.dock.kind !== kind || state.dock.id !== id) return
  const data = res.data || {}
  if (res.status === 0 || data.ok === false) {
    state.dock.tags = []
    state.dock.note = res.status === 501
      ? '标签接口还没上线，可以先照名称手动补。'
      : (textOf(data.message) || '取不到这个参考的 tag')
    renderDock()
    return
  }
  const packTags = function (list) {
    const seen = {}
    return (Array.isArray(list) ? list : [])
      .map(function (entry) { return { tag: tagName(entry), cn: tagCn(entry) } })
      .filter(function (entry) {
        if (entry.tag === '' || seen[entry.tag] === true) return false
        seen[entry.tag] = true
        return true
      })
  }
  // 现接口回 positive / negative（docs/API.md:284-292），早先约定的是 tags，两种都认。
  const tags = packTags(Array.isArray(data.positive) ? data.positive : data.tags)
  const negative = packTags(data.negative)
  state.dock.tags = tags
  if (tags.length === 0) state.dock.note = '这个参考没有映射到 tag，可以照名称手动补。'
  else if (negative.length > 0) {
    state.dock.note = '还会补上负向：' + negative.map(function (entry) { return entry.tag }).join(', ')
  } else state.dock.note = ''
  renderDock()
  if (tags.length === 0) return
  const box = refGridBox(kind)
  if (box === null) return
  box.querySelectorAll('.rcard').forEach(function (card) {
    if (card.dataset.refId !== id) return
    card.dataset.picked = '1'
    const badge = card.querySelector('.gcard-badge')
    if (badge !== null) badge.textContent = '✓'
  })
}

/* ---------------- 中栏：样式 ---------------- */

function styleGroupLabel(key) {
  const hit = state.styles.groups.find(function (item) {
    if (typeof item === 'string') return item === key
    return item !== null && typeof item === 'object' && (textOf(item.id) === key || textOf(item.key) === key)
  })
  if (hit !== null && typeof hit === 'object') {
    const label = textOf(hit.label)
    if (label !== '') return label
    const title = textOf(hit.title)
    if (title !== '') return title
  }
  return GROUP_LABELS[key] || key
}

function renderStyles() {
  const box = $('style-groups')
  if (box === null) return
  clear(box)
  const styles = Array.isArray(state.styles.styles) ? state.styles.styles : []
  if (!state.styles.ok) {
    box.append(el('p', { class: 'dim', text: '样式库不可用：' + (state.styles.message || '接口没上线') }))
    return
  }
  if (styles.length === 0) {
    box.append(el('p', { class: 'dim', text: '样式库是空的。' }))
    return
  }
  const order = []
  const map = {}
  styles.forEach(function (style) {
    const key = textOf(style.group) || 'other'
    if (map[key] === undefined) { map[key] = []; order.push(key) }
    map[key].push(style)
  })
  order.forEach(function (key) {
    const section = el('section', { class: 'sgroup' })
    const head = el('div', { class: 'sgroup-h' })
    head.append(el('b', { text: styleGroupLabel(key) }))
    head.append(el('span', { text: String(map[key].length) }))
    section.append(head)
    const grid = el('div', { class: 'sgrid' })
    map[key].forEach(function (style) {
      const id = textOf(style.id)
      const on = state.styles.selected.has(id)
      const card = el('button', {
        class: 'scard' + (on ? ' is-on' : ''),
        type: 'button',
        dataset: { id: id, accent: textOf(style.accent) || 'indigo' },
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': '套用样式「' + (textOf(style.title) || id) + '」',
      })
      card.append(el('span', { class: 'scard-title', text: textOf(style.title) || id }))
      if (textOf(style.note) !== '') card.append(el('span', { class: 'scard-note', text: textOf(style.note) }))
      const tags = Array.isArray(style.tags) ? style.tags : []
      const cn = Array.isArray(style.cn) ? style.cn : []
      const preview = tags.map(function (tag, index) {
        const zh = textOf(cn[index])
        return zh === '' ? tag : tag + '（' + zh + '）'
      })
      card.append(el('span', { class: 'scard-tags', text: preview.join(' · ') }))
      grid.append(card)
    })
    section.append(grid)
    box.append(section)
  })
}

function paintStylePicked() {
  const picked = state.styles.selected.size
  const label = $('style-picked')
  if (label !== null) label.textContent = '已选 ' + picked
  const button = $('style-apply')
  if (button !== null) button.disabled = picked === 0
}

async function loadStyles() {
  const res = await api('/styles')
  const data = res.data || {}
  const status = $('style-status')
  if (res.status === 0 || data.ok !== true) {
    state.styles.ok = false
    state.styles.message = textOf(data.message) || (res.status === 0 ? '连不上本地服务' : '接口 HTTP ' + res.status)
    renderStyles()
    if (status !== null) status.textContent = '样式库不可用：' + state.styles.message
    return
  }
  state.styles.ok = true
  state.styles.styles = Array.isArray(data.styles) ? data.styles : []
  state.styles.groups = Array.isArray(data.groups) ? data.groups : []
  renderStyles()
  paintStylePicked()
  if (status !== null) status.textContent = '共 ' + state.styles.styles.length + ' 个样式，点一下选中，再套用到提示词。'
}

function toggleStyle(id) {
  if (state.styles.selected.has(id)) state.styles.selected.delete(id)
  else state.styles.selected.add(id)
  const card = document.querySelector('.scard[data-id="' + id.replace(/"/g, '') + '"]')
  if (card !== null) {
    const on = state.styles.selected.has(id)
    card.classList.toggle('is-on', on)
    card.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  paintStylePicked()
}

function applyStyles() {
  const chosen = state.styles.styles.filter(function (style) { return state.styles.selected.has(textOf(style.id)) })
  if (chosen.length === 0) { flash('先选一个样式'); return }
  const box = $('prompt')
  const current = splitTags(box.value).map(function (token) { return tagCore(token).toLowerCase() })
  const add = []
  chosen.forEach(function (style) {
    const tags = Array.isArray(style.tags) ? style.tags : []
    tags.forEach(function (tag) {
      const name = textOf(tag)
      if (name === '' || current.indexOf(name.toLowerCase()) >= 0) return
      current.push(name.toLowerCase())
      add.push(name)
    })
  })
  if (add.length === 0) { flash('这些样式的 tag 都已经在提示词里了'); return }
  appendToPrompt(add.join(', '))
  flash('已套用 ' + chosen.length + ' 个样式，追加 ' + add.length + ' 个 tag')
}

/* ---------------- 右栏：工作流与出图 ---------------- */

async function loadWorkflows() {
  const box = $('workflow')
  const res = await api('/workflows')
  const data = res.data || {}
  if (box === null) return
  clear(box)
  if (res.status === 0 || data.ok === false || !Array.isArray(data.workflows)) {
    box.append(el('option', { value: '', text: textOf(data.message) || '工作流读不到' }))
    return
  }
  const list = data.workflows
  if (list.length === 0) { box.append(el('option', { value: '', text: '工作流目录是空的' })); return }
  list.forEach(function (item) {
    const id = textOf(item.id)
    if (id === '') return
    const note = []
    if (typeof item.name === 'string' && item.name !== '' && item.name !== id) note.push(item.name)
    if (Number.isFinite(item.nodes)) note.push(item.nodes + ' 节点')
    if (textOf(item.message) !== '') note.push(item.message)
    box.append(el('option', { value: id, text: note.length > 0 ? id + ' · ' + note.join(' · ') : id }))
  })
  selectWant('workflow', state.ui.workflowId)
  state.ui.workflowId = box.value
}

function imageUrl(item) {
  if (item === null || typeof item !== 'object') return ''
  const direct = textOf(item.url)
  if (direct !== '') return direct
  const filename = textOf(item.filename)
  if (filename === '') return ''
  const sub = textOf(item.subfolder)
  const type = textOf(item.type) || 'output'
  return API + '/image?filename=' + encodeURIComponent(filename) + '&subfolder=' + encodeURIComponent(sub) + '&type=' + encodeURIComponent(type)
}

function renderShots() {
  const box = $('results')
  const empty = $('results-empty')
  if (box === null) return
  clear(box)
  const images = Array.isArray(state.run.images) ? state.run.images : []
  images.forEach(function (item) {
    const src = imageUrl(item)
    if (src === '') return
    const button = el('button', { class: 'shot', type: 'button', 'aria-label': '放大查看这张图' })
    button.append(el('img', { src: src, alt: textOf(item.filename) || '生成结果', loading: 'lazy' }))
    button.addEventListener('click', function () { openLightbox(src, textOf(item.filename) || '生成结果') })
    box.append(button)
  })
  if (empty !== null) empty.hidden = images.length > 0
}

function setRunStage(stage, message) {
  state.run.stage = stage
  const badge = $('run-badge')
  if (badge !== null) badge.textContent = STAGE_LABELS[stage] || stage
  const line = $('run-status')
  if (line !== null) line.textContent = message === undefined || message === '' ? (STAGE_LABELS[stage] || stage) : String(message)
  const bar = $('run-progress')
  if (bar !== null) {
    const show = stage === 'queued' || stage === 'running'
    bar.hidden = !show
    const fill = bar.firstElementChild
    if (fill !== null) fill.style.width = Math.round(Math.max(0, Math.min(1, state.run.progress)) * 100) + '%'
  }
}

function pushHistory(entry) {
  state.history.unshift(entry)
  if (state.history.length > HIST_MAX) state.history.length = HIST_MAX
  renderHistory()
}

function renderHistory() {
  const box = $('history')
  if (box === null) return
  clear(box)
  state.history.forEach(function (entry) {
    const item = el('li', { class: 'hi' })
    if (entry.thumb !== '') item.append(el('img', { class: 'hi-thumb', alt: '', loading: 'lazy', src: entry.thumb }))
    else item.append(el('span', { class: 'hi-thumb is-empty', 'aria-hidden': 'true' }))
    const main = el('div', { class: 'hi-main' })
    main.append(el('b', { text: entry.workflowId || '（未选工作流）' }))
    main.append(el('span', { text: (entry.time || '') + ' · seed ' + String(entry.seed) }))
    item.append(main)
    item.append(el('span', { class: 'hi-state', dataset: { s: entry.state || 'queued' }, text: STAGE_LABELS[entry.state] || entry.state || 'queued' }))
    box.append(item)
  })
  const count = $('hist-count')
  if (count !== null) count.textContent = state.history.length + ' 条'
}

function currentVars() {
  const vars = {
    width: intOf($('width').value, 1200, 64, 4096),
    height: intOf($('height').value, 1800, 64, 4096),
    seed: intOf($('seed').value, 20261108, 0, Number.MAX_SAFE_INTEGER),
    steps: intOf($('steps').value, 30, 1, 150),
    cfg: floatOf($('cfg').value, 5.03, 0.5, 30),
  }
  if (state.ref.name !== '') vars.refImage = state.ref.name
  return vars
}

async function doRun() {
  if (state.run.running) return
  const button = $('btn-run')
  const workflowId = $('workflow') === null ? '' : $('workflow').value
  if (workflowId === '') { flash('先选一个工作流'); return }
  const positive = state.forge.positive
  if (positive.trim() === '') { flash('正向提示词是空的，先锻造'); return }
  const vars = currentVars()
  state.run.running = true
  state.run.images = []
  state.run.progress = 0
  if (button !== null) button.disabled = true
  setRunStage('queued', '提交中…')
  renderShots()
  const res = await api('/run', { body: { workflowId: workflowId, positive: positive, negative: state.forge.negative, vars: vars } })
  const data = res.data || {}
  if (res.status === 0 || data.ok !== true) {
    const message = textOf(data.message) || ('提交失败（HTTP ' + res.status + '）')
    state.run.running = false
    if (button !== null) button.disabled = false
    setRunStage('failed', message)
    pushHistory({ time: clock(), workflowId: workflowId, seed: vars.seed, state: 'failed', thumb: '' })
    return
  }
  state.run.promptId = textOf(data.promptId)
  const entry = { time: clock(), workflowId: workflowId, seed: vars.seed, state: 'queued', thumb: '' }
  pushHistory(entry)
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(function (item) { return typeof item === 'string' && item !== '' }) : []
  const queue = Number.isFinite(data.queueNumber) ? '队列第 ' + data.queueNumber + ' 位' : '已提交'
  setRunStage('queued', queue + (warnings.length > 0 ? ' · ' + warnings[0] : ''))
  schedulePoll()
}

function clock() {
  const now = new Date()
  const pad = function (n) { return n < 10 ? '0' + n : String(n) }
  return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())
}

function schedulePoll() {
  if (state.run.timer !== 0) window.clearTimeout(state.run.timer)
  state.run.timer = window.setTimeout(pollJob, POLL_MS)
}

function finishRun(stage, message) {
  state.run.running = false
  const button = $('btn-run')
  if (button !== null) button.disabled = false
  setRunStage(stage, message)
  state.run.progress = stage === 'done' ? 1 : state.run.progress
  const head = state.history[0]
  if (head !== undefined) {
    head.state = stage
    const first = Array.isArray(state.run.images) ? state.run.images[0] : undefined
    if (first !== undefined) head.thumb = imageUrl(first)
    renderHistory()
  }
}

async function pollJob() {
  const id = state.run.promptId
  if (id === '') { finishRun('unknown', '没有 promptId'); return }
  const res = await api('/job?id=' + encodeURIComponent(id))
  const data = res.data || {}
  if (res.status === 0) { finishRun('failed', textOf(data.message) || '连不上本地服务'); return }
  if (data.ok !== true) {
    finishRun('failed', textOf(data.message) || ('查状态失败（HTTP ' + res.status + '）'))
    return
  }
  const stage = textOf(data.state) || 'unknown'
  if (Number.isFinite(data.progress)) state.run.progress = data.progress
  if (stage === 'done') {
    state.run.images = Array.isArray(data.images) ? data.images : []
    renderShots()
    finishRun('done', textOf(data.message) || ('完成 · ' + state.run.images.length + ' 张图'))
    return
  }
  if (stage === 'failed') {
    state.run.images = Array.isArray(data.images) ? data.images : []
    renderShots()
    finishRun('failed', textOf(data.message) || '生成失败')
    return
  }
  const progress = Math.round(Math.max(0, Math.min(1, state.run.progress)) * 100)
  setRunStage(stage, (STAGE_LABELS[stage] || stage) + (stage === 'running' ? ' ' + progress + '%' : ''))
  const head = state.history[0]
  if (head !== undefined && head.state !== stage) { head.state = stage; renderHistory() }
  schedulePoll()
}

/* ---------------- 灯箱 ---------------- */

var lightboxFrom = null

function openLightbox(src, name) {
  const box = $('lightbox')
  const img = $('lightbox-img')
  if (box === null || img === null) return
  img.src = src
  img.alt = name
  const label = $('lightbox-name')
  if (label !== null) label.textContent = name
  lightboxFrom = document.activeElement
  box.hidden = false
  const close = $('lightbox-close')
  if (close !== null) close.focus()
}

function closeLightbox() {
  const box = $('lightbox')
  if (box === null || box.hidden) return
  box.hidden = true
  const img = $('lightbox-img')
  if (img !== null) img.src = ''
  if (lightboxFrom !== null && typeof lightboxFrom.focus === 'function') lightboxFrom.focus()
  lightboxFrom = null
}

/* ---------------- 参考图上传 ---------------- */

function readFileAsDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader()
    reader.onload = function () { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = function () { reject(new Error('读文件失败')) }
    reader.readAsDataURL(file)
  })
}

async function uploadRef(file) {
  if (file === null || file === undefined) { state.ref.name = ''; return }
  if (state.ref.busy) return
  state.ref.busy = true
  const line = $('run-status')
  if (line !== null) line.textContent = '上传参考图…'
  try {
    const dataUrl = await readFileAsDataUrl(file)
    const comma = dataUrl.indexOf(',')
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
    if (base64 === '') { if (line !== null) line.textContent = '参考图读不出来'; return }
    const res = await api('/upload', { body: { filename: file.name, data: base64 } })
    const data = res.data || {}
    if (res.status === 0 || data.ok !== true) {
      if (line !== null) line.textContent = textOf(data.message) || '参考图上传失败'
      return
    }
    state.ref.name = textOf(data.name) || textOf(data.filename) || file.name
    if (line !== null) line.textContent = '参考图已就位：' + state.ref.name
  } catch (err) {
    if (line !== null) line.textContent = '参考图上传失败'
  } finally {
    state.ref.busy = false
  }
}

/* ---------------- /state 与 /profiles ---------------- */

function applyState(res) {
  const data = res.data || {}
  if (res.status === 0) {
    setPill('pill-llm', 'err', '连不上本地服务')
    setPill('pill-comfy', 'err', '连不上本地服务')
    return
  }
  const config = data.config !== null && typeof data.config === 'object' ? data.config : {}
  state.config = config
  state.comfy = data.comfy === null || typeof data.comfy !== 'object' ? null : data.comfy

  const llm = config.llm !== null && typeof config.llm === 'object' ? config.llm : {}
  state.llm = {
    provider: textOf(llm.provider),
    model: textOf(llm.model),
    ready: llm.hasLlmService === true || llm.apiKeySet === true || textOf(llm.provider) !== '',
  }
  paintLlmPill()
  paintComfyPill()

  const tags = config.tags !== null && typeof config.tags === 'object' ? config.tags : {}
  if (Number.isFinite(tags.maxTags)) { state.ui.maxTags = intOf(tags.maxTags, 40, 8, 160); $('maxTags').value = String(state.ui.maxTags) }
  const purge = config.purge !== null && typeof config.purge === 'object' ? config.purge : {}
  if (LEVELS.indexOf(textOf(purge.level)) >= 0) { state.ui.level = textOf(purge.level); $('level').value = state.ui.level }
  const forge = config.forge !== null && typeof config.forge === 'object' ? config.forge : {}
  if (textOf(forge.profile) !== '') { state.ui.profile = textOf(forge.profile); selectWant('profile', state.ui.profile) }
  const comfy = config.comfy !== null && typeof config.comfy === 'object' ? config.comfy : {}
  if (textOf(comfy.defaultWorkflowId) !== '' && state.ui.workflowId === '') state.ui.workflowId = textOf(comfy.defaultWorkflowId)
  state.llm.model = state.llm.model === '' ? textOf(forge.model) : state.llm.model
  paintLlmPill()
}

function applyProfiles(res) {
  const data = res.data || {}
  const list = Array.isArray(data.profiles) ? data.profiles : []
  state.profiles.list = list
  const current = data.current !== null && typeof data.current === 'object' ? data.current : {}
  const id = textOf(current.id) || textOf(current.profile) || textOf(current.key)
  const box = $('profile')
  if (box !== null) {
    clear(box)
    const ids = list.map(function (item) { return typeof item === 'string' ? item : textOf(item.id) }).filter(function (item) { return item !== '' })
    ;(ids.length > 0 ? ids : ['tag', 'pony', 'natural', 'custom']).forEach(function (key) {
      const hit = list.find(function (item) { return item !== null && typeof item === 'object' && textOf(item.id) === key })
      const label = hit !== undefined && textOf(hit.title) !== '' ? textOf(hit.title) : (PROFILE_LABELS[key] || key)
      box.append(el('option', { value: key, text: label }))
    })
    selectWant('profile', textOf(state.config === null ? '' : (state.config.forge || {}).profile) || 'tag')
  }
  state.profiles.current = id !== '' ? id : ($('profile') === null ? 'tag' : $('profile').value)
  paintProfilePill()
}

async function saveConfig(patch) {
  const res = await api('/config', { body: { patch: patch } })
  const data = res.data || {}
  if (res.status === 0 || data.ok === false) { flash(textOf(data.message) || '设置没存上'); return false }
  return true
}

/* ---------------- 接口设置：LLM 与 ComfyUI ---------------- */

const LLM_PRESETS = [
  { id: 'builtin', label: '本机内置 LLM（provider 照旧）', provider: '', baseUrl: '', model: '' },
  { id: 'deepseek', label: 'DeepSeek 官方', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'siliconflow', label: '硅基流动', provider: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'dashscope', label: '阿里百炼', provider: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'ollama', label: '本机 Ollama', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
  { id: 'opencode', label: 'opencode 内置（订阅）', provider: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/v1', model: 'deepseek-v4.1-flash' },
]
const COMFY_DIR_HINTS = ['C:/ComfyUI', 'D:/ComfyUI', 'D:/ComfyUI_windows_portable/ComfyUI', 'D:/AI/ComfyUI', 'C:/Users/Public/ComfyUI']
const LLM_V1_HOSTS = ['api.deepseek.com', 'api.openai.com', 'api.siliconflow.cn']

function setSetStatus(id, message, kind) {
  const node = $(id)
  if (node === null) return
  node.textContent = String(message)
  node.dataset.kind = kind || ''
}

function dropQuotes(value) {
  return textOf(value).replace(/^["'\u0060]+|["'\u0060]+$/g, '')
}

function tidyPath(value) {
  const text = dropQuotes(value)
  if (text === '') return ''
  return text.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/** LLM 接口地址：补协议、补已知服务的 /v1、去掉末尾斜杠。 */
/** 取上一级目录（本工具内部统一用 /）。 */
function parentDir(path) {
  const clean = tidyPath(path)
  const cut = clean.lastIndexOf('/')
  return cut > 0 ? clean.slice(0, cut) : clean
}

/** 只取最前一段（盘符或首个目录名），用来判断两个路径是不是同一套安装。 */
function pathRoot(path) {
  const clean = tidyPath(path)
  const cut = clean.indexOf('/')
  return cut > 0 ? clean.slice(0, cut) : clean
}

function normalizeLlmBase(value) {
  let text = dropQuotes(value)
  if (text === '') return ''
  if (/^[\w.-]+:\d{2,5}(\/.*)?$/.test(text)) text = 'http://' + text
  if (!/^(https?|wss?):\/\//i.test(text)) text = 'https://' + text
  try {
    const url = new URL(text)
    if ((url.pathname === '' || url.pathname === '/') && LLM_V1_HOSTS.indexOf(url.hostname) >= 0) url.pathname = '/v1'
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return (url.origin + path + url.search).replace(/\/+$/, '')
  } catch (error) {
    return text.replace(/\/+$/, '')
  }
}

/** ComfyUI 接口地址：只填端口 / 主机也能认。 */
function normalizeComfyBase(value) {
  let text = dropQuotes(value)
  if (text === '') return ''
  if (/^\d{2,5}$/.test(text)) return 'http://127.0.0.1:' + text
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text
  return text.replace(/\/+$/, '')
}

/** 目录输入：既收目录，也收 main.py 完整路径 / 整条启动命令，拆成目录 + python + 参数。 */
function parseComfyInput(value) {
  const out = { dir: '', python: '', args: '' }
  let raw = textOf(value).split(/\s+/).map(function (token) { return dropQuotes(token) }).filter(function (token) { return token !== '' }).join(' ')
  if (raw === '') return out
  const command = raw.match(/^(\S*?(?:python[0-9.]*(?:\.exe)?|py|py\.exe))\s+(.+)$/i)
  if (command !== null && /\.py\b/i.test(command[2])) {
    out.python = tidyPath(command[1])
    raw = command[2]
  }
  const file = raw.match(/^(.*?)([^\s\\/]*\.py)\b\s*(.*)$/)
  if (file !== null) {
    // main.py 之前可能夹着 python 自己的开关（如 -s / -X utf8），只取最后一段像路径的当目录
    const tokens = textOf(file[1]).split(/\s+/).map(function (token) { return dropQuotes(token) }).filter(function (token) { return token !== '' && token.indexOf('-') !== 0 })
    const dirToken = tokens.length > 0 ? tokens[tokens.length - 1] : ''
    if (dirToken !== '') {
      const clean = tidyPath(dirToken)
      // python_embeded/python.exe -s ComfyUI/main.py：相对目录按 python 上面两级推成绝对路径
      const relative = clean.indexOf('/') < 0 && out.python.indexOf('/') > 0
      out.dir = relative ? parentDir(parentDir(out.python)) + '/' + clean : clean
    }
    out.args = textOf(file[3])
    return out
  }
  out.dir = tidyPath(raw)
  return out
}

function applyLlmPreset() {
  const box = $('set-llm-preset')
  if (box === null) return
  const hit = LLM_PRESETS.find(function (item) { return item.id === box.value })
  if (hit === undefined) return
  if (hit.baseUrl !== '') $('set-llm-base').value = hit.baseUrl
  if (hit.model !== '') $('set-llm-model').value = hit.model
  if (hit.baseUrl === '' && hit.model === '') {
    $('set-llm-base').value = ''
    $('set-llm-model').value = ''
    setSetStatus('set-llm-status', '内置服务：地址留空，provider 用配置里那个', '')
  } else {
    setSetStatus('set-llm-status', '已套用预设，填 key 后测试', '')
  }
}

function fillSettings(force) {
  const config = state.config !== null && typeof state.config === 'object' ? state.config : {}
  const llm = config.llm !== null && typeof config.llm === 'object' ? config.llm : {}
  const comfy = config.comfy !== null && typeof config.comfy === 'object' ? config.comfy : {}

  const preset = $('set-llm-preset')
  if (preset !== null && preset.options.length <= 1) {
    LLM_PRESETS.forEach(function (item) {
      preset.append(el('option', { value: item.id, text: item.label, dataset: { provider: item.provider } }))
    })
  }
  const dirs = $('set-comfy-dirs')
  if (dirs !== null && dirs.children.length === 0) {
    COMFY_DIR_HINTS.forEach(function (item) { dirs.append(el('option', { value: item })) })
  }

  const typing = function (id) { const node = $(id); return node !== null && document.activeElement === node }
  if (force === true || !typing('set-llm-base')) { const node = $('set-llm-base'); if (node !== null) node.value = textOf(llm.baseUrl) }
  if (force === true || !typing('set-llm-model')) { const node = $('set-llm-model'); if (node !== null) node.value = textOf(llm.model) }
  if (force === true) { const node = $('set-llm-key'); if (node !== null) node.value = '' }

  // 已存的地址能对上某个预设，就把预设顺手选中，省得用户自己回查用了哪家
  if (preset !== null && textOf(llm.baseUrl) !== '') {
    const hit = LLM_PRESETS.find(function (item) { return item.baseUrl !== '' && normalizeLlmBase(item.baseUrl) === normalizeLlmBase(llm.baseUrl) })
    if (hit !== undefined) preset.value = hit.id
  }

  const keyHint = $('set-llm-keyhint')
  if (keyHint !== null) {
    keyHint.textContent = llm.apiKeySet === true
      ? '已保存 ' + (textOf(llm.apiKeyHint) || '（掩码）') + '，留空就不改'
      : '还没有保存过 key'
  }

  if (force === true || !typing('set-comfy-base')) { const node = $('set-comfy-base'); if (node !== null) node.value = textOf(comfy.baseUrl) || 'http://127.0.0.1:8188' }
  if (force === true || !typing('set-comfy-dir')) { const node = $('set-comfy-dir'); if (node !== null) node.value = textOf(comfy.launchDir) }
  if (force === true || !typing('set-comfy-python')) { const node = $('set-comfy-python'); if (node !== null) node.value = textOf(comfy.pythonPath) }
  if (force === true || !typing('set-comfy-args')) { const node = $('set-comfy-args'); if (node !== null) node.value = textOf(comfy.launchArgs) }
}

function settingsOpen() {
  const box = $('settings')
  return box !== null && box.hidden === false
}

function openSettings() {
  fillSettings(true)
  const box = $('settings')
  if (box === null) return
  box.hidden = false
  document.body.classList.add('drawer-on')
  const first = $('set-llm-base')
  if (first !== null) first.focus()
}

function closeSettings() {
  const box = $('settings')
  if (box === null || box.hidden === true) return
  box.hidden = true
  document.body.classList.remove('drawer-on')
  const back = $('btn-settings')
  if (back !== null) back.focus()
}

async function refreshState() {
  const res = await api('/state')
  applyState(res)
}

async function probeLlm() {
  const baseUrl = normalizeLlmBase($('set-llm-base').value)
  $('set-llm-base').value = baseUrl
  const key = dropQuotes(textOf($('set-llm-key').value))
  // 地址没改：不传 baseUrl，让服务端用配置里的地址与已存的 key，省得每次重贴 key
  const storedBase = normalizeLlmBase(state.config?.llm?.baseUrl ?? '')
  const sameStored = baseUrl !== '' && storedBase === baseUrl
  const body = { apiKey: key }
  if (!sameStored) body.baseUrl = baseUrl
  setSetStatus('set-llm-status', '测试中…', 'busy')
  const button = $('set-llm-probe')
  if (button !== null) button.disabled = true
  const res = await api('/llm/probe', { body: body })
  if (button !== null) button.disabled = false
  const data = res.data || {}
  if (res.status === 0) { setSetStatus('set-llm-status', '连不上本地服务', 'err'); return }
  if (data.ok !== true) {
    if (data.error === 'no-api-key') {
      setSetStatus('set-llm-status', sameStored ? '这个地址还没存 key：在上面填一个再测' : '换了地址就得重填 key（存下的 key 只在本机同一地址复用）', 'err')
      return
    }
    setSetStatus('set-llm-status', textOf(data.message) || textOf(data.error) || '连不上', 'err')
    return
  }
  const list = $('set-llm-models')
  if (list !== null) {
    clear(list)
    const models = Array.isArray(data.models) ? data.models : []
    models.forEach(function (id) { list.append(el('option', { value: id })) })
    const current = $('set-llm-model')
    if (current !== null && textOf(current.value) === '' && models.length > 0) current.value = models[0]
  }
  setSetStatus('set-llm-status', (textOf(data.message) || '连上了') + '（' + (textOf(data.endpoint) || baseUrl) + '）', 'ok')
}

async function saveLlmSettings() {
  const baseUrl = normalizeLlmBase($('set-llm-base').value)
  $('set-llm-base').value = baseUrl
  const key = dropQuotes(textOf($('set-llm-key').value))
  const patch = { llm: { baseUrl: baseUrl, model: textOf($('set-llm-model').value) } }
  const presetBox = $('set-llm-preset')
  const chosen = presetBox !== null && presetBox.selectedOptions.length > 0 ? presetBox.selectedOptions[0] : null
  const provider = chosen !== null && chosen.dataset !== undefined ? textOf(chosen.dataset.provider) : ''
  if (provider !== '') patch.llm.provider = provider
  if (key !== '') patch.llm.apiKey = key
  setSetStatus('set-llm-status', '保存中…', 'busy')
  const ok = await saveConfig(patch)
  if (!ok) { setSetStatus('set-llm-status', '没存上，检查本地服务', 'err'); return }
  if ($('set-llm-key') !== null) $('set-llm-key').value = ''
  await refreshState()
  fillSettings(false)
  setSetStatus('set-llm-status', '已保存，下次锻造就用它', 'ok')
  flash('LLM 设置已保存')
}

async function probeComfy() {
  setSetStatus('set-comfy-status', '探测中…', 'busy')
  const res = await api('/comfy')
  const data = res.data || {}
  if (res.status === 0) { setSetStatus('set-comfy-status', '连不上本地服务', 'err'); return }
  const status = data.status !== null && typeof data.status === 'object' ? data.status : {}
  const launch = data.launch !== null && typeof data.launch === 'object' ? data.launch : {}
  const plan = $('set-comfy-plan')
  if (plan !== null) {
    if (launch.ok === true) {
      plan.textContent = '可以自动启动：' + (textOf(launch.command) || textOf(launch.python) + ' main.py')
    } else {
      plan.textContent = textOf(launch.message) || '还没有可用的安装目录（要能找到 main.py）'
    }
  }
  const dirBox = $('set-comfy-dir')
  if (launch.ok === true && dirBox !== null && textOf(dirBox.value) === '') dirBox.value = tidyPath(launch.dir)
  const online = status.ok === true
  setSetStatus('set-comfy-status', online ? '在线，可以直接出图' : '离线：先「启动 ComfyUI」或手动开', online ? 'ok' : 'warn')
  state.comfy = data
  paintComfyPill()
}

async function launchComfyFromSettings() {
  setSetStatus('set-comfy-status', '启动中…（第一次加载模型会慢）', 'busy')
  const button = $('set-comfy-launch')
  if (button !== null) button.disabled = true
  const res = await api('/comfy/launch', { body: { waitMs: 60000 } })
  if (button !== null) button.disabled = false
  const data = res.data || {}
  if (res.status === 0) { setSetStatus('set-comfy-status', '连不上本地服务', 'err'); return }
  const plan = $('set-comfy-plan')
  if (plan !== null && (data.error === 'no-launch-dir' || data.error === 'launch')) {
    plan.textContent = textOf(data.message) || '启动失败：先把安装目录填对'
  }
  if (data.ok !== true) {
    setSetStatus('set-comfy-status', textOf(data.message) || '启动失败', 'err')
    return
  }
  setSetStatus('set-comfy-status', data.alreadyRunning === true ? '本来就在跑' : '已启动，等它就绪…', 'ok')
  await probeComfy()
  await loadWorkflows()
}

async function saveComfySettings() {
  const parsed = parseComfyInput($('set-comfy-dir').value)
  const baseUrl = normalizeComfyBase($('set-comfy-base').value) || 'http://127.0.0.1:8188'
  const python = textOf($('set-comfy-python').value) || parsed.python
  const args = textOf($('set-comfy-args').value) || parsed.args
  const baseBox = $('set-comfy-base')
  const dirBox = $('set-comfy-dir')
  const pyBox = $('set-comfy-python')
  const argsBox = $('set-comfy-args')
  if (baseBox !== null) baseBox.value = baseUrl
  if (dirBox !== null) dirBox.value = parsed.dir
  if (pyBox !== null) pyBox.value = python
  if (argsBox !== null) argsBox.value = args
  setSetStatus('set-comfy-status', '保存中…', 'busy')
  const ok = await saveConfig({ comfy: { baseUrl: baseUrl, launchDir: parsed.dir, pythonPath: python, launchArgs: args } })
  if (!ok) { setSetStatus('set-comfy-status', '没存上，检查本地服务', 'err'); return }
  const mixed = python !== '' && parsed.dir !== '' && pathRoot(python) !== pathRoot(parsed.dir)
  await refreshState()
  await probeComfy()
  await loadWorkflows()
  flash('ComfyUI 设置已保存')
  if (mixed) {
    setSetStatus('set-comfy-status', '已保存。但 python（' + pathRoot(python) + '）和 ComfyUI 目录（' + pathRoot(parsed.dir) + '）不像同一套安装，启动多半失败；不确定就把 python 路径留空', 'warn')
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  LEVELS.forEach(function (key) {
    const opt = el('option', { value: key, text: LEVEL_LABELS[key] })
    $('level').append(opt)
  })

  $('prompt').addEventListener('input', function () { autoGrow(); saveUi() })
  $('prompt-clear').addEventListener('click', function () {
    $('prompt').value = ''
    autoGrow()
    saveUi()
    $('prompt').focus()
  })

  $('btn-forge').addEventListener('click', function () { doForge() })
  $('solo').title = '勾上后在描述末尾补一句「画面里只画一个人」，不改 tag 解析'
  $('solo').addEventListener('change', function () { state.ui.solo = $('solo').checked; saveUi() })
  $('maxTags').addEventListener('change', function () { state.ui.maxTags = intOf($('maxTags').value, 40, 8, 160); $('maxTags').value = String(state.ui.maxTags); saveUi() })
  $('level').addEventListener('change', function () {
    state.ui.level = LEVELS.indexOf($('level').value) >= 0 ? $('level').value : 'full'
    saveUi()
  })
  $('profile').addEventListener('change', function () {
    state.ui.profile = $('profile').value
    paintProfilePill()
    saveUi()
    saveConfig({ forge: { profile: state.ui.profile } })
  })

  $('pos-copy').addEventListener('click', function () { copyText(state.forge.positive, '正向') })
  $('neg-copy').addEventListener('click', function () { copyText(state.forge.negative, '负向') })

  $('tab-pose').addEventListener('click', function () { showTab('pose') })
  $('tab-style').addEventListener('click', function () { showTab('style') })

  var qTimer = 0
  $('pose-q').addEventListener('input', function () {
    if (qTimer !== 0) window.clearTimeout(qTimer)
    qTimer = window.setTimeout(function () {
      state.poses.q = $('pose-q').value.trim()
      state.poses.picked = {}
      loadPoses(true)
    }, 250)
  })

  $('pose-sets').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-set]')
    if (hit === null) return
    state.poses.set = hit.dataset.set
    state.poses.category = ''
    loadPoses(true)
  })
  $('pose-cats').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-category]')
    if (hit === null) return
    state.poses.category = hit.dataset.category
    loadPoses(true)
  })
  $('pose-angles').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-angle]')
    if (hit === null) return
    state.poses.angle = hit.dataset.angle
    loadPoses(true)
  })
  $('pose-more').addEventListener('click', function () { loadPoses(false) })
  $('pose-grid').addEventListener('click', function (event) {
    const card = event.target.closest('.gcard')
    if (card === null) return
    pickPose(card.dataset.base, card)
  })

  $('tab-costume').addEventListener('click', function () { showTab('costume') })
  $('tab-portrait').addEventListener('click', function () { showTab('portrait') })

  const refTimer = { costume: 0, portrait: 0 }
  ;[['costume', 'costume-q'], ['portrait', 'portrait-q']].forEach(function (pair) {
    const kind = pair[0]
    const box = $(pair[1])
    if (box === null) return
    box.addEventListener('input', function () {
      if (refTimer[kind] !== 0) window.clearTimeout(refTimer[kind])
      refTimer[kind] = window.setTimeout(function () {
        state.refs[kind].q = box.value.trim()
        loadRefs(kind, true)
      }, 250)
    })
  })

  $('costume-cats').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-set]')
    if (hit === null) return
    state.refs.costume.set = hit.dataset.set
    loadRefs('costume', true)
  })
  $('portrait-sets').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-set]')
    if (hit === null) return
    state.refs.portrait.set = hit.dataset.set
    loadRefs('portrait', true)
  })
  $('portrait-hairs').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-hair]')
    if (hit === null) return
    state.refs.portrait.hair = hit.dataset.hair
    loadRefs('portrait', true)
  })
  $('portrait-popular').addEventListener('click', function () {
    state.refs.portrait.popular = state.refs.portrait.popular !== true
    paintPopular()
    loadRefs('portrait', true)
  })
  $('costume-more').addEventListener('click', function () { loadRefs('costume', false) })
  $('portrait-more').addEventListener('click', function () { loadRefs('portrait', false) })
  $('ref-costume-grid').addEventListener('click', function (event) {
    const card = event.target.closest('.rcard')
    if (card === null) return
    pickRef('costume', card.dataset.refId)
  })
  $('ref-portrait-grid').addEventListener('click', function (event) {
    const card = event.target.closest('.rcard')
    if (card === null) return
    pickRef('portrait', card.dataset.refId)
  })
  $('ref-dock-copy').addEventListener('click', function () {
    if (state.dock.tags.length === 0) return
    copyText(dockTagText(), (REF_LABELS[state.dock.kind] || '参考') + ' tag')
  })
  $('ref-dock-fill').addEventListener('click', function () { fillDockTags() })
  $('ref-dock-clear').addEventListener('click', function () { closeDock() })
  $('ref-dock-tags').addEventListener('click', function (event) {
    const chip = event.target.closest('[data-index]')
    if (chip === null) return
    const index = Number(chip.dataset.index)
    if (!Number.isFinite(index)) return
    state.dock.tags.splice(index, 1)
    renderDock()
  })

  $('style-groups').addEventListener('click', function (event) {
    const card = event.target.closest('.scard')
    if (card === null) return
    toggleStyle(card.dataset.id)
  })
  $('style-apply').addEventListener('click', function () { applyStyles() })

  $('workflow').addEventListener('change', function () { state.ui.workflowId = $('workflow').value; saveUi() })
  ;['width', 'height', 'seed', 'steps', 'cfg'].forEach(function (id) {
    $(id).addEventListener('change', function () { saveUi() })
  })
  $('ref-file').addEventListener('change', function () { uploadRef($('ref-file').files[0]) })
  $('btn-run').addEventListener('click', function () { doRun() })

  $('btn-settings').addEventListener('click', function () { openSettings() })
  $('settings-close').addEventListener('click', function () { closeSettings() })
  $('settings').addEventListener('click', function (event) {
    if (event.target.dataset.close !== undefined) closeSettings()
  })
  $('set-llm-preset').addEventListener('change', function () { applyLlmPreset() })
  $('set-llm-base').addEventListener('blur', function () {
    const box = $('set-llm-base')
    if (box !== null) box.value = normalizeLlmBase(box.value)
  })
  $('set-llm-probe').addEventListener('click', function () { probeLlm() })
  $('set-llm-save').addEventListener('click', function () { saveLlmSettings() })
  $('set-comfy-base').addEventListener('blur', function () {
    const box = $('set-comfy-base')
    if (box !== null) box.value = normalizeComfyBase(box.value)
  })
  $('set-comfy-dir').addEventListener('change', function () {
    const parsed = parseComfyInput($('set-comfy-dir').value)
    const dirBox = $('set-comfy-dir')
    const pyBox = $('set-comfy-python')
    const argsBox = $('set-comfy-args')
    if (dirBox !== null && parsed.dir !== '') dirBox.value = parsed.dir
    if (pyBox !== null && parsed.python !== '' && textOf(pyBox.value) === '') pyBox.value = parsed.python
    if (argsBox !== null && parsed.args !== '' && textOf(argsBox.value) === '') argsBox.value = parsed.args
  })
  $('set-comfy-ping').addEventListener('click', function () { probeComfy() })
  $('set-comfy-launch').addEventListener('click', function () { launchComfyFromSettings() })
  $('set-comfy-save').addEventListener('click', function () { saveComfySettings() })

  $('lightbox').addEventListener('click', function (event) {
    if (event.target.dataset.close !== undefined) closeLightbox()
  })
  $('lightbox-close').addEventListener('click', function () { closeLightbox() })
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    if (settingsOpen()) { closeSettings(); return }
    if ($('ref-dock') !== null && $('ref-dock').hidden === false) { closeDock(); return }
    closeLightbox()
  })
}

/* ---------------- 启动 ---------------- */

async function boot() {
  bindEvents()
  applyStored()
  autoGrow()
  selectWant('level', 'full')
  selectWant('profile', 'tag')
  state.ui.maxTags = intOf($('maxTags').value, 40, 8, 160)
  state.ui.level = LEVELS.indexOf($('level').value) >= 0 ? $('level').value : 'full'
  state.ui.solo = $('solo').checked
  showTab('pose')
  renderJudge()
  renderHistory()
  renderShots()
  setRunStage('idle', '就绪')

  const results = await Promise.all([api('/state'), api('/profiles')])
  applyState(results[0])
  applyProfiles(results[1])
  fillSettings(true)
  saveUi()
  await Promise.all([loadWorkflows(), loadStyles(), loadPoses(true)])
}

boot().catch(function (error) {
  const line = $('forge-status')
  if (line !== null) line.textContent = '面板初始化失败：' + (error && error.message ? error.message : String(error))
})
