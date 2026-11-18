/**
 * dsh-tagger · 左侧栏面板（浏览器侧，纯 JS，无构建）
 *
 * 形状照 _plugin_ref/templates/decoration/client.js：window.__ModuleLoader__.load + factory(require)。
 * 这里只做三件事：
 *   1. 把面板注册成原生侧边栏一行（sidebar.panellist）+ 主面板（main keyed slot）；
 *   2. betterSidebar 存在时额外占一个页签（拿不到就跳过，不影响原生面板）；
 *   3. 面板本身：白话 → /forge → tag 芯片 → /run → 轮询 /job → 出图。
 *
 * 所有数据都走宿主已挂好的前缀 /tagger/api，面板不直接碰 ComfyUI。
 * 文案走 locale 服务（namespace 与包名一致），locale/*.json 与下面的 dict 保持一致（测试会比对）。
 */
window.__ModuleLoader__.load({
  // 这段注册 id 必须与包名一致：宿主按 package.json 的 name 取出模块行（graphRow(packageName, ...)），
  // 再在 __ModuleLoader__ 的工厂表里找同名 id。改成旧名 dsh-prompt-forge 会让宿主报
  // `could not load "dsh-tagger": loaded without registering "dsh-tagger"`。
  id: 'dsh-tagger',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-tagger'
    // 主注册前缀是 lib/routes.js 的 PREFIX（/tagger/api）；/prompt-forge/api 只是旧前缀别名。
    const API = '/tagger/api'
    const PANEL_ID = 'prompt-forge'
    const TAB_ID = 'prompt-forge:forge'
    const LEVELS = ['off', 'light', 'standard', 'full', 'max']
    const REFINE_MODES = ['add', 'edit', 'prune', 'weights']
    const JOB_KEY = { idle: 'idle', submitting: 'submitting', queued: 'queued', running: 'running', done: 'done', failed: 'failed', unknown: 'unknown' }
    const DEFAULT_POLL_MS = 1200

    const dict = {
      zh: {
        meta: {
          title: '提示词锻造台',
          description: '白话描述直接锻成 WD + Camie 双标准图像标签，并投递本机 ComfyUI。',
        },
        panel: '提示词',
        title: '提示词锻造台',
        subtitle: '写白话，锻出 WD + Camie 标准标签，直接进 ComfyUI。',
        'label.input': '画面描述',
        'placeholder.input': '银发少女站在雨夜霓虹街头，湿透的白衬衫贴着身体，回头看向镜头，电影感暖光，浅景深…',
        'action.generate': '锻造标签',
        'action.generating': '锻造中…',
        'action.submit': '投递 ComfyUI',
        'action.submitting': '投递中…',
        'action.resubmit': '再投一次',
        'action.copy': '复制全文',
        'action.copied': '已复制',
        'action.copyFailed': '复制失败',
        'action.removeTag': '点掉这个 tag',
        standards: '标签标准',
        'standard.wd': 'WD',
        'standard.camie': 'Camie',
        maxTags: '最多 tag',
        workflow: '工作流',
        'workflow.auto': '默认工作流',
        'workflow.loading': '读取工作流…',
        'ref.label': '参考图（锁体态）',
        'ref.hint': '选一张照片或线稿，自动提深度图喂 ControlNet',
        'ref.uploading': '上传中…',
        'ref.ready': '已上传',
        'ref.failed': '上传失败',
  'ref.offHint': '当前工作流不用参考图；选下拉里带〔参考图〕的那条（feiyue-sam3-ref）就启用',
  'ref.badge': '　〔参考图〕',
        'workflow.error': '工作流读不出来',
        level: '破甲强度',
        'level.off': '关',
        'level.light': '轻',
        'level.standard': '标准',
        'level.full': '全开',
        'level.max': '极限',
        'state.empty': '还没锻造。上面写画面，点「锻造标签」。',
        'state.loading': '正在锻造，稍等…',
        'result.positive': '正向',
        'result.negative': '负向',
        'result.negativeBuiltin': '负向与画质词由 ComfyUI 工作流内置，这一栏只做展示',
        'result.warnings': '警告',
        'result.raw': '模型原始输出',
        'result.meta': '模型',
        'result.bilingual': '中英对照 · 带权重',
        'hint.bilingual': '一行一条：(tag:权重) — 中文。权重与正向串一致（1 不带括号），可整段复制进 ComfyUI',
        'refine.title': '二次精修',
        'refine.placeholder': '再补点室内光线和汗水的细节',
        'refine.run': '让 AI 精修',
        'refine.running': '精修中…',
        'refine.mode.add': '补充',
        'refine.mode.edit': '改写',
        'refine.mode.prune': '精简',
        'refine.mode.weights': '调权',
        'refine.nochange': '这次没有改动。',
        'refine.added': '新增',
        'refine.removed': '删除',
        'refine.weighted': '调权',
        'refine.failed': '精修失败',
        'spi.badge': 'SPI',
        'spi.slots': '槽',
        'purge.lamp': '破甲',
        'purge.off': '已关闭',
        'purge.modules': '生效模块',
        'purge.charsUnit': ' 字破甲层',
        'purge.live': '已生效',
        job: '任务',
        'job.idle': '没投递',
        'job.submitting': '投递中',
        'job.queued': '排队中',
        'job.running': '生成中',
        'job.done': '完成',
        'job.failed': '失败',
        'job.unknown': '查不到',
        image: '出图',
        settings: '设置',
        'settings.provider': 'Provider',
        'settings.model': '模型',
        'settings.level': '破甲档位',
        'settings.baseUrl': 'ComfyUI 地址',
        'settings.workflowDir': '工作流目录',
        'settings.launchDir': 'ComfyUI 目录（含 main.py）',
        'settings.launchDirHint': '留空自动找 D:/QUARK/ComfyUI-aki-v3.2/ComfyUI',
        'settings.pythonPath': 'python 路径（留空自动找）',
        'settings.pythonPathHint': '留空用 <目录>/../python/python.exe',
        'comfy.lamp': 'ComfyUI',
        'comfy.online': '已连接',
        'comfy.offline': '未连接',
        'comfy.starting': '启动中',
        'comfy.checking': '检测中',
        'comfy.check': '检测连接',
        'comfy.launch': '启动 ComfyUI',
        'comfy.launching': '启动中…',
        'comfy.launchFailed': '启动失败',
        'comfy.dir': '目录',
        'comfy.checkHint': '点这里检测连接',
        'settings.forge': '本地后处理',
        'settings.repair': '词形修复',
        'settings.postprocess': '去重合序',
        'settings.poseHints': '姿势补全',
        'settings.candidates': '候选注入',
        'pipeline.title': '本地处理',
        'pipeline.repairs': '修正',
        'pipeline.poseHints': '补词',
        'pipeline.changes': '整理',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '已保存',
        'settings.failed': '保存失败',
        'error.emptyText': '先写点什么。',
        'error.forge': '锻造失败',
        'error.run': '投递失败',
        'error.job': '任务查询失败',
        'error.network': '网络请求失败',
        'error.config': '读配置失败',
      },
      en: {
        meta: {
          title: 'Prompt Forge',
          description: 'Forges plain-language descriptions into WD + Camie image tags and submits them to the local ComfyUI.',
        },
        panel: 'Prompts',
        title: 'Prompt Forge',
        subtitle: 'Write plainly; forge WD + Camie tags straight into ComfyUI.',
        'label.input': 'Picture description',
        'placeholder.input': 'A silver-haired girl on a neon-lit rainy street, soaked white shirt clinging, looking back at the camera, cinematic warm light, shallow depth of field…',
        'action.generate': 'Forge tags',
        'action.generating': 'Forging…',
        'action.submit': 'Submit to ComfyUI',
        'action.submitting': 'Submitting…',
        'action.resubmit': 'Submit again',
        'action.copy': 'Copy full text',
        'action.copied': 'Copied',
        'action.copyFailed': 'Copy failed',
        'action.removeTag': 'Remove this tag',
        standards: 'Standards',
        'standard.wd': 'WD',
        'standard.camie': 'Camie',
        maxTags: 'Max tags',
        workflow: 'Workflow',
        'workflow.auto': 'Default workflow',
        'workflow.loading': 'Loading workflows…',
        'ref.label': 'Reference image (locks the pose)',
        'ref.hint': 'Pick a photo or sketch — its depth map goes into ControlNet',
        'ref.uploading': 'Uploading…',
        'ref.ready': 'Uploaded',
        'ref.failed': 'Upload failed',
  'ref.offHint': 'This workflow ignores the reference image — pick the one tagged [reference] (feiyue-sam3-ref)',
  'ref.badge': '  [reference]',
        'workflow.error': 'Cannot read workflows',
        level: 'Jailbreak level',
        'level.off': 'Off',
        'level.light': 'Light',
        'level.standard': 'Standard',
        'level.full': 'Full',
        'level.max': 'Max',
        'state.empty': 'Nothing forged yet. Describe the picture above, then press "Forge tags".',
        'state.loading': 'Forging, one moment…',
        'result.positive': 'Positive',
        'result.negative': 'Negative',
        'result.negativeBuiltin': 'Negative prompt and quality words come from the ComfyUI workflow',
        'result.warnings': 'Warnings',
        'result.raw': 'Raw model output',
        'result.meta': 'Model',
        'result.bilingual': 'Tag — Chinese · weights',
        'hint.bilingual': 'One per line: (tag:weight) — Chinese. Weights mirror the positive string (bare tag when 1); copy the whole box into ComfyUI',
        'refine.title': 'Refine',
        'refine.placeholder': 'e.g. add indoor light and sweat detail',
        'refine.run': 'Let AI refine',
        'refine.running': 'Refining…',
        'refine.mode.add': 'Add',
        'refine.mode.edit': 'Edit',
        'refine.mode.prune': 'Prune',
        'refine.mode.weights': 'Weights',
        'refine.nochange': 'No change this time.',
        'refine.added': 'Added',
        'refine.removed': 'Removed',
        'refine.weighted': 'Reweighted',
        'refine.failed': 'Refine failed',
        'spi.badge': 'SPI',
        'spi.slots': ' slots',
        'purge.lamp': 'Jailbreak',
        'purge.off': 'Off',
        'purge.modules': 'modules',
        'purge.charsUnit': ' chars directive',
        'purge.live': 'active',
        job: 'Job',
        'job.idle': 'Not submitted',
        'job.submitting': 'Submitting',
        'job.queued': 'Queued',
        'job.running': 'Running',
        'job.done': 'Done',
        'job.failed': 'Failed',
        'job.unknown': 'Unknown',
        image: 'Result image',
        settings: 'Settings',
        'settings.provider': 'Provider',
        'settings.model': 'Model',
        'settings.level': 'Jailbreak level',
        'settings.baseUrl': 'ComfyUI address',
        'settings.workflowDir': 'Workflow directory',
        'settings.launchDir': 'ComfyUI folder (with main.py)',
        'settings.launchDirHint': 'Empty: auto-detect D:/QUARK/ComfyUI-aki-v3.2/ComfyUI',
        'settings.pythonPath': 'Python path (auto if empty)',
        'settings.pythonPathHint': 'Empty: use <folder>/../python/python.exe',
        'comfy.lamp': 'ComfyUI',
        'comfy.online': 'Online',
        'comfy.offline': 'Offline',
        'comfy.starting': 'Starting',
        'comfy.checking': 'Checking',
        'comfy.check': 'Check',
        'comfy.launch': 'Start ComfyUI',
        'comfy.launching': 'Starting…',
        'comfy.launchFailed': 'Launch failed',
        'comfy.dir': 'Folder',
        'comfy.checkHint': 'Click to re-check',
        'settings.forge': 'Local post-processing',
        'settings.repair': 'Spelling repair',
        'settings.postprocess': 'Dedupe & order',
        'settings.poseHints': 'Pose hints',
        'settings.candidates': 'Candidate injection',
        'pipeline.title': 'Local pipeline',
        'pipeline.repairs': 'repaired',
        'pipeline.poseHints': 'added',
        'pipeline.changes': 'tidied',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved',
        'settings.failed': 'Save failed',
        'error.emptyText': 'Write something first.',
        'error.forge': 'Forge failed',
        'error.run': 'Submit failed',
        'error.job': 'Job lookup failed',
        'error.network': 'Network request failed',
        'error.config': 'Cannot read config',
      },
    }

    const CSS = [
      '.ptf{display:flex;flex-direction:column;gap:12px;height:100%;overflow-y:auto;padding:16px;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#181818);',
      'font-size:13px;line-height:1.55;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18)) transparent;}',
      '.ptf *{box-sizing:border-box;}',
      '.ptf-head{display:flex;flex-direction:column;gap:2px;}',
      '.ptf-title{font-size:15px;font-weight:600;letter-spacing:.01em;}',
      '.ptf-sub{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;}',
      '.ptf-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}',
      '.ptf-head-titles{display:flex;flex-direction:column;gap:2px;min-width:0;}',
    '.ptf-head-tags{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;flex:0 0 auto;}',
    '.ptf-comfy{cursor:pointer;font:inherit;background:transparent;}',
    '.ptf-comfy[disabled]{cursor:default;}',
    '.ptf-comfy[data-state="online"]{border-color:#2f9e44;color:#2f9e44;}',
    '.ptf-comfy[data-state="online"] .ptf-dot{background:#2f9e44;}',
    '.ptf-comfy[data-state="offline"]{border-color:#e03131;color:#e03131;}',
    '.ptf-comfy[data-state="offline"] .ptf-dot{background:#e03131;}',
    '.ptf-comfy[data-state="starting"]{border-color:#ef7d00;color:#ef7d00;}',
    '.ptf-comfy[data-state="starting"] .ptf-dot{background:#ef7d00;animation:ptf-lamp-breathe 1.4s ease-in-out infinite;}',
    '.ptf-comfy[data-state="checking"]{border-color:#9aa0a6;color:#9aa0a6;}',
    '.ptf-comfy[data-state="checking"] .ptf-dot{background:#9aa0a6;}',
      '.ptf-lamp{flex:none;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:var(--dsw-radius-xs,999px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));font-size:11px;line-height:1.45;white-space:nowrap;cursor:default;',
      'background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));color:var(--dsw-alias-label-secondary,#5c5c5c);}',
      '.ptf-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#aaa);}',
      '.ptf-lamp[data-level="off"] .ptf-dot{background:#9aa0a6;}',
      '.ptf-lamp[data-level="light"] .ptf-dot{background:#e0a800;box-shadow:0 0 0 3px rgba(224,168,0,.18);}',
      '.ptf-lamp[data-level="standard"] .ptf-dot{background:#ef7d00;box-shadow:0 0 0 3px rgba(239,125,0,.2);}',
      '.ptf-lamp[data-level="full"]{color:var(--dsw-alias-state-error-primary,#d33);border-color:rgba(224,49,49,.35);}',
      '.ptf-lamp[data-level="full"] .ptf-dot{background:#e03131;box-shadow:0 0 0 3px rgba(224,49,49,.2);animation:ptf-lamp-breathe 2.4s ease-in-out infinite;}',
      '.ptf-lamp[data-level="max"]{color:#a855f7;border-color:rgba(168,85,247,.4);font-weight:600;}',
      '.ptf-lamp[data-level="max"] .ptf-dot{background:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.25);animation:ptf-lamp-breathe 1.4s ease-in-out infinite;}',
      '.ptf-lamp[data-enabled="off"]{opacity:.55;}',
      '@keyframes ptf-lamp-breathe{0%,100%{opacity:1}50%{opacity:.3}}',
      '.ptf-section{display:flex;flex-direction:column;gap:6px;}',
      '.ptf-label{font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500;}',
      '.ptf-textarea{width:100%;min-height:88px;resize:vertical;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));',
      'color:inherit;font:inherit;outline:none;}',
      '.ptf-textarea:focus{border-color:var(--dsw-alias-brand-primary,#2b7fff);}',
      '.ptf-opts{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;}',
      '.ptf-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer;}',
      '.ptf-field{display:inline-flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);}',
      '.ptf-field-wide{flex:1 1 140px;min-width:120px;}',
      '.ptf-number,.ptf-input,.ptf-select{height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));',
      'color:inherit;font:inherit;font-size:12px;outline:none;max-width:100%;}',
      '.ptf-number{width:70px;}',
      '.ptf-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.ptf-primary{height:30px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:none;cursor:pointer;',
      'background:var(--dsw-alias-button-primary-fill,#2b7fff);color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:12px;}',
      '.ptf-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1c6ee0);}',
      '.ptf-primary:disabled{opacity:.5;cursor:not-allowed;}',
      '.ptf-ghost{height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font:inherit;font-size:12px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:inherit;}',
      '.ptf-card{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:var(--dsw-radius-lg,12px);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));}',
      '.ptf-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.ptf-chips{display:flex;flex-wrap:wrap;gap:5px;}',
      '.ptf-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:var(--dsw-radius-xs,999px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-fill-l1,rgba(0,0,0,.04));',
      'color:inherit;font:inherit;font-size:12px;cursor:pointer;}',
      '.ptf-chip:hover{border-color:var(--dsw-alias-state-error-primary,#d33);color:var(--dsw-alias-state-error-primary,#d33);}',
      '.ptf-chip-weight{opacity:.6;font-size:11px;}',
      '.ptf-ref-off{opacity:.5;}',
      '.ptf-refine{display:flex;flex-direction:column;gap:8px;padding-top:10px;',
      'border-top:1px solid var(--dsw-alias-separator-primary,rgba(0,0,0,.08));}',
      '.ptf-refine-input{min-height:56px;font-size:12px;}',
      '.ptf-refine-modes{display:flex;gap:6px;flex-wrap:wrap;}',
      '.ptf-mode{height:24px;padding:0 9px;border-radius:var(--dsw-radius-xs,999px);cursor:pointer;font:inherit;font-size:11px;',
      'background:var(--dsw-alias-fill-l1,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'color:var(--dsw-alias-label-secondary,#5c5c5c);}',
      '.ptf-mode[data-on="on"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));',
      'border-color:var(--dsw-alias-brand-primary,#2b7fff);color:var(--dsw-alias-brand-primary,#2b7fff);}',
      '.ptf-delta{display:flex;gap:6px 12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#5c5c5c);}',
      '.ptf-delta-part{display:inline-flex;gap:4px;align-items:baseline;}',
      '.ptf-delta-tags{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,#181818);}',
      '.ptf-spi{flex:none;display:inline-flex;align-items:baseline;gap:6px;padding:3px 9px;border-radius:var(--dsw-radius-xs,999px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));',
      'font-size:11px;line-height:1.45;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
      '.ptf-spi code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.75;}',
      '.ptf-pair{display:flex;flex-direction:column;gap:6px;}',
      '.ptf-bilingual{min-height:56px;max-height:260px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      'font-size:12px;line-height:1.5;resize:vertical;white-space:pre;}',
      '.ptf-details{border-top:1px solid var(--dsw-alias-separator-primary,rgba(0,0,0,.08));padding-top:8px;}',
      '.ptf-details>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);list-style:none;}',
      '.ptf-details>summary::-webkit-details-marker{display:none;}',
      '.ptf-pre{margin:6px 0 0;padding:8px;border-radius:var(--dsw-radius-sm,6px);white-space:pre-wrap;word-break:break-word;',
      'background:var(--dsw-alias-markdown-code-block,rgba(0,0,0,.04));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}',
      '.ptf-warnings{margin:0;padding-left:16px;color:var(--dsw-alias-state-warn-primary,#b8860b);font-size:12px;}',
      '.ptf-pipeline{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6470);}',
      '.ptf-pipeline .ptf-label{margin:0;white-space:nowrap;}',
      '.ptf-meta{font-size:11px;color:var(--dsw-alias-label-quaternary,#9a9a9a);}',
      '.ptf-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
      '.ptf-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);word-break:break-word;}',
      '.ptf-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#2e9e5b);}',
      '.ptf-job{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ptf-pill{padding:2px 8px;border-radius:var(--dsw-radius-xs,999px);font-size:11px;',
      'background:var(--dsw-alias-fill-l2,rgba(0,0,0,.06));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));}',
      '.ptf-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.7;}',
      '.ptf-images{display:flex;flex-wrap:wrap;gap:8px;}',
      '.ptf-image{display:block;width:132px;border-radius:var(--dsw-radius-md,8px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));}',
      '.ptf-image img{display:block;width:100%;height:auto;}',
      '.ptf-settings{display:flex;flex-direction:column;gap:10px;}',
      '.ptf-grid{display:flex;flex-direction:column;gap:8px;}',
      '.ptf-grid .ptf-field{align-items:stretch;}',
      '.ptf-grid .ptf-input,.ptf-grid .ptf-select{width:100%;}',
    ].join('')

    /** 字典同时支持扁平键（'state.empty'）与嵌套键（meta.title）：先当扁平键查，再按 '.' 往下走。 */
    function lookup(table, key) {
      const flat = String(key ?? '')
      if (table !== null && typeof table === 'object' && Object.prototype.hasOwnProperty.call(table, flat)) {
        const direct = table[flat]
        if (typeof direct === 'string') return direct
      }
      let node = table
      for (const part of flat.split('.')) {
        if (node === null || typeof node !== 'object' || !(part in node)) return flat
        node = node[part]
      }
      return typeof node === 'string' ? node : flat
    }

    /** 面板内所有文案都从这里出；拿不到宿主 locale 时退回内置字典。 */
    /** 宿主 t 查不到（返回空或原键）时用内置字典兜底，保证面板上不出现 state.empty 这种裸键。 */
    function withFallback(primary, fallback) {
      return (key, vars) => {
        let value
        try {
          value = typeof primary === 'function' ? primary(key, vars) : undefined
        } catch (error) {
          value = undefined
        }
        if (typeof value === 'string' && value !== '' && value !== key) return value
        return fallback(key, vars)
      }
    }

    function createT(lang) {
      const table = dict[lang] ?? dict.zh
      return (key, vars) => {
        const raw = lookup(table, key)
        if (vars === undefined || vars === null) return raw
        return raw.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match))
      }
    }

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function clampInt(value, min, max, fallback) {
      const n = Number.parseInt(String(value ?? ''), 10)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    /** 单条 tag → 文本：weight 为 1 就不带括号，别把 (tag:1) 糊进 CLIPTextEncode。 */
    function formatTag(item) {
      const tag = String(item?.tag ?? '').trim()
      if (tag === '') return ''
      const weight = Number(item?.weight)
      if (!Number.isFinite(weight) || Math.abs(weight - 1) < 1e-6) return tag
      return '(' + tag + ':' + Math.round(weight * 100) / 100 + ')'
    }

    function formatTagLine(list) {
      return (Array.isArray(list) ? list : []).map(formatTag).filter(tag => tag !== '').join(', ')
    }

    function normalizeTags(list) {
      return (Array.isArray(list) ? list : [])
        .map(item => {
          const source = typeof item === 'string' ? { tag: item } : item ?? {}
          const weight = Number(source.weight)
          return {
            tag: String(source.tag ?? '').trim(),
            weight: Number.isFinite(weight) ? weight : 1,
            kind: typeof source.kind === 'string' ? source.kind : '',
            cn: typeof source.cn === 'string' ? source.cn : '',
          }
        })
        .filter(item => item.tag !== '')
    }

    /** 本地三道处理的痕迹：老服务端没有 pipeline 字段，缺了就是空数组，面板不显示这一块。 */
    function normalizePipeline(value) {
      const list = key => (Array.isArray(value?.[key]) ? value[key] : [])
      return {
        repairs: list('repairs')
          .map(item => ({ from: String(item?.from ?? ''), to: String(item?.to ?? ''), how: String(item?.how ?? '') }))
          .filter(item => item.from !== '' && item.to !== ''),
        poseHints: list('poseHints').map(item => ({ tag: String(item?.tag ?? ''), hit: String(item?.hit ?? '') })).filter(item => item.tag !== ''),
        changes: list('changes')
          .map(item => ({ kind: String(item?.kind ?? ''), tag: String(item?.tag ?? ''), reason: String(item?.reason ?? '') }))
          .filter(item => item.tag !== ''),
      }
    }

    /** 破甲灯只认服务端给的状态；字段缺了按「全开」兜底，不猜模块。 */
    function normalizePurge(value) {
      const level = LEVELS.includes(value?.level) ? value.level : 'full'
      const chars = Number(value?.chars)
      return {
        level,
        enabled: value?.enabled !== false && level !== 'off',
        modules: Array.isArray(value?.modules) ? value.modules.map(item => String(item)) : [],
        chars: Number.isFinite(chars) && chars > 0 ? chars : 0,
      }
    }

    /** delta 只有三种形状：新增 tag 名、删除 tag 名、调权 {tag, from, to}；形状不对就当空。 */
    function normalizeDelta(value) {
      const text = item => String(item ?? '').trim()
      const num = item => {
        const n = Number(item)
        if (!Number.isFinite(n)) return '?'
        return String(Math.round(n * 100) / 100)
      }
      const names = list => (Array.isArray(list) ? list : [])
        .map(item => (typeof item === 'string' ? item : item?.tag))
        .map(text)
        .filter(item => item !== '')
      const weighted = (Array.isArray(value?.weighted) ? value.weighted : [])
        .map(item => ({ tag: text(item?.tag), from: num(item?.from), to: num(item?.to) }))
        .filter(item => item.tag !== '')
      return { added: names(value?.added), removed: names(value?.removed), weighted }
    }

    function chosenStandards(flags) {
      const out = []
      if (flags.wd) out.push('wd')
      if (flags.camie) out.push('camie')
      return out.length > 0 ? out : ['wd', 'camie']
    }

    function apiUrl(api, path, params) {
      const query = params === undefined || params === null
        ? ''
        : Object.entries(params)
          .filter(([, value]) => value !== undefined && value !== null && value !== '')
          .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
          .join('&')
      return api + path + (query === '' ? '' : '?' + query)
    }

    function imageSrc(api, image) {
      return apiUrl(api, '/image', {
        filename: image?.filename ?? '',
        subfolder: image?.subfolder ?? '',
        type: image?.type ?? 'output',
      })
    }

    /** 所有请求的唯一出口：网络错、非 2xx、坏 JSON 都变成可读结果，面板只负责显示。 */
    async function requestJson(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        return { ok: false, status: 0, payload: null, message: describe(error) }
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok) {
        const message = String(payload?.message ?? payload?.error ?? 'HTTP ' + response.status)
        return { ok: false, status: response.status, payload, message }
      }
      if (payload === null || typeof payload !== 'object') {
        return { ok: false, status: response.status, payload: null, message: 'bad-json' }
      }
      return { ok: true, status: response.status, payload, message: '' }
    }

    // 参考图走 base64 上传：/upload 只收 JSON，不接 multipart
    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('read-failed'))
        reader.readAsDataURL(file)
      })
    }

    function PanelIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 18,
        height: 18,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
        h('path', { key: 'a', d: 'M4 19l7.2-7.2' }),
        h('path', { key: 'b', d: 'M14.5 4.2l5.3 5.3' }),
        h('path', { key: 'c', d: 'M16.4 2.3l5.3 5.3-2.4 2.4-5.3-5.3z' }),
        h('path', { key: 'd', d: 'M11.2 8.1l4.7 4.7-2.1 2.1-4.7-4.7z' }),
      )
    }

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

      // delta 摘要：三类各自成串，全空就明说「没有改动」，别让用户猜按钮有没有生效。
      const deltaNode = refine.status !== 'done' || refine.delta === null ? null : (() => {
        const { added, removed, weighted } = refine.delta
        if (added.length === 0 && removed.length === 0 && weighted.length === 0) {
          return h('div', { key: 'delta', class: 'ptf-hint', 'data-testid': 'ptf-refine-delta' }, t('refine.nochange'))
        }
        const part = (key, label, value) => h('span', { key, class: 'ptf-delta-part' },
          h('span', { key: 'label', class: 'ptf-label' }, label),
          h('span', { key: 'tags', class: 'ptf-delta-tags' }, value),
        )
        return h('div', { key: 'delta', class: 'ptf-delta', 'data-testid': 'ptf-refine-delta' },
          added.length === 0 ? null : part('added', t('refine.added'), added.join(', ')),
          removed.length === 0 ? null : part('removed', t('refine.removed'), removed.join(', ')),
          weighted.length === 0 ? null : part('weighted', t('refine.weighted'),
            weighted.map(item => item.tag + ' ' + item.from + '→' + item.to).join('; ')),
        )
      })()

      // 精修卡：没有结果就没有可改的东西，整块不渲染。
      const refineNode = result === null ? null : h('div', {
        key: 'refine',
        class: 'ptf-refine',
        'data-testid': 'ptf-refine-card',
        'data-mode': refine.mode,
        'data-status': refine.status,
      },
      h('div', { key: 'head', class: 'ptf-card-head' },
        h('span', { key: 'label', class: 'ptf-label' }, t('refine.title')),
      ),
      h('textarea', {
        key: 'input',
        class: 'ptf-textarea ptf-refine-input',
        rows: 2,
        placeholder: t('refine.placeholder'),
        value: refine.instruction,
        'data-testid': 'ptf-refine-input',
        onChange: event => setRefine(previous => ({ ...previous, instruction: event.target.value })),
      }),
      h('div', { key: 'modes', class: 'ptf-refine-modes' }, REFINE_MODES.map(mode => h('button', {
        key: 'mode-' + mode,
        type: 'button',
        class: 'ptf-mode',
        'data-testid': 'ptf-refine-mode-' + mode,
        'data-on': refine.mode === mode ? 'on' : 'off',
        onClick: () => setRefine(previous => ({ ...previous, mode })),
      }, t('refine.mode.' + mode)))),
      h('div', { key: 'actions', class: 'ptf-actions' },
        h('button', {
          key: 'run',
          type: 'button',
          class: 'ptf-primary',
          'data-testid': 'ptf-refine-run',
          disabled: refine.status === 'running',
          onClick: runRefine,
        }, refine.status === 'running' ? t('refine.running') : t('refine.run')),
        refine.error === '' ? null : h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-refine-error' }, refine.error),
      ),
      deltaNode,
      )

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

      const chipNodes = (result?.chips ?? []).map((chip, index) => h('button', {
        key: 'chip-' + index,
        type: 'button',
        class: 'ptf-chip',
        title: t('action.removeTag'),
        'data-testid': 'ptf-chip',
        'data-tag': chip.tag,
        onClick: () => removeChip(index),
      },
      h('span', { key: 'tag' }, chip.tag),
      chip.weight !== 1 ? h('span', { key: 'w', class: 'ptf-chip-weight' }, 'x' + chip.weight) : null,
      ))

      const warningNodes = (result?.warnings ?? []).map((warning, index) => h('li', { key: 'warn-' + index }, warning))

      // 本地处理痕迹：让用户看得见"模型给的词被改成了什么"，词库缺词也一眼可查。
      const pipe = result?.pipeline ?? { repairs: [], poseHints: [], changes: [] }
      const pipeParts = []
      if (pipe.repairs.length > 0) {
        pipeParts.push(t('pipeline.repairs') + ' ' + pipe.repairs.map(item => item.from + '→' + item.to).join('、'))
      }
      if (pipe.poseHints.length > 0) {
        pipeParts.push(t('pipeline.poseHints') + ' ' + pipe.poseHints.map(item => item.tag).join('、'))
      }
      if (pipe.changes.length > 0) {
        pipeParts.push(t('pipeline.changes') + ' ' + pipe.changes.map(item => item.tag).join('、'))
      }
      const pipelineNode = pipeParts.length === 0
        ? null
        : h('div', { key: 'pipeline', class: 'ptf-pipeline', 'data-testid': 'ptf-pipeline', title: pipeParts.join(' · ') },
          h('span', { key: 'label', class: 'ptf-label' }, t('pipeline.title')),
          h('span', { key: 'text' }, pipeParts.join(' · ')))

      const imageNodes = (run.images ?? []).map((image, index) => h('a', {
        key: 'image-' + index,
        class: 'ptf-image',
        href: imageSrc(api, image),
        target: '_blank',
        rel: 'noreferrer',
        title: image?.filename ?? '',
      },
      h('img', { key: 'img', src: imageSrc(api, image), alt: t('image'), 'data-testid': 'ptf-image', loading: 'lazy' }),
      ))

      const lampTitle = purgeInfo.enabled
        ? [t('purge.lamp') + ' · ' + t('level.' + purgeInfo.level),
          purgeInfo.modules.length > 0 ? t('purge.modules') + ': ' + purgeInfo.modules.join(', ') : '',
          purgeInfo.chars > 0 ? purgeInfo.chars + t('purge.charsUnit') : '',
          t('purge.live')].filter(item => item !== '').join(' · ')
        : [t('purge.lamp') + ' · ' + t('purge.off'), t('purge.live')].join(' · ')

      const lampNode = h('span', {
        key: 'lamp',
        class: 'ptf-lamp',
        'data-level': purgeInfo.level,
        'data-enabled': purgeInfo.enabled ? 'on' : 'off',
        'data-testid': 'ptf-purge-lamp',
        title: lampTitle,
      },
      h('span', { key: 'dot', class: 'ptf-dot' }),
      h('span', { key: 'text' }, t('purge.lamp') + ' · ' + t('level.' + purgeInfo.level)),
      )

      // SPI 徽标：版本 + 槽位数 + 当前接口前缀，一眼看出面板连的是哪套接口。
      const spiNode = !spi.ok ? null : h('span', {
        key: 'spi',
        class: 'ptf-spi',
        'data-testid': 'ptf-spi-badge',
        'data-version': spi.version,
        'data-slots': spi.slots,
        title: t('spi.badge') + ' v' + spi.version + ' · ' + spi.slots + t('spi.slots') + ' · ' + api,
      },
      h('span', { key: 'text' }, t('spi.badge') + ' v' + spi.version + ' · ' + spi.slots + t('spi.slots')),
      h('code', { key: 'api' }, api),
      )

      const comfyTitle = [
        t('comfy.lamp') + ' · ' + t('comfy.' + comfyStatus.state),
        comfyStatus.version !== '' ? 'v' + comfyStatus.version : '',
        comfyStatus.launchDir !== '' ? t('comfy.dir') + ': ' + comfyStatus.launchDir : '',
        comfyStatus.message,
        t('comfy.checkHint'),
      ].filter(item => typeof item === 'string' && item !== '').join(' · ')

      const comfyNode = h('button', {
        key: 'comfy',
        type: 'button',
        class: 'ptf-lamp ptf-comfy',
        'data-state': comfyStatus.state,
        'data-testid': 'ptf-comfy-lamp',
        title: comfyTitle,
        disabled: comfyStatus.busy !== '',
        onClick: checkComfy,
      },
      h('span', { key: 'dot', class: 'ptf-dot' }),
      h('span', { key: 'text' }, t('comfy.' + comfyStatus.state) + (comfyStatus.version !== '' ? ' v' + comfyStatus.version : '')),
      )

      const workflowOptions = [h('option', { key: 'auto', value: '' }, t('workflow.auto'))].concat(
        workflows.map(item => {
          const needsImage = Array.isArray(item.vars) && item.vars.some(v => String(v?.name ?? '') === 'image')
          return h('option', { key: String(item.id), value: String(item.id) }, String(item.title ?? item.id) + (needsImage ? t('ref.badge') : ''))
        }),
      )

      const levelSelect = (onChange, testId = 'ptf-level') => h('select', {
        key: 'level',
        class: 'ptf-select',
        value: level,
        'data-testid': testId,
        onChange: event => onChange(event.target.value),
      }, LEVELS.map(item => h('option', { key: item, value: item }, t('level.' + item))))

      const settingsNode = h('details', {
        key: 'settings',
        class: 'ptf-details ptf-settings',
        'data-testid': 'ptf-settings',
      },
      h('summary', { key: 'summary' }, t('settings')),
      h('div', { key: 'body', class: 'ptf-grid' },
        h('label', { key: 'provider', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.provider')),
          h('input', {
            key: 'input',
            class: 'ptf-input',
            'data-testid': 'ptf-set-provider',
            value: settings.provider,
            onChange: event => patchSettings({ provider: event.target.value }),
          }),
        ),
        h('label', { key: 'model', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.model')),
          h('input', {
            key: 'input',
            class: 'ptf-input',
            'data-testid': 'ptf-set-model',
            value: settings.model,
            onChange: event => patchSettings({ model: event.target.value }),
          }),
        ),
        h('label', { key: 'level', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.level')),
          levelSelect(value => patchSettings({ level: value }), 'ptf-set-level'),
        ),
        h('div', { key: 'forge', class: 'ptf-field ptf-field-wide' },
          h('span', { key: 'label' }, t('settings.forge')),
          h('div', { key: 'row', class: 'ptf-opts' },
            h('label', { key: 'repair', class: 'ptf-check' },
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: settings.forgeRepair,
                'data-testid': 'ptf-forge-repair',
                onChange: () => patchSettings({ forgeRepair: !settings.forgeRepair }),
              }),
              h('span', { key: 'text' }, t('settings.repair')),
            ),
            h('label', { key: 'postprocess', class: 'ptf-check' },
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: settings.forgePostprocess,
                'data-testid': 'ptf-forge-postprocess',
                onChange: () => patchSettings({ forgePostprocess: !settings.forgePostprocess }),
              }),
              h('span', { key: 'text' }, t('settings.postprocess')),
            ),
            h('label', { key: 'poseHints', class: 'ptf-check' },
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: settings.forgePoseHints,
                'data-testid': 'ptf-forge-posehints',
                onChange: () => patchSettings({ forgePoseHints: !settings.forgePoseHints }),
              }),
              h('span', { key: 'text' }, t('settings.poseHints')),
            ),
            h('label', { key: 'candidates', class: 'ptf-check' },
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: settings.forgeCandidates,
                'data-testid': 'ptf-forge-candidates',
                onChange: () => patchSettings({ forgeCandidates: !settings.forgeCandidates }),
              }),
              h('span', { key: 'text' }, t('settings.candidates')),
            ),
          ),
        ),
        h('label', { key: 'baseUrl', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.baseUrl')),
          h('input', {
            key: 'input',
            class: 'ptf-input',
            'data-testid': 'ptf-set-baseurl',
            value: settings.baseUrl,
            onChange: event => patchSettings({ baseUrl: event.target.value }),
          }),
        ),
        h('label', { key: 'workflowDir', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.workflowDir')),
          h('input', {
            key: 'input',
            class: 'ptf-input',
            'data-testid': 'ptf-set-workflowdir',
            value: settings.workflowDir,
            onChange: event => patchSettings({ workflowDir: event.target.value }),
          }),
        ),
        h('label', { key: 'launchDir', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.launchDir')),
          h('input', {
            key: 'input',
            class: 'ptf-input',
            'data-testid': 'ptf-set-launchdir',
            placeholder: t('settings.launchDirHint'),
            value: settings.launchDir,
            onChange: event => patchSettings({ launchDir: event.target.value }),
          }),
        ),
        h('label', { key: 'pythonPath', class: 'ptf-field' },
          h('span', { key: 'label' }, t('settings.pythonPath')),
          h('input', {
            key: 'input',
            class: 'ptf-input',
            'data-testid': 'ptf-set-pythonpath',
            placeholder: t('settings.pythonPathHint'),
            value: settings.pythonPath,
            onChange: event => patchSettings({ pythonPath: event.target.value }),
          }),
        ),
        h('div', { key: 'comfyActions', class: 'ptf-actions' },
          h('button', {
            key: 'check',
            type: 'button',
            class: 'ptf-ghost',
            'data-testid': 'ptf-comfy-check',
            disabled: comfyStatus.busy !== '',
            onClick: checkComfy,
          }, comfyStatus.busy === 'check' ? t('comfy.checking') : t('comfy.check')),
          h('button', {
            key: 'launch',
            type: 'button',
            class: 'ptf-ghost',
            'data-testid': 'ptf-comfy-launch',
            disabled: comfyStatus.busy !== '',
            onClick: startComfy,
          }, comfyStatus.busy === 'launch' ? t('comfy.launching') : t('comfy.launch')),
          h('span', {
            key: 'state',
            class: comfyStatus.state === 'online' ? 'ptf-ok' : 'ptf-hint',
            'data-testid': 'ptf-comfy-state',
          }, t('comfy.' + comfyStatus.state)),
          comfyStatus.message !== '' ? h('span', { key: 'msg', class: 'ptf-error' }, comfyStatus.message) : null,
        ),
        h('div', { key: 'actions', class: 'ptf-actions' },
          h('button', {
            key: 'save',
            type: 'button',
            class: 'ptf-primary',
            'data-testid': 'ptf-save-settings',
            disabled: settingsStatus === 'saving',
            onClick: saveSettings,
          }, settingsStatus === 'saving' ? t('settings.saving') : t('settings.save')),
          settingsStatus === 'saved' ? h('span', { key: 'ok', class: 'ptf-ok', 'data-testid': 'ptf-settings-saved' }, t('settings.saved')) : null,
          settingsError !== '' ? h('span', { key: 'err', class: 'ptf-error' }, settingsError) : null,
        ),
      ),
      )

      const resultNode = result === null ? null : h('section', {
        key: 'result',
        class: 'ptf-card',
        'data-testid': 'ptf-result',
      },
      h('div', { key: 'head', class: 'ptf-card-head' },
        h('span', { key: 'label', class: 'ptf-label' }, t('result.positive')),
        h('button', {
          key: 'copy',
          type: 'button',
          class: 'ptf-ghost',
          'data-testid': 'ptf-copy',
          onClick: copyPositive,
        }, copyStatus === 'copied' ? t('action.copied') : copyStatus === 'failed' ? t('action.copyFailed') : t('action.copy')),
      ),
      h('div', { key: 'pair', class: 'ptf-pair' },
        h('div', { key: 'head', class: 'ptf-card-head' },
          h('span', { key: 'label', class: 'ptf-label' }, t('result.bilingual')),
          h('button', {
            key: 'copy',
            type: 'button',
            class: 'ptf-ghost',
            'data-testid': 'ptf-copy-bilingual',
            onClick: copyBilingual,
          }, copyPair === 'copied' ? t('action.copied') : copyPair === 'failed' ? t('action.copyFailed') : t('action.copy')),
        ),
        h('textarea', {
          key: 'text',
          class: 'ptf-textarea ptf-bilingual',
          'data-testid': 'ptf-bilingual',
          readOnly: true,
          rows: Math.min(20, Math.max(4, pairLines.length)),
          value: bilingualText,
          title: t('hint.bilingual'),
          onFocus: event => { if (typeof event?.target?.select === 'function') event.target.select() },
        }),
      ),
      h('div', { key: 'chips', class: 'ptf-chips', 'data-testid': 'ptf-chips' },
        chipNodes.length > 0 ? chipNodes : h('span', { key: 'none', class: 'ptf-hint' }, '-'),
      ),
      pipelineNode,
      refineNode,
      h('div', { key: 'full', class: 'ptf-pre', 'data-testid': 'ptf-positive' }, positiveText),
      warningNodes.length > 0
        ? h('div', { key: 'warnings' },
          h('div', { key: 'label', class: 'ptf-label' }, t('result.warnings')),
          h('ul', { key: 'list', class: 'ptf-warnings', 'data-testid': 'ptf-warnings' }, warningNodes),
        )
        : null,
      h('details', { key: 'negative', class: 'ptf-details', 'data-testid': 'ptf-negative' },
        h('summary', { key: 'summary' }, t('result.negative') + ' (' + result.negativeChips.length + ')'),
        h('div', { key: 'builtin', class: 'ptf-hint', 'data-testid': 'ptf-negative-builtin' }, t('result.negativeBuiltin')),
        h('pre', { key: 'text', class: 'ptf-pre' }, negativeText),
        h('pre', { key: 'pairs', class: 'ptf-pre ptf-bilingual', 'data-testid': 'ptf-negative-pairs' }, negativePairText),
      ),
      h('details', { key: 'raw', class: 'ptf-details', 'data-testid': 'ptf-raw' },
        h('summary', { key: 'summary' }, t('result.raw')),
        h('pre', { key: 'text', class: 'ptf-pre' }, result.raw),
      ),
      h('div', { key: 'meta', class: 'ptf-meta' },
        t('result.meta') + ': ' + (result.model === '' ? '-' : result.model) + (result.ms > 0 ? ' / ' + result.ms + 'ms' : ''),
      ),
      h('div', {
        key: 'ref',
        class: isRefWorkflow ? 'ptf-field ptf-field-wide' : 'ptf-field ptf-field-wide ptf-ref-off',
        'data-testid': 'ptf-ref',
        'data-active': isRefWorkflow ? 'on' : 'off',
      },
        h('span', { key: 'label' }, t('ref.label')),
        h('input', {
          key: 'file',
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp',
          disabled: !isRefWorkflow,
          'data-testid': 'ptf-ref-file',
          onChange: pickRef,
        }),
        h('div', {
          key: 'status',
          class: refError !== '' ? 'ptf-error' : 'ptf-hint',
          'data-testid': 'ptf-ref-status',
        }, !isRefWorkflow
          ? t('ref.offHint')
          : refBusy ? t('ref.uploading') : refError !== '' ? t('ref.failed') + ': ' + refError : refName !== '' ? t('ref.ready') + ' ' + refName : t('ref.hint')),
      ),
      h('div', { key: 'actions', class: 'ptf-actions' },
        h('button', {
          key: 'submit',
          type: 'button',
          class: 'ptf-primary',
          'data-testid': 'ptf-submit',
          disabled: run.status === 'submitting' || run.status === 'queued' || run.status === 'running',
          onClick: submitRun,
        }, run.status === 'submitting'
          ? t('action.submitting')
          : run.status === 'idle' ? t('action.submit') : t('action.resubmit')),
      ),
      h('div', { key: 'job', class: 'ptf-job', 'data-testid': 'ptf-job', 'data-job': run.status },
        h('span', { key: 'label', class: 'ptf-label' }, t('job')),
        h('span', { key: 'state', class: 'ptf-pill' }, t('job.' + (JOB_KEY[run.status] ?? 'idle'))),
        run.promptId === '' ? null : h('code', { key: 'id', class: 'ptf-code' }, run.promptId),
      ),
      run.error !== '' ? h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-run-error' }, t('error.run') + ': ' + run.error) : null,
      imageNodes.length > 0 ? h('div', { key: 'images', class: 'ptf-images', 'data-testid': 'ptf-images' }, imageNodes) : null,
      )

      const body = forge.status === 'forging'
        ? h('div', { key: 'loading', class: 'ptf-hint', 'data-testid': 'ptf-loading' }, t('state.loading'))
        : resultNode !== null
          ? resultNode
          : h('div', { key: 'empty', class: 'ptf-hint', 'data-testid': 'ptf-empty' }, t('state.empty'))

      return h('div', {
        class: 'ptf',
        'data-testid': 'ptf-panel',
        'data-state': forge.status,
        'data-job': run.status,
      },
      h('style', { key: 'style' }, CSS),
      h('div', { key: 'head', class: 'ptf-head' },
        h('div', { key: 'row', class: 'ptf-head-row' },
          h('div', { key: 'titles', class: 'ptf-head-titles' },
            h('div', { key: 'title', class: 'ptf-title' }, t('title')),
            h('div', { key: 'sub', class: 'ptf-sub' }, t('subtitle')),
          ),
          h('div', { key: 'tags', class: 'ptf-head-tags' }, comfyNode, spiNode, lampNode),
        ),
      ),
      h('section', { key: 'input', class: 'ptf-section' },
        h('label', { key: 'label', class: 'ptf-label', htmlFor: 'ptf-text' }, t('label.input')),
        h('textarea', {
          key: 'textarea',
          id: 'ptf-text',
          class: 'ptf-textarea',
          rows: 4,
          placeholder: t('placeholder.input'),
          value: text,
          'data-testid': 'ptf-text',
          onChange: event => setText(event.target.value),
        }),
      ),
      h('div', { key: 'options', class: 'ptf-opts' },
        h('label', { key: 'wd', class: 'ptf-check' },
          h('input', {
            key: 'input',
            type: 'checkbox',
            checked: standards.wd,
            'data-testid': 'ptf-standard-wd',
            onChange: () => setStandards({ ...standards, wd: !standards.wd }),
          }),
          h('span', { key: 'text' }, t('standard.wd')),
        ),
        h('label', { key: 'camie', class: 'ptf-check' },
          h('input', {
            key: 'input',
            type: 'checkbox',
            checked: standards.camie,
            'data-testid': 'ptf-standard-camie',
            onChange: () => setStandards({ ...standards, camie: !standards.camie }),
          }),
          h('span', { key: 'text' }, t('standard.camie')),
        ),
        h('label', { key: 'max', class: 'ptf-field' },
          h('span', { key: 'label' }, t('maxTags')),
          h('input', {
            key: 'input',
            type: 'number',
            min: 8,
            max: 160,
            class: 'ptf-number',
            value: maxTags,
            'data-testid': 'ptf-maxtags',
            onChange: event => setMaxTags(clampInt(event.target.value, 8, 160, 40)),
          }),
        ),
        h('label', { key: 'workflow', class: 'ptf-field ptf-field-wide' },
          h('span', { key: 'label' }, t('workflow')),
          h('select', {
            key: 'select',
            class: 'ptf-select',
            value: workflowId,
            'data-testid': 'ptf-workflow',
            onChange: event => setWorkflowId(event.target.value),
          }, workflowOptions),
        ),
        h('label', { key: 'level', class: 'ptf-field' },
          h('span', { key: 'label' }, t('level')),
          levelSelect(setLevel),
        ),
      ),
      workflowState === 'loading'
        ? h('div', { key: 'workflow-loading', class: 'ptf-hint', 'data-testid': 'ptf-workflow-loading' }, t('workflow.loading'))
        : workflowState === 'error'
          ? h('div', { key: 'workflow-error', class: 'ptf-error', 'data-testid': 'ptf-workflow-error' }, t('workflow.error') + ': ' + workflowError)
          : null,
      h('div', { key: 'actions', class: 'ptf-actions' },
        h('button', {
          key: 'generate',
          type: 'button',
          class: 'ptf-primary',
          'data-testid': 'ptf-generate',
          disabled: forge.status === 'forging' || text.trim() === '',
          onClick: generate,
        }, forge.status === 'forging' ? t('action.generating') : t('action.generate')),
      ),
      forge.error !== '' ? h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-error' }, t('error.forge') + ': ' + forge.error) : null,
      body,
      settingsNode,
      )
    }

    function warn(where, error) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[tagger] ' + where + ': ' + message)
      }
    }

    function apply(ctx) {
      let t = createT('zh')

      // 客户端 cordis 不能在声明 inject 之外直接摸服务（会抛 cannot get property "locale" without inject），
      // 所以 locale / betterSidebar 都走 ctx.inject(['x'], scope => ...)：服务缺席时回调不执行，面板照样挂载。
      try {
        ctx.inject(['locale'], scope => {
          const locale = scope.locale
          if (locale === null || locale === undefined || typeof locale.register !== 'function') return
          const register = () => {
            const dispose = locale.register(NS, { zh: dict.zh, en: dict.en })
            if (typeof locale.bind === 'function') t = withFallback(locale.bind(NS), createT('zh'))
            return dispose
          }
          if (typeof scope.effect === 'function') scope.effect(register, 'tagger: dictionaries')
          else register()
        })
      } catch (error) {
        warn('locale', error)
      }

      // betterSidebar 是可选注入：没有这个服务时 cordis 只是不执行回调，原生面板照样在。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['betterSidebar'], scope => {
            const sidebar = scope?.betterSidebar ?? (typeof scope?.get === 'function' ? scope.get('betterSidebar') : undefined)
            if (sidebar === undefined || sidebar === null || typeof sidebar.registerTab !== 'function') return
            const register = () => sidebar.registerTab({
              id: TAB_ID,
              title: t('meta.title'),
              description: t('meta.description'),
              icon: PanelIcon,
              order: 41,
              single: true,
              component: Panel,
            })
            if (typeof scope.effect === 'function') scope.effect(register, 'tagger: betterSidebar tab')
            else register()
          })
        }
      } catch (error) {
        warn('betterSidebar', error)
      }

      const slots = ctx.slots
      if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        warn('slots', 'slots 服务不可用，面板没有运行时挂载点。')
        return
      }

      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 41,
        locale: NS,
        label: () => t('panel'),
      }, PanelIcon))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t, api: API }),
      }, Panel))
    }

    return {
      name: 'dsh-tagger',
      inject: ['slots'],
      apply,
      /** 测试用：面板、字典、纯函数都从这里拿，不影响宿主消费的字段。 */
      __internals: {
        Panel,
        PanelIcon,
        dict,
        createT,
        formatTag,
        formatTagLine,
        normalizeTags,
        normalizePipeline,
        normalizePurge,
        normalizeDelta,
        chosenStandards,
        apiUrl,
        imageSrc,
        requestJson,
        NS,
        API,
        PANEL_ID,
        LEVELS,
      },
    }
  },
})
