// plan: server/standalone.mjs 的端到端测试——真起进程、真发 HTTP、真关掉
/**
 * 独立入口的冒烟测试。
 *
 * 为什么起真进程：standalone 的职责就是「没有 DSH 也能跑」，直接拿 createRuntime 测不到
 * CLI 解析、端口绑定、SIGTERM 收尾这些真正容易坏的地方。
 *
 * 两条约束：
 *   1. 不联网：llm 不配置，health 里 llmReady 必须是 false，任何一个请求都不该出网。
 *   2. 不碰用户数据：--data-dir 指向临时目录，用完删掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'server', 'standalone.mjs')
const READY = /STANDALONE_READY url=(\S+)/

/** 等子进程打印 STANDALONE_READY（--port 0 时真实端口只有它知道）。 */
function waitForReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('standalone 启动超时，已收到输出：' + output.slice(0, 800)))
    }, timeoutMs)
    const onOut = chunk => {
      output += String(chunk)
      const hit = READY.exec(output)
      if (hit === null) return
      cleanup()
      resolve(hit[1])
    }
    const onErr = chunk => {
      output += String(chunk)
    }
    const onExit = code => {
      cleanup()
      reject(new Error('standalone 提前退出（code=' + code + '）：' + output.slice(0, 800)))
    }
    function cleanup() {
      clearTimeout(timer)
      child.stdout.off('data', onOut)
      child.stderr.off('data', onErr)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onOut)
    child.stderr.on('data', onErr)
    child.on('exit', onExit)
  })
}

/** SIGTERM 优雅退出：超时就硬杀，测试别吊死。 */
function stop(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
    child.kill('SIGTERM')
  })
}

