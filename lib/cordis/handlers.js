// plan: 全部 HTTP 接口（面板与 /tagger/api 的整套路由表集中在这里，出问题只看这一个文件）

/**
 * lib/cordis/handlers.js — 面板的全部接口，一张表：[{ path, methods, handler }]。
 *
 * 为什么集中：每个接口的方法、入参、返回都在同一处；分派本身在 lib/routes.js。
 * 这里只做「校验入参 → 调运行时 → 定状态码」，业务逻辑都在 lib/ 下的各个模块里。
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { poseGallery, poseImage } from '../poses.js'
import { resolveLaunch } from '../launch.js'
import { apiUrl } from './adapter.js'
import { resolveWorkflowDir } from '../comfy-workflow.js'
import { importWorkflow } from '../workflow-import.js'
// 服装 / 人像两个只读参考库（catalog.csv 在 ai-pose-gallery-zh 里，与姿势库同源）
import { RefError, refGallery, refImage, refItem, refKind } from '../refs.js'
// 模型档案（tag 系 / Pony 系 / 自然语言系 / 自定义）：面板「模型档案」下拉的数据源
import { listProfiles, profileState } from '../model-profiles.js'
import { PLUGIN, VERSION } from './config.js'
// 配置读取与落盘统一走 lib/spi.js 的入口（与别处同一份实现，不在这里各拼一遍）
import { readConfig, saveConfig } from '../spi.js'

/** 把流式 chunk 压成可读摘要（/probe 诊断用，别把整个 chunk 打出去）。 */
function summarizeChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return { raw: String(chunk).slice(0, 120) }
  const out = { type: chunk.type }
  if (typeof chunk.kind === 'string') out.kind = chunk.kind
  if (chunk.reason !== undefined && chunk.reason !== null) out.reason = chunk.reason
  if (typeof chunk.text === 'string') out.text = chunk.text.slice(0, 120)
  if (typeof chunk.delta === 'string') out.delta = chunk.delta.slice(0, 120)
  if (chunk.failure !== undefined) out.failure = chunk.failure
  if (chunk.usage !== undefined) out.usage = chunk.usage
  out.keys = Object.keys(chunk)
  return out
}

/** 语言包白名单：只认包根 locale/ 下这两门语言，别的一律退回 zh。 */
const LOCALE_LANGS = ['zh', 'en']
const LOCALE_DEFAULT = 'zh'

/** /probe 一次最多回这么多 chunk：模型一直吐也不能让探针无限攒内存。 */
const PROBE_CHUNK_LIMIT = 256
/** /probe 整条流的等待上限。 */
const PROBE_TIMEOUT_MS = 30000
/** 标签库冷启动最多等这么久，超时就先用手上有的索引回答。 */
const TAGS_READY_WAIT_MS = 3000
/** 导入工作流时 body.path 允许的最大文件大小。 */
const IMPORT_MAX_BYTES = 10 * 1024 * 1024

/** 两个地址是不是同一个源（协议 + 主机 + 端口）。解析不了就当不同源。 */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * 等标签库把索引建好：ready() 不存在就不等，抛错或超时也放过去 ——
 * 查询顶多查不到词，不能让一个 /tags 把接口拖死。
 * @param {any} tags @param {number} [waitMs] @returns {Promise<boolean>} 是否真的就绪
 */
