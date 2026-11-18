/**
 * 锻造器：白话 → WD/Camie 标签（走宿主 llm 服务，不做二次跳跃）。
 *
 * 一次 generate 的完整链路：
 *   白话 + 破甲系统提示词 → llm.stream 流式拼 text-delta → JSON（坏了修一次）
 *   → 本地标签库 canonicalize 校对（库里没有的进 warnings）→ 按 weightSyntax 拼成
 *   可直接进 CLIPTextEncode 的正/负向串 → 记 history.json。
 *
 * 铁律：generate 永远返回 ForgeResult 对象，不抛。调用方（HTTP / MCP / 面板）
 * 只需要看 ok 与 error，不需要 try/catch。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PURGE_LEVELS,
  agentDirective as purgeAgentDirective,
  buildForgeSystemPrompt,
  purgeState as purgeStateOf,
} from './purge.js'
import { createPostProcessor } from './postprocess.js'
import { createRepairer } from './repair.js'
import { applyPoseHints, detectPoseHints, selectCandidates } from './zh-intent.js'

const DEFAULT_TIMEOUT_MS = 120000
// 画质词一律由 ComfyUI 工作流内置；模型仍爱自己加一条 masterpiece，这里统一清掉。
const QUALITY_TAGS = new Set([
  'masterpiece', 'best_quality', 'great_quality', 'good_quality', 'high_quality', 'ultra_quality',
  'highest_quality', 'amazing_quality', 'perfect_quality', 'highres', 'absurdres', 'ultra_detailed',
  'extremely_detailed', 'very_aesthetic', 'newest',
])

// 模型爱现编的画质词：highly_detailed / extremely_detailed / super_detailed…，全部按画质词处理。
const QUALITY_PATTERN = /^(highly|very|ultra|extremely|super|absurdly|insanely|incredibly)_(detailed|quality|resolution)$|_detailed$|_quality$/

function isQualityKey(key) {
  if (QUALITY_TAGS.has(key)) return true
  if (key === 'detailed' || key === 'detailed_background') return false
  return QUALITY_PATTERN.test(key)
}

/** 去掉画质词（用户自己在描述里点名的除外）。返回 { rows, dropped }。 */
function stripQuality(rows, described) {
  const said = String(described ?? '').toLowerCase().replace(/_/g, ' ')
  const kept = []
  const dropped = []
  for (const row of rows) {
    const key = String(row?.tag ?? '').toLowerCase().trim().replace(/\s+/g, '_').replace(/^\(+|\)+$/g, '')
    const asked = said.includes(key) || said.includes(key.replace(/_/g, ' '))
    if (isQualityKey(key) && !asked) {
      dropped.push(row.tag)
      continue
    }
    kept.push(row)
  }
  return { rows: kept, dropped }
}

const DEFAULT_MAX_TOKENS = 4000
const MAX_TOKEN_CEILING = 16000
const DEFAULT_TEMPERATURE = 0.5
const DEFAULT_STANDARDS = ['wd', 'camie']
const MAX_POSITIVE_HARD_CAP = 200
const PURGE_LEVEL_SET = new Set(PURGE_LEVELS)
const COLD_INDEX_WARNING = '标签库未就绪，未校对'
const INDEX_WAIT_MS = 3000
const INDEX_WAIT_TIMEOUT = '\u0000index-wait'

function indexWait() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(INDEX_WAIT_TIMEOUT), INDEX_WAIT_MS)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fallbackDir() {
  return path.join(os.homedir(), '.dsh-tagger')
}