/** 等它自己退出（--help 这种跑完就走的场景，别抢着发信号）。 */
function waitExit(child, timeoutMs = 15000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function spawnStandalone(args, env) {
  return spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

test('standalone：health / spi / spi.version / 根路径 HTML 都能对外提供', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-standalone-'))
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  // 明确「没配模型接口」：health 必须如实说 llmReady:false，且不许联网
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL

  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  try {
    const url = await waitForReady(child)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)

    const healthRes = await fetch(url + '/tagger/api/health')
    assert.equal(healthRes.status, 200)
    const health = await healthRes.json()
    assert.equal(health.ok, true)
    assert.equal(health.plugin, 'dsh-tagger')
    assert.equal(health.mode, 'standalone')
    assert.equal(health.llmReady, false)
    assert.equal(health.basePath, '/tagger/api')
    assert.equal(health.mcp.endpoint, '/tagger/api/mcp')
    assert.equal(typeof health.port, 'number')

    const spiRes = await fetch(url + '/tagger/api/spi')
    assert.equal(spiRes.status, 200)
    const spi = await spiRes.json()
    assert.equal(spi.ok, true)
    assert.equal(typeof spi.spi.version, 'number')
    assert.ok(Array.isArray(spi.spi.slots.tagProviders))

    // 根路径 = 能直接用的锻造台面板（不是信息页）
    const rootRes = await fetch(url + '/')
    assert.equal(rootRes.status, 200)
    assert.match(rootRes.headers.get('content-type') ?? '', /text\/html/)
    const panel = await rootRes.text()
    assert.ok(panel.includes('DSh Tagger'), '面板标题里要有产品名')
    assert.ok(panel.includes('锻造台'), '根路径要直接是面板，不是信息页')
    assert.ok(panel.includes('"/tagger/api"'), '面板要打到自己这个前缀上')
    assert.ok(panel.includes('二次精修'), '面板要有二次精修区块')

    const panelAlias = await fetch(url + '/panel')
    assert.equal(panelAlias.status, 200)
    assert.equal(await panelAlias.text(), panel, '/panel 与 / 必须是同一份面板')

    // 信息页挪到 /about，仍然保留健康状态与接口清单
    const aboutRes = await fetch(url + '/about')
    assert.equal(aboutRes.status, 200)
    const html = await aboutRes.text()
    assert.ok(html.includes('DSh Tagger'))
    assert.ok(html.includes('/tagger/api/health'))
    assert.ok(html.includes('/tagger/api/mcp'))

    // 旧前缀要跟 DSH 宿主里保持一致，老脚本不用改地址
    const legacyRes = await fetch(url + '/prompt-forge/api/health')
    assert.equal(legacyRes.status, 200)
    const legacy = await legacyRes.json()
    assert.equal(legacy.plugin, 'dsh-tagger')

    // 没有的路径仍然是结构化的 404，不是裸崩
    const missing = await fetch(url + '/tagger/api/nope')
    assert.equal(missing.status, 404)
    const missingBody = await missing.json()
    assert.equal(missingBody.ok, false)
    assert.equal(missingBody.error, 'unknown-route')
  } finally {
    await stop(child)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('standalone：--help 打印用法后退出 0，不占端口', { timeout: 30000 }, async () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const child = spawnStandalone(['--help'], env)
  let output = ''
  child.stdout.on('data', chunk => {
    output += String(chunk)
  })
  const code = await waitExit(child, 15000)
  assert.equal(code, 0)
  assert.ok(output.includes('--port'))
  assert.ok(output.includes('DSH_TAGGER_BASE_URL'))
})

test('standalone：面板能填接口与 ComfyUI，保存后立刻生效（不用重启）', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-standalone-'))
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL

  // 一个假模型服务：/v1/models 列一个模型，用来验证 /llm/probe 真能连通
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: "stub-model" }] }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
  const stubUrl = 'http://127.0.0.1:' + stub.address().port

  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  try {
    const url = await waitForReady(child)
    const panel = await (await fetch(url + '/')).text()
    for (const id of ['接口设置', 'llm-baseurl', 'llm-key', 'llm-model', 'comfy-baseurl', 'comfy-dir', 'comfy-python', 'comfy-workflows', 'comfy-default', '测试连接', '启动 ComfyUI']) {
      assert.ok(panel.includes(id), '面板要能填 ' + id)
    }

    // 初始：没配 key，且 /config 里绝不出现明文 key
    const before = await (await fetch(url + '/tagger/api/config')).json()
    assert.equal(before.config.llm.apiKeySet, false)
    assert.equal(Object.prototype.hasOwnProperty.call(before.config.llm, 'apiKey'), false)

    // 面板保存接口 → settings.json → 下一次请求就用新值（standalone 不重启）
    const saved = await fetch(url + '/tagger/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { llm: { baseUrl: stubUrl + '/v1', apiKey: 'sk-standalone-test', model: 'stub-model' } } }),
    })
    const savedBody = await saved.json()
    assert.equal(savedBody.config.llm.apiKeySet, true)
    assert.equal(savedBody.config.llm.apiKeyHint, '…test')
    assert.equal(JSON.stringify(savedBody).includes('sk-standalone-test'), false, '配置视图不能漏明文 key')

    const health = await (await fetch(url + '/tagger/api/health')).json()
    assert.equal(health.llmReady, true, '保存接口后 health 立刻就该说 ready')
    assert.equal(health.llm.endpoint, stubUrl + '/v1/chat/completions')
    assert.equal(health.llm.model, 'stub-model')

    // 测试连接：拿面板填的地址与 key 打 /models
    const probe = await fetch(url + '/tagger/api/llm/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: stubUrl, apiKey: 'sk-standalone-test' }),
    })
    assert.equal(probe.status, 200)
    const probeBody = await probe.json()
    assert.equal(probeBody.ok, true)
    assert.deepEqual(probeBody.models, ['stub-model'])
    assert.equal(probeBody.endpoint, stubUrl + '/v1/models')

    // 面板字段留空时用「已经保存的」配置去探活：测试连接不该逼用户重敲 key
    const fallback = await fetch(url + '/tagger/api/llm/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: '', apiKey: '' }),
    })
    assert.equal(fallback.status, 200)
    assert.deepEqual((await fallback.json()).models, ['stub-model'])

    // ComfyUI 设置同样能存能回读（这里只验证落配置，不真连）
    const comfySaved = await fetch(url + '/tagger/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { comfy: { baseUrl: 'http://127.0.0.1:9', launchDir: 'D:/tmp/comfy', pythonPath: 'D:/tmp/comfy/python/python.exe', defaultWorkflowId: 'stub-wf' } } }),
    })
    const comfyCfg = (await comfySaved.json()).config.comfy
    assert.equal(comfyCfg.baseUrl, 'http://127.0.0.1:9')
    assert.equal(comfyCfg.launchDir, 'D:/tmp/comfy')
    assert.equal(comfyCfg.defaultWorkflowId, 'stub-wf')
  } finally {
    await stop(child)
    await new Promise(resolve => stub.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})
