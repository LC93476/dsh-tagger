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
index.js                宿主入口，只做编排（112 行）：装配 runtime + 注册前缀 + 注册 MCP
lib/cordis/adapter.js   宿主适配层：日志 / 端点拼接 / llm 设置 / 最小 ctx（shims 与 index 共用）
lib/cordis/config.js    PLUGIN / VERSION / configView(rt) / persistPatch
lib/cordis/commands.js  模型工具注册 + 系统提示词注入（受 purge.injectIntoAgentPrompt 控制）
lib/cordis/handlers.js  26 条 HTTP 路由（/forge /refine /run /job /upload /pose-thumb /spi /config …）
lib/config.js           默认配置与归一化（DEFAULTS 是配置的唯一真相）
client.js               侧边栏面板门面（**已暂停开发**，实现拆在 client/）
client/                 面板子模块（locale / api / state / ui / views），暂停开发
lib/tags.js             标签索引统一入口（实现拆在 lib/tags/）
lib/tags/text.js        归一化/键名/转义/权重写法（纯函数）
lib/tags/loader.js      读盘、overlay 签名、seed 词条、建索引
lib/tags/matcher.js     检索、canonicalize、中文对照、近邻建议
lib/tags/index.js       懒加载、热重载、进程内单例（resetTagIndexCache）
lib/forge.js            锻造器门面（实现拆在 lib/forge/）
lib/repair.js           词形修复（差一点就对 → 库里真词）
lib/postprocess.js      去重、降权、13 段排序、裁剪门面（规则表在 lib/postprocess/rules.js）
lib/zh-intent.js        中文姿势/视角意图与候选注入
lib/refine.js           二次精修门面（实现拆在 lib/refine/）
lib/purge.js            破甲系统提示词
lib/comfy.js            ComfyUI 兼容门面（实现拆在 lib/comfy/）
lib/comfy/index.js      编排 + HTTP：ping / listWorkflows / submit / status / waitFor / image
lib/comfy/workflow.js   纯函数：格式判定、正负向映射、vars 注入、schema、历史摘要
lib/comfy/upload.js     参考图落 ComfyUI 的 input/
lib/backend-common.js   后端公共层（HTTP / 超时 / 错误归一 / 轮询）
lib/seed-tags.js        seed 词条薄入口（词条本体在 data/tags/seed/*.jsonl）
lib/mcp.js              MCP 服务端
lib/spi.js              扩展注册表
lib/routes.js           路由与 dispatch（含 /* 通配）
lib/poses.js            姿势目录与缩略图查找
server/standalone.mjs   脱离 DSH 的独立服务（静态资源 no-cache + ETag）
server/shims.mjs        纯 Cordis 生命周期垫片（createContext + 8 个传输层名字再导出，2.2KB）
lib/cordis/host.js      独立模式的 ctx 与 llm/webServer/tools 传输层实现（原 shims.mjs 正文）
server/public/          Web 面板静态资源：panel.css / api.js / state.js / render.js / settings.js / history.js / app.js
scripts/                run-tests.mjs / check-tags.mjs / bench.mjs / build-tags.mjs / push-to-github.ps1
scripts/win/            Windows 启停脚本（根目录 .cmd/.vbs 只是转发）
data/tags/*.jsonl       随包 overlay 词表（nsfw / 姿势视角 / 画质 / 场景）
data/tags/seed/         内置 seed 词条，13 个 jsonl（387 行）
tools/                  开发期工具（见下）
tests/                  17 个测试套件
docs/CONTRACT.md        核心契约（模块 / 配置 / 路由 / SPI / 客户端）
docs/API.md             接口手册（HTTP 路由 + MCP 工具）
docs/PERF.md            实测性能数字与健壮性清单（scripts/bench.mjs）
docs/AGENT-INJECT.md    交给 agent 执行的注入指令（可直接粘贴的提示词 + 退出码语义）
```

`tools/` 里都是**开发期**用的，运行时不需要：

| 脚本 | 用途 | 运行时要不要 |
| --- | --- | --- |
| `tools/make-pose-thumbs.py` | 把姿势库 1439 张 500KB 原图压成 220px 缩略图（走 PIL，需要 Python） | **不要**，缩略图已随 ComfyUI 节点目录生成；换机器/换姿势库时才重跑 |
| `tools/ui2api.mjs` | 把 ComfyUI 的 UI 格式工作流转成 API 格式模板 | 不要 |
| `tools/make-public.mjs` | 生成公开发布版（见文末） | 不要 |
| `scripts/build-tags.mjs` | 校验/统计词表覆盖情况 | 不要 |
| `scripts/check-overlay-tags.mjs` | 补词表质量闸门：tag 是否真在词库、中文是否为空、跨文件是否重复、`aliases` 是否规范、`POSE_HINTS` 里的 tag 是否都在库 | 不要（改 `data/tags/**` 后跑一次） |
| `scripts/suggest-overlay.mjs` | 按热度从真词表里掏「库里真有但 overlay 没收录」的候选词（带 danbooru 分组与中文名），补词取材用 | 不要 |
```

## 检查与测试（npm 脚本）

```bash
npm run check:tags   # 词表结构自检：data/tags/*.jsonl 每行合法 + 同文件内 tag 不重复
npm run typecheck    # tsc --noEmit -p tsconfig.json（allowJs + checkJs，不进构建）
npm test             # 全量测试，串行
npm run check        # 上面三道连跑
npm run bench        # 本地计算层基准，超预算 exit 1（见 docs/PERF.md）
```

`npm test` 走 `scripts/run-tests.mjs` 而不是裸 `node --test`：

- **必须串行**（`--test-concurrency=1`）：几个套件会读同一份默认词表目录，进程并行时可能撞上另一个进程
  正在重写 overlay，表现为偶发 1 条失败，单跑必绿。这不是业务 bug，但门禁里不许并行。
- 这个参数是 Node 20.11 才有的，`engines` 定的是 `>=18.18.0`，所以由脚本按版本决定加不加，
  老版本给一句提示后并行跑，不会因为参数不认识整条命令报错。

17 个套件：`comfy` `forge` `http` `mcp` `poses` `postprocess` `refine` `render` `repair` `shim`
`standalone` `tags` `tags-pose` `ui2api` `upload` `zh-intent` `cordis`。
（没装 Danbooru 词表的机器上，需要真库的三条用例会 skip 而不是失败，见 `tests/_lib-guard.mjs`。）

本机 bash 没有 `node` 命令时，用宿主自带的 Electron 当 node：

```bash
cd "/d/DSh tagger"
export ELECTRON_RUN_AS_NODE=1
R="C:/Users/34701/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"
"$R" scripts/run-tests.mjs          # = npm test
"$R" scripts/check-tags.mjs         # = npm run check:tags
"$R" scripts/check-overlay-tags.mjs # 补词表体检（改了 data/tags/** 就跑）
```

CI 跑同样的三道门禁（`check:tags` → `typecheck` → `test`），配置在 `.github/workflows/ci.yml`，
windows-latest + Node 20，步骤直接调上面这些 npm 脚本。

## 发布包里有什么（npm pack）

`package.json` 的 `files` 是白名单，只打这些：

```
index.js  client.js  client/  lib/  server/  data/  locale/  types/  icon.svg  README.md
```

- **不含** `tests/`、`scripts/`（门禁与推送脚本）、`docs/`、`tools/`（开发期工具）、`cordis.patch.yml`。
- 自检：`npm pack --dry-run`（本机没有 npm 时，用宿主自带的 Electron 跑一份下载好的 npm-cli.js，见下）。
  当前 102 个文件 / 232.2 kB tarball / 712.3 kB 解包（含 `lib/tags/matcher/` 六个子模块、`server/public/i18n.js`、`lib/cordis/host.js`）。
- 为什么 `cordis.patch.yml` 不进包：它是**写给 `~/.dsh/profiles/<profile>/` 的样例补丁**，装进 node_modules 也不会被 DSH 读；
  安装照本文开头「装法」直接写 profile 里的 patch 就行。

本机没有 `node`/`npm` 时的打包自检：

```bash
mkdir -p /tmp/npmcli && cd /tmp/npmcli
curl -sSL --ssl-no-revoke -o npm.tgz https://registry.npmjs.org/npm/-/npm-10.9.2.tgz && tar xzf npm.tgz
cd "/d/DSh tagger"
ELECTRON_RUN_AS_NODE=1 "C:/Users/34701/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  /tmp/npmcli/package/bin/npm-cli.js pack --dry-run
```

## 装了哪两个 profile

| profile | 包 | 前缀 | 备注 |
| --- | --- | --- | --- |
| `~/.dsh/profiles/desktop` | `dsh-tagger`（junction → `D:\DSh tagger`） | `/tagger/api` + 旧 `/prompt-forge/api` | 桌面端主用 |
| `~/.dsh/profiles/web` | `dsh-tagger`（junction → `D:\DSh tagger`） | 同上 | 原 `dsh-prompt-forge` 条目已改名为 `tagger`，旧包目录保留可回滚 |

两个 profile 指向同一份源码，改完只需重启对应进程；旧前缀由 `index.js` / `server/standalone.mjs`
各自 try 注册一次，失败只记日志（不会因为两条都注册而崩）。


## 一键部署（换台机器 / 换系统都能起）

这个项目零运行时依赖（只用 node 标准库，不需要 `npm install`），词表也一起在 `data/` 里，
所以换环境只要满足「有 node 或有 docker」。四种起法，挑一条：

| 场景 | 一条命令 |
| --- | --- |
| Windows | 双击 `deploy.cmd`（换端口：`deploy.cmd 8090`）；没 node 也没 docker 会自动下便携版 node 到 `.runtime/` |
| macOS / Linux | `./deploy.sh`（换端口：`./deploy.sh 8090`；对外监听：`./deploy.sh 8090 0.0.0.0`） |
| 服务器 / NAS（Docker） | `cp .env.example .env` 填好 → `docker compose up -d --build` |
| 断网 / 拷 U 盘 | `node scripts/pack.mjs` 打出 `dist/dsh-tagger-0.2.0.zip`（约 19MB，含全量词表快照），拷过去解开跑 `deploy.sh` / 双击 `deploy.cmd` |

细节（镜像怎么建、容器里连宿主 ComfyUI、健康检查、常见报错）全在 [INSTALL.md](INSTALL.md)。
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
| `/tagger/api/locale?lang=zh` | 语言包：`{ ok, locale, langs, dict }`，与 `locale/<lang>.json` 同一份；桌面面板的文案也从这里取，不再硬编码 |

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

随包词表现在一共 **1247 行**：四个主文件（`general-nsfw` 154 / `pose-view` 274 / `quality-common` 30 / `scene-common` 53）
拥有词条，`data/tags/seed/*.jsonl` 十三份（736 行）只补主文件没有的词。改词表前先记住三条：

- **合并语义**：同一条词在多份文件出现时，字典序靠前的赢中文（`general-nsfw → pose-view → quality-common → scene-common`），靠后的只贡献更大的 `postCount` 与额外 `aliases`；seed 用 `if (!entries.has(key))`，只补空位、永不覆盖。
- **去重**：删「靠后那份」的行，删之前把它独有的 `aliases` 并进保留行（并集不会自动继承）。
- **只收库内真词**：`lib/postprocess/rules.js` 的桶表尤其如此 —— 表里混进库里没有的词，只会误导后面维护的人（`tests/postprocess.test.mjs` 有「幽灵词」断言）。

改完 `data/tags/**` 跑一次 `node scripts/check-overlay-tags.mjs`（不在库 / 缺中文 / 跨文件重复 / 别名不规范 / `POSE_HINTS` 不在库，五类一次报全），
取材用 `node scripts/suggest-overlay.mjs --group Posture --limit 40`（按热度吐「库里真有但没收录」的候选词，带 danbooru 分组与中文名）。

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
| 导入自定义工作流 | 选一份 ComfyUI「导出（API 格式）」的 `.json`，可再带一份 `.schema.json`；填模板 id | 导入到模板目录（同名可勾「覆盖同名」） |

**导入自己的工作流**：在 ComfyUI 里把工作流用「工作流 → 导出（API）/ Save (API Format)」存成 json（那份是 `{ 节点id: { class_type, inputs } }`，
不是带 `nodes`/`links` 的界面格式），回到面板「接口设置 → 导入自定义工作流」选文件、填个 id（小写字母/数字/连字符）、点「导入到模板目录」。
没带 schema 也没关系：服务端会按节点输入反推一份（正负向提示词绑到识别出的 CLIPTextEncode，seed/steps/cfg/宽高拿模板当前值当默认），
导入完下拉里立刻可选、直接出图。同名模板默认拒绝，要覆盖得勾「覆盖同名」。接口细节见 docs/API.md「导入自定义工作流」。

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

### 反过来：把自己的提示词一键注入公开版

公开版是「合规版」，破甲提示词里那几段露骨词清单被 `BLOCK_RULES` 拆掉了。想在自己机器上把公开版变成
**私货全量版**（同一套提示词、同一套词表），用反向脚本，不用手抄：

    node tools/inject-private.mjs               # 注入（默认目标 ../DSh tagger-lite）
    node tools/inject-private.mjs --dry         # 只列表，看差在哪
    node tools/inject-private.mjs --check       # 已最新 → 0；有差异 → 1（可以塞进脚本/CI）
    node tools/inject-private.mjs --dst "D:/别的目录"
    node tools/inject-private.mjs --only prompt,tags
    node tools/inject-private.mjs --verify      # 注完顺手跑目标仓的词表自检
    node tools/inject-private.mjs --restore     # 用最近一次备份还原

注入的 6 份文件（其余一律不动，README 仍是公开版）：

| 文件 | 公开版里被削成什么样 | 注入后 |
| --- | --- | --- |
| `lib/purge.js` | 露骨词清单整段换成含蓄说法 | 原样，破甲提示词全量 |
| `lib/postprocess/rules.js` | 成人向细节整表删掉 | 分桶 / 上下位关系全量 |
| `lib/zh-intent.js` | 9 条体位·行为意图词被丢 | 全量 27 行意图条目 |
| `data/tags/general-nsfw.jsonl` | **整份不存在** | 46 行 NSFW 补词 |
| `data/tags/pose-view.jsonl` | 丢 15 行 | 136 行全量 |
| `data/tags/seed/seed-08-adult.jsonl` | 丢 12 行 | 全量 |

写盘前会把目标文件备份到本仓库的 `.inject-backups/<时间戳>/`（已 gitignore），`--restore` 直接回滚；
`--check` 幂等，重复跑不会重复备份。

⚠️ 注入后的目录**不要 `git push` 到公开仓**。想回到干净公开版：`--restore`，或重跑 `tools/make-public.mjs`。

### 把注入能力打包带走（注入包）

换台机器、或者只想把「注入」这一步交给别人时，光拷一个 `inject-private.mjs` 没用 —— 六份私货文件得跟着走。
打成独立的注入包：

    node scripts/pack-inject.mjs                 # 出 dist/dsh-tagger-inject-<版本>/ 与同名 zip
    node scripts/pack-inject.mjs --out /tmp/x    # 换输出目录
    node scripts/pack-inject.mjs --no-zip        # 只要目录

包里的结构（约 96 KB，不需要 node_modules、不联网）：

    dsh-tagger-inject-0.2.0/
      inject-private.mjs        注入脚本（认 payload/ 布局，也仍然认仓库布局）
      payload/<六个相对路径>     六份私货文件，路径与仓库里一致
      inject.cmd                Windows 入口：inject.cmd "D:\DSh tagger-lite" [--dry|--check|--verify|--restore]
      inject.sh                 macOS / Linux 入口：./inject.sh "/path/to/dsh-tagger-lite"
      README.txt                用法与还原说明
      MANIFEST.txt              每份文件 sha256 前 16 位 + 字节数

`inject.cmd` 找 node 的顺序：`PATH` 里的 node → DeepSeek Harness 自带的 electron（拿 `ELECTRON_RUN_AS_NODE=1` 当 node 用）→ `%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\...` → `%ProgramFiles%\nodejs\node.exe`。都没有才报错。

包内注入的备份写在**包目录**的 `.inject-backups/<时间戳>/`（不写进目标仓），`--restore` 用同一份备份精确回滚。

