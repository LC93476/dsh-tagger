# DSh Tagger 契约文档

这份文档是**给扩展作者看的**：想接别的插件、想加自己的标签源、想拿标签去别处出图、想做 web 版，
都按这里的接口说话。核心代码（`lib/tags.js` / `lib/forge.js` / `lib/refine.js` / `lib/comfy.js`）
**不 import 任何外部东西**，扩展只能从 SPI 注册表插进来 —— 这是刻意的：卸载时整批 dispose，不会留尾巴。

## 1. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `index.js` | 宿主入口：`name` / `inject` / `apply(ctx, config)`；装配 runtime、注册 HTTP 前缀、注册 MCP 工具 |
| `client.js` | 浏览器端面板（`window.__ModuleLoader__.load` 工厂），侧边栏 + better-sidebar 页签 |
| `lib/tags.js` | 标签索引：读 `data/tags/*.jsonl` 与 `<dataDir>/tags/*.jsonl`，别名归一、中英对照、格式化 |
| `lib/forge.js` | 锻造器：白话 → 调 LLM → 解析 JSON → 过标签库校验 → 标签串 |
| `lib/refine.js` | 二次精修：在一串已有标签上做增量增删/调权，**不重跑整串** |
| `lib/purge.js` | 破甲系统提示词（档位 off / light / standard / full / max） |
| `lib/comfy.js` | ComfyUI 客户端：模板 → 变量注入 → `POST /prompt` → 轮询 `/history` |
| `lib/mcp.js` | MCP 服务端（JSON-RPC over HTTP），供外部 MCP 客户端调用 |
| `lib/spi.js` | 扩展注册表（槽位 + 钩子） |
| `lib/routes.js` | 路由表与 dispatch（前缀可换，支持旧前缀共存） |
| `server/standalone.mjs` | 脱离 DSH 的独立 HTTP 服务（web 版入口） |

## 2. 二次精修契约（`lib/refine.js`）

```js
import { createRefiner } from './lib/refine.js'

const refiner = createRefiner({ config, llm, tags, logger, spi })

const result = await refiner.refine({
  positive: '1girl, silver hair, on_bed',   // 已有正向串（必需，可为空串）
  negative: '',                             // 已有负向串（可选）
  instruction: '加一点夜晚室内光和汗',        // 白话指令
  mode: 'add',                              // add | edit | prune | weights
  options: {},                              // 覆盖 maxNewTags / temperature / maxTokens / timeoutMs / keepOrder
})
```

返回：

```js
{
  ok: true,
  positive: '1girl, silver hair, on_bed, night, indoors, sweat',
  negative: '',
  tags: [{ tag: '1girl', weight: 1, cn: '一个女孩' }, ...],
  delta: {
    added: ['night', 'indoors', 'sweat'],
    removed: [],
    weighted: [{ tag: 'silver_hair', from: 1, to: 1.2 }],
  },
  ops: { mode: 'add', received: 3, kept: 1, dropped: 0 },
  notes: '补了夜景与光线',
  ms: 6210,
  model: 'deepseek-v4.1-flash',
  purgeLevel: 'full',
  warnings: [],
}
```

四种 `mode` 的语义：

- `add`：在现有串上补齐缺失标签，不动已有标签与权重；新增上限 `config.refine.maxNewTags`。
- `edit`：按指令改画面 —— 删掉冲突标签、加新标签。
- `prune`：只删冗余/冲突，不新增。
- `weights`：只调权重，标签集合不变。

硬约束（实现与调用方都可以依赖）：

1. **不重跑整串**：模型只输出差分 JSON，输出预算与小标签集无关。
2. **所有新增过标签库校验**：`tags.canonicalizeMany` 命中不了的丢弃并进 `warnings`，绝不出现库里没有的 tag。
3. `keepOrder: true`（默认）时用户已有标签顺序不变，新增追加在尾部；`false` 才允许重排。
4. 失败不抛：`{ ok: false, error, warnings }`，HTTP 层对应 502。

HTTP 对应：`POST /tagger/api/refine`，body `{ positive, negative, instruction | text, mode, options }`。

## 3. SPI 契约（`lib/spi.js`）

```js
import { createRegistry, SPI_VERSION, SLOTS, HOOKS } from './lib/spi.js'
const spi = createRegistry({ logger, config })
```

### 槽位（SLOTS）

