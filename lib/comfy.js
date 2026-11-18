/**
 * ComfyUI 客户端：ping / 列工作流 / 投递 / 查状态 / 等出图 / 取图。
 *
 * 为什么自己写 HTTP 而不引依赖：插件要能零依赖装进 profile，node:http 够用；
 * 而且 /view 回的是二进制，直接收 Buffer 比 fetch 的 body 处理更直白。
 *
 * 铁律：submit 只"读"工作流文件，改的是内存里的深拷贝 —— 模板永远不被一次投递污染。
 * 这条不是洁癖：模板是复现凭据，被投递改过的模板会让"这张图当时用的参数"永久丢失。
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** 工作台数据目录（工作流模板、uploads、cache 都在这下面）。 */
export const WORKBENCH_DIR = path.join(os.homedir(), '.dsh-comfyui-workbench')

/** 工作流目录：配置优先，否则用工作台默认位置。每次现取，面板改完立刻生效。 */
export function resolveWorkflowDir(config) {
  const configured = typeof config?.comfy?.workflowDir === 'string' ? config.comfy.workflowDir.trim() : ''
  return configured === '' ? path.join(WORKBENCH_DIR, 'workflows') : path.resolve(configured)
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'
const TEXT_CLASS = /textencode/i
const NEGATIVE_TITLE = /negative|neg_|负向|反向|负面|消极/i
const POSITIVE_TITLE = /positive|正向|正面|肯定/i

function nowBaseUrl(config) {
  const raw = typeof config?.comfy?.baseUrl === 'string' ? config.comfy.baseUrl.trim() : ''
  return (raw === '' ? DEFAULT_BASE_URL : raw).replace(/\/+$/, '')
}

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 底层请求：收全 Buffer，超时/取消都转成异常，调用方统一 try/catch。 */
function request(target, options = {}) {
  const { method = 'GET', timeoutMs = 15000, signal } = options
  return new Promise((resolveRequest, rejectRequest) => {
    let url
    try {
      url = new URL(target)
    } catch {
      rejectRequest(new Error('地址不合法：' + target))
      return
    }
    const payload = options.body === undefined
      ? undefined
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(JSON.stringify(options.body), 'utf8')
    const headers = { Accept: '*/*', ...(options.headers ?? {}) }
    if (payload !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    const lib = url.protocol === 'https:' ? https : http
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      fn(value)
    }
    const req = lib.request(url, { method, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => finish(resolveRequest, {
        status: res.statusCode ?? 0,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
        url: target,
      }))
      res.on('error', error => finish(rejectRequest, error))
    })
    const timer = setTimeout(() => {
      req.destroy(new Error('请求超时（' + timeoutMs + 'ms）：' + method + ' ' + target))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    req.on('error', error => finish(rejectRequest, error))
    const onAbort = () => req.destroy(new Error('请求已取消：' + method + ' ' + target))
    if (signal !== undefined) {
      if (signal.aborted === true) {
        onAbort()
        return
      }
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    }
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 宽松 JSON 解析：坏响应也要能给出一条能读的消息，不是抛栈。 */
function parseJson(buffer) {
  const text = buffer.toString('utf8')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function bodyPreview(buffer, limit = 300) {
  const text = buffer.toString('utf8').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** UI 格式（界面工程文件带 nodes + links）不能直接投递，必须先 Export (API)。 */
export function isUiFormat(workflow) {
  return workflow !== null
    && typeof workflow === 'object'
    && Array.isArray(workflow.nodes)
    && (Array.isArray(workflow.links) || typeof workflow.last_node_id !== 'undefined')
}

function nodeIds(workflow) {
  return Object.keys(workflow).filter(key => {
    const node = workflow[key]
    return node !== null && typeof node === 'object' && typeof node.class_type === 'string'
  })
}

/** 节点标题：_meta.title（API 导出保留）+ title/comment 兜底。 */
function nodeTitle(node) {
  const meta = node?._meta ?? {}
  const title = meta.title ?? node?.title ?? meta.node_name ?? ''
  return typeof title === 'string' ? title : ''
}

function textNodes(workflow) {
  return nodeIds(workflow)
    .filter(id => {
      const node = workflow[id]
      return TEXT_CLASS.test(node.class_type) || typeof node?.inputs?.text === 'string'
    })
    .sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      return a.localeCompare(b)
    })
}

function bindingOf(variable) {
  const candidates = [variable?.node, variable?.nodeId, variable?.node_id, variable?.target, variable?.bind]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number') return String(candidate)
    if (candidate !== null && typeof candidate === 'object') {
      const inner = candidate.node ?? candidate.nodeId ?? candidate.id
      if (typeof inner === 'string' && inner.trim() !== '') return inner.trim()
      if (typeof inner === 'number') return String(inner)
    }
  }
  return ''
}

/**
 * 找正/负向节点。顺序：配置指定 > schema 变量绑定 > 标题语义 > 出现顺序。
 * 标题语义看中文（正向提示词/负向提示词）也看英文（positive/negative）—— 本机两套模板都有。
 */
export function resolveTextMapping(workflow, schema, config, warnings = []) {
  const nodes = textNodes(workflow)
  const has = id => id !== '' && workflow[id] !== undefined && typeof workflow[id]?.inputs?.text === 'string'
  const comfy = config?.comfy ?? {}
  let positiveNode = ''
  let negativeNode = ''

  for (const [field, assign] of [['positiveNode', value => { positiveNode = value }], ['negativeNode', value => { negativeNode = value }]]) {
    const wanted = typeof comfy[field] === 'string' ? comfy[field].trim() : ''
    if (wanted === '') continue
    if (has(wanted)) assign(wanted)
    else warnings.push('配置 comfy.' + field + '=' + wanted + ' 在工作流里不是 CLIPTextEncode 节点，已忽略')
  }

  for (const variable of Array.isArray(schema?.vars) ? schema.vars : []) {
    const name = String(variable?.name ?? '')
    const bound = bindingOf(variable)
    if (bound === '' || !has(bound)) continue
    if (/^negative/i.test(name) || name === 'negative_prompt' || name === '负向提示词') {
      if (negativeNode === '') negativeNode = bound
    } else if (/^positive/i.test(name) || name === 'prompt' || name === '正向提示词') {
      if (positiveNode === '') positiveNode = bound
    }
  }

  for (const id of nodes) {
    const title = nodeTitle(workflow[id])
    if (title === '') continue
    if (negativeNode === '' && NEGATIVE_TITLE.test(title) && !POSITIVE_TITLE.test(title)) negativeNode = id
    else if (positiveNode === '' && POSITIVE_TITLE.test(title) && !NEGATIVE_TITLE.test(title)) positiveNode = id
  }

  // 什么线索都没有：按出现顺序取，且两个节点必须不同 —— 同一节点既正又负等于没写负向。
  const rest = nodes.filter(id => id !== positiveNode && id !== negativeNode)
  if (positiveNode === '' && rest.length > 0) positiveNode = rest.shift()
  if (negativeNode === '' && rest.length > 0) negativeNode = rest.shift()

  if (positiveNode === '') {
    warnings.push('工作流里找不到 CLIPTextEncode 节点，正向提示词无处可写（用 comfy.positiveNode 指定节点 id）')
  }
  return { positiveNode, negativeNode, candidates: nodes }
}

function coerceVar(value, current, variable) {
  const declared = typeof variable?.type === 'string' ? variable.type.toLowerCase() : ''
  if (declared === 'number' || typeof current === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    return Number.isFinite(n) ? n : value
  }
  if (declared === 'boolean' || typeof current === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
    return value
  }
  if (declared === 'string' || typeof current === 'string') {
    return typeof value === 'string' ? value : String(value)
  }
  return value
}

/**
 * 把 vars 写进节点同名输入。支持三种键：
 *   'seed'        → 按 schema 变量绑定 / 输入同名匹配（每个工作流都能用）
 *   '7.seed'      → 精确打到节点 7 的 seed（工作流有两个 KSampler 时用这个）
 *   'prompt' / 'negative_prompt' → 已由 submit 单独处理，这里跳过
 */
export function applyVars(workflow, schema, vars, mapping, warnings = []) {
  const applied = []
  const skipped = []
  const internal = new Set((Array.isArray(schema?.internalInputs) ? schema.internalInputs : []).map(String))
  const declared = new Map()
  for (const variable of Array.isArray(schema?.vars) ? schema.vars : []) {
    if (typeof variable?.name === 'string') declared.set(variable.name, variable)
  }
  const promptNodeIds = new Set([mapping?.positiveNode, mapping?.negativeNode].filter(Boolean))

  for (const [key, raw] of Object.entries(vars ?? {})) {
    if (raw === undefined || raw === null) continue
    if (key === 'prompt' || key === 'negative_prompt' || key === 'positive' || key === 'negative') continue

    const dotted = /^([^.]+)\.([^.]+)$/.exec(key)
    if (dotted !== null) {
      const [, nodeId, input] = dotted
      const node = workflow[nodeId]
      if (node !== undefined && node.inputs !== null && typeof node.inputs === 'object') {
        node.inputs[input] = coerceVar(raw, node.inputs[input], declared.get(input))
        applied.push({ name: key, node: nodeId, input })
        continue
      }
      warnings.push('变量 ' + key + ' 没落到任何节点（工作流里没有节点 ' + nodeId + '）')
      skipped.push(key)
      continue
    }

    const variable = declared.get(key)

    // bindings：[{node,input}] —— 一个变量同时写进多个节点（姿势 id 要同时喂姿势图和姿势标签）。
    if (Array.isArray(variable?.bindings) && variable.bindings.length > 0) {
      let hit = 0
      for (const binding of variable.bindings) {
        const nodeId = String(binding?.node ?? '')
        const input = String(binding?.input ?? '')
        const node = workflow[nodeId]
        if (node === undefined || node.inputs === null || typeof node.inputs !== 'object') continue
        if (input === '' || !Object.hasOwn(node.inputs, input)) continue
        node.inputs[input] = coerceVar(raw, node.inputs[input], variable)
        applied.push({ name: key, node: nodeId, input })
        hit += 1
      }
      if (hit > 0) continue
      warnings.push('变量 ' + key + ' 的 bindings 没落到任何节点，已丢弃')
      skipped.push(key)
      continue
    }

    const bound = bindingOf(variable)
    if (bound !== '' && workflow[bound]?.inputs !== undefined && Object.hasOwn(workflow[bound].inputs, key)) {
      workflow[bound].inputs[key] = coerceVar(raw, workflow[bound].inputs[key], variable)
      applied.push({ name: key, node: bound, input: key })
      continue
    }

    if (internal.has(key)) {
      warnings.push('变量 ' + key + ' 是内部参数（' + [...internal].join('/') + '），不按名字覆盖；要改请用 <节点id>.' + key)
      skipped.push(key)
      continue
    }

    let target = ''
    for (const id of nodeIds(workflow)) {
      if (promptNodeIds.has(id)) continue
      const inputs = workflow[id].inputs
      if (inputs === null || typeof inputs !== 'object') continue
      if (!Object.hasOwn(inputs, key)) continue
      if (Array.isArray(inputs[key])) continue
      if (key === 'text') continue
      target = id
      break
    }
    if (target === '') {
      warnings.push('变量 ' + key + ' 在工作流里没有同名输入，已丢弃（可用 <节点id>.' + key + ' 精确指定）')
      skipped.push(key)
      continue
    }
    workflow[target].inputs[key] = coerceVar(raw, workflow[target].inputs[key], variable)
    applied.push({ name: key, node: target, input: key })
  }
  return { applied, skipped }
}

/** 读 schema：坏了不算致命，只是少标题/缺默认值。 */
function readSchema(schemaPath) {
  if (!fs.existsSync(schemaPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function varsFromSchema(schema, workflow, mapping) {
  const vars = []
  for (const variable of Array.isArray(schema?.vars) ? schema.vars : []) {
    if (variable === null || typeof variable !== 'object' || typeof variable.name !== 'string') continue
    vars.push({
      name: variable.name,
      label: typeof variable.label === 'string' ? variable.label : variable.name,
      group: typeof variable.group === 'string' ? variable.group : 'basic',
      type: typeof variable.type === 'string' ? variable.type : 'string',
      default: variable.default,
      ...(Array.isArray(variable.options) ? { options: variable.options } : {}),
      ...(Number.isFinite(variable.min) ? { min: variable.min } : {}),
      ...(Number.isFinite(variable.max) ? { max: variable.max } : {}),
      ...(Number.isFinite(variable.step) ? { step: variable.step } : {}),
      ...(typeof variable.hint === 'string' ? { hint: variable.hint } : {}),
    })
  }
  if (vars.length > 0) {
    // 没写 default 的补上模板当前值 —— 面板的输入框才有东西显示。
    // 按全模板找同名输入（不只正负两个节点）：width/seed 这些挂在别的节点上，
    // 只看文本节点会让它们永远空着。文本节点排前面，同名输入撞车时优先提示词节点。
    const textIds = [mapping?.positiveNode, mapping?.negativeNode].filter(nodeId => nodeId !== undefined && workflow[nodeId] !== undefined)
    const allIds = [...new Set([...textIds, ...nodeIds(workflow)])]
    for (const variable of vars) {
      if (variable.default !== undefined) continue
      const declared = (Array.isArray(schema?.vars) ? schema.vars : []).find(item => item?.name === variable.name)
      const bindings = Array.isArray(declared?.bindings) ? declared.bindings : []
      const boundFirst = bindings.find(binding => {
        const inputs = workflow[String(binding?.node ?? '')]?.inputs
        return inputs !== null && typeof inputs === 'object' && Object.hasOwn(inputs, String(binding?.input ?? ''))
      })
      if (boundFirst !== undefined) {
        variable.default = workflow[String(boundFirst.node)].inputs[String(boundFirst.input)]
        continue
      }
      const id = allIds.find(nodeId => {
        const inputs = workflow[nodeId]?.inputs
        return inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) && Object.hasOwn(inputs, variable.name)
      })
      if (id !== undefined) variable.default = workflow[id].inputs[variable.name]
    }
    return vars
  }
  // 没有 schema：从节点输入反推一份可用变量表（至少让面板能改 seed/宽高）
  const seen = new Set()
  for (const id of nodeIds(workflow)) {
    const inputs = workflow[id].inputs
    if (inputs === null || typeof inputs !== 'object') continue
    for (const [name, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) continue
      if (seen.has(name)) continue
      seen.add(name)
      vars.push({
        name,
        label: name,
        group: 'advanced',
        type: typeof value === 'number' ? 'number' : 'string',
        default: value,
      })
    }
  }
  return vars
}

function imagesOf(historyEntry, baseUrl) {
  const outputs = historyEntry?.outputs ?? {}
  const images = []
  for (const nodeOutput of Object.values(outputs)) {
    if (nodeOutput === null || typeof nodeOutput !== 'object') continue
    for (const list of [nodeOutput.images, nodeOutput.gifs, nodeOutput.videos]) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item === null || typeof item !== 'object' || typeof item.filename !== 'string') continue
        const subfolder = typeof item.subfolder === 'string' ? item.subfolder : ''
        const type = typeof item.type === 'string' ? item.type : 'output'
        const query = new URLSearchParams({ filename: item.filename, subfolder, type })
        images.push({
          filename: item.filename,
          subfolder,
          type,
          ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
          url: baseUrl + '/view?' + query.toString(),
        })
      }
    }
  }
  return images
}

function failureMessageOf(historyEntry) {
  const messages = Array.isArray(historyEntry?.status?.messages) ? historyEntry.status.messages : []
  for (const entry of messages) {
    if (!Array.isArray(entry)) continue
    const [kind, payload] = entry
    if (kind !== 'execution_error' && kind !== 'execution_interrupted') continue
    const detail = payload?.exception_message ?? payload?.message ?? payload?.node_type
    return (kind === 'execution_interrupted' ? '执行被中断' : '执行失败') + (detail ? '：' + String(detail).split('\n')[0] : '')
  }
  return '执行失败（ComfyUI 没有给具体原因）'
}

function summarizeHistory(entry) {
  const promptInfo = Array.isArray(entry?.prompt) ? entry.prompt : []
  const extra = promptInfo[3] !== null && typeof promptInfo[3] === 'object' ? promptInfo[3] : {}
  return {
    completed: entry?.status?.completed === true,
    status: entry?.status?.status_str ?? '',
    ...(typeof extra.create_time === 'number' ? { createTime: extra.create_time } : {}),
    ...(Array.isArray(promptInfo[4]) ? { outputNodes: promptInfo[4] } : {}),
  }
}

/**
 * @param {{ config?: object, logger?: { info?:Function, warn?:Function, error?:Function } }} deps
 */
export function createComfyClient({ config, logger } = {}) {
  const log = logger ?? {}
  const info = typeof log.info === 'function' ? log.info.bind(log) : () => {}
  const comfyCfg = () => (config?.comfy !== null && typeof config?.comfy === 'object' ? config.comfy : {})

  /** ComfyUI 活着吗？顺带把版本号带走 —— 面板用它显示服务状态。 */
  async function ping() {
    const baseUrl = nowBaseUrl(config)
    try {
      const res = await request(baseUrl + '/system_stats', { timeoutMs: 8000 })
      if (res.status !== 200) {
        return { ok: false, reachable: false, baseUrl, message: 'GET /system_stats 返回 HTTP ' + res.status + '：' + bodyPreview(res.buffer) }
      }
      const data = parseJson(res.buffer)
      if (data === null) {
        return { ok: false, reachable: false, baseUrl, message: '/system_stats 不是合法 JSON（地址指向了别的东西？）' }
      }
      const version = data?.system?.comfyui_version ?? data?.system?.version ?? ''
      const devices = Array.isArray(data?.devices) ? data.devices : []
      return {
        ok: true,
        reachable: true,
        version: String(version),
        baseUrl,
        system: {
          os: data?.system?.os ?? '',
          python: data?.system?.python_version ? String(data.system.python_version).split(' ')[0] : '',
          ramTotal: data?.system?.ram_total ?? null,
        },
        devices: devices.map(device => ({
          name: device?.name ?? '',
          vramTotal: device?.vram_total ?? null,
          vramFree: device?.vram_free ?? null,
        })),
      }
    } catch (error) {
      return {
        ok: false,
        reachable: false,
        baseUrl,
        message: '连不上 ComfyUI（' + baseUrl + '）：' + msgOf(error) + '。检查服务是否在跑，或面板设置里的地址。',
      }
    }
  }

  /** 扫工作流目录：<id>.json 是 API 格式模板，<id>.schema.json 是它的输入面。 */
  async function listWorkflows() {
    const dir = resolveWorkflowDir(config)
    if (!fs.existsSync(dir)) {
      return { ok: false, dir, workflows: [], message: '工作流目录不存在：' + dir + '（在面板设置里改 comfy.workflowDir，或把 API 格式 JSON 放进去）' }
    }
    let names
    try {
      names = fs.readdirSync(dir)
    } catch (error) {
      return { ok: false, dir, workflows: [], message: '读不了工作流目录：' + msgOf(error) }
    }
    const ids = names
      .filter(name => /\.json$/i.test(name) && !/\.schema\.json$/i.test(name))
      .map(name => name.slice(0, -5))
      .sort((a, b) => a.localeCompare(b))

    const workflows = []
    const problems = []
    for (const id of ids) {
      const workflowPath = path.join(dir, id + '.json')
      const schemaPath = path.join(dir, id + '.schema.json')
      let workflow = null
      let readError = ''
      try {
        workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'))
      } catch (error) {
        readError = 'JSON 解析失败：' + msgOf(error)
      }
      const schema = readSchema(schemaPath)
      const uiFormat = isUiFormat(workflow)
      const mapping = workflow !== null && !uiFormat
        ? resolveTextMapping(workflow, schema, config, [])
        : { positiveNode: '', negativeNode: '' }
      const entry = {
        id,
        title: typeof schema?.title === 'string' && schema.title.trim() !== '' ? schema.title : id,
        description: typeof schema?.description === 'string' ? schema.description : '',
        vars: workflow !== null && !uiFormat ? varsFromSchema(schema, workflow, mapping) : [],
        path: workflowPath,
        schemaPath: fs.existsSync(schemaPath) ? schemaPath : '',
        format: uiFormat ? 'ui' : 'api',
        nodes: workflow !== null && !uiFormat ? nodeIds(workflow).length : 0,
        mapping: { positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode },
        hasSchema: schema !== null,
      }
      if (readError !== '') {
        entry.error = readError
        problems.push(id + '：' + readError)
      } else if (uiFormat) {
        entry.message = '这是 UI 格式（含 nodes/links），请在 ComfyUI 里 Export (API) 重新导出后再放进来'
        problems.push(id + '：UI 格式')
      }
      workflows.push(entry)
    }

    return {
      ok: true,
      dir,
      workflows,
      ...(problems.length > 0 ? { warnings: problems } : {}),
      ...(workflows.length === 0 ? { message: '目录里还没有 API 格式的工作流 JSON：' + dir } : {}),
    }
  }

  /** 读一份工作流（深拷贝，绝不回写）。id 空则取目录里第一个。 */
  function loadWorkflow(workflowId) {
    const dir = resolveWorkflowDir(config)
    const requested = String(workflowId ?? '').trim()
    const configured = typeof comfyCfg().defaultWorkflowId === 'string' ? comfyCfg().defaultWorkflowId.trim() : ''
    let id = requested !== '' ? requested : configured
    const available = (() => {
      try {
        return fs.readdirSync(dir)
          .filter(name => /\.json$/i.test(name) && !/\.schema\.json$/i.test(name))
          .map(name => name.slice(0, -5))
          .sort((a, b) => a.localeCompare(b))
      } catch {
        return []
      }
    })()

    if (id === '') {
      if (available.length === 0) {
        return { ok: false, error: 'no-workflow', dir, message: '没有可用工作流：' + dir + ' 里没有 <id>.json' }
      }
      id = available[0]
    }
    // 大小写不一致时按忽略大小写再找一次，省得手抄错一个字母就卡住
    if (!available.includes(id)) {
      const loose = available.find(name => name.toLowerCase() === id.toLowerCase())
      if (loose !== undefined) id = loose
    }
    if (!available.includes(id)) {
      return {
        ok: false,
        error: 'workflow-not-found',
        dir,
        message: '工作流 ' + id + ' 不存在。目录里可用：' + (available.length === 0 ? '（空）' : available.join(' / ')),
      }
    }
    const workflowPath = path.join(dir, id + '.json')
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(workflowPath, 'utf8'))
    } catch (error) {
      return { ok: false, error: 'bad-workflow', dir, id, message: '工作流 JSON 读不了：' + msgOf(error) }
    }
    if (isUiFormat(parsed)) {
      return {
        ok: false,
        error: 'ui-format',
        dir,
        id,
        message: '工作流 ' + id + ' 是 UI 格式（含 nodes/links），ComfyUI 的 /prompt 只吃 API 格式：请在界面里 Export (API) 后重新放进来',
      }
    }
    if (nodeIds(parsed).length === 0) {
      return { ok: false, error: 'bad-workflow', dir, id, message: '工作流 ' + id + ' 里没有 class_type 节点，不像 API 格式' }
    }
    return {
      ok: true,
      id,
      dir,
      path: workflowPath,
      schemaPath: path.join(dir, id + '.schema.json'),
      schema: readSchema(path.join(dir, id + '.schema.json')),
      workflow: JSON.parse(JSON.stringify(parsed)),
    }
  }

  /** 投递：读模板 → 内存深拷贝 → 写正向/负向 + vars → POST /prompt。 */
  async function submit({ workflowId = '', positive = '', negative = '', vars = {} } = {}) {
    const loaded = loadWorkflow(workflowId)
    if (!loaded.ok) {
      return { ok: false, workflowId: String(workflowId ?? ''), error: loaded.error, dir: loaded.dir, message: loaded.message }
    }

    const { workflow, schema, id } = loaded
    const warnings = []
    const mapping = resolveTextMapping(workflow, schema, config, warnings)
    const positiveText = typeof positive === 'string' ? positive.trim() : ''
    const negativeText = typeof negative === 'string' ? negative.trim() : ''

    if (positiveText !== '' || negativeText !== '') {
      if (mapping.positiveNode === '') {
        return {
          ok: false,
          workflowId: id,
          error: 'no-prompt-node',
          mapping: { positiveNode: '', negativeNode: mapping.negativeNode },
          warnings,
          message: '工作流 ' + id + ' 里找不到可以写提示词的 CLIPTextEncode 节点（用 comfy.positiveNode 指定节点 id）',
        }
      }
      if (positiveText !== '') workflow[mapping.positiveNode].inputs.text = positiveText
      if (negativeText !== '') {
        if (mapping.negativeNode === '') warnings.push('工作流里没有单独的负向节点，负向提示词没写进去')
        else workflow[mapping.negativeNode].inputs.text = negativeText
      }
    }

    const applied = applyVars(workflow, schema, vars, mapping, warnings)
    const clientId = crypto.randomUUID()
    const body = { prompt: workflow, client_id: clientId }
    const baseUrl = nowBaseUrl(config)

    let res
    try {
      res = await request(baseUrl + '/prompt', {
        method: 'POST',
        body,
        timeoutMs: num(comfyCfg().submitTimeoutMs, 120000, 5000, 600000),
      })
    } catch (error) {
      return {
        ok: false,
        workflowId: id,
        error: 'unreachable',
        mapping: { positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode },
        warnings,
        message: '投递失败，连不上 ComfyUI（' + baseUrl + '）：' + msgOf(error),
      }
    }

    const data = parseJson(res.buffer)
    const nodeErrors = data?.node_errors !== null && typeof data?.node_errors === 'object' ? data.node_errors : {}
    const nodeErrorIds = Object.keys(nodeErrors ?? {})
    const topError = data?.error
    if (res.status !== 200 || topError !== undefined || nodeErrorIds.length > 0) {
      const details = []
      if (topError !== undefined) {
        details.push(typeof topError === 'string' ? topError : (topError.message ?? topError.type ?? JSON.stringify(topError)))
      }
      for (const nodeId of nodeErrorIds) {
        const errors = nodeErrors[nodeId]?.errors
        const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null
        details.push('节点 ' + nodeId + (first?.message ? '：' + first.message : '') + (first?.details ? '（' + first.details + '）' : ''))
      }
      if (details.length === 0) details.push('HTTP ' + res.status + ' ' + bodyPreview(res.buffer))
      return {
        ok: false,
        workflowId: id,
        error: 'rejected',
        status: res.status,
        mapping: { positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode },
        nodeErrors,
        applied: applied.applied,
        warnings,
        message: 'ComfyUI 拒收这次任务：' + details.join('；'),
      }
    }

    const promptId = typeof data?.prompt_id === 'string' ? data.prompt_id : ''
    if (promptId === '') {
      return {
        ok: false,
        workflowId: id,
        error: 'no-prompt-id',
        mapping: { positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode },
        warnings,
        message: 'ComfyUI 没回 prompt_id：' + bodyPreview(res.buffer),
      }
    }

    info('已投递 ' + id + ' → ' + promptId + '（正向节点 ' + mapping.positiveNode + '，负向节点 ' + (mapping.negativeNode || '无') + '）')
    return {
      ok: true,
      promptId,
      workflowId: id,
      mapping: { positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode },
      applied: applied.applied,
      skipped: applied.skipped,
      warnings,
      queueNumber: typeof data?.number === 'number' ? data.number : null,
      clientId,
    }
  }

  /** 一次状态查询：历史里查完再问队列，done/failed 优先（历史是终态，队列是过程）。 */
  async function status(promptId) {
    const id = String(promptId ?? '').trim()
    const baseUrl = nowBaseUrl(config)
    if (id === '') return { ok: false, promptId: '', state: 'unknown', images: [], message: '缺 promptId' }

    let queueRes
    let historyRes
    try {
      ;[queueRes, historyRes] = await Promise.all([
        request(baseUrl + '/queue', { timeoutMs: 8000 }),
        request(baseUrl + '/history/' + encodeURIComponent(id), { timeoutMs: 8000 }),
      ])
    } catch (error) {
      return { ok: false, promptId: id, state: 'unknown', images: [], message: '查状态的请求失败（' + baseUrl + '）：' + msgOf(error) }
    }

    const queue = parseJson(queueRes.buffer) ?? {}
    const history = parseJson(historyRes.buffer) ?? {}
    const historyEntry = history !== null && typeof history === 'object' ? history[id] : undefined

    if (historyEntry !== undefined && historyEntry !== null) {
      const images = imagesOf(historyEntry, baseUrl)
      const statusStr = historyEntry?.status?.status_str
      const completed = historyEntry?.status?.completed === true
      if (statusStr === 'error') {
        return {
          ok: true,
          promptId: id,
          state: 'failed',
          images,
          message: failureMessageOf(historyEntry),
          history: summarizeHistory(historyEntry),
        }
      }
      if (statusStr === 'success' || completed === true || images.length > 0) {
        return {
          ok: true,
          promptId: id,
          state: 'done',
          images,
          progress: 1,
          message: images.length === 0 ? '任务完成，但工作流里没有保存节点（加 SaveImage 才能取图）' : undefined,
          history: summarizeHistory(historyEntry),
        }
      }
    }

    const running = Array.isArray(queue.queue_running) ? queue.queue_running : []
    const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : []
    const isMine = entry => (Array.isArray(entry) ? entry[1] === id : entry?.prompt_id === id)
    if (running.some(isMine)) {
      return { ok: true, promptId: id, state: 'running', images: [], queuePosition: 0 }
    }
    const pendingIndex = pending.findIndex(isMine)
    if (pendingIndex >= 0) {
      return { ok: true, promptId: id, state: 'queued', images: [], queuePosition: pendingIndex + 1 }
    }

    return {
      ok: true,
      promptId: id,
      state: 'unknown',
      images: [],
      message: '队列和历史里都没有这个 promptId：可能刚提交还没入队（等一秒再查），或历史已被清空',
    }
  }

  /** 轮询到终态；超时返回最后一次状态 + timedOut，交给面板决定是继续等还是放弃。 */
  async function waitFor(promptId, { timeoutMs, pollIntervalMs } = {}) {
    const started = Date.now()
    const limit = num(timeoutMs ?? comfyCfg().timeoutMs, 900000, 1000, 3600000)
    const interval = num(pollIntervalMs ?? comfyCfg().pollIntervalMs, 1000, 50, 30000)
    let last = await status(promptId)
    for (;;) {
      if (last.state === 'done' || last.state === 'failed') {
        return { ...last, waitedMs: Date.now() - started, timedOut: false }
      }
      if (Date.now() - started + interval >= limit) break
      await sleep(interval)
      last = await status(promptId)
    }
    return {
      ...last,
      ok: false,
      waitedMs: Date.now() - started,
      timedOut: true,
      message: last.message ?? ('等出图超时（' + limit + 'ms），任务可能还在排队；用 prompt_forge_status 继续查'),
    }
  }

  /** 取图：/view 回二进制，这里原样转交 Buffer + content-type。 */
  async function image({ filename = '', subfolder = '', type = 'output' } = {}) {
    const baseUrl = nowBaseUrl(config)
    const name = String(filename ?? '').trim()
    if (name === '') return { ok: false, message: '缺 filename' }
    const query = new URLSearchParams({
      filename: name,
      subfolder: typeof subfolder === 'string' ? subfolder : '',
      type: typeof type === 'string' && type !== '' ? type : 'output',
    })
    try {
      const res = await request(baseUrl + '/view?' + query.toString(), { timeoutMs: 30000 })
      if (res.status !== 200) {
        return {
          ok: false,
          status: res.status,
          message: 'ComfyUI 取图失败（HTTP ' + res.status + '）：' + name + '。文件可能被清理了，或 type/subfolder 不对',
        }
      }
      return {
        ok: true,
        buffer: res.buffer,
        contentType: String(res.headers['content-type'] ?? 'image/png').split(';')[0],
        bytes: res.buffer.length,
        url: res.url,
      }
    } catch (error) {
      return { ok: false, message: '取图请求失败（' + baseUrl + '）：' + msgOf(error) }
    }
  }

  /** 上传参考图：写进 ComfyUI 的 input 目录，返回可给 LoadImage 用的文件名。 */
  async function upload({ filename, data, subfolder } = {}) {
    const launchDir = typeof config?.comfy?.launchDir === 'string' ? config.comfy.launchDir.trim() : ''
    if (launchDir === '') return { ok: false, error: 'no-launch-dir', message: '还没配 comfy.launchDir，找不到 ComfyUI 的 input 目录' }
    const raw = typeof filename === 'string' ? filename : ''
    const ext = path.extname(raw).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext) === false) {
      return { ok: false, error: 'bad-type', message: '只收 png / jpg / webp 参考图' }
    }
    const payload = typeof data === 'string' ? data.replace(/^data:[^,]*,/, '') : ''
    if (payload === '') return { ok: false, error: 'empty-file', message: '参考图是空的' }
    let buffer = null
    try { buffer = Buffer.from(payload, 'base64') } catch { return { ok: false, error: 'bad-base64', message: '参考图不是合法的 base64' } }
    if (buffer === null || buffer.length === 0) return { ok: false, error: 'empty-file', message: '参考图是空的' }
    if (buffer.length > 24 * 1024 * 1024) return { ok: false, error: 'too-large', message: '参考图超过 24MB，先压一下' }
    const dir = path.join(launchDir, 'input', typeof subfolder === 'string' ? subfolder.trim() : '')
    const stamp = crypto.randomBytes(4).toString('hex')
    const base = raw.replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(0, 60) || 'ref'
    const name = 'tagger_ref_' + stamp + '_' + base
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), buffer)
    } catch (error) {
      return { ok: false, error: 'write-failed', message: '写不进 ComfyUI 的 input 目录：' + msgOf(error) }
    }
    return { ok: true, name, bytes: buffer.length, dir, hint: '把 name 填进 vars.image' }
  }
  return {
    ping,
    listWorkflows,
    submit,
    status,
    waitFor,
    image,
    upload,
    // 面板调试用（不在契约里，但只读、无副作用）
    workflowDir: () => resolveWorkflowDir(config),
    baseUrl: () => nowBaseUrl(config),
  }
}
