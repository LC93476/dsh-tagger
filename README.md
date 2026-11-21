# DSh Tagger（`dsh-tagger`）

> 白话描述 → **WD（Danbooru）+ Camie** 标准标签 → 直接投递本机 ComfyUI。省掉「再找一个 LLM 把话转成 tag」那一跳。

自带一个独立 web 服务（默认 `http://127.0.0.1:7789/`），浏览器打开就是锻造台。锻造走 OpenAI 兼容的模型接口（默认 provider `opencode-go`、model `deepseek-v4.1-flash`）加一层破甲提示词；出 tag 之后再叠三道**本地**后处理（规范对齐 / 修复未知词 / 中文意图映射），所以同一段白话反复锻造不会飘。

## 快速开始

| 你在哪 | 怎么起 |
| --- | --- |
| Windows | 双击 `start.cmd`；换端口就 `start.cmd 8090` |
| macOS / Linux | `chmod +x start.sh && ./start.sh`；`./start.sh 8090 0.0.0.0` 换端口并对外监听 |
| Docker | `docker compose up -d`（数据在卷 `tagger-data`） |

三条路都会先找 node（找不到就下便携 node 到 `.runtime/`；Windows 上没 node 但有 docker 会退到 `docker compose`）。**首次运行会问 6 个问题**——监听端口、模型接口 baseUrl、API Key、模型名、ComfyUI 地址、工作流模板目录——**直接回车 = 保持默认 / 跳过该键**，答案写进数据目录的 `settings.json`（默认 `.data/settings.json`）。之后启动就只是「起服务 + 开浏览器」。

想重填：`npm run setup`（`--print` 只打印当前值，`--yes` 全用默认）。

## 目录

```
dsh-tagger/
├─ bin/tagger.mjs          唯一命令行入口（dsh-tagger）
├─ index.js               装配入口：createRuntime + createHandlers
├─ server/                 独立 web 服务（standalone.mjs）与 web 面板静态资源
├─ lib/                    锻造、精修、后处理、词表索引、ComfyUI 客户端、路由、MCP、SPI
├─ data/tags/              词表 overlay（jsonl）+ 大词库快照
├─ locale/                 中英文案
├─ scripts/
│   ├─ setup.mjs           首次运行向导
│   ├─ dev/                run-tests / check-layout / bench
│   ├─ tags/               build-tags / check-tags / check-overlay-tags / suggest-overlay
│   ├─ release/            pack / pack-inject / make-public / inject-private / ui2api
│   ├─ assets/             姿势缩略图生成（Python）
│   └─ win/                Windows 启停脚本（根目录的 .cmd/.vbs 只是转发）
├─ tests/                  21 个测试套件（node:test，零依赖）
├─ docs/                   文档索引见 docs/README.md
├─ start.cmd  start.sh     一键启动
├─ deploy.cmd  deploy.sh   三行转发（等价于 start）
└─ Dockerfile  docker-compose.yml
```

## 命令行

```bash
npm start                                              # = node bin/tagger.mjs，127.0.0.1:7789
node bin/tagger.mjs --port 8090 --host 0.0.0.0 --open   # 换端口 / 对外监听 / 起完开浏览器
npm link && dsh-tagger --help                          # 用 bin 名
```

| 参数 | 说明 |
| --- | --- |
| `--port` / `--host` | 监听地址，默认 `7789` / `127.0.0.1` |
| `--data-dir` | 数据目录（`settings.json`、运行历史），默认 `.data` |
| `--open` / `--no-open` | 起完是否开浏览器 |
| `--setup` | 先走向导再起服务 |
| `--version` / `--help` | 打印后退出 |

其余参数（`--base-url`、`--api-key`、`--model`、`--workflow-dir`、`--provider`）原样透传给服务，用来临时覆盖 `settings.json`——适合试模型，不适合长期（下次启动就没了）。

本机没装 node 时 `start.cmd` / `start.sh` 会自动补一份便携 node；开发期想直接跑脚本，也可以借 DSH 自带的 electron 当 node：

