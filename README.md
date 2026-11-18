# DSh Tagger（dsh-tagger）

用一句白话描述画面，直接锻造成 **WD + Camie** 标准的标签串，再一键投给 ComfyUI 出图；
锻造完还能让 AI 对标签做**二次精修**（加/删/调权重），不用再手抄一遍。

从老的 `dsh-prompt-forge` 派生，工程名 `dsh-tagger`，目标形态是**桌面端优先 + web 版可脱离 DSH 独立跑**。

## 装法

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml（或 web profile）
- insert:
    - id: tagger
      name: dsh-tagger
      config: { ... }   # 见本仓库 cordis.patch.yml
```

装完重启 DSH：宿主对插件模块**没有 cache-busting**，改 `index.js` / `lib/*.js` 必须重启进程才生效；
`data/tags/*.jsonl` 词表改动会热重载，不用重启。

面板入口：左侧栏图标 + better-sidebar 页签「标签」。
HTTP 前缀 `/tagger/api`，旧前缀 `/prompt-forge/api` 同时兼容。

## 面板能干什么

1. 写白话（中文），选档位/上限，点「锻造」→ 得到带权重的标签串。
2. **中英对照 · 带权重**框：一行一条 `(tag:1.2) — 中文`，可整段复制。
3. **二次精修**：写一句「再补点室内光线和汗」，选 add / edit / prune / weights，
   让 AI 在现有串上做增量改动 —— 已有标签顺序不变，新增的一定在词表里。
4. 选模板 → 一键出图；头像灯显示破甲档位，SPI 徽标显示扩展接口版本。
5. **换姿势**：出图区点那张姿势卡（左边缩略图 + 中文名）打开缩略图墙 —— 1439 张人体线稿按中文名/编号/分类搜，按体系（standard / sexy / upper / couple）筛，点一张即选中，卡面跟着变成那张图。缩略图由 `tools/make-pose-thumbs.py` 预先压到 220px（原图 500KB → 7KB），走 `GET /pose-thumb`。旁边「CN 强度」只对 `feiyue-sam3-pose*` 生效。
6. **用自己的图锁体态**：「出图」区一直显示（不用先锻造），里面那行「参考图」也在；工作流下拉里带 `〔参考图〕` 后缀的才是参考图模板（`feiyue-sam3-ref`），选中后这一行才可点 —— 选一张本地图，面板会自动 `POST /upload` 传进 ComfyUI 的 `input/`，再带上 `vars.image` 出图。骨架从图里提（深度图 → ControlNet），提示词只负责长相、衣服、场景。`cnStrength` 越像就调高（0.5–0.7），只想借姿势压到 0.3。
   下拉读的是 ComfyUI 里 `ai-pose-gallery-zh` 的姿势库（4 个体系去重后 1439 个姿势 id，`侧坐・单手支撑・身体柔弯` 这种中文名 + 角度），
   选 `斜侧`/`侧面` 通常比正面摆拍自然；强度 0.3–0.45 是松档，0 完全不锁姿势（只靠提示词），0.6 以上会变僵硬。
   API 侧等价于 `vars: { pose: 'full_sexy_P016_diag', cnStrength: 0.38 }`，姿势清单在 `GET /tagger/api/poses?q=侧坐`。
   > 在 ComfyUI 里点开「㉚ 姿势库（深度图）」弹窗时，右上角默认是 **🛡️ 安全模式 (SFW)**，
   > 它会藏掉「全身单人・性感系」和「双人缠绵」两个体系 —— 这就是为什么弹窗里看着全是站姿/坐姿，很死板。
   > 点一下那个按钮变成 **🔞 18+ 完整模式**，性感系姿势才会出来（插件这边的下拉不受这个开关限制，一直是全库）。

## 目录

```
index.js                宿主入口（HTTP 前缀 + MCP 工具）
client.js               侧边栏面板门面（实现拆在 client/）
client/                 面板子模块（locale / api / state / ui / views）
lib/tags.js             标签索引统一入口（实现拆在 lib/tags/）
lib/tags/text.js        归一化/键名/转义/权重写法（纯函数）
lib/tags/loader.js      读盘、overlay 签名、建索引
lib/tags/matcher.js     检索、canonicalize、中文对照、近邻建议
lib/tags/index.js       懒加载、热重载、进程内单例（resetTagIndexCache）
lib/forge.js            锻造器
lib/repair.js           词形修复（差一点就对 → 库里真词）
lib/postprocess.js      去重、降权、13 段排序、裁剪门面（规则表在 lib/postprocess/rules.js）
lib/zh-intent.js        中文姿势/视角意图与候选注入
lib/refine.js           二次精修门面（实现拆在 lib/refine/）
lib/purge.js            破甲系统提示词
lib/comfy.js            ComfyUI 投递
lib/backend-common.js   后端公共层（HTTP / 超时 / 错误归一 / 轮询）
lib/mcp.js              MCP 服务端
lib/spi.js              扩展注册表
lib/routes.js           路由与 dispatch
lib/config.js           默认配置与归一化
server/standalone.mjs   脱离 DSH 的独立服务
server/public/          Web 面板静态资源（panel.css / api.js / state.js / app.js）
scripts/win/            Windows 启停脚本（根目录 .cmd/.vbs 只是转发）
tools/                  开发期工具（见下）
tests/                  16 个测试套件
docs/CONTRACT.md        核心契约（模块 / 配置 / 路由 / SPI / 客户端）
docs/API.md             接口手册（HTTP 路由 + MCP 工具）
docs/PERF.md            实测性能数字与健壮性清单（scripts/bench.mjs）
```

`tools/` 里都是**开发期**用的，运行时不需要：

| 脚本 | 用途 | 运行时要不要 |
| --- | --- | --- |
| `tools/make-pose-thumbs.py` | 把姿势库 1439 张 500KB 原图压成 220px 缩略图（走 PIL，需要 Python） | **不要**，缩略图已随 ComfyUI 节点目录生成；换机器/换姿势库时才重跑 |
| `tools/ui2api.mjs` | 把 ComfyUI 的 UI 格式工作流转成 API 格式模板 | 不要 |
| `tools/make-public.mjs` | 生成公开发布版（见文末） | 不要 |
| `scripts/build-tags.mjs` | 校验/统计词表覆盖情况 | 不要 |
```

## 测试与静态检查

本机 bash 没有 node，用 Electron 当 node：

```bash
cd "/d/DSh tagger"
ELECTRON_RUN_AS_NODE=1 "C:/Users/34701/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --test --test-concurrency=1 tests/*.test.mjs
```

（`--test` 必须逐文件列；给目录会 MODULE_NOT_FOUND。`--test-concurrency=1` 不能省：几个套件会读同一份
默认词表目录，进程并行时可能撞上另一个进程正在重写 overlay，表现为偶发 1 条失败，单跑必绿。）

16 个套件：`comfy` `forge` `http` `mcp` `poses` `postprocess` `refine` `render` `repair` `shim`
`standalone` `tags` `tags-pose` `ui2api` `upload` `zh-intent`。

词表结构自检（`data/tags/*.jsonl` 每行合法性 + 同文件内 tag 重复检查，CI 第一道门禁）：

```bash
node scripts/check-tags.mjs          # 有问题 exit 1，并列出「文件:行号 原因」
```

类型检查（不进构建，纯检查；`tsconfig.json` 是 `allowJs` + `checkJs` + `noEmit`）：

```bash
npm i --no-save typescript @types/node   # 只在本地查，不写进依赖
npx tsc --noEmit -p tsconfig.json
```

CI 跑同样的三道门禁（词表自检 → 类型检查 → 全量测试），配置在 `.github/workflows/ci.yml`。

> 注意：这个 workflow 文件**暂时没有随仓提交**。当前推送用的 GitHub token 只有 `repo` scope，
> GitHub 会拒绝任何创建/修改 `.github/workflows/*.yml` 的推送（`refusing to allow a Personal Access Token to
> create or update workflow … without workflow scope`）。给 token 加上 `workflow` scope 后，删掉 `.gitignore`
> 里那两行、`git add .github/workflows/ci.yml && git commit && git push` 就补齐了。本地等价命令就是上面这三条。

## 装了哪两个 profile

| profile | 包 | 前缀 | 备注 |
| --- | --- | --- | --- |
| `~/.dsh/profiles/desktop` | `dsh-tagger`（junction → `D:\DSh tagger`） | `/tagger/api` + 旧 `/prompt-forge/api` | 桌面端主用 |
| `~/.dsh/profiles/web` | `dsh-tagger`（junction → `D:\DSh tagger`） | 同上 | 原 `dsh-prompt-forge` 条目已改名为 `tagger`，旧包目录保留可回滚 |

两个 profile 指向同一份源码，改完只需重启对应进程；旧前缀由 `index.js` / `server/standalone.mjs`
各自 try 注册一次，失败只记日志（不会因为两条都注册而崩）。


## 双击启动（不经过 DSH）

根目录下三个脚本，双击就行（真正的实现归档在 `scripts/win/`，根目录这三个只是转发入口，
为的是保持"双击根目录某个文件"的老习惯；要改逻辑改 `scripts/win/` 里那份）：

| 脚本 | 作用 |
| --- | --- |
| `start-tagger.cmd` | 前台起服务（黑窗就是日志），自动打开 `http://127.0.0.1:7789/` 面板。关窗口 = 停服务。 |
| `start-tagger-hidden.vbs` | 同上但不出黑窗（想彻底静默用这个），面板照样自动打开。 |
| `stop-tagger.cmd [端口]` | 按端口结束服务（默认 7789，端口被占又不记得窗口在哪时用）。 |

`scripts/win/` 里另有 `tagger.env.cmd.example` —— 复制到**仓库根目录**改名 `tagger.env.cmd` 才会被读到。

脚本自己找运行时：先 `where node`，找不到就用 DeepSeek Harness 自带的 Electron（`ELECTRON_RUN_AS_NODE=1`）
当 node 跑，所以本机没装 node 也能启动。端口已经在监听时不重复起，直接开面板。

### 想用锻造 / 精修的话再配一次模型接口

独立服务拿不到 DSH 宿主的 `llm` 服务，得直接给一个 OpenAI 兼容接口。把 `scripts/win/tagger.env.cmd.example`
复制成 `tagger.env.cmd`（脚本会自动 `call` 它），填其中一段：

```bat
set "DSH_TAGGER_BASE_URL=https://api.deepseek.com"
set "DSH_TAGGER_API_KEY=sk-xxxxxxxx"
set "DSH_TAGGER_MODEL=deepseek-chat"
```

不填也能启动：面板会显示 `llm 未配置`，标签检索与 ComfyUI 投递照常，锻造 / 精修直接回 `no-llm` 而不是卡住。
`tagger.env.cmd` 里有密钥，别提交到任何仓库。

### 独立服务的页面

| 路径 | 内容 |
| --- | --- |
| `/` `/panel` `/panel.html` | 锻造台面板（白话 → 中英对照 → 二次精修 → 选工作流出图） |
| `/about` | 信息页：健康状态、数据目录、接口清单 |
| `/tagger/api/*` | 全部 HTTP 接口（旧 `/prompt-forge/api/*` 同样可用） |
| `/tagger/api/mcp` | MCP JSON-RPC 端点 |

## 命令行独立跑（不用 DSH）

```bash
cd "/d/DSh tagger"
node server/standalone.mjs --port 7789 --base-url https://api.example.com/v1 --api-key sk-xxx --model deepseek-v4.1-flash
# 或全用环境变量：DSH_TAGGER_BASE_URL / DSH_TAGGER_API_KEY / DSH_TAGGER_MODEL / DSH_TAGGER_DATA / DSH_TAGGER_WORKFLOW_DIR
```

起来后 `http://127.0.0.1:7789/` 是 web 壳，接口在 `/tagger/api`，MCP 在 `/tagger/api/mcp`。
不配 `--base-url/--api-key` 时 `llmReady:false`，只跑标签库与 ComfyUI 投递，锻造与精修会直接回 `no-llm` 而不是卡住。

## 词表

`data/tags/*.jsonl` 是自带补丁词表；用户自己的放 `~/.dsh-tagger/tags/*.jsonl`
（每行 `{"tag":"...","cn":"中文","aliases":["同义词"]}`）。两个目录都会加载，改完下一次查询自动重建索引。

## 本地三道后处理（白话 → 标签的兜底）

模型只负责"看图说话"，拼写与排序靠本地三道确定性处理，任何一道出错都只记 warning、不打断锻造：

| 顺序 | 模块 | 干什么 | 关掉的开关 |
| --- | --- | --- | --- |
| ① 词形修复 | `lib/repair.js` | 把 `top_down_bottom_up` / `one_leg_up` / `hair_long` 这类"差一点就对"的词纠回库里真词（连字符、撇号、单复数、空格、近邻建议），只动查不到的，修不上就原样留着并进 warning | `forge.repair: false` |
| ② 姿势意图 | `lib/zh-intent.js` | 白话里说「跪趴」「翘起屁股」「从正后方拍」「回头看」「跪在床边」时，把 `all_fours` / `arched_back` / `from_behind` / `looking_back` / `kneeling` 补进去（只补缺失、保序、权重 1.05–1.12） | `forge.poseHints: false` |
| ③ 去重合序 | `lib/postprocess.js` | 真同义只留一个（保 `from_side` 删 `profile`）、上位词降权到 0.85 不删、按 13 段稳定排序（服装必在镜头前）、超上限按段优先级裁剪、一个人数词都没有时补 `1girl` | `forge.postprocess: false` |

另外每次锻造前会用`selectCandidates`把白话里检索到的**库里真有的候选中英词**塞进提示词（RAG），模型不用自己回忆拼写；关掉用 `forge.candidates: false`，条数用 `forge.candidateLimit` 调（默认 18）。

未收录的词**不会静默消失**：它们留在结果里，同时 warning 里报「xxx 不在库里」——删不删由你决定。

### 三道处理改了什么，结果卡里看得见

结果卡芯片下面多一条「本地处理」：`修正 top_down_bottom_up→top-down-bottom-up · 补词 all_fours、kneeling · 整理 profile`。
服务端 `/forge` 响应里对应 `pipeline: { repairs, poseHints, changes }`（形状见 docs/API.md）；
`changes` 只留"看得见的动作"，排序/分桶这类内部步骤和已进 warning 的未收录词不重复列。

### web 面板里填模型接口与 ComfyUI

独立服务（`start-tagger.cmd`）没有宿主 llm 服务，所以面板顶部有「接口设置」：

| 区块 | 填什么 | 按钮 |
| --- | --- | --- |
| 模型 API | 接口地址（OpenAI 兼容，可带 `/v1`）、API Key、模型名、provider 名 | 保存接口 · 测试连接 |
| ComfyUI | 地址、安装目录、python 路径、工作流模板目录、默认工作流 id | 保存 ComfyUI · 检测连通 · 启动 ComfyUI |

保存写进 `settings.json`，**下一次锻造就用新值，不用重启**；Key 存进后 `GET /config` 只回「已配置 + 尾号」，不回明文。
（Key 本身是明文落在 `~/.dsh-tagger/settings.json` 里，跟其他本地配置同权限 —— 接口不吐它，但能读这个文件的人能看到。）

常见地址：

| 服务 | 接口地址 | 说明 |
| --- | --- | --- |
| OpenCode Go（本机在用的那个） | `https://opencode.ai/inference/go/v1` | 模型名填 `deepseek-v4.1-flash`；这个服务要求每条请求带 `x-opencode-session`，插件会自动补 |
| DeepSeek 官方 | `https://api.deepseek.com/v1` | — |
| 任意 OpenAI 兼容（LM Studio / Ollama / OneAPI） | `http://127.0.0.1:1234/v1` 之类 | 本地服务 Key 随便填非空即可 |
「测试连接」打 `POST /tagger/api/llm/probe` 去问 `/v1/models`：连上会告诉你看到几个模型，连不上给地址与原因。
DSH 面板不需要填这些 —— 那边走宿主自己的模型服务。

### 开关在哪改

| 位置 | 生效方式 |
| --- | --- |
| DSH 面板 → 设置 → **本地后处理**（四个勾选框） | 点保存写进 settings.json，**立刻生效**，不用重启 |
| Web 面板（start-tagger.cmd 开的那个）→ 顶部四个勾选框 | 勾了即保存，立刻生效 |
| `POST /tagger/api/config` `{"patch":{"forge":{...}}}` | 同上 |

只有改 `lib/*.js` 本身才需要重启宿主（插件模块没有 cache-busting）。

## 公开发布版（和谐版）

本仓库是完整版（含内置成人词表）。对外发布的版本由生成器产出，不是手改的分叉：

    node tools/make-public.mjs --dst "D:/DSh tagger-lite"

它做的事：

1. 复制 git 已跟踪文件，丢掉 data/tags/general-nsfw.jsonl
2. POSE_HINTS / SEED_TAGS 按元素过滤，其余 js 按行丢命中红线的条目
3. 命中红线的 test(...) 用例整块丢（并留说明）
4. lib/purge.js 用 BLOCK_RULES 定向改写：拆掉露骨词清单，保留全部破甲档位与模块
5. README.md 用 public-src/README.public.md 覆盖
6. 最后复查红线，输出目录里还有命中就 exit 1

改完 lib/* 或词表后重跑一次，再推 lite 仓库即可。公开版仓库：dsh-tagger-lite（公开）。