function clampTimeout(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
  return Math.min(600000, Math.max(100, n))
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function trimNumber(value) {
  const rounded = Math.round(value * 100) / 100
  if (Number.isInteger(rounded)) return String(rounded)
  return String(rounded).replace(/0+$/, '').replace(/\.$/, '')
}

function cleanTag(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return ''
  text = text.replace(/^[-+*•\s]+/, '')
  text = text.replace(/^["'`]+|["'`]+$/g, '')
  text = text.replace(/[,\s]+$/, '')
  text = text.replace(/\s+/g, ' ')
  return text.trim()
}

/** 从 '(tag:1.2)' / 'tag::1.2' / '{{tag}}' / 'tag' 里拆出 tag 与权重。 */
function splitWeight(raw) {
  let text = String(raw ?? '').trim()
  let weight
  const paren = text.match(/^\((.+):([0-9]*\.?[0-9]+)\)$/)
  if (paren !== null) {
    text = paren[1]
    weight = Number.parseFloat(paren[2])
  } else {
    const colon = text.match(/^(.+?)::([0-9]*\.?[0-9]+)$/)
    if (colon !== null) {
      text = colon[1]
      weight = Number.parseFloat(colon[2])
    } else {
      const braces = text.match(/^\{\{(.+)\}\}$/)
      if (braces !== null) {
        text = braces[1]
        weight = 1.1
      }
    }
  }
  return { tag: cleanTag(text), weight: Number.isFinite(weight) ? weight : undefined }
}

/** positive / negative 数组的元素可以是字符串，也可以是 {tag, weight} 这类对象。 */
function normalizeEntry(item) {
  if (typeof item === 'string') {
    const split = splitWeight(item)
    if (split.tag === '') return undefined
    return { tag: split.tag, weight: split.weight }
  }
  if (!isRecord(item)) return undefined
  const rawTag = item.tag ?? item.name ?? item.word ?? item.text ?? item.value
  if (typeof rawTag !== 'string') return undefined
  const split = splitWeight(rawTag)
  if (split.tag === '') return undefined
  const rawWeight = item.weight ?? item.w ?? item.score ?? item.strength ?? split.weight
  const weight = typeof rawWeight === 'number' ? rawWeight : Number.parseFloat(String(rawWeight ?? ''))
  return { tag: split.tag, weight: Number.isFinite(weight) ? weight : undefined }
}

function normalizeList(value) {
  const rows = []
  const push = item => {
    const row = normalizeEntry(item)
    if (row !== undefined) rows.push(row)
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item)
    return rows
  }
  if (typeof value === 'string') {
    for (const piece of value.split(/[,\n]/)) push(piece)
    return rows
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) push(item)
    return rows
  }
  return rows
}

/** 剥掉 markdown 围栏（模型爱在外面包一层 ```json）。 */
function extractFenced(raw) {
  const source = String(raw ?? '').trim()
  if (source === '') return { text: source, repaired: false }
  const fence = source.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence !== null) {
    const inner = fence[1].trim()
    if (inner !== '') return { text: inner, repaired: true }
  }
  const stripped = source.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim()
  if (stripped !== source) return { text: stripped, repaired: true }
  return { text: source, repaired: false }
}

/** 第一个 { 或 [ 的下标，找不到返回 -1。 */
function firstBrace(text) {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (objStart >= 0 && arrStart >= 0) return Math.min(objStart, arrStart)
  return Math.max(objStart, arrStart)
}

/** 切到最后一个 } 或 ] 之后（去掉"希望有帮助"这类尾巴）。 */
function trimToLastJson(text) {
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end < 0) return text
  return text.slice(0, end + 1)
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 补齐没闭合的引号 / 括号（模型偶尔被截断）。 */
function closeUnbalanced(input) {
  const stack = []
  let inString = false
  let escape = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '['
      if (stack.length > 0 && stack[stack.length - 1] === want) stack.pop()
    }
  }
  let out = input
  if (inString) out += '"'
  out = out.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === '{' ? '}' : ']'
  return out
}

/** 结构性修复：注释、尾逗号、单引号、裸键、控制字符、截断。 */
function repairJsonText(input) {
  let text = String(input ?? '')
  text = text.replace(/^\uFEFF/, '')
  text = text.replace(/\/\*[\s\S]*?\*\//g, '')
  text = text.replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  text = text.replace(/,\s*([}\]])/g, '$1')
  text = text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
  text = text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
  return closeUnbalanced(text)
}

/**
 * 解析模型输出：剥围栏 → 直解 → 去前后废话 → **结构性修复一次** → 仍失败返回 undefined。
 * repaired 表示"不是原样 JSON.parse 成功的"（剥围栏也算）。
 * 截断场景优先用"从第一个括号到结尾"的候选，否则尾部 tag 会被丢掉。
 */
function parseForgeJson(raw) {
  const fenced = extractFenced(raw)
  const source = fenced.text
  if (source === '') return { value: undefined, repaired: fenced.repaired, error: '输出为空' }

  const direct = tryParse(source)
  if (direct.ok === true) return { value: direct.value, repaired: fenced.repaired, error: undefined }

  const start = firstBrace(source)
  const fromBrace = start > 0 ? source.slice(start) : source
  const trimmed = trimToLastJson(fromBrace)
  const candidates = []
  for (const candidate of [fromBrace, trimmed]) {
    if (candidate !== '' && candidates.includes(candidate) === false) candidates.push(candidate)
  }
  for (const candidate of candidates) {
    const hit = tryParse(candidate)
    if (hit.ok === true) return { value: hit.value, repaired: true, error: undefined }
  }
  let message = direct.message
  for (const candidate of candidates) {
    const hit = tryParse(repairJsonText(candidate))
    if (hit.ok === true) return { value: hit.value, repaired: true, error: undefined }
    message = hit.message
  }
  return { value: undefined, repaired: true, error: message }
}

function pickPositive(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value
  if (!isRecord(value)) return []
  const candidates = [value.positive, value.positive_tags, value.positive_tag, value.tags, value.prompt, value.p]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return []
}

function pickNegative(value) {
  if (!isRecord(value)) return []
  const candidates = [value.negative, value.negative_tags, value.negative_prompt, value.n]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return []
}

function pickNotes(value) {
  if (!isRecord(value)) return undefined
  const raw = value.notes ?? value.note ?? value.comment
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text === '' ? undefined : text.slice(0, 500)
}