```bash
ELECTRON_RUN_AS_NODE=1 "C:/Users/<你>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" bin/tagger.mjs --port 7789
```

## MCP

独立服务自带 MCP 端点 `POST /tagger/api/mcp`：任何 MCP 客户端（agent、编辑器、自写脚本）连上来就能看到 `forge_tags`、`refine_tags`、`comfy_run` 等工具，直接调锻造与出图，不用自己拼提示词。接口前缀是 `/tagger/api`，旧前缀 `/prompt-forge/api` 仍然兼容。

## 面板能干什么

- **锻造**：左边贴白话（越具体越好：人物、构图、衣装、光线、情绪），右边出正向 / 负向两组 tag，带逐条权重；能反复重掷、只改某一条。
- **精修**：出 tag 之后还能让 AI 二次增删（「把背景删干净」「加一个回头」），改的是结果集，不是重来一遍。
- **投递 ComfyUI**：把当前 tag 填进工作流模板的变量槽，排队出图；工作流可以是 UI 格式导入的（`scripts/release/ui2api.mjs` 负责转 API 格式）。
- **姿势参考**：内置 1439 张姿势 / 视角线稿，点一张就插进提示词，省得手写构图词。
- **设置**：模型接口与 ComfyUI 地址在面板里就能填，写回数据目录的 `settings.json`，不用手改文件。

## 姿势画廊

挑姿势、拿 tag —— 不跑 ControlNet。内置姿势库有 1439 张姿势 / 视角线稿，画廊把同一姿势的
正面 / 斜侧 / 侧面 / 俯视 / 仰视聚成一组，点开一张就能看到该补哪些 tag（姿态词 + 镜头词），
可以单条划掉不要的，也可以整串复制或一键填回锻造台。

- **入口**：浏览器打开 `/gallery`（`http://127.0.0.1:7789/gallery`），或点面板「出图」卡右上角的「姿势画廊 ↗」（新标签页打开）。
- **数据源**：ComfyUI 里装的 `ai-pose-gallery-zh` 自制节点 —— 读它的 `custom_nodes/ai-pose-gallery-zh/skills/pose-reference-*/references/catalog.csv`，缩略图取 `img/thumbs/`。所以得先把 ComfyUI 目录（`comfy.launchDir`，设置页或 `settings.json`）配对，否则画廊是空的，页面会提示「没读到姿势库」。

  「填入面板」走浏览器本地存储：把当前这几个 tag 写进 `localStorage` 的 `dsh-tagger:pending-prompt`，然后跳回 `/panel`；锻造台启动时读一次就删除，填进输入框并聚焦 —— 所以它只会覆盖这一次，不会在下次开面板时把你手写的内容盖掉。

  画廊只回答「这个姿势该带哪些词」，不做骨架控制。真要锁姿势还是走 ControlNet 那套模板（见 `docs/API.md` 里姿势类模板的两个专属变量）。

## 三栏工作台

`/studio` 是把「写提示词 → 挑样式 → 出图」摆在一屏里的工作台，三个竖栏从左到右：

- **左栏 · 提示词**：写白话，或直接贴一串 tag（锻造台铸好的那串粘过来也一样）；正向 / 负向都在这里改。
- **中栏 · 参考样式**：一份一份的样式预设（服务端 `/tagger/api/styles` 提供），选中一个就当当前提示词的参考样式。样式是「画风 / 光感 / 完成度」这种成套写法，和逐个补 tag 是两条路。
- **右栏 · 生成结果**：投出去的任务与产物图排在这里，同一组提示词连着改几版能直接比。

打开方式：浏览器访问 `http://127.0.0.1:7789/`（根路径就是工作台，`/studio` 是它的别名）。三个页面各管一段，别混：

| 页面 | 管什么 |
| --- | --- |
| `/` = `/studio`（三栏工作台，默认页） | 一屏写完提示词、套样式、顺手看图；右上角「设置」里填 LLM key 与 ComfyUI 目录 |
| `/panel`（锻造台） | 白话 → tag：锻造、精修、投递、设置都在这儿 |
| `/gallery`（姿势画廊） | 挑姿势拿该补的 tag，不做骨架控制 |