| 槽位 | 实现形状 |
| --- | --- |
| `tagProviders` | `{ id, label, search(term, limit) → [{ tag, cn }] }` |
| `postProcessors` | `{ id, apply(result, ctx) → result }`，按注册顺序串行，返回值替换上一步结果 |
| `workflowBackends` | `{ id, label, ping() , listWorkflows(), submit(payload), status(id) }` |
| `panels` | `{ id, label, mount(el, api) }`（web 版用） |

```js
const dispose = spi.register('tagProviders', 'my-dict', {
  label: '我的词表',
  search(term, limit) { return [{ tag: 'my_tag', cn: '我的词' }] },
})
// 卸载时 dispose()
```

同名 `id` 重复注册会先 dispose 旧的再替换；返回的 `dispose()` 幂等。

### 钩子（HOOKS）

`beforeForge` / `afterForge` / `beforeRefine` / `afterRefine` / `beforeSubmit` / `afterSubmit`

```js
const off = spi.on('afterForge', async (payload, ctx) => {
  payload.result.notes = (payload.result.notes ?? '') + ' [已过我的规则]'
}, { id: 'my-rule' })
```

钩子收到的 payload 可**就地改写**；单个钩子抛错只记日志，后续钩子照跑，主流程绝不中断。

### 注册表 API

```
version, register(slot, id, impl, meta) -> dispose, has(slot,id), get(slot,id),
entries(slot), values(slot), on(hook, fn, meta) -> off,
emit(hook, payload, ctx), applyPostProcessors(result, ctx),
searchProviders(term, limit), describe()
```

`describe()` 的形状（`GET /tagger/api/spi` 原样返回）：

```js
{
  version: 1,
  slots: { tagProviders: [{ id: 'my-dict', label: '我的词表' }], postProcessors: [], workflowBackends: [], panels: [] },
  hooks: { beforeForge: [], afterForge: ['my-rule'], ... },   // 每项是钩子 id 数组
  backends: [{ id, label }],
}
```

## 4. 客户端契约（`client.js`）

必须是模块加载器认得的形状：

```js
window.__ModuleLoader__.load({
  id: 'dsh-tagger',
  factory(require) {
    const React = require('react')
    return { inject: ['slots'], apply(ctx) { /* 注册面板 */ } }
  },
})
```

两个入口：

- 侧边栏图标：`slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id, order, label }, Icon))`
- 主面板：`slots.inject('main', () => slots.register({ name: 'main', key: id }, Panel))`
- better-sidebar 页签（可选服务，用 `ctx.inject` 才摸得到）：
  ```js
  ctx.inject(['betterSidebar'], scope => scope.effect(() => {
    const dispose = scope.betterSidebar.registerTab({ id, title: () => t('title'), description, icon, order, single: true, component })
    return () => dispose()
  }, 'tagger: sidebar tab'))
  ```

文案：`client.js` 内嵌 `dict` 与 `locale/zh.json`、`locale/en.json` 是**三份副本**，加键必须三处同改
（`tests/render.test.mjs` 会检查有没有裸键漏出来）。

样式只用宿主设计 token：`--dsw-alias-bg-base|bg-layer-1..3`、`--dsw-alias-border-l1..l4`、
`--dsw-alias-label-primary|secondary|tertiary|caption`、`--dsw-alias-brand-primary`、
`--dsw-alias-button-primary-fill|button-primary-hover`、`--dsw-alias-state-success|warn|error-primary`、
`--dsw-radius-xs|sm|md|lg|xl|panel`。类名前缀统一 `.ptf-`。

## 5. web 版 / 别的宿主怎么接

`server/standalone.mjs` 做的就是「自己造一个最小 ctx」：

```js
const ctx = {
  get(service) { /* 'llm' | 'webServer' | 'tools' */ },
  effect(fn) { /* 返回 dispose 的注册 */ },
  inject(deps, fn) { /* 可选服务 */ },
}
```

只要你的宿主能提供 `llm`（`stream({provider, model, messages, ...})` 产出
`{type:'text-delta', text}` / `{type:'finish', kind}`）和 `webServer`
（`register({ kind: 'prefix', path, handler }) → dispose`），整套 `/tagger/api` 就活了。

## 6. 兼容与版本

- `SPI_VERSION = 1`：槽位/钩子名变了才跳版本，新增槽位算兼容。
- HTTP 前缀 `/tagger/api`；旧前缀 `/prompt-forge/api` 由同一个 dispatch 同时注册（`LEGACY_PREFIX`），
  老脚本不用改。
- MCP：`SERVER_INFO.name = 'dsh-tagger'`，工具集在 `lib/mcp.js`，详见 `docs/API.md`。
