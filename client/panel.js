// 面板主组件：状态、副作用、动作。视图由 view-*.js 负责，这里只做组装。
import { API, DEFAULT_POLL_MS, JOB_KEY, LEVELS, NS, PANEL_ID, REFINE_MODES, TAB_ID } from './constants.js'
import { createT, dict, withFallback } from './locale.js'
import { chosenStandards, clampInt, describe, formatTag, formatTagLine, normalizeDelta, normalizePipeline, normalizePurge, normalizeTags } from './state.js'
import { apiUrl, imageSrc, readAsDataUrl, requestJson } from './api.js'
import { createIcon } from './icon.js'
import { shell } from './view-shell.js'

// 面板组件：只放状态、钩子与动作；渲染全在 client/view-*.js 里，靠一个 bag 传进去。
export function createPanel({ React }) {
  const h = React.createElement
function Panel(props) {
  const t = typeof props?.t === 'function' ? props.t : createT('zh')
  const api = typeof props?.api === 'string' && props.api !== '' ? props.api : API
  const pollMs = Number.isFinite(props?.pollIntervalMs) && props.pollIntervalMs > 0 ? props.pollIntervalMs : DEFAULT_POLL_MS

  const [text, setText] = React.useState('')
  const [standards, setStandards] = React.useState({ wd: true, camie: true })
  const [maxTags, setMaxTags] = React.useState(40)
  const [level, setLevel] = React.useState('full')
  const [workflows, setWorkflows] = React.useState([])
  const [workflowState, setWorkflowState] = React.useState('loading')
  const [workflowError, setWorkflowError] = React.useState('')
  const [workflowId, setWorkflowId] = React.useState('')
  const [forge, setForge] = React.useState({ status: 'idle', error: '' })
  const [result, setResult] = React.useState(null)
  const [run, setRun] = React.useState({ status: 'idle', promptId: '', images: [], error: '' })
  // 参考图：只有 feiyue-sam3-ref 这类模板用得上（深度图锁体态），选完立刻传到 ComfyUI 的 input/
  const [refName, setRefName] = React.useState('')
  const [refBusy, setRefBusy] = React.useState(false)
  const [refError, setRefError] = React.useState('')
  const [settings, setSettings] = React.useState({
    provider: '',
    model: '',
    level: 'full',
    baseUrl: '',
    workflowDir: '',
    launchDir: '',
    pythonPath: '',
    // 本地三道后处理的开关（存 settings.json，改完点保存立刻生效，不用重启）
    forgeRepair: true,
    forgePostprocess: true,
    forgePoseHints: true,
    forgeCandidates: true,
  })
  const [comfyStatus, setComfyStatus] = React.useState({ state: 'checking', version: '', message: '', busy: '', launchDir: '', command: '' })
  const [settingsStatus, setSettingsStatus] = React.useState('idle')
  const [settingsError, setSettingsError] = React.useState('')
  const [copyStatus, setCopyStatus] = React.useState('idle')
  const [copyPair, setCopyPair] = React.useState('idle')
  const [purgeInfo, setPurgeInfo] = React.useState({ enabled: true, level: 'full', modules: [], chars: 0 })
  // 二次精修：指令、模式、请求状态、上一次的 delta（全空时给「没有改动」）。
  const [refine, setRefine] = React.useState({ instruction: '', mode: 'add', status: 'idle', error: '', delta: null })
  // SPI 自述：拿不到（旧服务端没有 /spi）就不显示徽标，不打扰用户。
  const [spi, setSpi] = React.useState({ ok: false, version: 0, slots: 0, hooks: 0 })

  React.useEffect(() => {
    let alive = true
    const boot = async () => {
      const wf = await requestJson(api + '/workflows')
      if (!alive) return
      if (wf.ok && Array.isArray(wf.payload?.workflows)) {
        setWorkflows(wf.payload.workflows)
        setWorkflowState('ready')
        setWorkflowError('')
      } else {
        setWorkflowState('error')
        setWorkflowError(wf.message || t('workflow.error'))
      }
      const cfg = await requestJson(api + '/config')
      if (!alive) return
      if (cfg.ok && cfg.payload?.config) {
        const c = cfg.payload.config
        setSettings({
          provider: String(c.llm?.provider ?? ''),
          model: String(c.llm?.model ?? ''),
          level: String(c.purge?.level ?? 'full'),
          baseUrl: String(c.comfy?.baseUrl ?? ''),
          workflowDir: String(c.comfy?.workflowDir ?? ''),
          launchDir: String(c.comfy?.launchDir ?? ''),
          pythonPath: String(c.comfy?.pythonPath ?? ''),
          forgeRepair: c.forge?.repair !== false,
          forgePostprocess: c.forge?.postprocess !== false,
          forgePoseHints: c.forge?.poseHints !== false,
          forgeCandidates: c.forge?.candidates !== false,
        })
        if (Array.isArray(c.tags?.standards)) {
          setStandards({ wd: c.tags.standards.includes('wd'), camie: c.tags.standards.includes('camie') })
        }
        if (Number.isFinite(c.tags?.maxTags)) setMaxTags(c.tags.maxTags)
        if (typeof c.purge?.level === 'string') setLevel(c.purge.level)
        if (typeof c.comfy?.defaultWorkflowId === 'string' && c.comfy.defaultWorkflowId !== '') {
          setWorkflowId(c.comfy.defaultWorkflowId)
        }
      } else if (!cfg.ok) {
        setSettingsError(cfg.message || t('error.config'))
      }
      // 破甲灯要有服务端状态：/state 里的 purge 才是「当前生效」的那一份。
      const st = await requestJson(api + '/state')
      if (!alive) return
      const purge = st.ok ? st.payload?.purge : null
      if (purge !== null && purge !== undefined && typeof purge === 'object') setPurgeInfo(normalizePurge(purge))
      // /spi 是自述接口：老版本没有这个路由，失败就当没有，不报错。
      const sp = await requestJson(api + '/spi')
      if (!alive) return
      const spiInfo = sp.ok ? sp.payload?.spi : null
      if (spiInfo !== null && spiInfo !== undefined && typeof spiInfo === 'object') {
        setSpi({
          ok: true,
          version: Number(spiInfo.version) || 0,
          slots: Array.isArray(spiInfo.slots) ? spiInfo.slots.length : Number(spiInfo.slots) || 0,
          hooks: Array.isArray(spiInfo.hooks) ? spiInfo.hooks.length : Number(spiInfo.hooks) || 0,
        })
      }
      // ComfyUI 连不上是常态（没开、在换模型），所以状态要能自证：/comfy 同时回 ping 与启动计划。
      applyComfy(await requestJson(api + '/comfy'))
    }
    boot()
    return () => {
      alive = false
    }
  }, [])

  // 15 秒一次静默探活：用户自己去开 ComfyUI 时，灯不用他点也会亮。
  React.useEffect(() => {
    let alive = true
    const timer = setInterval(() => {
      if (!alive) return
      setComfyStatus(current => {
        if (current.busy === '') requestJson(api + '/comfy').then(res => { if (alive) applyComfy(res) })
        return current
      })
    }, 15000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  React.useEffect(() => {
    const promptId = run.promptId
    if (promptId === '') return undefined
    if (run.status !== 'queued' && run.status !== 'running') return undefined
    let alive = true
    const tick = async () => {
      const res = await requestJson(apiUrl(api, '/job', { id: promptId }))
      if (!alive) return
      if (!res.ok) {
        setRun(prev => ({ ...prev, status: 'failed', error: res.message || t('error.job') }))
        return
      }
      const payload = res.payload ?? {}
      const state = typeof payload.state === 'string' ? payload.state : 'unknown'
      const images = Array.isArray(payload.images) ? payload.images : []
      setRun(prev => ({
        ...prev,
        status: JOB_KEY[state] ?? 'unknown',
        images: images.length > 0 ? images : prev.images,
        error: typeof payload.message === 'string' && state === 'failed' ? payload.message : '',
      }))
    }
    const timer = setInterval(tick, Math.max(1, pollMs))
    tick()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [run.promptId, run.status])



  const positiveText = result === null
    ? ''
    : result.chips.length > 0 ? formatTagLine(result.chips) : result.positive
  const negativeText = result === null
    ? ''
    : result.negativeChips.length > 0 ? formatTagLine(result.negativeChips) : result.negative


  // 中英对照：一行一条「(tag:权重) — 中文」。权重跟着正向串走（1 不带括号），
  // 库里没中文就只留带权重的 tag，不编中文、不留空破折号。
  const pairOf = chip => {
    const weighted = typeof chip.weight === 'number' && chip.weight !== 1
      ? '(' + chip.tag + ':' + chip.weight + ')'
      : chip.tag
    return chip.cn === '' || chip.cn === undefined ? weighted : weighted + ' — ' + chip.cn
  }
  const pairLines = (result?.chips ?? []).map(pairOf)
  const bilingualText = pairLines.join('\n')
  const negativePairText = (result?.negativeChips ?? []).map(pairOf).join('\n')

  const generate = async () => {
    const value = text.trim()
    if (value === '') {
      setForge({ status: 'error', error: t('error.emptyText') })
      return
    }
    setForge({ status: 'forging', error: '' })
    setCopyStatus('idle')
    setRun({ status: 'idle', promptId: '', images: [], error: '' })
    // 新一轮锻造换了结果，上一轮的 delta 就不再对应当前标签了。
    setRefine(previous => ({ ...previous, status: 'idle', error: '', delta: null }))
    const res = await requestJson(api + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: value,
        options: { standards: chosenStandards(standards), maxTags, purgeLevel: level },
      }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setForge({ status: 'error', error: res.payload?.message ?? res.message ?? t('error.forge') })
      return
    }
    const payload = res.payload
    setResult({
      positive: String(payload.positive ?? ''),
      negative: String(payload.negative ?? ''),
      chips: normalizeTags(payload.tags),
      negativeChips: normalizeTags(payload.negativeTags),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map(item => String(item)) : [],
      raw: String(payload.raw ?? ''),
      model: String(payload.model ?? ''),
      ms: Number(payload.ms) || 0,
      repaired: payload.repaired === true,
      pipeline: normalizePipeline(payload.pipeline),
    })
    if (typeof payload.purgeLevel === 'string' && LEVELS.includes(payload.purgeLevel)) {
      setPurgeInfo(previous => normalizePurge({ ...previous, level: payload.purgeLevel }))
    }
    setForge({ status: 'done', error: '' })
  }

  const isRefWorkflow = workflowId.indexOf('ref') >= 0
  // 参考图模板才带 image 变量；其它模板传了也会被 applyVars 丢掉，但保持请求干净更好
  const runVars = isRefWorkflow && refName !== '' ? { image: refName } : {}

  const pickRef = async event => {
    const file = event?.target?.files?.[0]
    if (file === undefined || file === null) return
    setRefBusy(true)
    setRefError('')
    try {
      const dataUrl = await readAsDataUrl(file)
      const res = await requestJson(api + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: String(file.name ?? 'ref.png'), data: dataUrl }),
      })
      if (!res.ok || res.payload?.ok === false) {
        setRefName('')
        setRefError(res.payload?.message ?? res.message ?? t('ref.failed'))
      } else {
        setRefName(String(res.payload?.name ?? ''))
      }
    } catch (error) {
      setRefName('')
      setRefError(describe(error))
    } finally {
      setRefBusy(false)
    }
  }

  const submitRun = async () => {
    if (positiveText === '') return
    setRun({ status: 'submitting', promptId: '', images: [], error: '' })
    const res = await requestJson(api + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, positive: positiveText, negative: negativeText, vars: runVars }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setRun({ status: 'failed', promptId: '', images: [], error: res.payload?.message ?? res.message ?? t('error.run') })
      return
    }
    const promptId = String(res.payload?.promptId ?? '')
    setRun({
      status: promptId === '' ? 'failed' : 'queued',
      promptId,
      images: [],
      error: promptId === '' ? t('error.run') : '',
    })
  }

  const removeChip = index => {
    if (result === null) return
    setResult({ ...result, chips: result.chips.filter((_, at) => at !== index) })
  }

  // 二次精修：拿「当前看得见的」正负向串（用户可能已经点掉过芯片）去让模型增删标签，
  // 成功后用返回的 tags/positive/negative 覆盖结果，其它字段（raw/warnings）保持原样。
  const runRefine = async () => {
    if (result === null || refine.status === 'running') return
    setRefine(previous => ({ ...previous, status: 'running', error: '', delta: null }))
    const res = await requestJson(api + '/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        positive: positiveText,
        negative: negativeText,
        instruction: refine.instruction.trim(),
        mode: refine.mode,
        options: {},
      }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setRefine(previous => ({
        ...previous,
        status: 'failed',
        error: String(res.payload?.message ?? res.message ?? t('refine.failed')),
        delta: null,
      }))
      return
    }
    const payload = res.payload ?? {}
    const negativeGiven = typeof payload.negative === 'string' && payload.negative !== formatTagLine(result === null ? [] : result.negativeChips)
    setResult(previous => previous === null ? previous : ({
      ...previous,
      positive: typeof payload.positive === 'string' ? payload.positive : previous.positive,
      negative: typeof payload.negative === 'string' ? payload.negative : previous.negative,
      chips: normalizeTags(payload.tags),
      // 负向串变了但没给负向芯片时，宁可留空（回落 result.negative），也不留过期芯片。
      negativeChips: Array.isArray(payload.negativeTags)
        ? normalizeTags(payload.negativeTags)
        : negativeGiven ? [] : previous.negativeChips,
      model: typeof payload.model === 'string' && payload.model !== '' ? payload.model : previous.model,
      ms: Number(payload.ms) > 0 ? Number(payload.ms) : previous.ms,
    }))
    setRefine(previous => ({ ...previous, status: 'done', error: '', delta: normalizeDelta(payload.delta) }))
    if (typeof payload.purgeLevel === 'string' && LEVELS.includes(payload.purgeLevel)) {
      setPurgeInfo(previous => normalizePurge({ ...previous, level: payload.purgeLevel }))
    }
  }

  const copyPositive = async () => {
    if (positiveText === '') return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(positiveText)
        setCopyStatus('copied')
      } else {
        setCopyStatus('failed')
      }
    } catch (error) {
      setCopyStatus('failed')
    }
  }

  const copyBilingual = async () => {
    if (bilingualText === '') return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(bilingualText)
        setCopyPair('copied')
      } else {
        setCopyPair('failed')
      }
    } catch (error) {
      setCopyPair('failed')
    }
  }
  const saveSettings = async () => {
    setSettingsStatus('saving')
    setSettingsError('')
    const res = await requestJson(api + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          llm: { provider: settings.provider, model: settings.model },
          purge: { level: settings.level },
          forge: {
            repair: settings.forgeRepair,
            postprocess: settings.forgePostprocess,
            poseHints: settings.forgePoseHints,
            candidates: settings.forgeCandidates,
          },
          comfy: {
            baseUrl: settings.baseUrl,
            workflowDir: settings.workflowDir,
            launchDir: settings.launchDir,
            pythonPath: settings.pythonPath,
          },
        },
      }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setSettingsStatus('error')
      setSettingsError(res.payload?.message ?? res.message ?? t('settings.failed'))
      return
    }
    setSettingsStatus('saved')
    setLevel(settings.level)
    setPurgeInfo(previous => normalizePurge({ ...previous, level: settings.level }))
    const fresh = await requestJson(api + '/state')
    if (fresh.ok) {
      const purge = fresh.payload?.purge
      if (purge !== null && purge !== undefined && typeof purge === 'object') setPurgeInfo(normalizePurge(purge))
    }
  }

  const patchSettings = patch => setSettings(previous => ({ ...previous, ...patch }))

  /** 把 /comfy 的响应折成灯的状态；连不上也要给出「为什么」，别只留一个灰点。 */
  const applyComfy = (res) => {
    const payload = res && res.ok && res.payload !== null && typeof res.payload === 'object' ? res.payload : null
    if (payload === null) {
      setComfyStatus(previous => ({
        ...previous,
        state: 'offline',
        version: '',
        message: String(res?.message ?? t('comfy.offline')),
        busy: '',
      }))
      return
    }
    const status = payload.status !== null && typeof payload.status === 'object' ? payload.status : {}
    const launch = payload.launch !== null && typeof payload.launch === 'object' ? payload.launch : {}
    const online = status.ok === true
    setComfyStatus(previous => ({
      ...previous,
      state: online ? 'online' : 'offline',
      version: online ? String(status.version ?? '') : '',
      message: online ? '' : String(status.message ?? launch.message ?? t('comfy.offline')),
      launchDir: String(launch.dir ?? ''),
      command: String(launch.command ?? ''),
      busy: '',
    }))
  }

  const checkComfy = async () => {
    setComfyStatus(previous => ({ ...previous, busy: 'check' }))
    applyComfy(await requestJson(api + '/comfy'))
  }

  const startComfy = async () => {
    setComfyStatus(previous => ({ ...previous, busy: 'launch' }))
    const res = await requestJson(api + '/comfy/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitMs: 60000 }),
    })
    const payload = res.payload !== null && typeof res.payload === 'object' ? res.payload : {}
    if (!res.ok || payload.ok === false) {
      setComfyStatus(previous => ({
        ...previous,
        state: 'offline',
        busy: '',
        message: String(payload.message ?? res.message ?? t('comfy.launchFailed')),
        launchDir: String(payload.dir ?? previous.launchDir),
      }))
      return
    }
    setComfyStatus(previous => ({
      ...previous,
      state: payload.state === 'online' ? 'online' : 'starting',
      version: String(payload.status?.version ?? previous.version),
      message: String(payload.message ?? ''),
      launchDir: String(payload.dir ?? previous.launchDir),
      command: String(payload.command ?? previous.command),
      busy: '',
    }))
  }
  const p = {
    h,
    t,
    api,
    text,
    setText,
    standards,
    setStandards,
    maxTags,
    setMaxTags,
    level,
    setLevel,
    workflows,
    workflowState,
    workflowError,
    workflowId,
    setWorkflowId,
    forge,
    result,
    run,
    refine,
    setRefine,
    runRefine,
    copyStatus,
    copyPair,
    refName,
    refBusy,
    refError,
    positiveText,
    negativeText,
    bilingualText,
    negativePairText,
    pairLines,
    settings,
    settingsStatus,
    settingsError,
    patchSettings,
    saveSettings,
    comfyStatus,
    checkComfy,
    startComfy,
    purgeInfo,
    spi,
    generate,
    submitRun,
    removeChip,
    copyPositive,
    copyBilingual,
    pickRef,
    isRefWorkflow,
  }
  return shell(p)
  }

  return { Panel }
}

export { NS, API, PANEL_ID, TAB_ID, LEVELS, REFINE_MODES, JOB_KEY, DEFAULT_POLL_MS } from './constants.js'
export { dict, createT, withFallback } from './locale.js'
export { describe, clampInt, formatTag, formatTagLine, normalizeTags, normalizePipeline, normalizePurge, normalizeDelta, chosenStandards } from './state.js'
export { apiUrl, imageSrc, requestJson, readAsDataUrl } from './api.js'
export { createIcon } from './icon.js'
export { shell } from './view-shell.js'