## 服装 / 人像参考库

`/studio` 中栏四个页签：**姿势 / 服装 / 人像 / 样式**。前两个是「看着图挑词」的参考库，和姿势画廊一样只看图拿 tag，不跑 ControlNet：

- **服装库**：成套穿搭（上装 / 下装 / 鞋袜 / 配饰），分普通与性感两批（`costume-reference`、`costume-reference-sexy`），合并成一个画廊；缩略图取节点根下的 `custom_nodes/ai-pose-gallery-zh/thumbs/costume/<id>.webp`（原图 `img/costume/<id>.webp`），点一张就把这套的 tag 追加到左栏提示词末尾。
- **人像库**：按「分区 / 发长 / 发型」组织的真人像参考，只有原图 `custom_nodes/ai-pose-gallery-zh/img/portrait/<id>.webp`（没有缩略图，卡片直接 load 原图），用来按发长 / 脸型 / 表情挑词。
- **数据源**：两个库都在 ComfyUI 里装的 `ai-pose-gallery-zh` 节点目录下（`custom_nodes/ai-pose-gallery-zh/skills/`），目录清单是各库的 `references/catalog.csv`；所以要先把 ComfyUI 目录（`comfy.launchDir`，设置页或 `settings.json`）配对。
- **没装库不是故障**：库读不到时 `GET /refs` 回 404 `no-ref-library`、`/ref-image` 与 `/ref-tags` 一并 404，页签显示「没读到参考库」空态，锻造、出图、姿势画廊照常。
- **只认本地文件**：二次元服装库（`costume-reference-anime`）的图挂在远端 URL 上，本仓库不支持 —— 留着它就得联网，也会让页面出现外链。这里保证断网可用、页内零外链。

3. **中文意图映射**（`lib/zh-intent.js`）：白话里的「回头」「跪趴」「半脱」这类说法先映射成候选 tag，兜住模型漏掉的构图与体位。
4. **词序与质量词**（`lib/postprocess/`）：去重、上位词降权，再按 14 段排词序 —— 质量词 → 主体 → 角色 → 发型/瞳色 → 体型 → 表情 → 姿势 → 肢体 → 服装 → 性细节 → 镜头 → 场景 → 光照 → 其它；镜头段内「视角 → 景别 → 构图」，发型段内「长度 → 造型 → 颜色 → 瞳色」。

正向串首的 `masterpiece, best_quality, highres` 由本地按 `tags.qualityTags` 补（前几个 token 对画面影响最大，放末尾基本白给）；模型自己写过的同名词只留一条并保留它的权重。想回到「评分词一条都不留、交给 ComfyUI 工作流内置」，把 `forge.quality` 设成 `false`。

词表快照来自 `dsh-comfyui-workbench`（99470 条 Danbooru 词条），本仓库的 overlay 只放「快照里没有、但我们常用」的词与中文别名。

快照现在**就放在仓库里**：`data/danbooru/` 下五份 jsonl（general 30693 / characters 35384 / copyrights 8414 / artists 24881 / groups 15064，约 20MB），所以任何一份 checkout 或下载版解压后开箱就是 99447 条，不必再配环境变量。

装/刷新快照只跑一条命令：`node scripts/tags/import-dict.mjs`（自动探测 `DSH_DANBOORU_DIR` > `~/.dsh-comfyui-workbench/data/danbooru`，也可 `--from <目录>` 指定）；`--check` 只校验、不写盘：有源目录时比 sha256，没有源目录时拿 `data/danbooru/manifest.json` 自检（不一致退出码 1，适合放进 CI 前的手工核对），`--dry` 只看计划，目标已存在且不同时默认拒绝、要覆盖加 `--force`。导入会顺带写 `data/danbooru/manifest.json` 记行数、字节与 sha256。

运行时探测顺序：`--dict-dir` > `DSH_DANBOORU_DIR` > `DSH_COMFYUI_DATA_DIR` > `~/.dsh-comfyui-workbench/data{,/danbooru}` > **仓库的 `data/danbooru`** > 相邻的 `dsh-comfyui-workbench/data{,/danbooru}` > `<数据目录>/tags`；一条都命中不了才退化成只用 seed + overlay 的 1247 条。

