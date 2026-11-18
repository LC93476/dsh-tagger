// plan: 精修引擎 —— 模型只出 JSON 差分（add / remove / weights / order），落到原串上归一化，绝不重跑整串。
/**
 * 二次精修（refine）：已经锻造好的标签串 → 再问一次模型，按指令增量增删 / 调权重。
 *
 * 存在的理由：锻造是「一次成型」，但人看图之前往往还有具体想法（再加点水光、把逆光去掉、
 * 同一角色换套衣服）。让模型重跑一遍会丢掉已经对的部分，所以这里只做**增量**：
 * 模型只允许输出 add / remove / weights 三种操作（外加可选 order），落到原串上再统一归一化。
 *
 * 契约（与 docs/API.md 一致，不要改字段名）：
 *   refine({ positive, negative?, instruction, mode?, options? }) → {
 *     ok, positive, negative, tags: [{ tag, weight, cn }],
 *     delta: { added: [], removed: [], weighted: [{ tag, from, to }] },
 *     ops, notes, ms, model, purgeLevel, warnings: []
 *   }
 *
 * mode: 'add'（只加）| 'edit'（可替换）| 'prune'（去冗余）| 'weights'（只调权重）
 *
 * 铁律：refine 永远返回结果对象，不抛。调用方（HTTP / MCP / 面板）只看 ok 与 error。
 */
import {
  PURGE_LEVELS,
  buildRefineSystemPrompt,
} from './purge.js'

const MODES = ['add', 'edit', 'prune', 'weights']
const MODE_SET = new Set(MODES)
const PURGE_LEVEL_SET = new Set(PURGE_LEVELS)

const DEFAULT_PROVIDER = 'opencode-go'
const DEFAULT_MODEL = 'deepseek-v4.1-flash'
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_TEMPERATURE = 0.4
const DEFAULT_MAX_TOKENS = 3000
const DEFAULT_MAX_NEW_TAGS = 12
const MAX_NEW_CEILING = 40
const MAX_TOKEN_CEILING = 16000
const MIN_WEIGHT = 0.1
const MAX_WEIGHT = 2.5
const INDEX_WAIT_MS = 3000
const INDEX_WAIT_TIMEOUT = '\u0000index-wait'
const COLD_INDEX_WARNING = '标签库未就绪，未校对'

/** 四种模式各自允许模型做什么 —— 直接写进 user prompt，别让模型自己猜。 */
const MODE_RULES = {
  add: '补齐模式：在现有串上补缺失的标签；**不动**已有标签、不改已有权重、不删任何标签（remove 留空）。',
  edit: '改写模式：按指令换画面内容 —— 删掉与新画面冲突的标签（remove），补新标签（add）；没冲突的标签不动。',
  prune: '去冗余模式：只删冗余 / 互相冲突的标签（remove）；**不新增**（add 必须是空数组），不动权重。',
  weights: '权重模式：只调整现有标签的权重（weights）；**不新增也不删除**，标签集合与顺序都不变。',
}

// ---------------------------------------------------------------- 小工具

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
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

/** 比较用的归一化键：大小写、空格 / 下划线、首尾括号都不敏感。 */
function tagKey(raw) {
  const text = cleanTag(String(raw ?? '')).toLowerCase()
  return text.replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '')
}

/** 单个 tag 的最终写法（与 forge 的 formatEntry 一致）。 */
function formatEntry(tag, weight, syntax) {
  if (syntax === 'plain') return tag
  const w = clampNumber(weight, MIN_WEIGHT, MAX_WEIGHT, 1)
  if (Math.abs(w - 1) < 0.005) return tag
  return '(' + tag + ':' + trimNumber(w) + ')'
}

function emptyDelta() {
  return { added: [], removed: [], weighted: [] }
}

function pushWarn(list, message) {
  const text = String(message ?? '').trim()
  if (text === '' || list.includes(text)) return
  list.push(text)
}

