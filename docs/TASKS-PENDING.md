# 未完成任务：补词表（overlay）与姿势 tag 描述精细化

> 这份文件是**断点续作说明**。写完于 2026-11-19 深夜，用户准备关机，为防丢进度落盘提交。
> 下次开工读这一份就能接上：不需要翻对话记录。

## 任务来源
用户 m06678：「你派遣agent团队进行丰富词库和姿势标签的tag描述进行精细化」。
四个 teammate 已派工，正在写盘时被叫停（本文件与 WIP 提交就是现场快照）。

## 已落地（本次新增，可直接用）
| 文件 | 作用 |
| --- | --- |
| `scripts/check-overlay-tags.mjs` | 补词表**质量闸门**：加载真词表（99470 条），逐行查 ① tag 不在库（锻造会被丢弃）② cn 为空 ③ 跨文件重复 ④ aliases 非数组/空项/与词库权威写法不一致 ⑤ `POSE_HINTS` 里不在库的 tag。`--quiet` `--json` `--max-report N`；exit 0 通过 / 1 有违规 / 2 词表加载失败。 |
| `scripts/suggest-overlay.mjs` | **取材工具**：从真词表按热度吐出「库里真有、overlay 还没收录」的候选词，带 danbooru 分组与中文名。`--kind general\|character\|copyright\|artist\|all` `--group <分组名>` `--grep <子串>` `--min-count N` `--limit N` `--out file.jsonl` `--json`。真实分组名：Posture / Image composition / Sexual positions / Sex acts / Nudity / Sexual attire / Sex objects / Attire / Lighting / Focus tags / Gestures / Hands / Subjective / Face tags / Hair styles / Real world locations …（注意不是 Pose / Camera）。 |

跑法（本机没有裸 node）：

```bash
EXE="C:/Users/34701/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"
cd "/d/DSh tagger"
ELECTRON_RUN_AS_NODE=1 "$EXE" scripts/check-overlay-tags.mjs
ELECTRON_RUN_AS_NODE=1 "$EXE" scripts/suggest-overlay.mjs --group Posture --limit 40
```

## 基线（开工前，2026-11-19）

词表 99470 条。overlay 行数：general-nsfw 46 / pose-view 136 / quality-common 7 / scene-common 9；seed/ seed-01-base 9 / 02-hair 42 / 03-face 48 / 04-composition 23 / 05-scene 37 / 06-quality 21 / 07-negative 27 / 08-adult 38 / 09-pose 19 / 10-outfit 30 / 11-character 36 / 12-copyright 38 / 13-artist 19。

`check-overlay-tags.mjs` 首跑结果：**exit 1，跨文件重复 45 处**（缺中文 0、不在库 0、别名问题 0）。
重复的成因基本是两类：
1. `seed-04-composition.jsonl` 整段复制了 `pose-view.jsonl` 的视角/景别 17 行（looking_at_viewer / looking_back / looking_up / looking_down / looking_away / eye_contact / profile / from_side / from_behind / from_above / from_below / full_body / upper_body / cowboy_shot / portrait / close-up）。
2. `seed-09-pose`（12 行）、`seed-10-outfit`（4 行）、`seed-08-adult`（10 行）、`seed-01-base`（hetero）、`seed-05-scene`（indoors / backlighting）、`scene-common`（desk_lamp / close-up）与主文件撞。

**为什么重复是 bug**：`lib/tags/index.js:81` 用 `includeSeed: true` 加载，seed 在主文件之后读入 —— 后写覆盖，seed 里的粗糙中文/权重会把主文件的精细版本盖掉。所有权规则：主文件（general-nsfw / pose-view / scene-common / quality-common）拥有词条，seed-* 只保留主文件没有的词。

## 四个任务（共享看板，状态见 team_task_list）

### task-30 · 补词表 A：pose-view + zh-intent（owner: repair-engine）
write scope：`data/tags/pose-view.jsonl`、`lib/zh-intent.js`。目标：pose-view 136 → ≥260 行（静态姿势/手与支撑/腿部姿态/身体弧线/头与视线/视角/景别）；`POSE_HINTS` 每条 when ≥3 个中文口语变体，权重沿用 W_POSE 1.1 / W_POSITION 1.12 / W_VIEW 1.05 / W_SOFT 1.05。