本仓库是**完整版**，`data/danbooru/` 里就是全量 99447 条（含成人向词条）。另发了 `dsh-tagger-lite` 仓库，带的是**过滤过的 SFW 快照**：生成它时 `scripts/tags/filter-dict.mjs` 会把完整快照按 Danbooru 分组（Sex acts / Sexual positions / Nudity / BDSM …）与词条名、别名、备注逐条过一遍，命中的词条整条剔除，只是别名或备注脏的摘掉别名、留着词条；`groups.jsonl` 不进公开版。全量 99447 条过滤后约 97497 条（general 28903 / characters 35325 / copyrights 8400 / artists 24869）。想自己生成一份 SFW 快照：`node scripts/tags/filter-dict.mjs [--from <源目录>] [--to <目标目录>] [--check]`。

词表装在别处（比如 `D:/QUARK/dsh-comfyui-workbench/data/danbooru`）时，在 `settings.json` 里写 `"tags": { "dataDirs": ["D:/QUARK/dsh-comfyui-workbench/data/danbooru"] }` 即可，不必每次开服务都带环境变量。面板顶部会显示索引条数：`99447` 是真词表，`1247` 说明只读到 seed。

## 模型档案

不同模型的文本编码器吃不同的写法：SDXL 动漫微调吃 Danbooru tag，Flux / SD3.5 / 写实类吃自然语言句子。
差别只在三件事上 —— 串首放什么质量词、要不要自动补、要不要按 14 段重排 —— 所以一个开关就够：

| `forge.profile` | 适用模型 | 效果 |
| --- | --- | --- |
| `tag`（默认） | Illustrious / NoobAI / Anima / Animagine | `masterpiece, best_quality, highres` 置顶；补质量词；按 14 段重排 |
| `pony` | Pony Diffusion V6 及其融合版 | `score_9, score_8_up, score_7_up, source_anime` 置顶；其余同 `tag` |
| `natural` | Flux / SD3.5 / 写实类 | 不补质量词（交给工作流）；不重排，保留模型给的短语顺序与空格（不 tag 化）；模型被要求输出英文短语而不是 tag 堆砌 |
| `custom` | 自己拿主意 | 三个值读 `forge.quality` / `forge.order` / `tags.qualityTags` |

```json
{ "forge": { "profile": "pony" } }
```

前三档会**接管**质量词、质量开关与词序开关：面板与 `GET /profiles` 显示的是生效值，手改 `tags.qualityTags` 或
`forge.quality` 都会被档案覆盖（不是静默失效 —— 看到的就是真正在用的值）。要自己填质量词、自己决定排不排序，
把 `profile` 设成 `custom`，然后照原来的方式写 `tags.qualityTags`、`forge.quality`、`forge.order`。

## 词表

一行一个词条，UTF-8 无 BOM，字段固定：

```json
{"tag":"all_fours","cn":"四肢着地（跪趴）","postCount":18000,"kind":"general","aliases":["跪趴","趴跪","手脚撑地"]}
```

- 主文件四份共 **511** 行：`general-nsfw.jsonl` 154、`pose-view.jsonl` 274、`quality-common.jsonl` 30、`scene-common.jsonl` 53。
- `data/tags/seed/` 13 份共 **736** 行，只放大词库没有的兜底词，所以和主文件零重复。
- 合计 17 份 / **1247** 行 / 1247 个 tag（`npm run check:layout` 会核这个数）。

改词表之前先看一眼现状：

```bash
npm run check:overlay     # tag 是否在词库、中文是否缺、跨文件是否重复、别名是否与权威写法冲突
npm run check:tags        # 结构自检（字段齐全、行数 == tag 数）
node scripts/tags/suggest-overlay.mjs --group "Sex acts" --limit 40   # 从快照里挑还没收录的词
```

## 检查与测试

一条命令跑全部门禁（词表 → overlay → 目录 → 类型 → 测试）：

