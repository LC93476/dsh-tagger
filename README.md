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

## 三道本地后处理

LLM 只负责「把话听懂」，剩下的规范化全在本地做，所以结果可复现、可体检：

1. **规范对齐**（`lib/tags/`）：每条 tag 去词表核对，别名 / 大小写 / 下划线统一成 WD 权威写法，顺手理平权重与分组。
2. **修复**（`lib/repair.js`）：词表里查不到的（拼错、自造、模型幻觉）按相近词与中文别名换掉；换不掉的标出来，不硬留。
3. **中文意图映射**（`lib/zh-intent.js`）：白话里的「回头」「跪趴」「半脱」这类说法先映射成候选 tag，兜住模型漏掉的构图与体位。
4. **词序与质量词**（`lib/postprocess/`）：去重、上位词降权，再按 14 段排词序 —— 质量词 → 主体 → 角色 → 发型/瞳色 → 体型 → 表情 → 姿势 → 肢体 → 服装 → 性细节 → 镜头 → 场景 → 光照 → 其它；镜头段内「视角 → 景别 → 构图」，发型段内「长度 → 造型 → 颜色 → 瞳色」。

正向串首的 `masterpiece, best_quality, highres` 由本地按 `tags.qualityTags` 补（前几个 token 对画面影响最大，放末尾基本白给）；模型自己写过的同名词只留一条并保留它的权重。想回到「评分词一条都不留、交给 ComfyUI 工作流内置」，把 `forge.quality` 设成 `false`。

词表快照来自 `dsh-comfyui-workbench`（99470 条 Danbooru 词条），本仓库的 overlay 只放「快照里没有、但我们常用」的词与中文别名。

快照本身不进仓库，运行时按顺序探测（`--dict-dir` > `DSH_DANBOORU_DIR` > `~/.dsh-comfyui-workbench/data` > 仓库里打包的 `data/danbooru` > 相邻的 `dsh-comfyui-workbench/data`，详见 [INSTALL.md](INSTALL.md)）；探测不到时退化成只用 seed + overlay 的 1247 条。

词表装在别处（比如 `D:/QUARK/dsh-comfyui-workbench/data/danbooru`）时，在 `settings.json` 里写 `"tags": { "dataDirs": ["D:/QUARK/dsh-comfyui-workbench/data/danbooru"] }` 即可，不必每次开服务都带环境变量。面板顶部会显示索引条数：`99447` 是真词表，`1247` 说明只读到 seed。

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

便携包里是「能独立起 web 服务」的全部（`bin/ index.js lib/ server/ data/ locale/` 加文档与部署脚本），不带 `tests/`、`scripts/`（只带 `scripts/win`）、`public-src/`。公开版由 `scripts/release/make-public.mjs` 按红线裁出来；要把私货提示词与词表注入回去，用 `scripts/release/inject-private.mjs`（`--dry` 只列表、`--check` 比差异、`--verify` 注入后自检、`--restore` 回滚）。

生成公开版时会顺手把 `package.json` 里指向被裁文件的 scripts 键删掉（`pack:inject`、`publish:lite`——它们依赖的 `pack-inject.mjs` / `make-public.mjs` 不进公开版）。判断依据是磁盘事实：scripts 里每个 `node <文件>` 目标在输出目录里不存在就删该键，所以公开版自己跑 `npm run check:layout` 也是绿的。

## 参与贡献

提 PR 之前请先看 [CONTRIBUTING.md](CONTRIBUTING.md)，并保证 `npm run check` 全绿（词表改了至少跑一次 `npm run check:overlay`）。开 issue 用仓库里的模板；改动碰 `lib/forge/` 或 `lib/postprocess/` 时顺手补一条测试。

---

文档索引见 [docs/README.md](docs/README.md)：接口细节在 `docs/API.md`，模块契约在 `docs/CONTRACT.md`，性能数字在 `docs/PERF.md`。