function mergeUsage(target, usage) {
  if (!isRecord(usage)) return
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
  if (typeof input === 'number' && Number.isFinite(input)) target.inputTokens = input
  if (typeof output === 'number' && Number.isFinite(output)) target.outputTokens = output
}

/** 单个 tag 的最终写法。plain 语法丢掉权重；comfy/a1111 用 (tag:1.2)。 */
function formatEntry(tag, weight, syntax) {
  if (syntax === 'plain') return tag
  const w = clampNumber(weight, 0.1, 2.5, 1)
  if (Math.abs(w - 1) < 0.005) return tag
  return '(' + tag + ':' + trimNumber(w) + ')'
}

/**
 * @param {{ config?: object, llm?: object, tags?: object, logger?: object, dir?: string }} deps
 */
export function createForge({ config, llm, tags, logger, dir } = {}) {
  const cfg = isRecord(config) ? config : {}
  const log = isRecord(logger) ? logger : { info() {}, warn() {}, error() {} }
  const dataDir = typeof dir === 'string' && dir !== '' ? dir : fallbackDir()
  const historyFile = path.join(dataDir, 'history.json')

  const promptCache = new Map()
  let historyRows
  // 三道本地后处理（词形修复 / 中文姿势意图 / 去重合序）都靠标签索引，懒建一次就够。
  let repairer
  let postProcessor

  function getRepairer() {
    if (repairer === undefined) {
      try {
        repairer = tags !== undefined && tags !== null ? createRepairer({ tags, logger: log }) : null
      } catch (error) {
        log.warn('词形修复器创建失败，本次跳过：' + (error instanceof Error ? error.message : String(error)))
        repairer = null
      }
    }
    return repairer
  }

  function getPostProcessor() {
    if (postProcessor === undefined) {
      try {
        postProcessor = createPostProcessor({ tags, logger: log })
      } catch (error) {
        log.warn('后处理管线创建失败，本次跳过：' + (error instanceof Error ? error.message : String(error)))
        postProcessor = null
      }
    }
    return postProcessor
  }

  /** 把后处理管线的 change 列表压成一句人话（只报用户看得懂的那几类）。 */
  function summarizeChanges(changes) {
    const label = { dedupe: '去掉重复/同义', superset: '上位词降权', fill: '补主体', trim: '裁掉超量' }
    const counts = new Map()
    for (const item of changes) {
      const kind = item !== null && typeof item === 'object' ? item.kind : undefined
      if (kind === undefined || label[kind] === undefined) continue
      if (item.reason === 'unmatched') continue
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    if (counts.size === 0) return ''
    return [...counts].map(([kind, n]) => label[kind] + (n > 1 ? '×' + n : '')).join('、')
  }

  /**
   * 本地补进来的行（比如自动补的 1girl）没有中文名，中英对照框会缺一格。
   * 这里回查一次标签库把中文补上，查不到就留空（对照框会只显示 tag）。
   */
  async function withCn(rows) {
    if (tags === undefined || tags === null || typeof tags.canonicalize !== 'function') return rows
    const out = []
    for (const row of rows) {
      if (typeof row.cn === 'string' && row.cn !== '') {
        out.push(row)
        continue
      }
      let cn = ''
      try {
        const hit = await tags.canonicalize(row.tag, { syntax: cfg.tags?.weightSyntax ?? 'comfy' })
        if (hit !== null && typeof hit === 'object' && typeof hit.cn === 'string') cn = hit.cn
      } catch (error) {
        log.warn('补中文名失败：' + (error instanceof Error ? error.message : String(error)))
      }
      out.push(cn === '' ? row : { ...row, cn })
    }
    return out
  }

  /**
   * 整理管线会把库里没有的词直接丢掉（免得污染 prompt），但那等于把用户看得见的东西
   * 静悄悄删了。这里把未收录的行按原来的相对位置插回去：用户自己删才叫删。
   */
  function restoreUnmatched(postRows, snapshot) {
    const position = new Map()
    snapshot.forEach((row, index) => { position.set(String(row.tag).toLowerCase(), index) })
    const present = new Set(postRows.map(row => String(row.tag).toLowerCase()))
    const missing = snapshot
      .map((row, index) => ({ row, index }))
      .filter(item => item.row.matched === false && present.has(String(item.row.tag).toLowerCase()) === false)
    if (missing.length === 0) return postRows

    const out = postRows.slice()
    for (const item of missing) {
      let at = out.length
      for (let index = 0; index < out.length; index++) {
        const origin = position.get(String(out[index].tag).toLowerCase())
        if (origin !== undefined && origin > item.index) {
          at = index
          break
        }
      }
      out.splice(at, 0, item.row)
    }
    return out
  }

  function keepCount() {
    const raw = cfg.ui?.keepHistory
    const n = Number.parseInt(String(raw ?? 20), 10)
    if (!Number.isFinite(n)) return 20
    return Math.min(200, Math.max(0, n))
  }

  /** 本次调用生效的破甲档：合法 options.purgeLevel 覆盖 config.purge.level，不写回 settings。 */
  function resolveLevel(override) {
    const wanted = typeof override === 'string' ? override.trim().toLowerCase() : ''
    if (PURGE_LEVEL_SET.has(wanted)) return wanted
    const base = typeof cfg.purge?.level === 'string' ? cfg.purge.level.trim().toLowerCase() : ''
    return PURGE_LEVEL_SET.has(base) ? base : 'full'
  }

  function cfgForLevel(level) {
    const purge = isRecord(cfg.purge) ? cfg.purge : {}
    if (purge.level === level) return cfg
    return { ...cfg, purge: { ...purge, level } }
  }

  /** system 提示词按档位缓存（面板反复点不同档位不用重建）。 */
  function promptPair(level) {
    const key = JSON.stringify([cfg.purge ?? null, cfg.tags ?? null, level])
    const hit = promptCache.get(key)
    if (hit !== undefined) return hit
    const scoped = cfgForLevel(level)
    const pair = {
      prompt: buildForgeSystemPrompt(scoped),
      preview: buildForgeSystemPrompt(scoped, { examples: false }),
    }
    promptCache.set(key, pair)
    if (promptCache.size > 16) promptCache.delete(promptCache.keys().next().value)
    return pair
  }

  function fullPrompt(level) {
    return promptPair(resolveLevel(level)).prompt
  }

  function loadHistory() {
    if (Array.isArray(historyRows)) return historyRows
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
      historyRows = Array.isArray(parsed) ? parsed.filter(isRecord) : []
    } catch {
      historyRows = []
    }
    return historyRows
  }

  function pushHistory(entry) {
    const keep = keepCount()
    if (keep <= 0) return
    const rows = loadHistory()
    rows.unshift(entry)
    if (rows.length > keep) rows.length = keep
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(historyFile, JSON.stringify(rows, null, 2), 'utf8')
    } catch (error) {
      log.warn('history.json 写入失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  function normalizeOptions(options) {
    const input = isRecord(options) ? options : {}
    const standardsRaw = Array.isArray(input.standards) ? input.standards : cfg.tags?.standards
    const standardsList = (Array.isArray(standardsRaw) ? standardsRaw : DEFAULT_STANDARDS)
      .map(v => String(v).toLowerCase())
      .filter(v => v === 'wd' || v === 'camie')
    const syntaxRaw = input.syntax ?? cfg.tags?.weightSyntax
    const syntax = syntaxRaw === 'plain' || syntaxRaw === 'a1111' || syntaxRaw === 'comfy' ? syntaxRaw : 'comfy'
    const maxTagsRaw = input.maxTags ?? cfg.tags?.maxTags
    const maxTags = clampNumber(maxTagsRaw, 8, MAX_POSITIVE_HARD_CAP, 40)
    return {
      standards: standardsList.length > 0 ? standardsList : DEFAULT_STANDARDS.slice(),
      syntax,
      maxTags: Math.round(maxTags),
      negative: typeof input.negative === 'string' ? input.negative.trim() : '',
      notes: typeof input.notes === 'string' ? input.notes.trim() : '',
      model: typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : String(cfg.llm?.model ?? 'deepseek-v4.1-flash'),
      provider: typeof input.provider === 'string' && input.provider.trim() !== '' ? input.provider.trim() : String(cfg.llm?.provider ?? 'opencode-go'),
      maxTokens: Math.round(clampNumber(input.maxTokens ?? cfg.llm?.maxTokens, 256, 16000, DEFAULT_MAX_TOKENS)),
      temperature: clampNumber(input.temperature, 0, 2, DEFAULT_TEMPERATURE),
      reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort !== ''
        ? input.reasoningEffort
        : (typeof cfg.llm?.reasoningEffort === 'string' && cfg.llm.reasoningEffort !== '' ? cfg.llm.reasoningEffort : undefined),
      timeoutMs: clampTimeout(input.timeoutMs ?? cfg.llm?.timeoutMs),
      purgeLevel: resolveLevel(input.purgeLevel),
    }
  }

  function buildUserPrompt(text, opts, candidates) {
    const lines = [
      '【画面描述】',
      text,
      '',
      '【本次要求】',
      '- 标准：' + opts.standards.join(' + '),
      '- 正向 tag 上限：' + opts.maxTags + ' 条',
      '- 权重语法：' + opts.syntax,
    ]
    if (opts.negative !== '') lines.push('- 必须并入 negative 的额外负向词：' + opts.negative)
    if (opts.notes !== '') lines.push('- 额外说明：' + opts.notes)
    // RAG：本地词库按白话检索出的真 tag，直接给模型抄，比它自己回忆拼写靠谱。
    if (Array.isArray(candidates) && candidates.length > 0) {
      lines.push(
        '',
        '【本地词库候选（这些是库里真有的词，描述对得上就直接用，拼写照抄）】',
        candidates.map(item => (typeof item.cn === 'string' && item.cn !== '' ? item.tag + '（' + item.cn + '）' : item.tag)).join('、'),
      )
    }
    lines.push('', '只输出 JSON 对象。')
    return lines.join('\n')
  }

  /**
   * 拉一次 llm.stream：拼 text-delta，abortController + timeoutMs 兜底，
   * finish kind=error 时把 failure.code 当 error。
   */
  async function collect(streamFn, options) {
    const controller = new AbortController()
    const parts = []
    const usage = {}
    let failure
    let timedOut = false
    let cancelled = false
    let truncated = false

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    const onOuterAbort = () => {
      cancelled = true
      controller.abort()
    }
    if (options.signal !== undefined && options.signal !== null) {
      if (options.signal.aborted === true) {
        clearTimeout(timer)
        return { text: '', error: 'aborted', message: '已取消。' }
      }
      options.signal.addEventListener('abort', onOuterAbort, { once: true })
    }

    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.code = 'aborted'
        reject(error)
      }, { once: true })
    })

    let iterator
    try {
      const iterable = streamFn({
        provider: options.provider,
        model: options.model,
        // 宿主 provider 需要路由会话 id（opencode-go 少这个头会 400 MissingSessionID）
        ...options.sessionId === undefined || options.sessionId === '' ? {} : { sessionId: options.sessionId },
        system: options.system,
        messages: options.messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        signal: controller.signal,
      })
      if (iterable === null || typeof iterable !== 'object') {
        return { text: '', error: 'bad-llm', message: 'llm.stream 没有返回可迭代的流。' }
      }
      iterator = typeof iterable[Symbol.asyncIterator] === 'function'
        ? iterable[Symbol.asyncIterator]()
        : typeof iterable[Symbol.iterator] === 'function' ? iterable[Symbol.iterator]() : undefined
      if (iterator === undefined) return { text: '', error: 'bad-llm', message: 'llm.stream 的返回值不可迭代。' }

      for (;;) {
        const step = await Promise.race([iterator.next(), aborted])
        if (step === null || step === undefined) break
        if (step.done === true) break
        const chunk = step.value
        if (!isRecord(chunk)) continue
        const type = chunk.type
        if (type === 'text-delta') {
          if (typeof chunk.text === 'string' && chunk.text !== '') parts.push(chunk.text)
          continue
        }
        if (type === 'usage') {
          mergeUsage(usage, chunk.usage ?? chunk)
          continue
        }
        if (isRecord(chunk.usage)) mergeUsage(usage, chunk.usage)
        if (type === 'finish') {
          // 宿主两种 finish 形状都要认：{kind, failure} 和 {reason:{kind, failure}}。
          const reason = isRecord(chunk.reason) ? chunk.reason : chunk
          const kind = typeof reason.kind === 'string' ? reason.kind : undefined
          const fail = isRecord(reason.failure) ? reason.failure : isRecord(chunk.failure) ? chunk.failure : undefined
          if (kind === 'error' || kind === 'aborted') failure = fail ?? { code: kind, message: '模型调用失败（' + kind + '）。' }
          else if (kind === 'max-tokens' || kind === 'length') truncated = true
          else if (fail !== undefined) failure = fail
          break
        }
      }
    } catch (error) {
      const code = error instanceof Error && typeof error.code === 'string' ? error.code : undefined
      if (code === 'aborted') {
        // 超时 / 外部取消都会走到这里，下面统一翻译。
      } else {
        clearTimeout(timer)
        if (options.signal !== undefined && options.signal !== null) options.signal.removeEventListener('abort', onOuterAbort)
        return {
          text: parts.join(''),
          error: 'llm-error',
          message: error instanceof Error ? error.message : String(error),
          usage,
        }
      }
    } finally {
      clearTimeout(timer)
      if (options.signal !== undefined && options.signal !== null) options.signal.removeEventListener('abort', onOuterAbort)
      if (iterator !== undefined && typeof iterator.return === 'function' && (timedOut || cancelled)) {
        try {
          await Promise.race([iterator.return(), new Promise(resolve => setTimeout(resolve, 250))])
        } catch {
          // 关流失败不影响结果
        }
      }
    }

    const text = parts.join('')
    if (timedOut) {
      return {
        text,
        error: 'timeout',
        message: '模型超时（' + options.timeoutMs + 'ms）' + (failure?.code ? '：' + failure.code : ''),
        usage,
      }
    }
    if (cancelled) return { text, error: 'aborted', message: '已取消。', usage }
    if (failure !== undefined) {
      return {
        text,
        error: typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'llm-error',
        message: typeof failure.message === 'string' && failure.message !== '' ? failure.message : '模型调用失败。',
        usage,
      }
    }
    if (truncated) return { text, error: 'max-tokens', message: '模型输出被 maxTokens 截断（' + options.maxTokens + '）。', usage }
    if (text.trim() === '') return { text, error: 'empty-output', message: '模型没有返回任何内容。', usage }
    return { text, usage }
  }

  /**
   * 索引 ready() 是异步的（首次构建可能要几秒）：等最多 INDEX_WAIT_MS，
   * 没就绪/抛错都当"未校对"，只记一条 warning，绝不拖死锻造。
   */
  async function indexReady(warnings) {
    if (tags === undefined || tags === null) return false
    if (typeof tags.ready !== 'function') return true
    try {
      const stats = typeof tags.stats === 'function' ? tags.stats() : undefined
      if (isRecord(stats) && stats.ready === true) {
        // 词表是纯文本，改完不该让人重启整个 app：指纹变了就在这里重建一次（一次 stat，便宜）。
        if (typeof tags.ensureFresh === 'function') {
          const reloaded = await tags.ensureFresh()
          if (reloaded) log.info('词表有变动，已热重载标签索引')
        }
        return true
      }
      const state = await Promise.race([Promise.resolve(tags.ready()), indexWait()])
      if (state === INDEX_WAIT_TIMEOUT) {
        log.warn('标签库 ' + INDEX_WAIT_MS + 'ms 内未构建完，本次按现有（seed）索引校对')
        return true
      }
      if (state === false) {
        if (warnings.includes(COLD_INDEX_WARNING) === false) warnings.push(COLD_INDEX_WARNING)
        return false
      }
      return true
    } catch (error) {
      log.warn('标签库 ready() 失败：' + (error instanceof Error ? error.message : String(error)))
      if (warnings.includes(COLD_INDEX_WARNING) === false) warnings.push(COLD_INDEX_WARNING)
      return false
    }
  }

  /** 标签库校对：能拿到索引就校对，拿不到就当未知（matched=undefined，不误报"不在库里"）。 */
  async function canonicalizeAll(list, warnings) {
    const rawList = list.map(row => row.tag)
    if (tags === undefined || tags === null || typeof tags.canonicalizeMany !== 'function') {
      return list.map(row => ({ ...row, matched: undefined }))
    }
    const ready = await indexReady(warnings)
    if (ready === false) return list.map(row => ({ ...row, matched: undefined }))
    let canon
    try {
      canon = await tags.canonicalizeMany(rawList, { syntax: cfg.tags?.weightSyntax ?? 'comfy' })
    } catch (error) {
      log.warn('标签库校对失败：' + (error instanceof Error ? error.message : String(error)))
      if (warnings.includes(COLD_INDEX_WARNING) === false) warnings.push(COLD_INDEX_WARNING)
      return list.map(row => ({ ...row, matched: undefined }))
    }
    if (!Array.isArray(canon)) return list.map(row => ({ ...row, matched: undefined }))
    return list.map((row, index) => {
      const hit = isRecord(canon[index]) ? canon[index] : undefined
      if (hit === undefined) return { ...row, matched: undefined }
      const tag = typeof hit.tag === 'string' && hit.tag.trim() !== '' ? String(hit.tag).trim() : row.tag
      const weight = row.weight ?? (typeof hit.weight === 'number' ? hit.weight : undefined)
      return {
        raw: row.tag,
        tag,
        weight,
        matched: hit.matched,
        kind: typeof hit.kind === 'string' ? hit.kind : undefined,
        cn: typeof hit.cn === 'string' ? hit.cn : undefined,
      }
    })
  }

  function formatRows(rows, syntax) {
    if (rows.length === 0) return ''
    if (tags !== undefined && tags !== null && typeof tags.formatTagString === 'function') {
      try {
        const out = tags.formatTagString(rows.map(row => ({ tag: row.tag, weight: row.weight ?? 1 })), { syntax })
        if (typeof out === 'string' && out.trim() !== '') return out.trim()
      } catch (error) {
        log.warn('formatTagString 失败，回退内置格式化：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return rows.map(row => formatEntry(row.tag, row.weight ?? 1, syntax)).join(', ')
  }

  function dedupe(rows) {
    const seen = new Set()
    const out = []
    for (const row of rows) {
      const key = row.tag.toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
    return out
  }

  async function generate(input) {
    const startedAt = Date.now()
    const request = isRecord(input) ? input : {}
    const opts = normalizeOptions(request.options)
    const warnings = []
    const base = {
      ok: false,
      positive: '',
      negative: '',
      tags: [],
      negativeTags: [],
      standards: opts.standards,
      raw: '',
      repaired: false,
      model: opts.model,
      provider: opts.provider,
      ms: 0,
      warnings,
    }
    const fail = (error, message, extra) => ({ ...base, ...extra, ok: false, error, message, ms: Date.now() - startedAt })

    const described = typeof request.text === 'string' ? request.text.trim() : ''
    if (described === '') return fail('empty-text', '先写点什么。')

    const forgeCfg = isRecord(cfg.forge) ? cfg.forge : {}
    // 白话里点到姿势/视角时，先从本地词库捞一批"真存在的词"喂给模型（省它自己猜拼写）。
    let candidates = []
    if (forgeCfg.candidates !== false && tags !== undefined && tags !== null) {
      try {
        candidates = await selectCandidates({ described, tags, limit: forgeCfg.candidateLimit ?? 18 })
      } catch (error) {
        log.warn('候选检索失败，按无候选继续：' + (error instanceof Error ? error.message : String(error)))
        candidates = []
      }
    }

    const streamFn = llm !== undefined && llm !== null && typeof llm.stream === 'function' ? llm.stream.bind(llm) : undefined
    if (streamFn === undefined) {
      return fail('no-llm', '宿主没有 llm 服务，检查 provider 配置（settings.json 里的 llm.provider / llm.model）。')
    }

    const callOnce = budget => collect(streamFn, {
      provider: opts.provider,
      model: opts.model,
      sessionId: typeof cfg.llm?.sessionId === 'string' && cfg.llm.sessionId !== '' ? cfg.llm.sessionId : 'dsh-tagger',
      system: fullPrompt(opts.purgeLevel),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(described, opts, candidates) }] }],
      maxTokens: budget,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      signal: request.signal,
    })

    // 长描述（尤其 NSFW 细描写）会让模型推理吃掉输出预算而被截断：截断时自动把上限翻倍重试一次，
    // 别让用户对着「模型输出被截断」自己猜该调多大。
    let collected = await callOnce(opts.maxTokens)
    if (collected.error === 'max-tokens' && opts.maxTokens < MAX_TOKEN_CEILING) {
      const retryBudget = Math.min(MAX_TOKEN_CEILING, Math.round(opts.maxTokens * 2))
      log.warn('输出被 maxTokens(' + opts.maxTokens + ') 截断，用 ' + retryBudget + ' 重试一次')
      collected = await callOnce(retryBudget)
      if (collected.error !== 'max-tokens') {
        warnings.push('输出被截断过，已把上限提到 ' + retryBudget + ' 重试成功')
      }
    }

    const usage = collected.usage !== undefined && Object.keys(collected.usage).length > 0 ? collected.usage : undefined
    if (collected.error !== undefined) {
      return fail(collected.error, collected.message ?? '模型调用失败。', { raw: collected.text, usage })
    }

    const raw = collected.text
    const parsed = parseForgeJson(raw)
    if (parsed.value === undefined) {
      log.warn('JSON 修复后仍失败：' + (parsed.error ?? 'unknown'))
      return fail('bad-json', '模型没给出可解析的 JSON（已尝试修复一次）：' + (parsed.error ?? ''), { raw, repaired: true, usage })
    }

    // 负向与画质词都交给 ComfyUI 工作流内置：模型给的 negative 直接丢掉，只保留调用方显式传入的额外负向。
    const cleaned = stripQuality(normalizeList(pickPositive(parsed.value)).slice(0, MAX_POSITIVE_HARD_CAP), described)
    const positiveRaw = cleaned.rows
    if (cleaned.dropped.length > 0) {
      warnings.push('去掉画质词（由 ComfyUI 内置）：' + cleaned.dropped.join(', '))
    }
    const negativeRaw = []
    if (opts.negative !== '') {
      for (const piece of opts.negative.split(/[,\n]/)) {
        const row = normalizeEntry(piece)
        if (row !== undefined) negativeRaw.unshift(row)
      }
    }
    if (positiveRaw.length === 0) {
      return fail('empty-tags', '模型没给出正向 tag。', { raw, repaired: parsed.repaired, usage })
    }

    const warnOnce = text => {
      if (warnings.includes(text) === false) warnings.push(text)
    }

    // 三道本地处理的痕迹：面板要显示"改了什么"，用户才有据可查（也方便排查词库缺词）。
    const pipelineInfo = { repairs: [], poseHints: [], changes: [] }

    let positiveRows = await canonicalizeAll(positiveRaw, warnings)

    // ① 词形修复：模型爱写的 top_down_bottom_up / worm's-eye_view 这类"差一点就对"的词，
    //    先在本地纠回库里真词（连字符、撇号、单复数、近邻），修不上的原样留着由下面记账。
    if (forgeCfg.repair !== false) {
      const fixer = getRepairer()
      if (fixer !== null) {
        try {
          const fixed = await fixer.fix(positiveRows)
          positiveRows = fixed.rows
          pipelineInfo.repairs = fixed.fixes.map(item => ({ from: item.from, to: item.to, how: item.how }))
          if (fixed.fixes.length > 0) {
            warnOnce('词形修正：' + fixed.fixes.map(item => item.from + ' → ' + item.to).join('、'))
          }
        } catch (error) {
          log.warn('词形修复失败，按原样继续：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
    positiveRows = dedupe(positiveRows)

    // 未收录的先记账——整理阶段会把它们摘掉，别让它们无声消失。
    for (const row of positiveRows) {
      if (row.matched === false) warnOnce((row.raw ?? row.tag) + ' 不在库里')
    }

    // ② 中文姿势/视角意图：白话里说「跪趴」「从下面看」，模型常漏，本地补（只补缺失，不动已有词序）。
    if (forgeCfg.poseHints !== false) {
      try {
        const hints = detectPoseHints(described)
        if (hints.length > 0) {
          const applied = applyPoseHints(positiveRows, hints)
          if (applied.added.length > 0) {
            pipelineInfo.poseHints = applied.added.map(item => ({ tag: item.tag, weight: item.weight, hit: item.key }))
            positiveRows = dedupe(await canonicalizeAll(applied.rows, warnings))
            warnOnce('补了话里的姿势/视角：' + applied.added.map(item => item.tag).join(', '))
          }
        }
      } catch (error) {
        log.warn('姿势意图识别失败，跳过：' + (error instanceof Error ? error.message : String(error)))
      }
    }

    // ③ 去重合序：真同义只留一个、上位词降权、按 13 段排词序、超上限按段优先级裁剪。
    if (forgeCfg.postprocess !== false) {
      const pipeline = getPostProcessor()
      if (pipeline !== null) {
        try {
          const snapshot = positiveRows.slice()
          const post = pipeline.apply(positiveRows, {
            described,
            maxTags: opts.maxTags,
            syntax: opts.syntax,
            standards: opts.standards,
          })
          positiveRows = await withCn(restoreUnmatched(post.rows, snapshot))
          // 面板只需要"看得见的动作"：排序/分桶是内部步骤，unmatched 已经单独进 warnings，都不列。
          pipelineInfo.changes = post.changes
            .filter(item => item.kind !== 'order' && item.kind !== 'buckets' && item.reason !== 'unmatched')
            .map(item => ({ kind: item.kind, tag: item.tag, ...item.reason === undefined ? {} : { reason: item.reason } }))
          const summary = summarizeChanges(post.changes)
          if (summary !== '') warnOnce('整理：' + summary)
        } catch (error) {
          log.warn('后处理失败，按原样继续：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }

    let negativeRows = dedupe(await canonicalizeAll(negativeRaw, warnings))

    if (positiveRows.length > opts.maxTags) {
      warnOnce('正向 ' + positiveRows.length + ' 条超过上限，已截到 ' + opts.maxTags + ' 条')
      positiveRows.length = opts.maxTags
    }

    for (const row of negativeRows) {
      if (row.matched === false) warnOnce((row.raw ?? row.tag) + ' 不在库里')
    }

    // 索引没就绪时 canonicalize 会全判"没匹上"，这里补一句人话解释，别让面板看到一片红。
    try {
      const stats = tags !== undefined && tags !== null && typeof tags.stats === 'function' ? tags.stats() : undefined
      if (isRecord(stats) && stats.ready === false) warnings.push('标签库尚未就绪，本条未做全量校对')
    } catch {
      // stats() 炸了不影响锻造结果
    }

    const keep = row => ({ tag: row.tag, weight: clampNumber(row.weight ?? 1, 0.1, 2.5, 1), ...row.kind === undefined ? {} : { kind: row.kind }, ...row.cn === undefined ? {} : { cn: row.cn } })
    const resultTags = positiveRows.map(keep)
    const resultNegative = negativeRows.map(keep)

    const positive = formatRows(resultTags, opts.syntax)
    const negative = formatRows(resultNegative, opts.syntax)
    const notes = pickNotes(parsed.value)

    const result = {
      ok: true,
      positive,
      negative,
      tags: resultTags,
      negativeTags: resultNegative,
      standards: opts.standards,
      purgeLevel: opts.purgeLevel,
      raw,
      repaired: parsed.repaired,
      model: opts.model,
      provider: opts.provider,
      ms: Date.now() - startedAt,
      warnings,
      pipeline: pipelineInfo,
      ...usage === undefined ? {} : { usage },
      ...notes === undefined ? {} : { notes },
    }

    pushHistory({
      id: 'f' + startedAt.toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date(startedAt).toISOString(),
      text: described,
      positive,
      negative,
      ms: result.ms,
      model: opts.model,
      ok: true,
    })

    return result
  }

  async function models(provider) {
    if (llm === undefined || llm === null || typeof llm.listModels !== 'function') return []
    const target = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : String(cfg.llm?.provider ?? 'opencode-go')
    try {
      const rows = await llm.listModels(target)
      if (!Array.isArray(rows)) return []
      return rows
        .map(row => {
          const id = isRecord(row) && typeof row.id === 'string' ? row.id : undefined
          if (id === undefined || id === '') return undefined
          const label = isRecord(row) && typeof row.name === 'string' && row.name !== '' ? row.name : undefined
          return label === undefined ? { id } : { id, label }
        })
        .filter(row => row !== undefined)
    } catch (error) {
      log.warn('listModels(' + target + ') 失败：' + (error instanceof Error ? error.message : String(error)))
      return []
    }
  }

  function systemPrompt(options) {
    const pair = promptPair(resolveLevel())
    const preview = isRecord(options) && options.preview === true
    return preview ? pair.preview : pair.prompt
  }

  function agentDirective() {
    return purgeAgentDirective(cfg)
  }

  function purgeState() {
    return purgeStateOf(cfg)
  }

  function history() {
    return loadHistory().slice()
  }

  function refreshPurge() {
    promptCache.clear()
  }

  return {
    generate,
    models,
    systemPrompt,
    agentDirective,
    purgeState,
    history,
    refreshPurge,
    /** 供内部/测试用：当前生效配置的快照。 */
    config: cfg,
    levels: PURGE_LEVELS.slice(),
  }
}