```bash
npm install        # 只有类型检查需要它（typescript / @types/node）
npm run check
```

单跑某一道：

```bash
npm test           # 21 个套件，node:test，零依赖
npm run typecheck  # tsc --noEmit
npm run bench      # 本地计算层基准，超预算 exit 1（数字见 docs/PERF.md）
```

### 本机没装 node

整套命令都能用 DSH 的 electron 顶替（`ELECTRON_RUN_AS_NODE=1`，实测 node v24）：

```bash
ELECTRON_RUN_AS_NODE=1 "<DSH>/DeepSeek Harness.exe" scripts/dev/run-tests.mjs
ELECTRON_RUN_AS_NODE=1 "<DSH>/DeepSeek Harness.exe" --test --test-concurrency=1 tests/*.test.mjs
```

## 配置

`settings.json`（在数据目录里，向导生成）只有几组键，其余全有默认值：

```json
{
  "server": { "port": 7789, "host": "127.0.0.1" },
  "llm":    { "baseUrl": "...", "apiKey": "sk-...", "model": "deepseek-v4.1-flash" },
  "comfy":  { "baseUrl": "http://127.0.0.1:8188", "workflowDir": "..." }
}
```

不想写文件就用环境变量：`DSH_TAGGER_DATA`、`DSH_TAGGER_BASE_URL`、`DSH_TAGGER_API_KEY`、`DSH_TAGGER_MODEL`、`DSH_TAGGER_COMFY_URL`、`DSH_TAGGER_WORKFLOW_DIR`。数据目录按 `DSH_TAGGER_DATA` → `DSH_PROMPT_FORGE_DATA` → `~/.dsh-tagger` 顺序探测（老的 `~/.dsh-prompt-forge` 有配置就沿用）。

## 打包与发布

```bash
npm run pack           # → dist/dsh-tagger-<版本>/ 与同名 zip（自带环境，解开就能跑）
npm run pack:inject    # → dist/dsh-tagger-inject-<版本>/ 与同名 zip（注入包，约 98 KB）
npm run publish:lite   # 生成公开版到 ../DSh tagger-lite（--dst / --dry）
```

便携包里是「能独立起 web 服务」的全部（`bin/ index.js lib/ server/ data/ locale/` 加文档与部署脚本），连开箱入口也一起带上：`start.cmd`、`start.sh`、`start-tagger.cmd`、`start-tagger-hidden.vbs`、`stop-tagger.cmd`、`bin/tagger.mjs`、`scripts/setup.mjs`（首次向导）与 `scripts/win/stop-tagger.cmd`；不带 `tests/`、其余 `scripts/`、`public-src/`。文本类条目走 DEFLATE，0.2.0 的 zip 从 21.5 MB 降到约 5.8 MB（压缩率 27%），解开后内容与目录一一对应（`MANIFEST.txt` 存 sha256 与字节数）。公开版由 `scripts/release/make-public.mjs` 按红线裁出来；要把私货提示词与词表注入回去，用 `scripts/release/inject-private.mjs`（`--dry` 只列表、`--check` 比差异、`--verify` 注入后自检、`--restore` 回滚）。

生成公开版时会顺手把 `package.json` 里指向被裁文件的 scripts 键删掉（`pack:inject`、`publish:lite`——它们依赖的 `pack-inject.mjs` / `make-public.mjs` 不进公开版）。判断依据是磁盘事实：scripts 里每个 `node <文件>` 目标在输出目录里不存在就删该键，所以公开版自己跑 `npm run check:layout` 也是绿的。

## 参与贡献

提 PR 之前请先看 [CONTRIBUTING.md](CONTRIBUTING.md)，并保证 `npm run check` 全绿（词表改了至少跑一次 `npm run check:overlay`）。开 issue 用仓库里的模板；改动碰 `lib/forge/` 或 `lib/postprocess/` 时顺手补一条测试。

---

文档索引见 [docs/README.md](docs/README.md)：接口细节在 `docs/API.md`，模块契约在 `docs/CONTRACT.md`，性能数字在 `docs/PERF.md`。