async function waitTagsReady(tags, waitMs = TAGS_READY_WAIT_MS) {
  if (typeof tags?.ready !== 'function') return false
  let timer
  try {
    const timeout = new Promise(resolve => {
      timer = setTimeout(resolve, waitMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return await Promise.race([Promise.resolve(tags.ready()).then(() => true), timeout.then(() => false)])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * body.path 指向的文件能不能当工作流 JSON 读：后缀 .json（不分大小写）、必须是普通文件、不超过 10MB。
 * 这三关都过不了就直接回 400，别拿任意路径去 readFile。
 * @param {string} file
 */
async function jsonFileInfo(file) {
  if (path.extname(file).toLowerCase() !== '.json') {
    return { ok: false, json: { ok: false, error: 'bad-path', message: '只能导入 .json 工作流文件：' + file } }
  }
  let info
  try {
    info = await stat(file)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, json: { ok: false, error: 'no-file', message: '读不了这个文件：' + file + '（' + why + '）' } }
  }
  if (info.isFile() !== true) {
    return { ok: false, json: { ok: false, error: 'no-file', message: '这不是一个普通文件：' + file } }
  }
  if (info.size > IMPORT_MAX_BYTES) {
    return { ok: false, json: { ok: false, error: 'too-large', message: '工作流文件超过 10MB，先精简一下：' + file } }
  }
  return { ok: true }
}

/**
 * 一个路由项。handler 的入参由 lib/routes.js 组装：精确路由给 url/method/body/req，
 * 通配路由（path 以 /* 结尾）额外给 params.rest；测试会直接调 handler 并自带 params，所以四个都标可选。
 * @typedef {{ path: string, methods: string[], handler: (args: { url?: any, method?: any, body?: any, req?: any, params?: any }) => any }} Route
 */

/**
 * 姿势标签映射（lib/pose-tags.js）走动态 import：那个文件还没落盘时，不能让整个 handlers 跟着崩。
 * 失败不缓存：文件到位后下一次请求就能用上，不用重启服务。
 */
let poseTagsModule
async function importPoseTags() {
  if (poseTagsModule !== undefined) return poseTagsModule
  let mod = null
  try {
    mod = await import('../pose-tags.js')
  } catch {
    return null
  }
  poseTagsModule = typeof mod?.tagsForPose === 'function' ? mod : null
  return poseTagsModule
}

/** 调一次映射函数；它自己炸了也只回空映射，不把请求变成 500。 */
function callTagsForPose(mod, input) {
  try {
    const out = mod.tagsForPose(input)
    return out !== null && typeof out === 'object' ? out : { pose: [], camera: [], reasons: [] }
  } catch {
    return { pose: [], camera: [], reasons: [] }
  }
}

/** 用标签库校对映射结果：每项 { tag, cn, matched }（索引没就绪时 cn 空、matched false）。 */
async function enrichPoseTags(rt, mapped) {
  const pickList = list => (Array.isArray(list) ? list.filter(tag => typeof tag === 'string' && tag !== '') : [])
  const pose = pickList(mapped?.pose)
  const camera = pickList(mapped?.camera)
  const reasons = Array.isArray(mapped?.reasons) ? mapped.reasons.map(item => String(item)) : []
  const merged = [...new Set([...pose, ...camera])]
  let rows = []
  if (merged.length > 0 && rt.tags !== undefined && rt.tags !== null && typeof rt.tags.canonicalizeMany === 'function') {
    try {
      rows = (await rt.tags.canonicalizeMany(merged, { syntax: rt.config?.tags?.weightSyntax ?? 'comfy' })) ?? []
    } catch { rows = [] }
  }
  const byTag = new Map()
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && typeof row.tag === 'string' && row.tag !== '') byTag.set(row.tag, row)
  }
  const enrich = list => list.map(tag => {
    const row = byTag.get(tag)
    return {
      tag,
      cn: row !== undefined && typeof row.cn === 'string' ? row.cn : '',
      matched: row !== undefined && row.matched !== false,
    }
  })
  const poseTags = enrich(pose)
  const cameraTags = enrich(camera)
  return { pose: poseTags, camera: cameraTags, tags: [...poseTags, ...cameraTags], reasons }
}

/**
 * 参考样式预设（lib/styles.js）走动态 import：那个文件还没落盘时，不能让整个 handlers 跟着崩。
 * 失败不缓存：文件到位后下一次请求就能用上，不用重启服务（同 importPoseTags 的路子）。
 */
let stylesModule
async function importStyles() {
  if (stylesModule !== undefined) return stylesModule
  let mod = null
  try {
    mod = await import('../styles.js')
  } catch {
    return null
  }
  stylesModule = typeof mod?.listStyles === 'function' && typeof mod?.styleById === 'function' ? mod : null
  return stylesModule
}

/**
 * 参考库标签映射（lib/ref-tags.js）走动态 import：那个文件还没落盘时，不能让整个 handlers 跟着崩。
 * 失败不缓存：文件到位后下一次请求就能用上，不用重启服务（同 importStyles 的路子）。
 * 契约：tagsForCostume(item) / tagsForPortrait(item) 收 refs.js 的归一记录（costume: id/name/category/cn/keywords，
 * portrait: id/partition/hair/style/title/popular），回 { tags: [{ tag, cn }], reasons }。
 */
let refTagsModule
async function importRefTags() {
  if (refTagsModule !== undefined) return refTagsModule
  let mod = null
  try {
    // 文件没到位时这里要静默退成 501，不能把 handlers 带崩；到位后下一次请求即可用（失败不缓存）。
    mod = await import('../ref-tags.js')
  } catch {
    return null
  }
  refTagsModule = typeof mod?.tagsForCostume === 'function' && typeof mod?.tagsForPortrait === 'function' ? mod : null
  return refTagsModule
}

/** 调一次参考库映射；它自己炸了也只回空映射，不把请求变成 500。 */
function callRefTags(mod, key, item) {
  try {
    const out = key === 'portrait' ? mod.tagsForPortrait(item) : mod.tagsForCostume(item)
    return out !== null && typeof out === 'object' ? out : {}
  } catch {
    return {}
  }
}

/** 一条样式补上 cn：与 tags 等长、词库里对不上的位置留空串。 */
function withChinese(style, cnMap) {
  const raw = Array.isArray(style?.tags) ? style.tags : []
  const tags = raw.filter(tag => typeof tag === 'string' && tag !== '')
  return {
    id: typeof style?.id === 'string' ? style.id : '',
    title: typeof style?.title === 'string' ? style.title : '',
    group: typeof style?.group === 'string' ? style.group : '',
    tags,
    note: typeof style?.note === 'string' ? style.note : '',
    accent: typeof style?.accent === 'string' ? style.accent : '',
    cn: tags.map(tag => cnMap.get(tag) ?? ''),
  }
}

/** 一次把整批 tag 交给标签库取中文名：索引没就绪时整批留空，不把接口拖死。 */
async function chineseMap(rt, tags) {
  const out = new Map()
  const unique = [...new Set(tags.filter(tag => typeof tag === 'string' && tag !== ''))]
  if (unique.length === 0) return out
  if (rt.tags === undefined || rt.tags === null || typeof rt.tags.canonicalizeMany !== 'function') return out
  await waitTagsReady(rt.tags)
  if (typeof rt.tags.ensureFresh === 'function') await rt.tags.ensureFresh()
  let rows = []
  try {
    rows = (await rt.tags.canonicalizeMany(unique, { syntax: rt.config?.tags?.weightSyntax ?? 'comfy' })) ?? []
  } catch {
    rows = []
  }
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && typeof row.tag === 'string' && row.tag !== '') {
      out.set(row.tag, typeof row.cn === 'string' ? row.cn : '')
    }
  }
  return out
}