/** 数组 / 单个字符串 / {tag} 对象都能吃成字符串列表。 */
function toTagList(value) {
  const out = []
  const push = item => {
    if (typeof item === 'string') {
      out.push(item)
      return
    }
    if (!isRecord(item)) return
    const raw = item.tag ?? item.name ?? item.word
    if (typeof raw === 'string') out.push(raw)
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (typeof value === 'string') value.split(/[,\n]/).forEach(push)
  else if (isRecord(value)) Object.keys(value).forEach(push)
  return out
}

/** weights 允许 [{tag, weight}] / ['(smile:1.2)'] / {"smile": 1.2} 三种写法。 */
function toWeightList(value) {
  const rows = []
  const push = item => {
    if (typeof item === 'string') {
      const split = splitWeight(item)
      if (split.tag !== '' && split.weight !== undefined) rows.push({ tag: split.tag, weight: split.weight })
      return
    }
    if (!isRecord(item)) return
    const raw = item.tag ?? item.name ?? item.word
    if (typeof raw !== 'string') return
    const rawWeight = item.weight ?? item.w ?? item.to ?? item.value
    const weight = typeof rawWeight === 'number' ? rawWeight : Number.parseFloat(String(rawWeight ?? ''))
    if (!Number.isFinite(weight)) return
    const split = splitWeight(raw)
    rows.push({ tag: split.tag === '' ? cleanTag(raw) : split.tag, weight })
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (isRecord(value)) {
    for (const [tag, weight] of Object.entries(value)) push({ tag, weight })
  }
  return rows
}

/** 去重（按 tagKey），保留首次出现的原写法。 */
function dedupeStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const text = cleanTag(item)
    const key = tagKey(text)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

/** 按模型给的 order 重排（只认能对上的，剩下的按原顺序接在末尾）。 */
function reorderRows(rows, order) {
  const byKey = new Map()
  for (const row of rows) {
    const key = tagKey(row.tag)
    if (!byKey.has(key)) byKey.set(key, row)
  }
  const used = new Set()
  const out = []
  for (const raw of order) {
    const key = tagKey(raw)
    const row = byKey.get(key)
    if (row === undefined || used.has(key)) continue
    used.add(key)
    out.push(row)
  }
  for (const row of rows) {
    const key = tagKey(row.tag)
    if (used.has(key)) continue
    used.add(key)
    out.push(row)
  }
  return out
}

function fallbackParseList(text) {
  const out = []
  for (const piece of String(text ?? '').split(',')) {
    const parsed = splitWeight(piece)
    if (parsed.tag !== '') out.push(parsed)
  }
  return out
}

// ---------------------------------------------------------------- JSON 容错（与 forge 同一套思路）

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

function firstBrace(text) {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (objStart >= 0 && arrStart >= 0) return Math.min(objStart, arrStart)
  return Math.max(objStart, arrStart)
}

function trimToLastJson(text) {
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end < 0) return text
  return text.slice(0, end + 1)
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: msgOf(error) }
  }
}

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