### task-31 · 补词表 B：general-nsfw + seed-08 + seed-07（owner: forge-llm）
write scope：`data/tags/general-nsfw.jsonl`（46 → ≥120）、`data/tags/seed/seed-08-adult.jsonl`（删 10 行重复后 ≥60）、`data/tags/seed/seed-07-negative.jsonl`（27 行补 aliases）。覆盖身体细节 / 体液 / 裸露程度 / 性行为 / 状态词，全部库内真词。

### task-32 · 补词表 C：场景 / 画质 / 构图（owner: tag-index）
write scope：`scene-common`（9 → ≥45）、`quality-common`（7 → ≥30）、`seed/seed-04-composition`（删 17 行重复，改写构图/光线/焦点，≥50）、`seed/seed-05-scene`（删 indoors/backlighting，≥60）、`seed/seed-06-quality`（21 → ≥40）。
注：锻造管线会丢弃纯评分词（masterpiece / best_quality），这类要么不收，要么在 cn 里注明「评分词，管线会丢」。

### task-33 · 补词表 D：seed 八份（owner: post-pipeline）
write scope：`seed-01-base`(9)、`seed-02-hair`(42→≥70)、`seed-03-face`(48→≥70)、`seed-09-pose`(删 12 行重复)、`seed-10-outfit`(删 4 行重复，→≥60)、`seed-11-character`(36)、`seed-12-copyright`(38)、`seed-13-artist`(19)。主要工作：cn 写成人话、aliases 补到 ≥3 条中文口语、postCount 用真实值。

## 行格式与硬约束

```json
{"tag":"all_fours","cn":"四肢着地（跪趴）","postCount":18000,"kind":"general","aliases":["跪趴","趴跪"]}
```

- `tag` 必须在词库（99470 条）里真存在 —— 否则锻造时 warn「不在库里」并丢弃。
- `cn` 必须是中文（面板中英对照 / 中文检索都吃它）。
- 同一个 tag 只许出现在一个文件里（见上面的所有权规则）。
- UTF-8 无 BOM、一行一 JSON、文件末尾留换行。
- aliases 放中文口语与英文变体，不要放**另一个真 tag** 的写法。

## 收尾验收（四个任务都齐了再跑）

```bash
EXE="C:/Users/34701/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"
cd "/d/DSh tagger"
ELECTRON_RUN_AS_NODE=1 "$EXE" scripts/check-overlay-tags.mjs          # 必须「✓ 补词表体检通过」exit 0
ELECTRON_RUN_AS_NODE=1 "$EXE" scripts/check-tags.mjs                  # 结构自检
ELECTRON_RUN_AS_NODE=1 "$EXE" /tmp/tsdk/package/lib/tsc.js -p tsconfig.json --typeRoots /tmp/tsdk/node_modules/@types   # 0 error
ELECTRON_RUN_AS_NODE=1 "$EXE" --test --test-concurrency=1 tests/*.test.mjs   # 基线 263 tests / 262 pass / 1 skipped
```

全绿后：README 补两个新脚本的说明 → `git commit`（作者 DSh Tagger <dsh-tagger@users.noreply.github.com>，长信息用 `git commit -F 文件`）→ push origin main → 重跑 `node tools/make-public.mjs` 生成 lite（注意它会 rmSync 整个目标目录，连 `.git` 一起删，需要先备份/重建）→ 推 lite 仓。

## 现场状态（提交这一刻）

四个 teammate 正在写盘阶段被 interrupt 叫停，所以 `data/tags/**` 里可能有写到一半的行。恢复办法：

1. 先跑 `check-overlay-tags.mjs` 看有哪些文件报 JSON 坏行 / 重复；
2. 用 `git log --oneline -3` 找这次 WIP 提交之前的版本对照（`git diff HEAD~1 -- data/tags`）；
3. 让对应 teammate 续写（`team_task_list` 看 owner，用 send_message 唤醒，把本文件路径发给它）。