/** ?q= 模糊匹配：id / title / note / tags / cn 里任一处包含就算命中（大小写不敏感）。 */
function styleMatchesQuery(style, needle) {
  const fields = [style.id, style.title, style.note, ...style.tags, ...style.cn]
  return fields.some(field => (typeof field === 'string' ? field.toLowerCase().includes(needle) : false))
}
/** 全部 HTTP 接口。返回 [{ path, methods, handler }]，逐条见 docs/API.md。 */
/** @returns {Route[]} */
export function createHandlers(rt) {
  // 并发保护：两个请求同时点「启动 ComfyUI」时只 spawn 一次，第二个复用同一份结果
  let launchingPromise = null

  /** 真正去拉一次 ComfyUI 并等它开始监听；waitMs 按第一个发起请求的算。 */
  async function launchOnce(waitMs) {
    const launched = await rt.launch()
    if (!launched.ok) {
      return { status: 500, json: { ok: false, error: 'launch-failed', message: launched.message, launch: launched } }
    }
    const deadline = Date.now() + waitMs
    let status = await rt.comfy.ping()
    while (!status.ok && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      status = await rt.comfy.ping()
    }
    return {
      json: {
        ok: status.ok,
        state: status.ok ? 'online' : 'starting',
        pid: launched.pid,
        command: launched.command,
        dir: launched.dir,
        status,
        message: status.ok ? undefined : '进程已拉起（pid ' + launched.pid + '），' + Math.round(waitMs / 1000) + ' 秒内还没开始监听 —— 首次加载模型可能更久，等一会儿再点「检测」。',
      },
    }
  }

  return [
    {
      path: '/spi',
      methods: ['GET'],
      handler: async () => ({ json: { ok: true, spi: rt.spi.describe() } }),
    },
    {
      // 多语言词典：面板与宿主共用同一份 locale/<lang>.json，前端自己按 key 取。
      path: '/locale',
      methods: ['GET'],
      handler: async ({ url }) => {
        const asked = (url.searchParams.get('lang') ?? '').trim().toLowerCase()
        const lang = LOCALE_LANGS.includes(asked) ? asked : LOCALE_DEFAULT
        try {
          // handlers.js 在 lib/cordis/ 下，包根的 locale/ 要退两级
          const raw = await readFile(new URL('../../locale/' + lang + '.json', import.meta.url), 'utf8')
          const dict = JSON.parse(raw)
          if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) throw new Error('语言包不是对象')
          return { json: { ok: true, locale: lang, langs: [...LOCALE_LANGS], dict } }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { status: 500, json: { ok: false, error: 'no-locale', message: '读不到语言包 locale/' + lang + '.json：' + message } }
        }
      },
    },
    {
      path: '/refine',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.refine.refine({
          positive: typeof body?.positive === 'string' ? body.positive : '',
          negative: typeof body?.negative === 'string' ? body.negative : '',
          instruction: typeof body?.instruction === 'string' ? body.instruction : typeof body?.text === 'string' ? body.text : '',
          mode: typeof body?.mode === 'string' ? body.mode : undefined,
          options: body?.options !== null && typeof body.options === 'object' ? body.options : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/health',
      methods: ['GET'],
      handler: async () => ({ json: { plugin: PLUGIN, version: VERSION, dataDir: rt.dir } }),
    },
    {
      path: '/state',
      methods: ['GET'],
      handler: async () => {
        const [comfy, workflows] = await Promise.all([rt.comfy.ping(), rt.comfy.listWorkflows()])
        return {
          json: {
            config: readConfig(rt),
            purge: rt.forge.purgeState(),
            comfy,
            workflows: workflows.ok ? workflows.workflows : [],
            workflowsError: workflows.ok ? undefined : workflows.message,
            history: rt.forge.history(),
          },
        }
      },
    },
    {
      // 模型档案：一份可选清单 + 当前档案的生效值（custom 时生效值来自配置本身）
      path: '/profiles',
      methods: ['GET'],
      handler: async () => ({ json: { profiles: listProfiles(), current: profileState(rt.config) } }),
    },
    {
      // 参考样式预设：/studio 中栏的卡片清单。groups 恒全量，styles 可按 group / q 过滤。
      // 每条 style 多带一个 cn：与 tags 等长、词库里对不上的位置是空串。
      path: '/styles',
      methods: ['GET'],
      handler: async ({ url }) => {
        const mod = await importStyles()
        if (mod === null) {
          return { status: 503, json: { ok: false, error: 'styles-unavailable', message: 'lib/styles.js 还没就位，样式预设暂时读不到' } }
        }
        const listed = mod.listStyles() ?? {}
        const groups = Array.isArray(listed.groups) ? listed.groups : []
        const raw = Array.isArray(listed.styles) ? listed.styles : []
        const pool = raw.flatMap(style => (Array.isArray(style?.tags) ? style.tags : []))
        const cnMap = await chineseMap(rt, pool)
        const group = (url.searchParams.get('group') ?? '').trim().toLowerCase()
        const needle = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        let styles = raw.map(style => withChinese(style, cnMap))
        if (group !== '') styles = styles.filter(style => style.group.toLowerCase() === group)
        if (needle !== '') styles = styles.filter(style => styleMatchesQuery(style, needle))
        return { json: { ok: true, groups, styles, total: styles.length } }
      },
    },
    {
      // /styles/:id —— 精确表放不下参数，用通配路由拿 params.rest（去掉 /styles/ 之后的部分）
      path: '/styles/*',
      methods: ['GET'],
      handler: async ({ params }) => {
        const mod = await importStyles()
        if (mod === null) {
          return { status: 503, json: { ok: false, error: 'styles-unavailable', message: 'lib/styles.js 还没就位，样式预设暂时读不到' } }
        }
        let id = typeof params?.rest === 'string' ? params.rest.replace(/\/+$/, '') : ''
        try {
          id = decodeURIComponent(id)
        } catch {
          id = ''
        }
        const found = id === '' ? null : mod.styleById(id)
        if (found === null || found === undefined) {
          return { status: 404, json: { ok: false, error: 'no-style', message: '没有这个样式：' + id } }
        }
        const tags = Array.isArray(found.tags) ? found.tags : []
        const cnMap = await chineseMap(rt, tags)
        return { json: { ok: true, style: withChinese(found, cnMap) } }
      },
    },
    {
      // 参考库画廊：服装 / 人像两个只读库。sets 首项恒 all（标签「全部」），hairs 只有人像库有内容。
      // 错码：bad-kind 400 / no-ref-library 404 —— 分派层原样带出去，面板按 error 提示。
      path: '/refs',
      methods: ['GET'],
      handler: async ({ url }) => {
        const gallery = refGallery(rt.config?.comfy?.launchDir ?? '', url.searchParams.get('kind') ?? '', {
          q: url.searchParams.get('q') ?? '',
          set: url.searchParams.get('set') ?? '',
          hair: url.searchParams.get('hair') ?? '',
          popular: url.searchParams.get('popular') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 0),
          offset: Number(url.searchParams.get('offset') ?? 0),
        })
        if (gallery.ok !== true) {
          return {
            status: gallery.error === 'bad-kind' ? 400 : 404,
            json: { ok: false, error: gallery.error, message: gallery.message },
          }
        }
        return { json: gallery }
      },
    },
    {
      // 参考图：服装缩略图优先 thumbs/costume（size=full 直接给原图），人像只有原图。
      // 只收 GET / HEAD：别的动词在分派层就被 405 挡掉（allow 文案由 methods 生成）。
      path: '/ref-image',
      methods: ['GET', 'HEAD'],
      handler: async ({ url }) => {
        let hit
        try {
          hit = refImage(
            rt.config?.comfy?.launchDir ?? '',
            url.searchParams.get('kind') ?? '',
            url.searchParams.get('id') ?? '',
            url.searchParams.get('size') ?? '',
          )
        } catch (error) {
          const code = error instanceof RefError ? error.code : 'no-ref-image'
          const why = error instanceof Error ? error.message : String(error)
          return {
            status: code === 'bad-kind' || code === 'bad-id' ? 400 : 404,
            json: { ok: false, error: code, message: why },
          }
        }
        let raw
        try {
          raw = await readFile(hit.file)
        } catch (error) {
          // 索引里有、盘上没了（用户删了图 / 换了目录）：404，不是 500 抛栈
          const why = error instanceof Error ? error.message : String(error)
          return { status: 404, json: { ok: false, error: 'no-ref-image', message: '读不到这张参考图：' + hit.file + '（' + why + '）' } }
        }
        return { binary: raw, contentType: hit.mediaType }
      },
    },
    {
      // 参考库标签：动态 import lib/ref-tags.js，只做映射 + 词表校对，不在这里编标签。
      path: '/ref-tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const kind = url.searchParams.get('kind') ?? ''
        const key = refKind(kind)
        if (key === '') {
          return { status: 400, json: { ok: false, error: 'bad-kind', message: '不认识的参考库：' + kind + '（只认 costume / portrait）' } }
        }
        const asked = url.searchParams.get('id') ?? ''
        const item = refItem(rt.config?.comfy?.launchDir ?? '', key, asked)
        if (item === null) {
          return { status: 404, json: { ok: false, error: 'no-ref', message: '参考库里没有这一条：' + asked } }
        }
        const mod = await importRefTags()
        if (mod === null) {
          return { status: 501, json: { ok: false, error: 'ref-tags-unavailable', message: '参考库标签映射还没就绪（lib/ref-tags.js）' } }
        }
        const mapped = callRefTags(mod, key, item)
        // lib/ref-tags.js 的实际契约是 { tags: [{ tag, cn }], reasons }（cn 它自己带好了）；
        // 也兼容 early 版本的 { positive, negative } 字符串数组 —— 两条线在并行写，接口层不要被形状绑死。
        const pairs = value => (Array.isArray(value) ? value : []).map(entry => {
          if (typeof entry === 'string') return { tag: entry, cn: '' }
          const tag = typeof entry?.tag === 'string' ? entry.tag : ''
          const cn = typeof entry?.cn === 'string' ? entry.cn : ''
          return { tag, cn }
        }).filter(pair => pair.tag !== '')
        const nullish = value => (Array.isArray(value) ? value.map(String) : [])
        const fromTags = Array.isArray(mapped?.tags) ? pairs(mapped.tags) : null
        const positive = fromTags !== null ? fromTags : pairs(mapped?.positive)
        const negative = fromTags !== null ? [] : pairs(mapped?.negative)
        // 模块自带 cn 就不查词表；只在 old shape 时才补，省一次索引往返
        const bare = [...positive, ...negative].filter(pair => pair.cn === '').map(pair => pair.tag)
        const cnMap = bare.length === 0 ? new Map() : await chineseMap(rt, bare)
        const enrich = list => list.map(pair => ({ tag: pair.tag, cn: pair.cn !== '' ? pair.cn : (cnMap.get(pair.tag) ?? '') }))
        return {
          json: {
            ok: true,
            kind: key,
            id: item.id,
            item,
            positive: enrich(positive),
            negative: enrich(negative),
            notes: nullish(mapped?.notes),
            reasons: nullish(mapped?.reasons),
          },
        }
      },
    },
    {
      path: '/config',
      methods: ['GET', 'POST'],
      handler: async ({ method, body }) => {
        if (method === 'POST') {
          saveConfig(rt, body?.patch ?? body ?? {})
        }
        return { json: { config: readConfig(rt) } }
      },
    },
    {
      path: '/models',
      methods: ['GET'],
      handler: async ({ url }) => {
        const provider = url.searchParams.get('provider') ?? rt.config.llm.provider
        const models = await rt.forge.models(provider)
        return { json: { provider, models } }
      },
    },
    {
      // web 版 / 独立服务专用：拿面板填的地址与 key 去打一次 /models，验证连通性。
      // 不写配置、不落盘 —— 只报能不能连上和看得到哪些模型。
      path: '/llm/probe',
      methods: ['POST'],
      handler: async ({ body }) => {
        const rawBase = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
        const rawKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        const baseUrl = rawBase !== '' ? rawBase : rt.config.llm.baseUrl
        // 跨源探测不借用已保存的 key：别把用户填的 key 送去一个陌生地址；只有同源才回落
        const reuseKey = sameOrigin(baseUrl, rt.config.llm.baseUrl)
        const apiKey = rawKey !== '' ? rawKey : reuseKey ? rt.config.llm.apiKey : ''
        const endpoint = apiUrl(baseUrl, '/models')
        if (endpoint === '') {
          return { status: 400, json: { ok: false, error: 'no-base-url', message: '先填接口地址，例如 https://api.openai.com/v1' } }
        }
        if (apiKey === '') {
          return { status: 400, json: { ok: false, error: 'no-api-key', endpoint, message: '先填 API Key' } }
        }
        const started = Date.now()
        let response
        try {
          response = await fetch(endpoint, {
            headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { status: 502, json: { ok: false, error: 'unreachable', endpoint, message } }
        }
        const raw = await response.text().catch(() => '')
        if (!response.ok) {
          return {
            status: 502,
            json: { ok: false, error: 'http-' + response.status, endpoint, status: response.status, message: raw.slice(0, 300) },
          }
        }
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = undefined
        }
        const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
        const models = rows.map(row => (typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : '')).filter(id => id !== '')
        return {
          json: {
            ok: true,
            endpoint,
            ms: Date.now() - started,
            count: models.length,
            models: models.slice(0, 40),
            message:
              models.length > 0
                ? '连上了，可见 ' + models.length + ' 个模型'
                : '连上了，但 /models 没列模型（有的服务不支持，不影响锻造）',
          },
        }
      },
    },
    {
      path: '/probe',
      methods: ['POST'],
      handler: async ({ body }) => {
        const llm = rt.llm
        if (typeof llm?.stream !== 'function') {
          return { status: 502, json: { ok: false, error: 'no-llm', message: '宿主没有 llm 服务。' } }
        }
        const text = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text.trim() : 'ping'
        const shape = body?.shape === 'string' ? body.shape : 'array'
        const message = shape === 'string'
          ? { role: 'user', content: text }
          : { role: 'user', content: [{ type: 'text', text }] }
        const args = {
          provider: typeof body?.provider === 'string' && body.provider !== '' ? body.provider : rt.config.llm.provider,
          model: typeof body?.model === 'string' && body.model !== '' ? body.model : rt.config.llm.model,
          sessionId: typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : 'dsh-tagger-probe',
          messages: [message],
          maxTokens: 64,
        }
        if (typeof body?.system === 'string' && body.system !== '') args.system = body.system
        if (typeof body?.messages === 'string' && body.messages !== '') {
          try {
            args.messages = JSON.parse(body.messages)
          } catch {
            return { status: 400, json: { ok: false, error: 'bad-json', message: 'messages 不是合法 JSON。' } }
          }
        }
        // 探针不能把宿主拖死：整条流 30s 上限，chunk 数上限 256
        args.signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
        const chunks = []
        let capped = false
        try {
          for await (const chunk of llm.stream(args)) {
            if (chunks.length >= PROBE_CHUNK_LIMIT) {
              capped = true
              break
            }
            chunks.push(summarizeChunk(chunk))
          }
        } catch (error) {
          return { status: 500, json: { ok: false, error: 'threw', message: String(error?.message ?? error), chunks, capped } }
        }
        return { status: 200, json: { ok: true, args: { provider: args.provider, model: args.model, shape }, chunks, capped } }
      },
    },
    {
      path: '/comfy',
      methods: ['GET'],
      handler: async () => {
        const [ping, workflows] = await Promise.all([rt.comfy.ping(), rt.comfy.listWorkflows()])
        return {
          json: {
            status: ping,
            launch: resolveLaunch(rt.config),
            workflows: workflows.ok ? workflows.workflows.map(item => ({ id: item.id, title: item.title })) : [],
          },
        }
      },
    },
    {
      path: '/comfy/launch',
      methods: ['POST'],
      handler: async ({ body }) => {
        // 已经在跑就直接认账 —— 别把用户的第二个 ComfyUI 实例也拉起来抢显存。
        const before = await rt.comfy.ping()
        if (before.ok) return { json: { ok: true, state: 'online', alreadyRunning: true, status: before } }
        const waitMs = Math.min(Math.max(Number(body?.waitMs ?? 45000) || 45000, 5000), 120000)
        // 并发点两次：第二个请求挂在同一个 Promise 上，rt.launch() 只跑一次
        if (launchingPromise === null) {
          launchingPromise = launchOnce(waitMs).finally(() => {
            launchingPromise = null
          })
        }
        return await launchingPromise
      },
    },
    {
      path: '/workflows',
      methods: ['GET'],
      handler: async () => {
        const result = await rt.comfy.listWorkflows()
        if (!result.ok) return { status: 502, json: { ok: false, error: 'workflows', message: result.message } }
        return { json: { workflows: result.workflows, dir: result.dir } }
      },
    },
    {
      // 导入自定义工作流：面板选文件 / 贴 JSON（可选一份 schema），落到 comfy.workflowDir。
      // body.path 是给本地独立服务用的：浏览器不方便选文件时可以直接给磁盘路径。
      path: '/workflows/import',
      methods: ['POST'],
      handler: async ({ body }) => {
        const configured = typeof rt.config?.comfy?.workflowDir === 'string' ? rt.config.comfy.workflowDir.trim() : ''
        const dir = configured !== '' ? configured : resolveWorkflowDir(rt.config)
        let workflow = body?.workflow
        const fromPath = typeof body?.path === 'string' ? body.path.trim() : ''
        if (workflow === undefined && fromPath !== '') {
          // body.path 是危险入参（任意磁盘路径）：读盘前先卡扩展名 / 普通文件 / 10MB 上限
          const info = await jsonFileInfo(fromPath)
          if (info.ok !== true) return { status: 400, json: info.json }
          try {
            workflow = await readFile(fromPath, 'utf8')
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            return { status: 400, json: { ok: false, error: 'no-file', message: '读不了这个文件：' + fromPath + '（' + why + '）' } }
          }
        }
        const result = importWorkflow({
          dir,
          name: body?.name,
          workflow,
          schema: body?.schema,
          overwrite: body?.overwrite === true,
          config: rt.config,
        })
        if (result.ok !== true) return { status: result.error === 'exists' ? 409 : 400, json: result }
        const list = await rt.comfy.listWorkflows()
        return {
          json: {
            ...result,
            workflows: list.ok ? list.workflows.map(item => ({ id: item.id, title: item.title, vars: item.vars })) : [],
          },
        }
      },
    },
    {
      path: '/poses',
      methods: ['GET'],
      handler: async ({ url }) => {
        const result = rt.poses.list({
          set: url.searchParams.get('set') ?? '',
          q: url.searchParams.get('q') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 0),
        })
        return { json: result }
      },
    },
    {
      path: '/pose-thumb',
      methods: ['GET'],
      handler: async ({ url }) => {
        const id = url.searchParams.get('id') ?? ''
        const hit = poseImage(rt.config?.comfy?.launchDir ?? '', id)
        if (hit === null) return { status: 404, json: { ok: false, error: 'pose-image', message: '没有这张姿势图：' + id } }
        // 索引里有、盘上没了（用户删了图 / 换了目录）：404，不是 500 抛栈
        let raw
        try {
          raw = await readFile(hit.file)
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          return { status: 404, json: { ok: false, error: 'pose-image', message: '读不到这张姿势图：' + hit.file + '（' + why + '）' } }
        }
        return { binary: raw, contentType: hit.contentType }
      },
    },
    {
      path: '/pose-gallery',
      methods: ['GET'],
      handler: async ({ url }) => {
        const gallery = poseGallery({
          launchDir: rt.config?.comfy?.launchDir ?? '',
          set: url.searchParams.get('set') ?? '',
          category: url.searchParams.get('category') ?? '',
          angle: url.searchParams.get('angle') ?? '',
          q: url.searchParams.get('q') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 0),
          offset: Number(url.searchParams.get('offset') ?? 0),
        })
        return { json: gallery }
      },
    },
    {
      path: '/pose-tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const base = (url.searchParams.get('base') ?? '').trim()
        if (base === '') {
          return { status: 400, json: { ok: false, error: 'bad-base', message: '要带 base（姿势组编号，如 full_single_P041）' } }
        }
        const angle = (url.searchParams.get('angle') ?? '').trim() || '正面'
        const ids = (url.searchParams.get('ids') ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
        // 一次拿全量组：limit 上限 400 够 288 组，baseOfId 才能找到靠后的姿势
        const gallery = poseGallery({ launchDir: rt.config?.comfy?.launchDir ?? '', limit: 400 })
        const group = gallery.groups.find(item => item.base === base)
        if (group === undefined) {
          return { status: 404, json: { ok: false, error: 'no-pose', message: '姿势库里没有这个姿势：' + base } }
        }
        const picked = ids.length > 0
          ? group.variants.filter(variant => ids.includes(variant.id))
          : group.variants.filter(variant => variant.angle === angle)
        if (picked.length === 0) {
          return {
            status: 404,
            json: {
              ok: false,
              error: 'no-variant',
              message: '这个姿势没有 ' + (ids.length > 0 ? ids.join(' / ') : angle) + ' 这一张',
              angles: group.variants.map(variant => variant.angle),
            },
          }
        }
        const mod = await importPoseTags()
        if (mod === null) {
          return { status: 501, json: { ok: false, error: 'pose-tags-unavailable', message: '姿势标签映射还没就绪（lib/pose-tags.js）' } }
        }
        const items = []
        for (const variant of picked) {
          const mapped = callTagsForPose(mod, {
            base: group.base,
            code: group.code,
            name: group.name,
            category: group.category,
            angle: variant.angle,
            set: group.set,
          })
          const enriched = await enrichPoseTags(rt, mapped)
          items.push({
            id: variant.id,
            angle: variant.angle,
            pose: enriched.pose,
            camera: enriched.camera,
            tags: enriched.tags,
            reasons: enriched.reasons,
          })
        }
        const first = items[0]
        return {
          json: {
            ok: true,
            base,
            angle: first.angle,
            set: group.set,
            setLabel: group.setLabel,
            category: group.category,
            name: group.name,
            pose: first.pose,
            camera: first.camera,
            tags: first.tags,
            reasons: first.reasons,
            items,
          },
        }
      },
    },
    {
      path: '/forge',
      methods: ['POST'],
      handler: async ({ body }) => {
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        if (text === '') return { status: 400, json: { ok: false, error: 'empty-text', message: '先写点什么。' } }
        const result = await rt.forge.generate({
          text,
          options: body?.options !== null && typeof body?.options === 'object' ? body.options : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/upload',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.comfy.upload({
          filename: typeof body?.filename === 'string' ? body.filename : '',
          data: typeof body?.data === 'string' ? body.data : '',
          // subfolder 透传：不给就只能落 input 根，LoadImage 拿不到 refs/ 这类子目录前缀。
          subfolder: typeof body?.subfolder === 'string' ? body.subfolder : '',
        })
        return { status: result.ok ? 200 : 400, json: result }
      },
    },
    {
      path: '/run',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.comfy.submit({
          workflowId: typeof body?.workflowId === 'string' ? body.workflowId : '',
          positive: typeof body?.positive === 'string' ? body.positive : '',
          negative: typeof body?.negative === 'string' ? body.negative : '',
          vars: body?.vars !== null && typeof body?.vars === 'object' ? body.vars : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/job',
      methods: ['GET'],
      handler: async ({ url }) => {
        const promptId = url.searchParams.get('id') ?? ''
        const result = await rt.comfy.status(promptId)
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/image',
      methods: ['GET'],
      handler: async ({ url }) => {
        const filename = url.searchParams.get('filename') ?? ''
        const subfolder = url.searchParams.get('subfolder') ?? ''
        const type = url.searchParams.get('type') ?? 'output'
        const got = await rt.comfy.image({ filename, subfolder, type })
        if (!got.ok) return { status: 404, json: { ok: false, error: 'image', message: got.message } }
        return { binary: got.buffer, contentType: got.contentType }
      },
    },
    {
      path: '/tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const query = url.searchParams.get('q') ?? ''
        // limit 钳在 1..200：别让 ?limit=999999 把索引拖死，也别让 0 / 负数漏进查询
        const asked = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
        const limit = Math.min(200, Math.max(1, Number.isFinite(asked) ? asked : 20))
        // 冷启动先等索引建好（最多 3s），再看「词表刚改过要不要重建」
        await waitTagsReady(rt.tags)
        if (typeof rt.tags.ensureFresh === 'function') await rt.tags.ensureFresh()
        return { json: { rows: rt.tags.search(query, { limit }), stats: rt.tags.stats() } }
      },
    },
    {
      path: '/tags/canonicalize',
      methods: ['POST'],
      handler: async ({ body }) => {
        const list = Array.isArray(body?.tags) ? body.tags.map(String) : []
        await waitTagsReady(rt.tags)
        if (typeof rt.tags.ensureFresh === 'function') await rt.tags.ensureFresh()
        return { json: { rows: rt.tags.canonicalizeMany(list, { syntax: rt.config.tags.weightSyntax }) } }
      },
    },
    {
      path: '/purge',
      methods: ['GET', 'POST'],
      handler: async ({ method, body }) => {
        if (method === 'POST') {
          saveConfig(rt, { purge: body?.purge ?? body ?? {} })
          rt.forge.refreshPurge?.()
        }
        return {
          json: { purge: rt.forge.purgeState(), preview: rt.forge.systemPrompt({ preview: true }).slice(0, 4000) },
        }
      },
    },
    {
      path: '/mcp',
      methods: ['POST', 'GET'],
      handler: async ({ body }) => {
        const reply = await rt.mcp.handle(body)
        // 通知（无 id）回空响应；批量请求原样回数组，不能包 { ok:true }。
        if (reply === null || reply === undefined) return { status: 204 }
        return { raw: reply }
      },
    },
  ]
}