/** 剥围栏 → 直解 → 去前后废话 → 结构性修复一次。 */
function parseRefineJson(raw) {
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

// ---------------------------------------------------------------- 工厂

/**
 * @param {{ config?: object, llm?: object, tags?: object, logger?: object, spi?: object }} deps
 */
export function createRefiner({ config, llm, tags, logger, spi } = {}) {
  const cfg = isRecord(config) ? config : {}
  const log = isRecord(logger) ? logger : { info() {}, warn() {}, error() {} }
  const promptCache = new Map()

  function syntaxOf() {
    const syntax = cfg.tags?.weightSyntax
    return syntax === 'plain' || syntax === 'a1111' || syntax === 'comfy' ? syntax : 'comfy'
  }

  function resolveMode(value) {
    const wanted = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (MODE_SET.has(wanted)) return wanted
    const base = typeof cfg.refine?.mode === 'string' ? cfg.refine.mode.trim().toLowerCase() : ''
    return MODE_SET.has(base) ? base : 'add'
  }

  /** 本次生效的破甲档：合法 options.purgeLevel 覆盖 config.purge.level，不写回 settings。 */
  function resolveLevel(override) {
    const wanted = typeof override === 'string' ? override.trim().toLowerCase() : ''
    if (PURGE_LEVEL_SET.has(wanted)) return wanted
    const base = typeof cfg.purge?.level === 'string' ? cfg.purge.level.trim().toLowerCase() : ''
    return PURGE_LEVEL_SET.has(base) ? base : 'full'
  }

  /** system 提示词按档位缓存（反复精修不用每次重建几千字）。 */
  function systemPrompt(level) {
    const key = JSON.stringify([cfg.purge ?? null, cfg.tags ?? null, level])
    const hit = promptCache.get(key)
    if (hit !== undefined) return hit
    const purge = isRecord(cfg.purge) ? cfg.purge : {}
    const text = buildRefineSystemPrompt({ ...cfg, purge: { ...purge, level } })
    promptCache.set(key, text)
    if (promptCache.size > 8) promptCache.delete(promptCache.keys().next().value)
    return text
  }

  function normalizeOptions(options, mode) {
    const input = isRecord(options) ? options : {}
    const refineCfg = isRecord(cfg.refine) ? cfg.refine : {}
    return {
      mode,
      syntax: syntaxOf(),
      maxNewTags: Math.round(clampNumber(input.maxNewTags ?? refineCfg.maxNewTags, 1, MAX_NEW_CEILING, DEFAULT_MAX_NEW_TAGS)),
      temperature: clampNumber(input.temperature ?? refineCfg.temperature, 0, 2, DEFAULT_TEMPERATURE),
      maxTokens: Math.round(clampNumber(input.maxTokens ?? refineCfg.maxTokens, 256, MAX_TOKEN_CEILING, DEFAULT_MAX_TOKENS)),
      timeoutMs: clampTimeout(input.timeoutMs ?? refineCfg.timeoutMs),
      keepOrder: (input.keepOrder ?? refineCfg.keepOrder) !== false,
      model: typeof cfg.llm?.model === 'string' && cfg.llm.model.trim() !== '' ? String(cfg.llm.model) : DEFAULT_MODEL,
      provider: typeof cfg.llm?.provider === 'string' && cfg.llm.provider.trim() !== '' ? String(cfg.llm.provider) : DEFAULT_PROVIDER,
      reasoningEffort: typeof cfg.llm?.reasoningEffort === 'string' && cfg.llm.reasoningEffort !== '' ? cfg.llm.reasoningEffort : undefined,
      sessionId: typeof cfg.llm?.sessionId === 'string' && cfg.llm.sessionId !== '' ? cfg.llm.sessionId : 'dsh-tagger',
      purgeLevel: resolveLevel(input.purgeLevel),
      raw: input,
    }
  }

  /** 索引 ready() 是异步的：等最多 INDEX_WAIT_MS，没就绪只记一条 warning，绝不拖死精修。 */
  async function indexReady(warnings) {
    if (tags === undefined || tags === null) return false
    if (typeof tags.ready !== 'function') return true
    try {
      const stats = typeof tags.stats === 'function' ? tags.stats() : undefined
      if (isRecord(stats) && stats.ready === true) {
        if (typeof tags.ensureFresh === 'function') {
          const reloaded = await tags.ensureFresh()
          if (reloaded) log.info('[tagger] 词表有变动，已热重载标签索引')
        }
        return true
      }
      const state = await Promise.race([Promise.resolve(tags.ready()), indexWait()])
      if (state === INDEX_WAIT_TIMEOUT) {
        log.warn('[tagger] 标签库 ' + INDEX_WAIT_MS + 'ms 内未构建完，本次按现有索引校对')
        return true
      }
      if (state === false) {
        pushWarn(warnings, COLD_INDEX_WARNING)
        return false
      }
      return true
    } catch (error) {
      log.warn('[tagger] 标签库 ready() 失败：' + msgOf(error))
      pushWarn(warnings, COLD_INDEX_WARNING)
      return false
    }
  }

  /** add 增量走标签库校验；库不可用时原样保留并记账（否则精修在冷启动阶段等于废掉）。 */
  async function canonicalizeAdd(list, warnings) {
    const passthrough = () => list.map(raw => ({ raw, tag: cleanTag(raw), weight: 1, matched: undefined, cn: '' }))
    if (tags === undefined || tags === null || typeof tags.canonicalizeMany !== 'function') {
      pushWarn(warnings, '标签库不可用，新增标签未校对')
      return passthrough()
    }
    const ready = await indexReady(warnings)
    if (ready === false) return passthrough()
    let canon
    try {
      canon = await tags.canonicalizeMany(list, { syntax: syntaxOf() })
    } catch (error) {
      log.warn('[tagger] 标签库校对失败：' + msgOf(error))
      pushWarn(warnings, COLD_INDEX_WARNING)
      return passthrough()
    }
    if (!Array.isArray(canon)) return passthrough()
    return list.map((raw, index) => {
      const hit = isRecord(canon[index]) ? canon[index] : undefined
      if (hit === undefined) return { raw, tag: cleanTag(raw), weight: 1, matched: undefined, cn: '' }
      const tag = typeof hit.tag === 'string' && hit.tag.trim() !== '' ? String(hit.tag).trim() : cleanTag(raw)
      return {
        raw,
        tag,
        weight: typeof hit.weight === 'number' && Number.isFinite(hit.weight) ? hit.weight : 1,
        matched: hit.matched,
        cn: typeof hit.cn === 'string' ? hit.cn : '',
      }
    })
  }

  /** 原串解析：优先用标签库的 parseTagString（认全 (tag:1.2) / tag::1.2 / {{tag}}）。 */
  function parseBaseList(text) {
    if (String(text ?? '').trim() === '') return []
    let rows
    if (tags !== undefined && tags !== null && typeof tags.parseTagString === 'function') {
      try {
        rows = tags.parseTagString(String(text))
      } catch (error) {
        log.warn('[tagger] parseTagString 失败，回退内置解析：' + msgOf(error))
        rows = undefined
      }
    }
    if (!Array.isArray(rows)) rows = fallbackParseList(text)
    const out = []
    for (const row of rows) {
      const tag = cleanTag(row?.tag)
      if (tag === '') continue
      const weight = typeof row?.weight === 'number' && Number.isFinite(row.weight) ? row.weight : 1
      out.push({ tag, weight: clampNumber(weight, MIN_WEIGHT, MAX_WEIGHT, 1) })
    }
    return out
  }

  function formatRows(rows, syntax) {
    if (rows.length === 0) return ''
    if (tags !== undefined && tags !== null && typeof tags.formatTagString === 'function') {
      try {
        const out = tags.formatTagString(rows.map(row => ({ tag: row.tag, weight: row.weight ?? 1 })), { syntax })
        if (typeof out === 'string' && out.trim() !== '') return out.trim()
      } catch (error) {
        log.warn('[tagger] formatTagString 失败，回退内置格式化：' + msgOf(error))
      }
    }
    return rows.map(row => formatEntry(row.tag, row.weight ?? 1, syntax)).join(', ')
  }

  /** 结果补中文名 / 词性（只读，不改用户已有写法）。 */
  async function enrich(rows) {
    if (rows.length === 0) return
    if (tags === undefined || tags === null || typeof tags.canonicalizeMany !== 'function') return
    try {
      const canon = await tags.canonicalizeMany(rows.map(row => row.tag), { syntax: syntaxOf() })
      if (!Array.isArray(canon)) return
      for (let i = 0; i < rows.length; i += 1) {
        const hit = isRecord(canon[i]) ? canon[i] : undefined
        if (hit === undefined) continue
        if (typeof hit.cn === 'string' && hit.cn !== '') rows[i].cn = hit.cn
        if (typeof hit.kind === 'string' && hit.kind !== '' && hit.kind !== 'unknown') rows[i].kind = hit.kind
      }
    } catch (error) {
      log.warn('[tagger] 结果补中文名失败：' + msgOf(error))
    }
  }

  function buildUserPrompt({ positiveText, negativeText, instruction, mode, opts }) {
    const lines = [
      '【现有正向标签串】',
      positiveText === '' ? '（空串 —— 按描述补出画面需要的标签）' : positiveText,
      '',
      '【现有负向标签串】',
      negativeText === '' ? '（无）' : negativeText,
      '',
      '【精修模式】' + mode + ' —— ' + MODE_RULES[mode],
      '【新增上限】本次最多新增 ' + opts.maxNewTags + ' 条',
      '【权重语法】' + opts.syntax,
    ]
    if (mode === 'add') lines.push('【注意】add 里不要出现已经在串里的词（含同义 / 下划线变体）。')
    if (mode === 'weights') lines.push('【注意】weights 里的 tag 必须与现有串里的写法一致。')
    if (opts.keepOrder === false) lines.push('【顺序】允许重排：需要换序时用 order 数组给出最终词序。')
    else lines.push('【顺序】保持现有标签顺序，新标签追加到末尾。')
    lines.push('', '【本次要求】', instruction, '', '只输出 JSON 差分对象。')
    return lines.join('\n')
  }

  function indexWait() {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(INDEX_WAIT_TIMEOUT), INDEX_WAIT_MS)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /** 拉一次 llm.stream：拼 text-delta，AbortController + timeoutMs 兜底，finish kind=error 透出 failure.code。 */
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
        ...options.sessionId === undefined || options.sessionId === '' ? {} : { sessionId: options.sessionId },
        system: options.system,
        messages: options.messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        signal: controller.signal,
      })
      if (iterable === null || typeof iterable !== 'object') {
        clearTimeout(timer)
        return { text: '', error: 'bad-llm', message: 'llm.stream 没有返回可迭代的流。' }
      }
      iterator = typeof iterable[Symbol.asyncIterator] === 'function'
        ? iterable[Symbol.asyncIterator]()
        : typeof iterable[Symbol.iterator] === 'function' ? iterable[Symbol.iterator]() : undefined
      if (iterator === undefined) {
        clearTimeout(timer)
        return { text: '', error: 'bad-llm', message: 'llm.stream 的返回值不可迭代。' }
      }

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
          if (kind === 'error' || kind === 'aborted') {
            failure = fail ?? { code: kind, message: '模型调用失败（' + kind + '）。' }
          } else if (kind === 'max-tokens' || kind === 'length') truncated = true
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
        return { text: parts.join(''), error: 'llm-error', message: msgOf(error), usage }
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

  /** 一次精修的全部业务逻辑；外面统一兜异常 + SPI 出口。 */
  async function runOnce(request, startedAt) {
    const warnings = []
    const instruction = typeof request.instruction === 'string' ? request.instruction.trim() : ''
    const mode = resolveMode(request.mode)
    const opts = normalizeOptions(request.options, mode)
    const basePositive = typeof request.positive === 'string' ? request.positive.trim() : ''
    const baseNegative = typeof request.negative === 'string' ? request.negative.trim() : ''

    const base = {
      ok: false,
      positive: basePositive,
      negative: baseNegative,
      mode,
      tags: [],
      delta: emptyDelta(),
      ops: 0,
      notes: '',
      ms: 0,
      model: opts.model,
      provider: opts.provider,
      purgeLevel: opts.purgeLevel,
      warnings,
    }
    const fail = (error, message, extra) => ({
      ...base,
      ...extra ?? {},
      ok: false,
      error,
      message,
      ms: Date.now() - startedAt,
      warnings,
    })

    if (instruction === '') return fail('empty-instruction', '写一句想加/想改什么。')
    // add / edit 允许空串起步；prune / weights 没有原串就没有可操作对象。
    if (basePositive === '' && mode !== 'add' && mode !== 'edit') {
      return fail('empty-positive', '先有标签串才能二次精修。')
    }

    const streamFn = llm !== undefined && llm !== null && typeof llm.stream === 'function' ? llm.stream.bind(llm) : undefined
    if (streamFn === undefined) {
      return fail('no-llm', '宿主没有 llm 服务，检查 provider 配置（settings.json 里的 llm.provider / llm.model）。')
    }

    const payload = { positive: basePositive, negative: baseNegative, instruction, mode, options: opts.raw }
    if (spi !== undefined && spi !== null && typeof spi.emit === 'function') {
      try {
        await spi.emit('beforeRefine', payload, { mode })
      } catch (error) {
        log.warn('[tagger] beforeRefine 钩子失败（已忽略）：' + msgOf(error))
      }
    }
    const positiveText = typeof payload.positive === 'string' ? payload.positive.trim() : basePositive
    const instructionText = typeof payload.instruction === 'string' && payload.instruction.trim() !== '' ? payload.instruction.trim() : instruction

    const baseRows = parseBaseList(positiveText)
    const baseKeys = new Map()
    for (const row of baseRows) {
      const key = tagKey(row.tag)
      if (key !== '' && baseKeys.has(key) === false) baseKeys.set(key, row)
    }

    const collected = await collect(streamFn, {
      provider: opts.provider,
      model: opts.model,
      sessionId: opts.sessionId,
      system: systemPrompt(opts.purgeLevel),
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildUserPrompt({ positiveText, negativeText: baseNegative, instruction: instructionText, mode, opts }) }],
      }],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      signal: request.signal,
    })

    const usage = collected.usage !== undefined && Object.keys(collected.usage).length > 0 ? collected.usage : undefined
    if (collected.error !== undefined) {
      log.warn('[tagger] refine 模型调用失败（' + collected.error + '）：' + (collected.message ?? ''))
      return fail(collected.error, collected.message ?? '模型调用失败。', {
        raw: collected.text,
        ...usage === undefined ? {} : { usage },
      })
    }

    const raw = collected.text
    const parsed = parseRefineJson(raw)
    if (parsed.value === undefined) {
      log.warn('[tagger] refine JSON 修复后仍失败：' + (parsed.error ?? 'unknown'))
      return fail('bad-json', '模型没给出可解析的 JSON（已尝试修复一次）：' + (parsed.error ?? ''), {
        raw,
        repaired: true,
        ...usage === undefined ? {} : { usage },
      })
    }
    const diff = isRecord(parsed.value) ? parsed.value : undefined
    if (diff === undefined) {
      return fail('bad-json', '模型给的 JSON 不是对象（要 {"add":[],"remove":[],"weights":[]}）。', {
        raw,
        repaired: parsed.repaired,
        ...usage === undefined ? {} : { usage },
      })
    }

    const rawAdd = toTagList(diff.add)
    const rawRemove = toTagList(diff.remove)
    const rawWeights = toWeightList(diff.weights)

    if ((mode === 'prune' || mode === 'weights') && rawAdd.length > 0) {
      pushWarn(warnings, mode + ' 模式不新增，已忽略 ' + rawAdd.length + ' 条 add')
    }
    if ((mode === 'add' || mode === 'weights') && rawRemove.length > 0) {
      pushWarn(warnings, mode + ' 模式不删标签，已忽略 ' + rawRemove.length + ' 条 remove')
    }
    if ((mode === 'add' || mode === 'prune') && rawWeights.length > 0) {
      pushWarn(warnings, mode + ' 模式不改权重，已忽略 ' + rawWeights.length + ' 条 weights')
    }

    // 1) remove：只删原串里真有的
    const removedRows = []
    const removedKeys = new Set()
    if (mode === 'edit' || mode === 'prune') {
      for (const raw of dedupeStrings(rawRemove)) {
        const key = tagKey(raw)
        const hit = baseKeys.get(key)
        if (hit === undefined || removedKeys.has(key)) {
          pushWarn(warnings, '要删的 ' + cleanTag(raw) + ' 不在现有串里，已跳过')
          continue
        }
        removedKeys.add(key)
        removedRows.push(hit)
      }
    }

    // 2) add：必须过标签库；库里没有的一律丢弃
    const addedRows = []
    if (mode === 'add' || mode === 'edit') {
      const wanted = []
      const takenKeys = new Set(baseKeys.keys())
      for (const raw of toTagList(diff.add)) {
        const text = cleanTag(raw)
        const key = tagKey(text)
        if (key === '' || takenKeys.has(key)) continue
        takenKeys.add(key)
        wanted.push({ raw: text, key })
      }
      if (wanted.length > 0) {
        const canonRows = await canonicalizeAdd(wanted.map(item => item.raw), warnings)
        for (let i = 0; i < wanted.length; i += 1) {
          const hit = isRecord(canonRows[i]) ? canonRows[i] : undefined
          const rawText = wanted[i].raw
          if (hit === undefined) continue
          if (hit.matched === false) {
            pushWarn(warnings, rawText + ' 不在库里，已丢弃')
            continue
          }
          const tag = typeof hit.tag === 'string' && hit.tag.trim() !== '' ? hit.tag.trim() : rawText
          const key = tagKey(tag)
          if (key === '' || baseKeys.has(key) || addedRows.some(row => tagKey(row.tag) === key)) continue
          addedRows.push({
            tag,
            weight: clampNumber(hit.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1),
            cn: typeof hit.cn === 'string' ? hit.cn : '',
            ...typeof hit.kind === 'string' ? { kind: hit.kind } : {},
          })
        }
      }
      if (addedRows.length > opts.maxNewTags) {
        pushWarn(warnings, '新增 ' + addedRows.length + ' 条超过上限 maxNewTags(' + opts.maxNewTags + ')，已截到 ' + opts.maxNewTags + ' 条')
        addedRows.length = opts.maxNewTags
      }
    }

    // 3) weights：只调原串（或本次新增）里真有的
    const weightedRows = []
    if (mode === 'edit' || mode === 'weights') {
      const touched = new Set()
      for (const item of rawWeights) {
        const key = tagKey(item.tag)
        if (key === '' || touched.has(key)) continue
        const target = baseKeys.get(key) ?? addedRows.find(row => tagKey(row.tag) === key)
        if (target === undefined) {
          pushWarn(warnings, '要调权重的 ' + cleanTag(item.tag) + ' 不在现有串里，已跳过')
          continue
        }
        const from = clampNumber(target.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1)
        const to = clampNumber(item.weight, MIN_WEIGHT, MAX_WEIGHT, from)
        if (Math.abs(to - from) < 0.005) continue
        touched.add(key)
        target.weight = to
        weightedRows.push({ tag: target.tag, from, to })
      }
    }

    // 4) 装配：keepOrder 时原有顺序一字不动，新标签追加到尾部
    let rows = []
    for (const row of baseRows) {
      if (removedKeys.has(tagKey(row.tag))) continue
      rows.push({ tag: row.tag, weight: clampNumber(row.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1) })
    }
    for (const row of addedRows) {
      if (removedKeys.has(tagKey(row.tag))) continue
      rows.push({ tag: row.tag, weight: clampNumber(row.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1), cn: row.cn })
    }
    if (opts.keepOrder === false) {
      const order = dedupeStrings(toTagList(diff.order))
      if (order.length > 0) rows = reorderRows(rows, order)
    }
    await enrich(rows)

    const resultTags = rows.map(row => ({
      tag: row.tag,
      weight: clampNumber(row.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1),
      cn: typeof row.cn === 'string' ? row.cn : '',
      ...typeof row.kind === 'string' ? { kind: row.kind } : {},
    }))
    const positive = formatRows(resultTags, opts.syntax)
    const delta = {
      added: addedRows.map(row => row.tag),
      removed: removedRows.map(row => row.tag),
      weighted: weightedRows.map(row => ({ tag: row.tag, from: row.from, to: row.to })),
    }
    const ops = delta.added.length + delta.removed.length + delta.weighted.length

    log.info('[tagger] refine ' + mode + '：+' + delta.added.length + ' -' + delta.removed.length
      + ' ~' + delta.weighted.length + '，' + (Date.now() - startedAt) + 'ms')

    return {
      ok: true,
      positive,
      negative: baseNegative,
      mode,
      tags: resultTags,
      delta,
      ops,
      notes: pickNotes(diff) ?? '',
      ms: Date.now() - startedAt,
      model: opts.model,
      provider: opts.provider,
      purgeLevel: opts.purgeLevel,
      raw,
      repaired: parsed.repaired,
      warnings,
      ...usage === undefined ? {} : { usage },
    }
  }

  /** 兜底结果：连 runOnce 都炸了也要给调用方一个形状完整的结果。 */
  function crashResult(request, startedAt, error) {
    const mode = resolveMode(request?.mode)
    return {
      ok: false,
      error: 'internal',
      message: '精修过程抛错（已兜住）：' + msgOf(error),
      mode,
      positive: typeof request?.positive === 'string' ? request.positive.trim() : '',
      negative: typeof request?.negative === 'string' ? request.negative.trim() : '',
      tags: [],
      delta: emptyDelta(),
      ops: 0,
      notes: '',
      ms: Date.now() - startedAt,
      model: typeof cfg.llm?.model === 'string' ? cfg.llm.model : DEFAULT_MODEL,
      purgeLevel: resolveLevel(),
      warnings: [],
    }
  }

  return {
    modes: MODES.slice(),

    async refine(input) {
      const startedAt = Date.now()
      const request = isRecord(input) ? input : {}
      let result
      try {
        result = await runOnce({ ...request, signal: request.signal }, startedAt)
      } catch (error) {
        log.warn('[tagger] refine 内部异常：' + msgOf(error))
        result = crashResult(request, startedAt, error)
      }

      // 成功的整串结果先过 postProcessors（外部可以改格式 / 追加字段）
      if (result.ok === true && spi !== undefined && spi !== null && typeof spi.applyPostProcessors === 'function') {
        try {
          const next = await spi.applyPostProcessors(result, { mode: result.mode, phase: 'refine' })
          if (isRecord(next)) result = next
        } catch (error) {
          log.warn('[tagger] refine postProcessors 失败（已忽略）：' + msgOf(error))
        }
      }
      // 出口钩子：成功失败都通知，方便外部记账
      if (spi !== undefined && spi !== null && typeof spi.emit === 'function') {
        try {
          await spi.emit('afterRefine', result, { mode: result.mode, ok: result.ok === true })
        } catch (error) {
          log.warn('[tagger] afterRefine 钩子失败（已忽略）：' + msgOf(error))
        }
      }
      return result
    },
  }
}
