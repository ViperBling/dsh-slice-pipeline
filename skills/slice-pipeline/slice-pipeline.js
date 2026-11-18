// ============================================================================
// DSH workflow 模板 —— 单 Slice 开发流水线（角色 / 模型 / 阶段 三分离）
// ----------------------------------------------------------------------------
// 运行模型：**一次只跑一个 Slice**；是否开启下一个 Slice 严格由用户触发。
//   · mode='plan-only'：跑 stages.plan（默认只有 design），返回计划交用户裁决
//   · mode='slice'    ：跑 stages.slice（默认 brief 投影 → 实现 → 代码审查 → 修订闭环）
//
// 为什么一次只跑一个：每个 Slice 是**单独可回退的单元**，推进节奏
// 由用户掌握。因此本脚本**没有跨 Slice 循环**——循环即等于"自动开启下一个 Slice"。
//
// 角色与模型：单一真源是 dsh-slice-pipeline 插件设置；主会话把 skill 注入的
// args JSON 原样传入（含 roles）。脚本无文件系统 API，自己读不了文件。
// 角色名与内置兜底值：
//   designer = deepseek-official/deepseek-flash （design）
//   reviewer = deepseek-official/deepseek-flash （codeReview）
//   task     = deepseek-official/deepseek-flash （implement / fix）
//   default  = deepseek-official/deepseek-flash （兜底：未单独列出的角色名落这里）
// 解析优先级：args.roles.<role> > args.roles.default > args.<legacy>Model > 内置默认值。
// effort 不在角色表内：agent() 不支持 effort，档位由各 provider 路由默认值决定。
//
// 阶段配置：默认值来自插件设置，由主会话把注入的 args JSON 原样传入 `args.stages`。
// 三个阶段族，各自是一串**有序、可裁剪**的阶段名：
//   plan:  design（主计划+切片定义+每片 research）
//   slice: brief（主会话产出/投影，不派 agent）→ implement（实现）→ codeReview（代码审查）
//          → fix（修订闭环，修复回生成方 + 复审）
// 归档（2026-11-03）：planReview、briefReview 的代码保留，但默认阶段表不含、
// 配置/覆盖里出现会被剔除并告警，不可启用（STAGE_DEFS.*.archived）。
// 硬依赖（调整顺序时不得违反）：design 首个；brief 在 implement 前；codeReview 在
// implement 后；fix 在 codeReview 后且依赖它。违反即 Fail Fast 抛错。
// 阶段角色来自 args.modules.{planning,review,patchDelivery}.role（排序/裁剪不改角色分工）。
//
// 交付物只有 patch + 薄文档。写入范围按场地规则：
//   · 给了 args.workspace（工作区副本）→ 只允许改副本，严禁碰原工作区；副本无需回退；
//   · 未给 → 允许在原仓库改，但产出 patch 后必须回退到基线。
//
// 单 Slice 内部是严格串行的（阶段间数据依赖，环环相扣），没有可并发项。
//
// ⚠️ 覆盖不了「交互式讨论」：workflow 非交互（父轮次等待、子 agent 消息不进父上下文）。
//
// args 约定：
//   plan-only 模式：{ mode:'plan-only', requirement:string, repoRoot?:string,
//                     discussionDigest?:string, maxSlices?:number,
//                     roles?:{ designer?, reviewer?, task?, default? },
//                     stages?:{ plan?:string[] } }
//   slice 模式    ：{ mode:'slice', sliceId:string, plan:object, repoRoot?:string,
//                     workspace?:string, outDir?:string, taskName?:string,
//                     designDocPath?:string, maxFixRounds?:number,
//                     roles?:{ designer?, reviewer?, task?, default? },
//                     stages?:{ slice?:string[] } }
//     roles = 角色 → 模型映射：把插件设置注入的 args.roles 原样传入。每个角色形如
//       { provider:'...', model:'...' }；只读 provider/model 两个字段，多传的键会被忽略。
//     stages = 阶段配置：把插件设置注入的 args.stages 原样传入（可只给其中一族）。
//     modules / reviewStandardPath = 插件注入的模块状态与审查规范路径；原样传入。
//     designModel / reviewModel / taskModel = 旧版单角色覆盖，保留兼容；
//       仅当对应角色不在 args.roles（含 args.roles.default）里时才生效。
//     designDocPath = brief（兜底 mode）与归档的 briefReview 使用的设计上位基准；
//       缺省按 <outDir>/plan.md → <outDir>/plan.json 顺序取第一个存在的。
// ============================================================================

const A = args || {};

// --- 角色 → 模型 解析 -------------------------------------------------------
// 真源：dsh-slice-pipeline 插件设置；主会话把 skill 注入的 args.roles 原样传入。
// 优先级：args.roles.<role> > args.roles.default > args.<legacy>Model > 内置默认值。
// 内置默认值只作为最后兜底：标准 DSH 的 deepseek-official/deepseek-flash。
const ROLE_DEFAULTS = {
  designer: { provider: 'deepseek-official', model: 'deepseek-flash' },
  reviewer: { provider: 'deepseek-official', model: 'deepseek-flash' },
  task:     { provider: 'deepseek-official', model: 'deepseek-flash' },
  default:  { provider: 'deepseek-official', model: 'deepseek-flash' }
};
const ROLE_NAMES = Object.keys(ROLE_DEFAULTS);
const A_ROLES = (A.roles && typeof A.roles === 'object' && !Array.isArray(A.roles)) ? A.roles : {};

// --- 模块配置解析（由 dsh-slice-pipeline 插件设置注入 args.modules） --------
const MODULE_KEYS = ['pipeline', 'planning', 'patchDelivery', 'workspaceRecovery', 'review', 'diagrams'];
const MODULE_STATUSES = ['ok', 'disabled', 'missingDoc'];
const HAS_MODULES = A.modules !== undefined;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

if (HAS_MODULES) {
  if (!isPlainObject(A.modules)) {
    throw new Error('args.modules must be an object (copy it from the injected plugin config)');
  }
  for (const key of MODULE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(A.modules, key)) continue;
    const module = A.modules[key];
    if (!isPlainObject(module)) {
      throw new Error('args.modules.' + key + '.enabled must be a boolean');
    }
    if (typeof module.enabled !== 'boolean') {
      throw new Error('args.modules.' + key + '.enabled must be a boolean');
    }
    if (module.role !== undefined
      && (typeof module.role !== 'string' || ROLE_NAMES.indexOf(module.role) === -1)) {
      throw new Error('args.modules.' + key + '.role must be one of: ' + ROLE_NAMES.join(', '));
    }
    if (module.status !== undefined && MODULE_STATUSES.indexOf(module.status) === -1) {
      throw new Error('args.modules.' + key + '.status must be one of: ' + MODULE_STATUSES.join(', '));
    }
    if (module.docs !== undefined) {
      if (!isPlainObject(module.docs)) {
        throw new Error('args.modules.' + key + '.docs must be an object with string values');
      }
      for (const docKey of Object.keys(module.docs)) {
        if (typeof module.docs[docKey] !== 'string') {
          throw new Error('args.modules.' + key + '.docs.' + docKey + ' must be a string');
        }
      }
    }
  }
  for (const key of Object.keys(A.modules)) {
    if (MODULE_KEYS.indexOf(key) === -1) {
      log('warn: args.modules.' + key + ' is not a known module (known: '
        + MODULE_KEYS.join(', ') + '); ignored by this workflow');
    }
  }
}

function moduleRole(key, fallback) {
  const module = HAS_MODULES ? A.modules[key] : undefined;
  return (module && typeof module.role === 'string') ? module.role : fallback;
}

// 只取 provider/model 两个字段：agent() 的 opts 只认这两项模型覆盖，多传的键
// （例如误抄进来的 effort）会触发"误用 hook"从而中断整个脚本。
function resolveRole(roleName, legacyOverride) {
  const candidates = [
    ['args.roles.' + roleName, A_ROLES[roleName]],
    ['args.roles.default', A_ROLES.default],
    ['args.' + roleName + 'Model (legacy)', legacyOverride],
    ['built-in default', ROLE_DEFAULTS[roleName] || ROLE_DEFAULTS.default]
  ];
  for (let i = 0; i < candidates.length; i++) {
    const source = candidates[i][0];
    const cand = candidates[i][1];
    if (cand === undefined || cand === null) continue;
    if (typeof cand !== 'object' || Array.isArray(cand)) {
      throw new Error('role "' + roleName + '" from ' + source
        + ' must be an object like { provider, model }');
    }
    if (typeof cand.provider !== 'string' || cand.provider.length === 0
      || typeof cand.model !== 'string' || cand.model.length === 0) {
      throw new Error('role "' + roleName + '" from ' + source
        + ' must carry non-empty string "provider" and "model"');
    }
    return { provider: cand.provider, model: cand.model };
  }
  // ROLE_DEFAULTS 一定命中，这里只是防御
  throw new Error('unreachable: no route resolved for role "' + roleName + '"');
}

const PLANNING_ROLE = moduleRole('planning', 'designer');
const REVIEW_ROLE = moduleRole('review', 'reviewer');
const DELIVERY_ROLE = moduleRole('patchDelivery', 'task');
const DESIGN = resolveRole(PLANNING_ROLE, A.designModel);
const REVIEW = resolveRole(REVIEW_ROLE, A.reviewModel);
const TASK = resolveRole(DELIVERY_ROLE, A.taskModel);

// phase 标签渲染用：把角色路由显示成 provider/model，避免标签写死"Opus/DeepSeek"
// 与实际配置脱节（角色表改了、标签不改会误导）。
function mdl(route) { return route.provider + '/' + route.model; }

// 结果自带路由指纹：主会话汇报时必须引用，避免凭记忆或注入块猜模型。
const ROUTES = {
  planning: { role: PLANNING_ROLE, route: mdl(DESIGN) },
  review: { role: REVIEW_ROLE, route: mdl(REVIEW) },
  delivery: { role: DELIVERY_ROLE, route: mdl(TASK) }
};

// 阶段执行器注册表：每个阶段怎么跑、用哪个角色。排序/裁剪只改 stages，
// 不改这里——阶段与角色的分工是稳定的。`archived: true` 是归档的唯一真源：
// ARCHIVED_STAGES 由它派生，重新启用 = 去掉标记 + 恢复默认阶段表。
// 必须定义在 parseStages 之前（阶段表解析要用归档名单）。
const STAGE_DEFS = {
  design: { family: 'plan', role: DESIGN, title: '设计（主计划 + 切片定义 + research）' },
  planReview: { family: 'plan', role: REVIEW, title: '计划审查', archived: true },
  brief: { family: 'slice', role: DESIGN, title: 'brief（主会话产出，workflow 只做投影）', lead: true },
  briefReview: { family: 'slice', role: REVIEW, title: '设计审查（只审方案合理性）', archived: true },
  implement: { family: 'slice', role: TASK, title: '实现（patch + 薄文档）' },
  codeReview: { family: 'slice', role: REVIEW, title: '代码审查' },
  fix: { family: 'slice', role: TASK, title: '修订（修复回生成方 + 复审）' }
};
const ARCHIVED_STAGES = Object.keys(STAGE_DEFS).filter((key) => STAGE_DEFS[key].archived === true);

const BATCH_MODES = ['plan-only', 'slice'];
const STAGE_MODES = ['design', 'brief', 'review', 'render-implement', 'render-fix'];
const mode = A.mode;
if (BATCH_MODES.indexOf(mode) === -1 && STAGE_MODES.indexOf(mode) === -1) {
  throw new Error('args.mode must be one of: ' + BATCH_MODES.concat(STAGE_MODES).join(', ')
    + " (batch: plan-only = design + plan review; slice = run exactly one slice. "
    + "stage: design / brief / review / render-implement / render-fix, one stage per run). "
    + "One slice per run: whether to start the next slice is the user's call.");
}
const isStageMode = STAGE_MODES.indexOf(mode) !== -1;

// --- 阶段配置：有序、可裁剪（默认来自 dsh-slice-pipeline 插件设置，内联进 args.stages）---
// 阶段执行器与归档名单见上文 STAGE_DEFS；此处只做校验与默认值。
// 默认（2026-11-03 起）：plan 只跑 design；slice 保留 brief 阶段（由主会话产出/批处理投影），
// 不再派发 brief agent。planReview / briefReview 已归档不启用（STAGE_DEFS.archived）。
const DEFAULT_STAGES = {
  plan:  ['design'],
  slice: ['brief', 'implement', 'codeReview', 'fix']
};
// 阶段 → 族（供 parseStages 校验；角色映射在文末 STAGE_DEFS）。
const STAGE_FAMILY = {
  design: 'plan', planReview: 'plan',
  brief: 'slice', briefReview: 'slice', implement: 'slice', codeReview: 'slice', fix: 'slice'
};
// 硬依赖：index(a) < index(b) 时 a 必须先于 b 出现。用于排序校验。
const STAGE_ORDER_CONSTRAINTS = [
  ['brief', 'implement'],
  ['brief', 'briefReview'],
  ['briefReview', 'implement'],
  ['implement', 'codeReview'],
  ['codeReview', 'fix']
];
// 必备阶段：缺了整条流水线不成立。brief 不再是必填（改由主会话产出）。
const REQUIRED_STAGES = { plan: ['design'], slice: ['implement'] };

function parseStages(family, override) {
  const list = (override === undefined || override === null)
    ? DEFAULT_STAGES[family].slice()
    : override;
  if (!Array.isArray(list) || list.length === 0 || list.some((s) => typeof s !== 'string')) {
    throw new Error('args.stages.' + family + ' must be a non-empty array of stage-name strings');
  }
  const known = Object.keys(STAGE_FAMILY).filter((k) => STAGE_FAMILY[k] === family);
  const unknown = list.filter((s) => known.indexOf(s) === -1);
  if (unknown.length > 0) {
    throw new Error('args.stages.' + family + ' has unknown stage(s): ' + unknown.join(', ')
      + '; known stages for "' + family + '": ' + known.join(', '));
  }
  const dup = list.filter((s, i) => list.indexOf(s) !== i);
  if (dup.length > 0) {
    throw new Error('args.stages.' + family + ' has duplicate stage(s): ' + [...new Set(dup)].join(', '));
  }
  // 归档阶段：代码保留但不启用——从阶段表剔除并告警，显式覆盖同样处理。
  const active = list.filter((s) => {
    if (ARCHIVED_STAGES.indexOf(s) === -1) return true;
    log('warn: stage "' + s + '" 已归档，不启用；已从 args.stages.' + family + ' 中剔除'
      + '（代码保留，重新启用需从归档名单移除并恢复默认阶段表）');
    return false;
  });
  for (const req of REQUIRED_STAGES[family]) {
    if (active.indexOf(req) === -1) {
      throw new Error('args.stages.' + family + ' is missing required stage "' + req + '"'
        + ' (required: ' + REQUIRED_STAGES[family].join(', ') + ')');
    }
  }
  for (const pair of STAGE_ORDER_CONSTRAINTS) {
    const a = active.indexOf(pair[0]);
    const b = active.indexOf(pair[1]);
    if (a !== -1 && b !== -1 && a > b) {
      throw new Error('args.stages.' + family + ' order violation: "' + pair[0]
        + '" must come before "' + pair[1] + '" (data dependency); got [' + active.join(' → ') + ']');
    }
  }
  return active;
}

const PLAN_STAGES = parseStages('plan', A.stages && A.stages.plan);
const SLICE_STAGES = parseStages('slice', A.stages && A.stages.slice);
const hasStage = (family, stage) =>
  (family === 'plan' ? PLAN_STAGES : SLICE_STAGES).indexOf(stage) !== -1;

// 角色路由日志放在 mode 校验之后：非法 mode 直接抛错，不留噪音日志。
// 未知角色名只告警不中断（roles 表可能先于本脚本扩展）。
Object.keys(A_ROLES).forEach(function (name) {
  if (ROLE_NAMES.indexOf(name) === -1) {
    log('warn: args.roles.' + name + ' is not a known role (known: '
      + ROLE_NAMES.join(', ') + '); ignored by this workflow');
  }
});
log('roles: planning(' + PLANNING_ROLE + ')=' + DESIGN.provider + '/' + DESIGN.model
  + ' review(' + REVIEW_ROLE + ')=' + REVIEW.provider + '/' + REVIEW.model
  + ' delivery(' + DELIVERY_ROLE + ')=' + TASK.provider + '/' + TASK.model);
if (REVIEW.provider === TASK.provider && REVIEW.model === TASK.model) {
  log('warn: reviewer and task resolve to the same model; independent review is recommended '
    + '(在 Slice Pipeline 插件设置里给 review 与 patchDelivery 模块选择不同角色或模型)');
}
log('stages: plan=[' + PLAN_STAGES.join(' → ') + '] slice=[' + SLICE_STAGES.join(' → ') + ']'
  + (A.stages ? ' (custom)' : ' (default)'));

const repoRoot = A.repoRoot || '.';
const workspace = A.workspace;
const taskName = A.taskName || 'slice-pipeline';
const outDir = A.outDir || (repoRoot + '/AIOut/' + taskName);
// 交付目录的 git pathspec 排除项：outDir 在 repoRoot 下时转成相对路径，否则原样使用。
const outDirRel = outDir.startsWith(repoRoot + '/') ? outDir.slice(repoRoot.length + 1) : outDir;
const diffExclude = ':(exclude)' + outDirRel;
// 跨调用上下文：design / brief / render-* 返回；后续调用的宿主逐字段比对不一致即报错。
const runContext = { repoRoot: repoRoot, workspace: workspace || null, outDir: outDir, taskName: taskName };
const maxSlices = A.maxSlices || 6;
const maxPlanRounds = A.maxPlanRounds || 3;
const maxFixRounds = (A.maxFixRounds === undefined) ? 3 : A.maxFixRounds;
if (!Number.isSafeInteger(maxFixRounds) || maxFixRounds < 0) {
  throw new Error('args.maxFixRounds must be a non-negative safe integer (0 = no fix loop)');
}

// --- 模块依赖检查（在任何 agent() 调用之前 fail fast） -----------------------
// 逐阶段模式只跑被调用的那一 stage；render-* 不派发任何 agent，故不做模块门禁。
const STAGE_MODE_STAGES = {
  design: ['design'],
  brief: ['brief'],
  review: ['codeReview'],
  'render-implement': [],
  'render-fix': []
};
const checkedStages = mode === 'plan-only'
  ? PLAN_STAGES
  : (mode === 'slice' ? SLICE_STAGES : STAGE_MODE_STAGES[mode]);
const moduleNeeds = Object.fromEntries(MODULE_KEYS.map((key) => [key, []]));
moduleNeeds.pipeline.push('(workflow)');
for (const stage of checkedStages) {
  const required = [];
  if (stage === 'design') required.push('planning');
  if (stage === 'planReview' || stage === 'briefReview' || stage === 'codeReview') required.push('review');
  if (stage === 'implement') required.push('patchDelivery', 'workspaceRecovery');
  if (stage === 'fix' && maxFixRounds > 0) required.push('patchDelivery', 'workspaceRecovery', 'review');
  for (const key of required) {
    if (moduleNeeds[key].indexOf(stage) === -1) moduleNeeds[key].push(stage);
  }
}
if (!HAS_MODULES) {
  log('warn: args.modules missing (legacy call); module dependency checks skipped');
} else {
  const problems = [];
  for (const key of MODULE_KEYS) {
    const neededBy = moduleNeeds[key];
    if (neededBy.length === 0) continue;
    const module = A.modules[key];
    if (module === undefined) {
      problems.push({ key, neededBy, reason: 'not provided in args.modules' });
      continue;
    }
    if (module.enabled !== true) {
      problems.push({ key, neededBy, reason: 'disabled' });
      continue;
    }
    if (module.status === 'missingDoc') {
      if (key === 'review' && typeof A.reviewStandard === 'string' && A.reviewStandard.trim().length > 0) {
        continue;
      }
      const missing = Array.isArray(module.missing) ? module.missing.join(', ') : '';
      problems.push({ key, neededBy, reason: 'missingDoc' + (missing ? ' ' + missing : '') });
    }
  }
  if (problems.length > 0) {
    const lines = ['slice-pipeline: required plugin modules are unavailable for this run:'];
    for (const problem of problems) {
      lines.push('- ' + problem.key + ' (needed by ' + problem.neededBy.join(', ') + '): ' + problem.reason);
    }
    lines.push('Fix: enable the module or correct its path in 设置 → 插件 → Slice Pipeline '
      + '(dsh-tui: /settings → Slice Pipeline), or — only with the user\'s explicit consent — remove those stages from args.stages.');
    throw new Error(lines.join('\n'));
  }
}

// --- 规范路径（由插件设置注入；缺路径时返回 null） ---------------------------
function docPath(key, docKey) {
  if (!HAS_MODULES) return null;
  const module = A.modules[key];
  const path = module && isPlainObject(module.docs) ? module.docs[docKey] : undefined;
  return (typeof path === 'string' && path.trim().length > 0) ? path : null;
}

const reviewStandardInline = typeof A.reviewStandard === 'string' && A.reviewStandard.trim().length > 0;
if (reviewStandardInline) log('info: args.reviewStandard inline override in use');
const DOCS = {
  planning: docPath('planning', 'standard'),
  diagrams: (HAS_MODULES && A.modules.diagrams && A.modules.diagrams.enabled === true)
    ? docPath('diagrams', 'standard') : null,
  delivery: docPath('patchDelivery', 'standard'),
  template: docPath('patchDelivery', 'template'),
  recovery: docPath('workspaceRecovery', 'standard'),
  review: (typeof A.reviewStandardPath === 'string' && A.reviewStandardPath.trim().length > 0)
    ? A.reviewStandardPath : docPath('review', 'standard')
};
const EXPECTED_STANDARD = reviewStandardInline ? null : DOCS.review;
const reviewReports = [];

// 产出文档语言规范（宿主注入绝对路径）：各阶段写给人看的文本一律按它写。
const PLAIN_LANGUAGE = (typeof A.plainLanguagePath === 'string' && A.plainLanguagePath.trim() !== '')
  ? A.plainLanguagePath : null;

function plainLanguageSection() {
  if (PLAIN_LANGUAGE === null) return [];
  return [
    '## 输出语言（先 read 规范再写）',
    '- 本 prompt 要求的所有文字产出按 ' + PLAIN_LANGUAGE + ' 写：读者是没参加本次对话的同事，先结论后依据；',
    '  术语首次出现用一句中文解释；不用内部流程黑话（盲审/对齐/门禁/兜底/锚定/拓扑序/delta/两段式 等）。',
    '- findings 按「现象 → 影响 → 建议」写；决策与问题写清「做什么 / 为什么 / 影响谁 / 不做什么」。',
    ''
  ];
}

function standardsSection(entries) {
  const available = entries.filter((entry) => typeof entry[1] === 'string' && entry[1].trim().length > 0);
  if (available.length === 0) return '';
  return [
    '## 必读规范（先 read，再动手）',
    ...available.map((entry) => '- ' + entry[0] + '：' + entry[1]),
    '只按上述绝对路径读取；读不到时在结果中如实说明并按下文要求继续，禁止 find / 或扫描盘符。'
  ].join('\n');
}

function withStandards(entries, lines) {
  const section = standardsSection(entries);
  return section ? [section, ''].concat(lines) : lines;
}

function normPath(p) {
  let s = String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:\//i.test(s)) s = s.toLowerCase();
  return s;
}

function recordReview(label, review) {
  reviewReports.push({
    label,
    standardPath: (review && typeof review.standardPath === 'string') ? review.standardPath : null
  });
}

function reviewConfirmation() {
  if (EXPECTED_STANDARD === null || reviewReports.length === 0) return null;
  const expected = normPath(EXPECTED_STANDARD);
  const mismatches = reviewReports.filter((report) => normPath(report.standardPath) !== expected);
  if (mismatches.length === 0) return true;
  log('warn: reviewer standardPath mismatch: '
    + mismatches.map((report) => report.label + '=' + report.standardPath).join(', '));
  return false;
}

// 设计审查的上位基准（默认 <outDir>/plan.md → plan.json）。
// 本模板无文件系统 API，只能把候选路径交给子 agent 自己按顺序 read 第一个存在的。
const designDocCandidates = A.designDocPath
  ? [A.designDocPath]
  : [outDir + '/plan.md', outDir + '/plan.json'];
const designDocPath = designDocCandidates.join('  →  ');
const baselineSource = A.designDocPath
  ? 'args.designDocPath'
  : '默认候选（按顺序取第一个存在的）: ' + designDocCandidates.join(' / ');

// 实际可写的工作根：给了副本就用副本，否则用原仓库
const WORK_ROOT = workspace || repoRoot;
const WRITE_SCOPE = workspace
  ? '只允许在副本 "' + workspace + '" 内修改文件；严禁修改原工作区 "' + repoRoot + '" 的任何文件。'
  : '允许在 "' + repoRoot + '" 内修改文件；但交付物只有 patch 与文档，产出 patch 后必须把工作区回退到基线。';

// 数 🔴 条数的小工具（codeReview / briefReview 共用）
function countReds(review) {
  return (review && Array.isArray(review.findings))
    ? review.findings.filter((f) => f && f.severity === 'red').length
    : null;
}

// --- 结构化输出 schema（只允许 type/properties/required/additionalProperties/items/enum/const/oneOf）---
// 设计阶段的调研结果：brief 的 details 直接从这里提炼，避免主会话/实现者重新调研。
// 限长是硬要求：design 结果经工具返回，超过 MAX_RESULT_CHARS 会被截断；
// schema 方言不支持 maxItems，超量由 normalizeResearch() 在拿到结果后裁剪并告警。
const RESEARCH_LIMITS = { symbols: 10, files: 5, forbidden: 5, verify: 3 };

function normalizeResearch(planValue) {  if (!planValue || !Array.isArray(planValue.slices)) return planValue;
  planValue.slices.forEach((slice) => {
    const research = slice && slice.research;
    if (!research || typeof research !== 'object' || Array.isArray(research)) return;
    Object.keys(RESEARCH_LIMITS).forEach((key) => {
      if (Array.isArray(research[key]) && research[key].length > RESEARCH_LIMITS[key]) {
        log('warn: slice ' + (slice.id || '?') + ' research.' + key + ' 超量（'
          + research[key].length + ' → ' + RESEARCH_LIMITS[key] + '），已裁剪');
        research[key] = research[key].slice(0, RESEARCH_LIMITS[key]);
      }
    });
  });
  return planValue;
}

const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['symbols', 'files', 'verify'],
  properties: {
    symbols: {
      type: 'array',
      description: '受影响符号（最多 10 个）；file:line 必须来自实际代码检索（codegraph），不得编造',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'file', 'line'],
        properties: {
          name: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' }
        }
      }
    },
    files: { type: 'array', description: '本片预计改动的文件（最多 5 个）', items: { type: 'string' } },
    forbidden: { type: 'array', description: '禁改区（最多 5 条）', items: { type: 'string' } },
    verify: { type: 'array', description: '本片验证命令（最多 3 条，可直接复制执行）', items: { type: 'string' } }
  }
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'interfaceContract', 'slices'],
  properties: {
    summary: { type: 'string', description: '主计划摘要：目标、范围、不做什么' },
    interfaceContract: { type: 'string', description: '接口契约：签名/语义/生命周期/错误路径/版本与缓存失效' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'scope', 'acceptance', 'research'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          scope: { type: 'string', description: '本片做什么/不做什么、禁改区' },
          interfaceContract: { type: 'string', description: '本片涉及的契约增量' },
          acceptance: { type: 'string', description: '可运行命令或可断言结果，禁止“应表现良好”' },
          verification: { type: 'string', description: '验证命令与基线 commit' },
          research: RESEARCH_SCHEMA
        }
      }
    }
  }
};

// 仅 design 模式使用的 schema 变体：批处理共用的 PLAN_SCHEMA 保持原样。
const DESIGN_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: PLAN_SCHEMA.required.concat(['decisions', 'openQuestions']),
  properties: Object.assign({}, PLAN_SCHEMA.properties, {
    decisions: {
      type: 'array',
      description: '已确认的决策（来自 discussionDigest 或需求本身）：不再重新论证',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'decision', 'reason'],
        properties: {
          topic: { type: 'string' },
          decision: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    },
    openQuestions: {
      type: 'array',
      description: '仍需用户拍板的问题；为空表示无需追问。不要用默认假设填空',
      items: { type: 'string' }
    }
  })
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'standardPath'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    standardPath: { type: 'string', description: '实际读取的审查规范绝对路径；内联/兜底时填 inline/none' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'issue', 'fix', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['red', 'yellow', 'green'] },
          file: { type: 'string', description: '实际文件路径；计划/设计审查写计划文档或 plan.json 小节' },
          line: { type: 'string', description: '实际行号或小节号；无法定位时写 N/A 并说明' },
          area: { type: 'string', description: '可选：模块/领域标签' },
          category: {
            type: 'string',
            enum: ['defect', 'over-fix', 'over-design', 'performance', 'slice-leak'],
            description: '可选，默认 defect；为单个边界引入通用机制/防御/契约变更/顺手重构报 over-fix（硬门禁项）；代码/注释含切片 id/标题/序号报 slice-leak'
          },
          issue: { type: 'string' },
          fix: { type: 'string' },
          evidence: { type: 'string', description: '引用实际代码片段或文档原文，作为判断依据' }
        }
      }
    },
    unverifiable: { type: 'string', description: '无法验证/未覆盖的项，如实写明' }
  }
};

// 逐阶段 review 专用 schema：round=1 两段式（阶段一盲审 → 阶段二读 brief 对齐）必须留痕；
// round>=2 用 FOCUSED_REVIEW_SCHEMA（对账式复审，不再假装盲审）。
// 批处理仍用 FINDINGS_SCHEMA（纯盲审），这里只加字段，不动原 schema 的内容。
const REVIEW_FINDING_ITEM = FINDINGS_SCHEMA.properties.findings.items;
const ALIGNED_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'standardPath', 'blindFindings'],
  properties: Object.assign({}, FINDINGS_SCHEMA.properties, {
    findings: {
      type: 'array',
      description: '两段合并去重后的最终结论；每条用 source 标明来自盲审还是对齐',
      items: Object.assign({}, REVIEW_FINDING_ITEM, {
        properties: Object.assign({}, REVIEW_FINDING_ITEM.properties, {
          source: {
            type: 'string',
            enum: ['blind', 'alignment'],
            description: 'blind = 阶段一（未读 brief）得出；alignment = 读 brief 后新增'
          }
        })
      })
    },
    blindFindings: {
      type: 'array',
      description: '阶段一的原始结论（读 brief 之前）；对齐阶段撤回了也要保留，供主会话核对两段确实执行过',
      items: REVIEW_FINDING_ITEM
    },
    withdrawn: {
      type: 'array',
      description: '对齐阶段撤回的盲审结论；每项写清为什么站不住',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'reason'],
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          issue: { type: 'string' },
          reason: { type: 'string', description: '撤回依据：与哪段实际代码/契约不符' }
        }
      }
    }
  })
};

// 对账式复审 schema（round>=2）：不再要求 blindFindings；必须逐条交代上一轮 findings 的状态。
const FOCUSED_PREVIOUS_FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'status', 'evidence'],
  properties: {
    issue: { type: 'string', description: '上一轮 finding 的原始描述（原样引用，便于对账）' },
    file: { type: 'string' },
    line: { type: 'string' },
    status: { type: 'string', enum: ['resolved', 'unresolved', 'changed'], description: 'resolved=真修好；unresolved=没修/没修对；changed=问题变了形态，需要在 findings 里重述' },
    evidence: { type: 'string', description: '代码位置或命令输出，不能只写结论' }
  }
};

const FOCUSED_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'standardPath', 'previousFindings'],
  properties: Object.assign({}, FINDINGS_SCHEMA.properties, {
    findings: {
      type: 'array',
      description: '本轮新发现（delta 或调用链影响面），不要重复上一轮已解决的条目',
      items: REVIEW_FINDING_ITEM
    },
    previousFindings: {
      type: 'array',
      description: '逐条核对上一轮 findings；每条必须给状态与证据',
      items: FOCUSED_PREVIOUS_FINDING_ITEM
    }
  })
};

// 设计审查专用 schema：与 plan 审查 / 代码审查隔离，缩小影响面。// `designRef` 是过滤网——指不回设计文档/契约的条目（典型行级 nit）不许输出。
const DESIGN_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['alignment', 'findings', 'standardPath'],
  properties: {
    alignment: {
      type: 'string',
      enum: ['aligned', 'deviates', 'over-engineered'],
      description: '本片方案与设计文档/主计划的整体关系'
    },
    standardPath: { type: 'string', description: '实际读取的审查规范绝对路径；内联/兜底时填 inline/none' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'layer', 'designRef', 'issue', 'fix', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['red', 'yellow', 'green'] },
          layer: {
            type: 'string',
            enum: ['architecture', 'contract'],
            description: '只允许 architecture/contract；实现细节与风格归 ④ 代码审查，本轮不报'
          },
          designRef: {
            type: 'string',
            description: '指回设计文档小节或主计划的具体契约条目；填不出来的条目一律不要输出'
          },
          issue: { type: 'string' },
          fix: { type: 'string' },
          evidence: { type: 'string', description: '引用设计文档/主计划原文或 codegraph 核验结果' }
        }
      }
    },
    unverifiable: { type: 'string', description: '无法验证/未覆盖的项，如实写明' }
  }
};

// brief 分两层：`architecture` 是设计审查的唯一输入（禁止 file:line 细节）；
// `details` 只喂实现者，不进设计审查上下文。
// 依据：细节不是"审出来"的，是被输入带进来的——审查粒度由输入决定。
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sliceId', 'architecture', 'details'],
  properties: {
    sliceId: { type: 'string' },
    architecture: {
      type: 'string',
      description: '方案层（≤1 页）：改动落在哪些模块、依赖方向、接口/契约增量、与主计划及设计文档的对应关系、被拒绝的替代方案。禁止出现 file:line、符号清单、命名与局部实现写法。'
    },
    details: {
      type: 'string',
      description: '落地层（供实现者）：受影响符号的实际 file:line、基线 commit、禁改区、验证命令、验收标准。不进设计审查上下文。'
    },
    openQuestions: {
      type: 'array',
      description: '讨论结论或本片定义与代码现实冲突、需要用户拍板的问题；为空表示无冲突',
      items: { type: 'string' }
    }
  }
};

// 实现阶段只回路径与结论，不回 patch 正文（避免结果被 maxResultChars 截断）
const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sliceId', 'patchPath', 'docPath', 'verifyResult'],
  properties: {
    sliceId: { type: 'string' },
    patchPath: { type: 'string' },
    patchLineCount: { type: 'integer' },
    docPath: { type: 'string' },
    filesChanged: { type: 'string' },
    verifyCommand: { type: 'string' },
    verifyResult: { type: 'string', description: '命令 + exit code + 关键输出；未验证项如实标注' },
    reverted: { type: 'string', description: '回退方式与结果；副本模式写 not-needed' },
    changedSymbols: {
      type: 'array',
      description: '本轮改动或新增的符号名（修复轮必须给，供复审界定调用链影响面）',
      items: { type: 'string' }
    },
    contractChanged: {
      type: 'boolean',
      description: '是否改了公共签名/共享布局/默认行为（true 会强制复审升级为全量）'
    },
    scopeNote: {
      type: 'string',
      description: '本轮动了 finding/brief 之外的文件时，说明为什么必须动（没有越界可留空）'
    },
    fixDeltaPath: {
      type: 'string',
      description: '本轮修复增量 patch 路径（相对上一轮 patch 的 delta）；未产出时留空，复审会自动升级全量'
    }
  }
};

// --- 审查纪律：对抗性 + 外部清单 + 不接受“看起来没问题” ---
const REVIEW_DISCIPLINE = [
  '你是资深引擎/系统架构审查者。忽略命名与风格，只审风险。',
  '严格按「必读审查规范」逐条核验；结论必须引用实际内容（文件/小节/行），不得只凭文档表述判断。',
  '审查对当前 checkout 是只读的：不得改动工作树 / index / HEAD；不派子代理；不重跑测试套件。',
  '检索必须由具名风险驱动：一次定向核查，并在结论里写明查了什么、得到什么；禁止无目标的全库扫描或 find /。'
].join('\n');

// --- 审查规范来源：内联覆盖 > 插件路径 > 兜底 ------------------------------
const FALLBACK_REVIEW_GUIDE = [
  '## 必读审查规范（fallback：未提供插件规范路径）',
  '1. 遵守项目 AGENTS.md / CLAUDE.md 的审查要求。',
  '2. 代码/符号核验必须使用 codegraph CLI（query/explore/node/callers/callees/impact），grep 只用于字面量文本。',
  '3. findings 必须给出严重程度、文件、行号、问题描述、修复建议、evidence。',
  '4. 没有真问题就 verdict=pass 且 findings 为空，禁止凑数。',
  '5. standardPath 填 none。'
].join('\n');

const REVIEW_AGENTS_GUIDE = reviewStandardInline
  ? [
      '## 必读审查规范（由 Slice Pipeline 插件设置提供，最高优先级）',
      '',
      A.reviewStandard,
      '',
      '如果工作区上下文中另有更新的 `~/.dsh/AGENTS.md` 或项目 `AGENTS.md` / `CLAUDE.md`，以更具体的项目规则优先；本规范是最低审查要求。',
      '',
      'standardPath 填 inline。'
    ].join('\n')
  : (DOCS.review
    ? [
        '## 必读审查规范（运行时规范，reviewer 只读这一份）',
        '先 read：' + DOCS.review,
        '逐条按该规范审查：十维清单、结论分级、codegraph 检索、证据与输出纪律都在里面。',
        '读不到时在 unverifiable 中说明，并按下方审查纪律继续，禁止 find / 或扫描盘符。',
        '输出字段 standardPath 填你实际读取的规范文件绝对路径；未能读取时填 none。',
        '项目自身的 AGENTS.md / CLAUDE.md 规则更具体时优先。'
      ].join('\n')
    : FALLBACK_REVIEW_GUIDE);

const planPrompt = (req, digest) => {
  const lines = [
    '你是架构设计者。基于下面的需求，产出主计划与切片方案。',
    '',
    '## 需求',
    req,
    '',
    '## 仓库根目录',
    repoRoot,
    '',
    '## 要求',
    '- 先做代码调研（读实际代码定位受影响符号），再给设计；不要凭猜测写契约。',
    '- interfaceContract 必须完整：签名、语义、生命周期、错误路径、版本/缓存失效。',
    '- 切片边界要求：每片可独立编译/验证/回滚；片间依赖单向；无跨片循环依赖。',
    '- acceptance 必须是可运行命令或可断言结果。',
    '- **每片必须输出 research**：受影响符号 file:line（必须来自实际代码检索，最多 10 个）、',
    '  会改动的文件（≤5）、禁改区（≤5）、验证命令（≤3）。brief 直接由主会话从 research 提炼，',
    '  不再单独调研；research 缺失或编造行号视为设计未完成。',
    '- 输出预算：plan.summary ≤800 字；interfaceContract ≤2000 字；每片 scope / acceptance 各 ≤600 字。',
    '- 不复述需求与讨论结论，只写新增信息；不写实现步骤、不写代码。',
    `- 切片数不超过 ${maxSlices}。`
  ];
  if (typeof digest === 'string' && digest.trim().length > 0) {
    lines.push(
      '',
      '## 已确认的讨论结论（用户已确认，不再重新论证）',
      digest,
      '',
      '- 以上方向视为已确认约束：不要重新论证其取舍，也不要在方案里推翻它。',
      '- decisions[] 记录已确认的决策；openQuestions[] 只放仍需用户拍板的问题（没有就留空）。'
    );
  }
  return withStandards([
    ['规划与切片规范', DOCS.planning],
    ['产出语言规范', PLAIN_LANGUAGE]
  ], lines).join('\n');
};

// 归档（2026-11-03）：planReview 不启用，保留代码供重新启用；见 ARCHIVED_STAGES。
const planReviewPrompt = (plan, req) => [
  REVIEW_AGENTS_GUIDE,
  '',
  REVIEW_DISCIPLINE,
  '',
  '## 待审对象：主计划与切片方案（JSON）',
  JSON.stringify(plan, null, 2),
  '',
  '## 原始需求（用于核对是否漏掉约束）',
  req,
  '',
  '## 重点核验面',
  '- 接口契约是否完整、是否与既有调用方兼容（去实际代码里核对）。',
  '- 切片边界能否独立验证/回滚；是否存在跨片循环依赖。',
  '- acceptance 是否真的可执行（模糊标准一律标 red/yellow）。',
  '- 是否遗漏了需求中的约束（漏掉的约束比推错的约束更致命）。'
].join('\n');

const planRevisePrompt = (plan, review) => withStandards([
  ['规划与切片规范', DOCS.planning],
  ['制图规范（需要配图时）', DOCS.diagrams],
  ['产出语言规范', PLAIN_LANGUAGE]
], [
  '你是架构设计者。审查者对你的计划提出了以下问题，请逐条核验后修订。',
  '',
  '## 你的原计划（JSON）',
  JSON.stringify(plan, null, 2),
  '',
  '## 审查结论（JSON）',
  JSON.stringify(review, null, 2),
  '',
  '## 要求',
  '- 逐条处理：确认为真的修正；误报的说明核验依据（文件+行号）后不改。',
  '- 不得为了迎合审查而引入无消费者的抽象。',
  '- 输出修订后的完整计划（同一 schema）。'
]).join('\n');

// 本片讨论结论（plan.json 的 slices[i].discussion）在 prompt 里的呈现：
// 讨论过的不再重新论证；豁免也必须留原话，避免"没讨论"被写成"讨论过"。
const discussionSection = (discussion) => {
  const lines = ['## 本片讨论结论（用户已确认，不再重新论证）'];
  if (discussion.waiver) {
    lines.push('- 用户明确豁免本片讨论，原话：' + discussion.waiver.quote);
    lines.push('- 豁免不等于可以自由发挥：仍受主计划接口契约与下面本片定义约束。');
    return lines;
  }
  lines.push('- 目标理解（本片解决什么、不解决什么）：', discussion.understanding);
  lines.push('- 已确认决策：');
  discussion.decisions.forEach((item) => {
    lines.push('  - ' + item.topic + ' → ' + item.decision
      + (item.reason ? '（理由：' + item.reason + '）' : ''));
  });
  if (Array.isArray(discussion.rejected) && discussion.rejected.length > 0) {
    lines.push('- 已否决的方案（不要再提）：');
    discussion.rejected.forEach((item) => {
      lines.push('  - ' + item.option + (item.reason ? '（否决理由：' + item.reason + '）' : ''));
    });
  }
  return lines;
};

// 讨论记录是门禁输入、不是阶段上下文：从「本片定义」JSON 里剔掉，避免每个 prompt 都夹带一遍。
const sliceForPrompt = (slice) => {
  const copy = {};
  Object.keys(slice || {}).forEach((key) => { if (key !== 'discussion') copy[key] = slice[key]; });
  return JSON.stringify(copy, null, 2);
};

// 审查 prompt 的本片定义：brief/research 是实现方与设计方自述，round=1 盲审阶段不能看到；
// 对齐阶段另有 briefPath / briefArch 入口。包内 sliceForReview 已按同一口径剔除。
const sliceForReviewPrompt = (slice) => {
  const copy = {};
  const hidden = ['discussion', 'brief', 'research'];
  Object.keys(slice || {}).forEach((key) => { if (!hidden.includes(key)) copy[key] = slice[key]; });
  return JSON.stringify(copy, null, 2);
};

const briefPrompt = (plan, slice, designDocPath, discussion) => withStandards([
  ['规划与切片规范', DOCS.planning],
  ['制图规范（需要配图时）', DOCS.diagrams],
  ['产出语言规范', PLAIN_LANGUAGE]
], [
  '你是本 Slice 的设计者。基于主计划与本片定义，产出本片的 Slice brief（严格分两层输出）。',
  '',
  '## 主计划摘要',
  plan.summary,
  '',
  '## 主计划接口契约（已冻结）',
  plan.interfaceContract,
  '',
  '## 本片定义（JSON）',
  sliceForPrompt(slice),
  '',
  '## 设计文档（先 read 它）',
  designDocPath,
  'architecture 层要与该文档显式对齐：说明本片方案对应文档的哪些部分。',
  '',
  ...discussionSection(discussion),
  '',
  '## 输出两层（不要混写）',
  '- `architecture`（≤1 页）：本片改动落在哪些模块、依赖方向、接口/契约增量、',
  '  与主计划及设计文档的对应关系、被拒绝的替代方案。',
  '  **禁止出现 file:line、符号清单、命名讨论、局部实现写法**——这一层是设计审查的唯一输入。',
  '- `details`（供实现者）：受影响符号的实际 file:line、基线 commit、禁改区、验证命令、验收标准。',
  '  这一层不进设计审查上下文，只给实现者。',
  '',
  '## 要求',
  '- 先做代码调研再写 details；architecture 层只讲方案，不讲怎么敲代码。',
  '- 不要写实现代码，只写实现者需要的约束。',
  '- 讨论结论里的决策不再论证；发现结论与代码现实冲突时，写进 openQuestions 交回用户，',
  '  不要自行改方向，也不要静默按旧结论实现。'
]).join('\n');

// 设计审查：只审「方案合理性」（对设计文档/主计划），不审实现细节。
// 输入纪律：只喂 architecture 层 + 上位基准；details（file:line）不进上下文。
const briefReviewPrompt = (briefArch, slice, plan, designDocPath, baselineSource) => [
  REVIEW_AGENTS_GUIDE,
  '',
  REVIEW_DISCIPLINE,
  '',
  '## 你的审查层级（硬约束，优先于上面的一般纪律）',
  '本轮**只审方案合理性**：本片方案相对设计文档与主计划是否合理、有无偏离、有无过度设计。',
  '本轮**不审**代码实现细节、命名、格式、局部写法——那些归 ④ 代码审查，不要在这里重复。',
  '你只拿到 brief 的 architecture 层，拿不到 file:line 细节，这是刻意设计：',
  '不要凭猜测补全未提供的实现细节，也不要要求补充细节。',
  '上面十维判据在本轮**只取与方案相关的维度**：架构与依赖方向、过度设计、模块职责边界、',
  '接口契约完整性、可验证性。性能/Bug/生命周期/线程安全/数据一致性属实现层，',
  '本轮仅在方案层面明显不合理时才提，且必须写清是哪条设计约束被破坏。',
  '',
  '## 上位基准（先 read，再判断）',
  '- 设计文档: ' + designDocPath,
  '- 基准来源: ' + baselineSource,
  '先把「应该长什么样」从设计文档里建立起来，再判断本片方案有没有不合理的地方。',
  '设计文档不存在时，以主计划为基准，并在 unverifiable 里写明基准降级。',
  '',
  '## 主计划摘要',
  plan.summary,
  '',
  '## 主计划接口契约（已冻结，不得重复提问）',
  plan.interfaceContract,
  '',
  '## 其他 Slice 的契约增量（用于判断越界与冲突）',
  JSON.stringify((plan.slices || []).map((s) => ({
    id: s.id,
    title: s.title,
    interfaceContract: s.interfaceContract || '(未定义)'
  })), null, 2),
  '',
  '## 待审对象：本片 brief 的 architecture 层（JSON）',
  JSON.stringify(briefArch, null, 2),
  '',
  '## 必答问卷（逐条回答后，再给 findings）',
  '1. 本片方案与设计文档的模块划分、依赖方向是否一致？不一致点具体在哪？',
  '2. 是否引入了设计文档/主计划里没有的抽象、组件或间接层？若有，消费者是谁（无消费者即过度设计）？',
  '3. 是否越界到其他 Slice 的范围，或漏掉设计文档中本片的目标？',
  '4. 本片的接口契约增量与主计划是否冲突或自相矛盾？',
  '5. 有没有更简单、且同样满足设计文档的做法？',
  '6. 只看方案层，本片能否独立编译/验证/回滚？',
  '',
  '## 输出纪律',
  '- 先给 `alignment`：aligned / deviates / over-engineered。',
  '- findings 的 `layer` 只能是 architecture 或 contract；填 implementation/style 视为无效输出。',
  '- 每条 finding 必须填 `designRef`，指回设计文档的小节或主计划的具体契约条目；',
  '  **指不回去的条目一律不要输出**——行级 nit 通常指不回去，这正是本轮的过滤网。',
  '- 没有真问题就 alignment=aligned 且 findings 为空，禁止凑数。'
].join('\n');

const implementPrompt = (slice, brief, briefReview) => withStandards([
  ['补丁交付规范', DOCS.delivery],
  ['薄文档模板', DOCS.template],
  ['工作区恢复规范', DOCS.recovery],
  ['产出语言规范', PLAIN_LANGUAGE]
], [
  '你是实现者。按下面的 brief 实现本 Slice。最终交付【只有 patch 与文档】，不留工作区改动。',
  '',
  '## 本片定义（JSON）',
  sliceForPrompt(slice),
  '',
  '## brief 架构层（方案约束，不得偏离）',
  (brief && brief.architecture) ? brief.architecture : '(缺失——architecture 层缺失属异常，按本片定义实现并在 verifyResult 里标注)',
  '',
  '## brief 落地层（file:line / 验证命令 / 验收标准）',
  (brief && brief.details) ? brief.details : '(缺失)',
  '',
  '## 设计审查结论（JSON）',
  JSON.stringify(briefReview, null, 2),
  '',
  '## 写入范围（硬约束，违反即失败）',
  WRITE_SCOPE,
  '',
  '## 切片信息隔离（硬约束，违反即失败）',
  '- 不得在代码、注释、标识符、测试名、日志字符串、新增文件/目录名或 patch 新增行中写入切片 id、切片标题或序号',
  '  （如 S1、SliceP08b、本片标题）；需要解释时用行为/模块/契约描述。交付物文件名除外。',
  '',
  '## 交付物路径',
  '- patch: ' + outDir + '/' + slice.id + '.patch',
  '- 薄文档: ' + outDir + '/' + slice.id + '.md',
  '',
  '## 步骤',
  '1. 记录基线：在工作区 `' + WORK_ROOT + '` 内跑 `git status --porcelain`，并把 `git diff` 存到 '
    + outDir + '/' + slice.id + '-baseline.patch（staged 改动另存一份，未跟踪文件列表另存一份）。',
  '   若基线**不干净**（status 非空）：先 `git stash push -u -m dsh-verify-baseline` 把既有改动（含未跟踪）'
    + '暂存、工作区回到 HEAD，再开始实现——这样后续回退才能安全用 `git checkout -- .`。',
  '2. 实现：严格按 brief 的范围与接口契约；遵守项目既有架构与风格（项目有 CLAUDE.md/AGENTS.md 时对照）；不越界改动。',
  '   **代码放置与 include 顺序按补丁交付规范「2. 最终 patch 的代码放置与 include 顺序」逐条执行**：',
  '   类内嵌类型先声明（同类无依赖时字典序）、新增函数/变量进原有分块、.cpp 实现顺序同声明顺序、',
  '   include 本类头文件在最上且按项目内/第三方/系统三块、块内字典序；自检结论写进 verifyResult。',
  '   **最小实现**：只实现 brief 描述的行为；不为假设的未来需求加通用机制/配置项/抽象层；',
  '   单个边界条件不顺手推广到同类输入；确需扩大范围（改契约/调用方/加机制）先停下，在 verifyResult 写清并回给 Lead。',
  '   **最小防御**：防御只加在可达的失败路径上；热路径（每帧/逐对象）不要加冗余校验、防御性拷贝或锁；',
  '   涉及热路径改动时在 verifyResult 写性能测量方式与结果（未测量写「未测量 + 原因」）。',
  '3. 编译验证：跑项目真实构建命令（或覆盖改动文件的最小目标），以退出码 0 判定，记录命令与关键输出。',
  '   无法编译/无法运行时，必须在 verifyResult 里如实标注，不得声称“可编译”。',
  '4. 生成 patch：先 `git add -N <本次新增的文件>` 让新增文件进入 diff，再'
    + ' `git diff -- . "' + diffExclude + '"`（交付目录不计入 diff）写入 patch 路径；**按依赖拓扑序重排文件段**（头文件先于其对应 .cpp；先声明→再实现→最后使用方；wiring/测试靠后），只换段序、不改段内 hunk，并用「逐段 SHA256 多重集一致 + `git apply --check` / `--reverse`」自证（见补丁交付规范「1. Diff 的唯一事实源与落盘顺序」）；最后跑 `git diff --check`。',
  '5. 写薄文档：目标与范围、接口与行为变更、验证记录（命令+exit code）、回滚方案、残余风险。',
  '6. ' + (workspace
    ? '副本无需回退（Scratch 副本验证后弃用即可），但绝不触碰原工作区。'
    : '回退工作区：`git checkout -- .` 并删除本次新增的未跟踪文件；第 1 步若创建过 stash，'
      + '再 `git stash pop` 恢复既有改动；stash 不可用时用第 1 步的 baseline patch 逐份 `git apply` 恢复。'
      + '交付目录 ' + outDir + ' 属预期存在，不计入回退范围。'),
  '7. 用 `git status --porcelain` 与第 1 步基线比对，确认一致。',
  '',
  '## 返回（只给路径与结论，不要贴 patch 正文）',
  '- sliceId / patchPath / patchLineCount / docPath / filesChanged / verifyCommand / verifyResult / reverted'
]).join('\n');

// fix（修订闭环）：修复回**生成方**（本阶段用 task 角色），不是审查方。
// 产出同一对交付物（patch + 薄文档）的修订版——覆盖同一 outDir 路径。
// userFeedback 仅在逐阶段 render-fix 传入；批处理 slice 的 fix 阶段不传，输出保持不变。
const fixPrompt = (slice, brief, impl, codeReview, round, userFeedback) => withStandards([
  ['补丁交付规范', DOCS.delivery],
  ['薄文档模板', DOCS.template],
  ['工作区恢复规范', DOCS.recovery],
  ['产出语言规范', PLAIN_LANGUAGE]
], [
  '你是实现者，正在修复你自己上一轮的实现（第 ' + round + ' 轮修订）。最终交付【只有修订后的 patch 与文档】，不留工作区改动。',
  '',
  '## 本片定义（JSON）',
  sliceForPrompt(slice),
  '',
  '## brief（方案约束，不得偏离）',
  '- 架构层: ' + ((brief && brief.architecture) ? brief.architecture : '(无)'),
  '- 落地层: ' + ((brief && brief.details) ? brief.details : '(无)'),
  '',
  ...(userFeedback === undefined ? [] : [
    '## 用户意见（优先，最高优先级）',
    userFeedback === '' ? '（本轮无用户意见；按下面的审查意见处理）' : userFeedback,
    '',
    '用户意见与审查意见冲突时：以用户意见为准，并在薄文档「审查处置摘要」里写明取舍理由。',
    ''
  ]),
  userFeedback === undefined
    ? '## 代码审查发现的问题（JSON，逐条处理）'
    : '## 审查意见（findings，JSON，逐条处理）',
  JSON.stringify(codeReview, null, 2),
  '',
  '## 上一轮的交付物',
  '- patch: ' + ((impl && impl.patchPath) ? impl.patchPath : '(缺失)'),
  '- 薄文档: ' + ((impl && impl.docPath) ? impl.docPath : '(缺失)'),
  '- 自述验证: ' + ((impl && impl.verifyResult) ? impl.verifyResult : '(无)'),
  '',
  '## 写入范围（硬约束，违反即失败）',
  WRITE_SCOPE,
  '',
  '## 切片信息隔离（硬约束，违反即失败）',
  '- 不得在代码、注释、标识符、测试名、日志字符串、新增文件/目录名或 patch 新增行中写入切片 id、切片标题或序号',
  '  （如 S1、SliceP08b、本片标题）；需要解释时用行为/模块/契约描述。交付物文件名除外。',
  '',
  '## 步骤',
  '1. 先把上一轮 patch **重新落盘**到工作区 `' + WORK_ROOT + '`（`git apply ' + ((impl && impl.patchPath) ? impl.patchPath : '<patch>') + '`），',
  '   在其上修复；无法落盘则在 verifyResult 里如实标注并停止。',
  '2. **给修复前状态拍快照**（用于产出本轮增量，证明只修了什么）：先对新增文件跑 `git add -N <文件>`，',
  '   再 `SNAP=$(git stash create)`；命令失败或返回空 → 本轮 `fixDeltaPath` 留空，后续复审会自动升级全量。',
  '3. 逐条处理审查发现：确认为真的修正；误报的说明核验依据（文件+行号）后不改。',
  '   **最小修复（硬约束）**：只改 finding 指向的行为；修好该边界即可，不顺手泛化到同类场景、不顺手重构；',
  '   不得为单个边界新增配置项/抽象层/兜底/公共 API 扩展；不要用不可达的防御代码或穷举测试掩盖根因；',
  '   **最小防御**：热路径上不得为不可达路径加防御、不得引入防御性拷贝/锁/额外提交；',
  '   修复引入新行为时必须补最小回归测试；确需扩大改动范围先停下并在 scopeNote 说明，交回 Lead 决定。',
  '   不得为了迎合审查引入无消费者的抽象，也不得越出 brief 范围；确需改到 finding/brief 之外的文件时，',
  '   在 `scopeNote` 写清为什么必须动，并在 `changedSymbols` 列出改动的符号（改了公共签名/共享布局/默认行为时 `contractChanged: true`）。',
  '   改动涉及的代码放置与 include 顺序按补丁交付规范「2. 最终 patch 的代码放置与 include 顺序」复核，上一轮的违规一并改正。',
  '4. 修完**必须重新编译验证**（同实现阶段的命令），记录 exit code。',
  '5. **生成本轮增量 patch**：`git diff $SNAP -- . "' + diffExclude + '"` 写入 `'
    + outDir + '/' + slice.id + '-fix-r' + round + '.patch`；自检该 patch 的文件集合覆盖本轮 `filesChanged`；',
  '   覆盖不了或无法生成（git 不可用、SNAP 为空）→ `fixDeltaPath` 留空并在 verifyResult 说明（复审会升级全量）。',
  '6. 重新生成完整 patch 与薄文档（**覆盖同一路径**）：' + outDir + '/' + slice.id + '.patch / .md；'
    + '**按依赖拓扑序重排文件段并自证**（逐段 SHA256 多重集一致 + `git apply --check`），只换段序、不改段内 hunk；',
  '   薄文档的验证记录更新为最新一轮的命令与结果。',
  '7. ' + (workspace
    ? '副本无需回退，但绝不触碰原工作区。'
    : '按与实现阶段相同的方式把工作区回退到基线（`git add -N` 的索引状态一并恢复）。'),
  '',
  '## 返回（同实现阶段的字段，另加本轮增量信息）',
  '- sliceId / patchPath / patchLineCount / docPath / filesChanged / verifyCommand / verifyResult / reverted',
  '- changedSymbols / contractChanged / scopeNote / fixDeltaPath（增量 patch 路径，未产出留空）'
]).join('\n');

// 两段式审查的 prompt 片段：只有逐阶段 review（带 briefPath）才出现；
// 批处理保持纯盲审，返回空数组以保证其 prompt 与之前字节一致。
const alignmentSection = (stage) => {
  if (!isPlainObject(stage)) return [];
  const hasPath = typeof stage.briefPath === 'string' && stage.briefPath !== '';
  const hasContent = typeof stage.briefArch === 'string' && stage.briefArch !== '';
  if (!hasPath && !hasContent) return [];
  return [
    '## 两段式审查（硬约束：顺序不可交换）',
    '**阶段一 · 盲审**：只用上面的 patch 路径与仓库里的实际代码，先独立得出结论，写进 `blindFindings`。',
    '本阶段**禁止 read** 下面这个 brief 文件，也不要假设「设计大概是想这么做」——一旦先看到方案，',
    '越界与过度设计就失去判据（有了现成解释，问题就消失了）。',
    '',
    hasPath
      ? '**阶段二 · 对齐**：再 read `' + stage.briefPath + '`（只取 architecture 层），逐条复核阶段一的结论：'
      : '**阶段二 · 对齐**：下面是设计方的 brief 架构层（内联给出，无独立文件），逐条复核阶段一的结论：',
    ...(hasPath ? [] : ['', '```', stage.briefArch, '```']),
    '- 仍然成立的 → 保留，标 `source="blind"`；',
    '- 站不住的 → 从 findings 移除，并写进 `withdrawn`（写清与哪段实际代码/契约不符）；',
    '- 新增「偏离既定方案 / 越界改动 / 过度设计 / 与验收标准不符」的项，标 `source="alignment"`。',
    'brief 是**设计方自述**，不是正确性依据：与代码/契约冲突时以代码为准，并如实记一条 finding。',
    '`findings` 必须是两段合并去重后的结果；`blindFindings` 原样保留，主会话据此核对两段确实执行过。',
    ''
  ];
};

// 审查包：宿主把 patch 全文、薄文档、统计与验收标准打进一个文件，reviewer 只读它一次。
// 批处理（无 stage）不生成包，返回空数组，保持原 prompt。
const packageSection = (stage) => {
  if (!isPlainObject(stage) || !isPlainObject(stage.reviewPackage)) return [];
  const pkg = stage.reviewPackage;
  if (pkg.skipped) {
    return [
      '## 审查包未生成（退回按路径读取）',
      '- 原因：' + (pkg.reason || '未知'),
      '- 本轮请按下面的 patch / 薄文档路径自行读取，并严格控制检索范围：只对具名风险做一次定向核实。',
      ''
    ];
  }
  const full = pkg.mode !== 'index-only';
  const focused = pkg.mode === 'focused';
  return [
    '## 审查包（唯一代码输入）',
    '- 先 read 这个文件一次：' + pkg.path,
    focused
      ? '- 包内是「上一轮 findings + 本轮修复增量（delta）+ 变更符号与文件」；全量 patch 只给路径，不要全文重读。'
      : '',
    '- 规模：' + pkg.files + ' 个文件 / ' + pkg.hunks + ' 个 hunk / +' + pkg.added + ' / -' + pkg.removed,
    full
      ? '- 包内已含 patch 全文与薄文档：不要再逐个 read 改动文件，也不要跑 git 命令。'
      : '- 包内只有清单与统计（patch 过大）：按清单分段 read 上面的 patch 路径，不要全库检索。',
    '- 核对 post-image 行号时用一次性临时副本树，不要按 patch 行号引用。',
    '- 本片 brief 不在包里：round=1 的盲审阶段不要读它；round>=2 的对账复审不要求读 brief。',
    ''
  ].filter((line) => line !== '');
};

// stage 仅在逐阶段 review 模式传入（轮次 / 用户意见 / 机械预检）；批处理不传，输出保持不变。
// 审查结论落盘路径。脚本运行环境没有文件系统 API，只能要求审查 agent 自己写；
// 命名与 review 模式做增量复审时读取上一轮结果的约定保持一致（<sliceId>-review-r<N>.json）。
function reviewFindingsPath(sliceId, stage) {
  const round = (isPlainObject(stage) && typeof stage.round === 'number' && stage.round > 0)
    ? Math.floor(stage.round)
    : 1;
  return outDir + '/reviews/' + sliceId + '-review-r' + round + '.json';
}

// render 任务书的传输文件：与宿主 canonical 结果分开，避免下一轮 previousReview 读到裸 review JSON。
function reviewPayloadPath(sliceId, stage) {
  const round = (isPlainObject(stage) && typeof stage.round === 'number' && stage.round > 0)
    ? Math.floor(stage.round)
    : 1;
  return outDir + '/reviews/' + sliceId + '-review-r' + round + '.payload.json';
}

// 强制审查结论落盘：长返回值会被宿主截断，findings 只在返回值里等于随时可能丢。
// renderOnly（Lead 侧 subagent）：写 payload 后只回路径，由宿主读文件并写 canonical；
// 其他路径（批处理 / 旧 in-script）仍要求“写文件 + 返回完整 JSON”，脚本没有文件系统可读。
function findingsPersistSection(slice, stage, renderOnly, external = false) {
  const sliceId = slice && slice.id ? slice.id : '(unknown-slice)';
  if (external) {
    return [
      '## 输出格式（硬要求）',
      '只输出一个 JSON 对象（不要 markdown 围栏、不要解释文字）；不写任何文件，宿主会保存结果。',
      ''
    ];
  }
  if (renderOnly) {
    return [
      '## 结果落盘（硬要求：先写文件，再返回路径）',
      '- 把本次审查结果按与返回值完全相同的 schema（verdict / findings / standardPath / unverifiable，字段一字不差）写成 UTF-8 JSON 文件：',
      '  ' + reviewPayloadPath(sliceId, stage),
      '- 目录不存在就先创建；文件内容必须是纯 JSON（不要 markdown 围栏、不要注释、不要把 findings 截断或省略）。',
      '- 写盘成功后，最终只返回 `{"reviewPath":"<上面的绝对路径>"}`；不要重复 findings。',
      '- 写盘失败才按 schema 返回完整 JSON，并在 unverifiable 里写明失败原因。',
      ''
    ];
  }
  return [
    '## 结果落盘（硬要求：先写文件，再返回）',
    '- 把本次审查结果按与返回值完全相同的 schema（verdict / findings / standardPath / unverifiable，字段一字不差）写成 UTF-8 JSON 文件：',
    '  ' + reviewFindingsPath(sliceId, stage),
    '- 目录不存在就先创建；文件内容必须是纯 JSON（不要 markdown 围栏、不要注释、不要把 findings 截断或省略）。',
    '- 写盘失败不要静默：在 unverifiable 里写明失败原因，并照常返回结果。',
    ''
  ];
}

const codeReviewPrompt = (slice, impl, stage, renderOnly = false, external = false) => {
  const lines = [
    REVIEW_AGENTS_GUIDE,
    '',
    REVIEW_DISCIPLINE,
    '',
    '本次是代码质量与风险审查：只依据仓库代码与 patch 判断，不要求复现、模仿或推测任何既有实现或模型输出。',
    '',
    '## 待审对象：本片 patch' + ((isPlainObject(stage) && isPlainObject(stage.reviewPackage) && stage.reviewPackage.skipped !== true)
      ? '（下方审查包已含全文；只读包一次，不要重复 read）'
      : '（必须实际 read 文件，不要相信摘要）'),
    '- patch: ' + ((impl && impl.patchPath) ? impl.patchPath : '(缺失)'),
    '- 薄文档: ' + ((impl && impl.docPath) ? impl.docPath : '(缺失)'),
    '- 实现者自述验证结果（仅作线索，不作为结论依据）: ' + ((impl && impl.verifyResult) ? impl.verifyResult : '(无)'),
    '',
    ...packageSection(stage),
    '## 本片定义（JSON）',
    sliceForReviewPrompt(slice),
    '',
    ...alignmentSection(stage),
    '## 重点核验面',
    '- 实际读 patch，逐条对照接口契约与验收标准（对不上即 red）。',
    '- 边界条件、错误路径、生命周期、并发与资源释放。',
    '- 是否越界改动 brief 之外的东西。',
    '- 代码放置与 include 顺序按补丁交付规范「2. 最终 patch 的代码放置与 include 顺序」逐条核验'
      + '（用户硬要求，不按个人风格忽略；违规按 🟡 报，引发编译/语义问题的按实际严重度报）。',
    '- 切片信息隔离：patch 新增行、代码、注释、标识符、测试名、日志字符串中出现切片 id/标题/序号时报 `category: "slice-leak"`（必须修复）。',
    '- 过度修复：若为单个边界条件引入通用机制、顺手重构、加不可达防御、改公共契约只为适配一个调用方，'
      + '报 finding 并在 `category` 写 `over-fix`（属硬门禁项，不能只写"接受理由"关闭）。',
    '- 性能：热路径（每帧/逐对象/逐像素）是否被过度防御拖重（不可达校验、防御性拷贝、每帧分配、锁、额外提交）；',
    '  CPU 与 GPU 分别按审查规范十维第 2 条核验。热路径性能回归且给不出量化证据（复杂度推导/profile/抓帧）按 🔴 报，',
    '  不得只写"可能影响性能"；冷路径与一次性初始化不上报性能问题。',
    '- 另外：质疑 brief/计划本身的假设——若设计有误，一并指出。',
    '',
    '## 测试与证据纪律',
    '- 不要为了复核实现者的测试报告而重跑测试套件：报告是未经验证的主张，用代码与 diff 去核。',
    '- 只有读代码产生具体疑问时才跑测试，且只跑覆盖该疑问的针对性用例，并写明「疑问 + 命令 + 结果」。',
    '- 实现者报告没给出覆盖测试 / 命令 / 输出时，允许跑一次针对性验证；证据缺失本身要写进 unverifiable。'
  ];
  if (isPlainObject(stage)) {
    lines.push(
      '',
      '## 审查轮次',
      'round=' + stage.round
        + (typeof stage.upgradeReason === 'string' && stage.upgradeReason !== ''
          ? '（本轮由增量复审升级为全量：' + stage.upgradeReason + '）'
          : '（逐阶段全量审查：本轮独立重审 patch，不依赖上一轮 findings）'),
      '',
      '## 用户对上一轮 patch 的修改意见（必须逐条核对是否已落实）',
      (typeof stage.userFeedback === 'string' && stage.userFeedback !== '')
        ? stage.userFeedback : '（本轮无用户意见）',
      '',
      '## 机械预检结果（Lead 提供，仅作线索，不替代实际 read patch）',
      (typeof stage.preflight === 'string') ? stage.preflight : JSON.stringify(stage.preflight, null, 2)
    );
  }
  lines.push(...findingsPersistSection(slice, stage, renderOnly, external));
  return lines.join('\n');
};

// round>=2 的对账式复审：只审「上一轮 findings 状态 + 修复增量 + 调用链影响面」，
// 不重读全量 patch、不再假装盲审。材料（上一轮 findings / delta）由宿主放进审查包或 args。
const focusedReviewPrompt = (slice, impl, stage, renderOnly = false, external = false) => {
  const previous = (stage && stage.previousReview) || null;
  const prevFindings = (previous && previous.codeReview && Array.isArray(previous.codeReview.findings))
    ? previous.codeReview.findings.map((item) => ({
        severity: item && item.severity,
        file: item && item.file,
        line: item && item.line,
        issue: item && item.issue
      }))
    : [];
  const symbols = (impl && Array.isArray(impl.changedSymbols)) ? impl.changedSymbols : [];
  return [
    REVIEW_AGENTS_GUIDE,
    '',
    REVIEW_DISCIPLINE,
    '',
    '本次是代码质量与风险审查：只依据仓库代码与 patch 判断，不要求复现、模仿或推测任何既有实现或模型输出。',
    '',
    '## 本轮是对账式复审（round=' + stage.round + '，不是全量重审）',
    '只做三件事：①逐条核对上一轮 findings 是否真的修好；②审本轮修复增量（delta）；',
    '③对 delta 触及的符号核调用链影响面。不要重读全量 patch，也不要重新审已通过的旧代码。',
    '',
    '## 待审对象',
    '- 全量 patch（仅用于定位，不是本轮审查对象）：' + ((impl && impl.patchPath) ? impl.patchPath : '(缺失)'),
    '- 本轮修复增量（delta，主要审查对象）：' + (stage.deltaPath || '(缺失——材料不足，请在 unverifiable 里写清并给 verdict=revise)'),
    '- 变更符号：' + (symbols.length ? symbols.join('、') : '(未提供；影响面无法核实，请在 unverifiable 写明)'),
    '',
    '## 上一轮 findings（摘要：只给位置与问题，不提供上一轮原话）',
    JSON.stringify(prevFindings, null, 2),
    '',
    ...packageSection(stage),
    '## 本片定义（JSON）',
    sliceForReviewPrompt(slice),
    '',
    '## 输出要求（硬约束）',
    '1. 必须输出 `previousFindings`：每条给 status（resolved/unresolved/changed）与 evidence（代码位置或命令输出）；',
    '   只写结论不写证据视为无效。`changed` 的问题要在 findings 里重述。',
    '2. 必须对变更符号逐个做一次 codegraph `impact` 或 `callers`（最多 8 个符号），证据写进 evidence；',
    '   影响调用点 > 20、或发现公共契约/共享布局变化 → 不要局部判断，写进 unverifiable 并建议升级全量。',
    '3. findings 只报 delta 与调用链影响面相关的新问题，不重复上一轮已解决的条目；',
    '   若修复属于「为单一边界引入通用机制 / 顺手重构 / 改公共契约只为适配一个调用方 / 加不可达防御」，',
    '   报一条 `category: "over-fix"` 的 finding（属硬门禁项，不能只写"接受理由"关闭）。',
    '4. delta 触及热路径时，额外核是否引入防御性拷贝 / 锁 / 额外提交 / 冗余校验；',
    '   热路径性能回归且无量化证据按 🔴 报（`category: "performance"`），冷路径不报。',
    '5. 与上一轮 findings 冲突时写清依据（代码位置/命令输出）。',
    '6. patch 新增行出现切片 id/标题/序号时报 `category: "slice-leak"`（必须修复）。',
    '',
    ...(typeof stage.scopeWarning === 'string' && stage.scopeWarning !== ''
      ? ['## 范围提醒（宿主提供）', stage.scopeWarning, '']
      : []),
    '## 用户对上一轮 patch 的修改意见（逐条核对是否已落实）',
    (typeof stage.userFeedback === 'string' && stage.userFeedback !== '') ? stage.userFeedback : '（本轮无用户意见）',
    '',
    '## 机械预检结果（Lead 提供，仅作线索）',
    (typeof stage.preflight === 'string') ? stage.preflight : JSON.stringify(stage.preflight, null, 2),
    '',
    ...findingsPersistSection(slice, stage, renderOnly, external)
  ].join('\n');
};

function runPhase(def, suffix, fn) {
  phase(def.title + (suffix || '') + '（' + mdl(def.role) + '）');
  return fn();
}

// ========================================================================
// 逐阶段模式（S1）：design / brief(兜底) / review / render-implement / render-fix
// ------------------------------------------------------------------------
// 每次只跑被调用的那一个阶段；brief 由主会话写入 plan.json 的 slices[i].brief，
// 逐阶段路径不再派发 brief agent（mode='brief' 仅作手工/旧流程兜底）。
// planReview / briefReview 已归档不启用。render-* 不派发任何 agent，只把任务书
// 原文交回宿主（宿主追加 sha12 指纹）。runContext 由宿主逐字段比对后回传。
// ========================================================================
function stageSliceOf(planValue, sliceIdValue) {
  if (!planValue || !Array.isArray(planValue.slices)) {
    throw new Error('args.plan is required in ' + mode + ' mode (the host reads planFile into args.plan)');
  }
  const found = planValue.slices.filter((s) => s && s.id === sliceIdValue)[0];
  if (!found) {
    throw new Error('args.sliceId "' + sliceIdValue + '" not found in args.plan.slices; available: '
      + planValue.slices.map((s) => (s && s.id) ? s.id : '?').join(', '));
  }
  return found;
}

function requireStageString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('args.' + name + ' is required in ' + mode + ' mode (non-empty string)');
  }
  return value;
}

function requireStageObject(value, name) {
  if (!isPlainObject(value)) {
    throw new Error('args.' + name + ' is required in ' + mode + ' mode (object)');
  }
  return value;
}

// impl 是上一轮实现者的返回（IMPL_SCHEMA）；缺 patchPath / docPath 会渲染出占位文本，直接拒绝。
function requireStageImpl(value) {
  const implValue = requireStageObject(value, 'impl');
  const missing = ['patchPath', 'docPath']
    .filter((key) => typeof implValue[key] !== 'string' || implValue[key].trim() === '');
  if (missing.length > 0) {
    throw new Error('args.impl is missing required field(s): ' + missing.join(', ')
      + ' (refuse to render placeholder text)');
  }
  return implValue;
}

function requireStageBrief(value) {
  const briefValue = requireStageObject(value, 'brief');
  const missing = ['sliceId', 'architecture', 'details']
    .filter((key) => typeof briefValue[key] !== 'string' || briefValue[key].trim() === '');
  if (missing.length > 0) {
    throw new Error('args.brief is missing required field(s): ' + missing.join(', ')
      + ' (refuse to render placeholder text)');
  }
  return briefValue;
}

function requireStageRound(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('args.round must be a >=1 integer in ' + mode + ' mode');
  }
  return value;
}

// ========================================================================
// 每片讨论门禁：每个 Slice 开工前必须先与用户讨论本片方案，结论落在
// plan.json 的 slices[i].discussion。没有记录 / 未确认 / 有未决问题 → 不派发。
// 豁免同样要机械留痕：waiver 必须带用户原话。
// ========================================================================
const DISCUSSION_SHAPE = '{sliceId, understanding, decisions:[{topic,decision,reason}], rejected:[{option,reason}], '
  + 'openQuestions:[], userConfirmed:true}，或豁免形式 {sliceId, waiver:{byUser:true,quote:"用户原话"}, openQuestions:[]}';

function requireSliceDiscussion(slice, sliceId) {
  const discussion = slice && slice.discussion;
  if (!isPlainObject(discussion)) {
    throw new Error('slice "' + sliceId + '" 缺少 discussion：每个 Slice 开始前必须先与用户讨论本片方案，'
      + '把结论写进 plan.json → slices[i].discussion = ' + DISCUSSION_SHAPE
      + '；没有讨论记录不派发 ' + mode + ' 阶段');
  }
  if (discussion.sliceId !== sliceId) {
    throw new Error('slices[' + sliceId + '].discussion.sliceId = ' + JSON.stringify(discussion.sliceId)
      + ' 与本片不一致（疑似复制了其他片的讨论记录，请按本片重新讨论）');
  }
  if (discussion.openQuestions != null
    && (!Array.isArray(discussion.openQuestions)
      || discussion.openQuestions.some((q) => typeof q !== 'string'))) {
    throw new Error('discussion.openQuestions 必须是字符串数组');
  }
  return discussion;
}

function assertDecisionItems(discussion) {
  if (!Array.isArray(discussion.decisions) || discussion.decisions.length === 0) {
    throw new Error('discussion.decisions 至少要有一条已确认决策（{topic,decision,reason}）；'
      + '确实无需决策且用户同意跳过讨论时，改用 waiver 并写入用户原话');
  }
  discussion.decisions.forEach((item) => {
    if (!isPlainObject(item) || typeof item.topic !== 'string' || item.topic.trim() === ''
      || typeof item.decision !== 'string' || item.decision.trim() === '') {
      throw new Error('discussion.decisions[] 每项都需要非空 topic 与 decision');
    }
  });
}

function assertDiscussionSettled(discussion) {
  const waiver = discussion.waiver;
  if (waiver != null) {
    if (!isPlainObject(waiver) || waiver.byUser !== true
      || typeof waiver.quote !== 'string' || waiver.quote.trim() === '') {
      throw new Error('discussion.waiver 必须写 {byUser:true, quote:"用户原话"}：'
        + '豁免本片讨论必须保留用户原话');
    }
    return 'waived';
  }
  if (typeof discussion.understanding !== 'string' || discussion.understanding.trim() === '') {
    throw new Error('discussion.understanding 不能为空：写清本片要解决什么、不解决什么');
  }
  assertDecisionItems(discussion);
  if (discussion.userConfirmed !== true) {
    throw new Error('discussion.userConfirmed 必须为 true：讨论结论要经用户明确确认后才能写 brief');
  }
  return 'confirmed';
}

function discussionGate(slice, sliceId) {
  const discussion = requireSliceDiscussion(slice, sliceId);
  const openQuestions = (discussion.openQuestions || []).map((q) => q.trim()).filter((q) => q !== '');
  if (openQuestions.length > 0) return { discussion, openQuestions, state: 'ask-user' };
  return { discussion, openQuestions, state: assertDiscussionSettled(discussion) };
}

// ========================================================================
// brief 解析（2026-11-03）：brief 的唯一事实源是 plan.json → slices[i].brief。
// 主会话在用户确认设计后，按 design 的 research 提炼 brief 写进 plan；
// 逐阶段路径直接把 plan 交给 render-*；briefFile 仅作手工/旧流程兼容。
// ========================================================================
const BRIEF_FILE_LINE = /[A-Za-z0-9_./\\-]+:\d+/;
const BRIEF_VERIFY_HINT = /验证|verify|exit|ctest|cmake|ninja|make|msbuild|cargo|npm|node --test/i;

function assertBriefShape(brief, label) {
  if (!isPlainObject(brief)) throw new Error(label + ' 必须是对象');
  const missing = ['sliceId', 'architecture', 'details']
    .filter((key) => typeof brief[key] !== 'string' || brief[key].trim() === '');
  if (missing.length > 0) throw new Error(label + ' 缺少字段：' + missing.join('、'));
  if (!BRIEF_FILE_LINE.test(brief.details)) {
    throw new Error(label + '.details 必须包含至少一个 file:line（如 lib/x.js:42）：'
      + 'brief 决定 Tasker 改哪里，没有符号定位说明设计调研没有落地');
  }
  if (!BRIEF_VERIFY_HINT.test(brief.details)) {
    throw new Error(label + '.details 必须写明验证命令（如 cmake --build … / ctest / node --test / exit 0）：'
      + 'brief 要能直接交给 Tasker 执行');
  }
  return brief;
}

function planBriefOf(slice) {
  return (slice && isPlainObject(slice.brief)) ? slice.brief : null;
}

function briefFromPlan(slice, sliceId) {
  const raw = planBriefOf(slice);
  if (raw === null) return null;
  const brief = Object.assign({}, raw);
  assertBriefShape(brief, 'plan.json 的 slices[i].brief');
  if (brief.sliceId !== sliceId) {
    throw new Error('plan.json 的 slices[i].brief.sliceId = ' + JSON.stringify(brief.sliceId)
      + ' 与 sliceId "' + sliceId + '" 不一致：拒绝用别的片的 brief 渲染任务书');
  }
  return brief;
}

function sameBrief(a, b) {
  return a.sliceId === b.sliceId && a.architecture === b.architecture && a.details === b.details;
}

function resolveBrief(slice, sliceId, fileBrief) {
  const fromPlan = briefFromPlan(slice, sliceId);
  const fromFile = (fileBrief == null) ? null : assertBriefShape(fileBrief, 'args.brief');
  if (fromFile !== null && fromFile.sliceId !== sliceId) {
    throw new Error('args.brief.sliceId = ' + JSON.stringify(fromFile.sliceId)
      + ' 与 sliceId "' + sliceId + '" 不一致：必须用本片的 brief');
  }
  if (fromPlan !== null && fromFile !== null) {
    if (!sameBrief(fromPlan, fromFile)) {
      throw new Error('plan.json 的 slices[i].brief 与 args.brief 内容不一致：'
        + 'brief 的唯一事实源是 plan.json，请保持两者一致或去掉 briefFile');
    }
    return fromPlan;
  }
  if (fromPlan !== null) return fromPlan;
  if (fromFile !== null) return fromFile;
  throw new Error('缺少本片 brief：请主会话先把 brief 写进 plan.json 的 slices[i].brief'
    + '（{sliceId, architecture, details, openQuestions?}），或继续用 briefFile 兼容传入');
}

function discussionBlockedResult(slice, sliceId, gate) {
  return {
    ok: true, mode, stage: 'discussion', sliceId, title: slice.title,
    nextAction: 'ask-user', openQuestions: gate.openQuestions, sliceDiscussion: gate.discussion,
    runContext, routes: ROUTES,
    reviewStandardPath: EXPECTED_STANDARD,
    reviewStandardConfirmed: reviewConfirmation()
  };
}

function stageFailure(stageName, sliceId, reason) {
  return {
    ok: false, mode, stage: stageName, sliceId, routes: ROUTES,
    reviewStandardPath: EXPECTED_STANDARD,
    reviewStandardConfirmed: reviewConfirmation(),
    reason
  };
}

// 0.10.0：Lead 侧 subagent 复审。renderOnly 只回任务书；codeReview 只做结果校验/后处理。
function validateDesignResult(value) {
  if (!isPlainObject(value)) throw new Error('codeDesign 必须是对象（外部 agent 返回的 plan JSON）');
  if (typeof value.summary !== 'string' || typeof value.interfaceContract !== 'string' || !Array.isArray(value.slices)) {
    throw new Error('codeDesign 缺少 summary / interfaceContract / slices');
  }
  value.slices.forEach((slice, index) => {
    if (!isPlainObject(slice)) throw new Error('codeDesign.slices[' + index + '] 必须是对象');
    for (const key of ['id', 'title', 'scope', 'acceptance', 'research']) {
      if (slice[key] === undefined || slice[key] === null || slice[key] === '') {
        throw new Error('codeDesign.slices[' + index + '] 缺少 ' + key);
      }
    }
    if (!isPlainObject(slice.research)) throw new Error('codeDesign.slices[' + index + '].research 必须是对象');
  });
  normalizeResearch(value);
  return value;
}

function designOutputSuffix() {
  return [
    '',
    '## 输出格式（硬要求）',
    '只输出一个 JSON 对象（不要 markdown 围栏、不要解释文字），字段按 DESIGN_PLAN_SCHEMA：',
    'summary / interfaceContract / slices / decisions / openQuestions；slices 每项含 id/title/scope/acceptance/research。',
    '不要写任何文件；宿主会把结果写入设计产物。'
  ].join('\n');
}

function reviewOutputSuffix(schemaName, renderOnly = false, external = false) {
  const lines = [
    '',
    '## 输出格式（硬要求）',
    '最终只输出一个 JSON 对象（不要 markdown 围栏、不要解释文字）。'
  ];
  if (external) {
    lines.push('字段按 ' + schemaName + ' schema；只输出 JSON，不写文件。');
  } else if (renderOnly) {
    lines.push('写盘成功时只输出 `{"reviewPath":"<结果文件绝对路径>"}`；写盘失败才按 ' + schemaName + ' schema 输出完整 JSON。');
  } else {
    lines.push('字段按 ' + schemaName + ' schema；写盘后返回完整 JSON。');
  }
  lines.push(schemaName === 'FOCUSED_REVIEW_SCHEMA'
    ? '必须包含 previousFindings（每条 status + evidence）。'
    : '必须包含 blindFindings（阶段一的原始结论）。');
  return lines.join('\n');
}

if (isStageMode) {
  log('mode=' + mode + '; runContext=' + JSON.stringify(runContext));

  if (mode === 'design') {
    const requirement = requireStageString(A.requirement, 'requirement');
    const digest = requireStageString(A.discussionDigest, 'discussionDigest');
    const renderDesignOnly = A.renderDesign === true;
    const ingestDesign = isPlainObject(A.codeDesign) ? A.codeDesign : null;
    if (renderDesignOnly && ingestDesign !== null) {
      throw new Error('args.renderDesign 与 args.codeDesign 不能同时使用');
    }
    if (A.externalAgents?.designer?.enabled === true && !renderDesignOnly && ingestDesign === null) {
      throw new Error('designer 已启用外部 agent：请用 renderDesign/codeDesign');
    }
    if (renderDesignOnly) {
      return {
        ok: true, mode: 'design-render', external: true, prompt: planPrompt(requirement, digest) + designOutputSuffix(),
        schemaName: 'DESIGN_PLAN_SCHEMA', outputSchema: DESIGN_PLAN_SCHEMA,
        routes: ROUTES, runContext,
        reviewStandardPath: EXPECTED_STANDARD,
        reviewStandardConfirmed: reviewConfirmation()
      };
    }
    const designed = ingestDesign !== null
      ? validateDesignResult(ingestDesign)
      : await runPhase(STAGE_DEFS.design, '', () => agent(
        planPrompt(requirement, digest), { label: 'design-plan', ...DESIGN, schema: DESIGN_PLAN_SCHEMA }));
    if (designed === null) {
      return {
        ok: false, mode, stage: 'design', runContext, routes: ROUTES,
        reviewStandardPath: EXPECTED_STANDARD,
        reviewStandardConfirmed: reviewConfirmation(),
        reason: 'design agent failed (see child session for the error)'
      };
    }
    const decisions = Array.isArray(designed.decisions) ? designed.decisions : [];
    const openQuestions = Array.isArray(designed.openQuestions) ? designed.openQuestions : [];
    normalizeResearch(designed);
    return {
      ok: true, mode, stages: ['design'], runContext, routes: ROUTES,
      external: ingestDesign !== null, plan: designed, decisions, openQuestions,
      reviewStandardPath: EXPECTED_STANDARD,
      reviewStandardConfirmed: reviewConfirmation(),
      nextAction: 'ask-user'
    };
  }

  if (mode === 'brief') {
    const stageSliceId = requireStageString(A.sliceId, 'sliceId');
    const stageSlice = stageSliceOf(A.plan, stageSliceId);
    const gate = discussionGate(stageSlice, stageSliceId);
    log('slice ' + stageSliceId + ' discussion: ' + (gate.state === 'ask-user'
      ? 'blocked by ' + gate.openQuestions.length + ' open question(s)'
      : gate.state === 'waived'
        ? 'waived by the user'
        : gate.discussion.decisions.length + ' confirmed decision(s)'));
    if (gate.state === 'ask-user') {
      return {
        ok: true, mode, stage: 'discussion', sliceId: stageSliceId, title: stageSlice.title,
        nextAction: 'ask-user', openQuestions: gate.openQuestions, sliceDiscussion: gate.discussion,
        runContext, routes: ROUTES,
        reviewStandardPath: EXPECTED_STANDARD,
        reviewStandardConfirmed: reviewConfirmation()
      };
    }
    const produced = await runPhase(STAGE_DEFS.brief, '', () => agent(
      briefPrompt(A.plan, stageSlice, designDocPath, gate.discussion), {
        label: 'brief:' + stageSliceId, ...DESIGN, schema: BRIEF_SCHEMA
      }));
    if (produced === null) {
      return {
        ok: false, mode, stage: 'brief', sliceId: stageSliceId, runContext, routes: ROUTES,
        reviewStandardPath: EXPECTED_STANDARD,
        reviewStandardConfirmed: reviewConfirmation(),
        reason: 'brief agent failed (see child session for the error)'
      };
    }
    log('info: brief 由主会话产出（plan.json → slices[i].brief）；briefReview 已归档，不可启用');
    const briefOpen = Array.isArray(produced.openQuestions)
      ? produced.openQuestions.filter((q) => typeof q === 'string' && q.trim() !== '')
      : [];
    return {
      ok: true, mode, stages: ['brief'], sliceId: stageSliceId, title: stageSlice.title,
      brief: produced, briefReview: null, briefReviewSkipped: true,
      sliceDiscussion: gate.discussion, openQuestions: briefOpen,
      designBaseline: baselineSource, runContext, routes: ROUTES,
      reviewStandardPath: EXPECTED_STANDARD,
      reviewStandardConfirmed: reviewConfirmation(),
      nextAction: briefOpen.length > 0 ? 'ask-user' : 'spawn-implementer'
    };
  }

  if (mode === 'review') {
    const stageSliceId = requireStageString(A.sliceId, 'sliceId');
    const implValue = requireStageImpl(A.impl);
    const round = requireStageRound(A.round);
    requireStageString(A.patchPath, 'patchPath');
    requireStageString(A.docPath, 'docPath');
    if (typeof A.userFeedback !== 'string') {
      throw new Error('args.userFeedback is required in review mode (round=1 may be an empty string)');
    }
    if (round > 1 && A.userFeedback.trim() === '') {
      throw new Error('args.userFeedback must be non-empty for review round ' + round);
    }
    if (A.preflight === undefined || A.preflight === null) {
      throw new Error('args.preflight is required in review mode (mechanical pre-check result)');
    }
    const stageSlice = stageSliceOf(A.plan, stageSliceId);
    // 宿主已按材料判定实际范围（round=1 / 缺料 / 用户要求都会是 full）。
    const reviewScope = (A.reviewScope === 'incremental') ? 'incremental' : 'full';
    // 待审对象以 Lead 机械预检过的 patchPath / docPath 为准，impl 其余字段原样透传。
    const reviewImpl = Object.assign({}, implValue, { patchPath: A.patchPath, docPath: A.docPath });
    const renderOnly = A.renderReview === true;
    const ingestReview = isPlainObject(A.codeReview) ? A.codeReview : null;
    const externalReviewer = A.externalAgents?.reviewer?.enabled === true;
    if (renderOnly && ingestReview !== null) {
      throw new Error('args.renderReview 与 args.codeReview 不能同时使用：render 只出任务书，codeReview 只消费结果');
    }
    if (externalReviewer && !renderOnly && ingestReview === null) {
      throw new Error('reviewer 已启用外部 agent：请用 renderReview 生成任务书，再用 codeReview 消费结果');
    }
    if (ingestReview !== null) {
      if (typeof ingestReview.verdict !== 'string' || !Array.isArray(ingestReview.findings)) {
        throw new Error('args.codeReview 必须是 review JSON（含 verdict 与 findings 数组）');
      }
      if (typeof ingestReview.standardPath !== 'string' || ingestReview.standardPath.trim() === '') {
        throw new Error('args.codeReview.standardPath 不能为空');
      }
      if (reviewScope === 'incremental' && !Array.isArray(ingestReview.previousFindings)) {
        throw new Error('args.codeReview.previousFindings 缺失：聚焦复审必须逐条交代上一轮 findings');
      }
    }
    let renderPrompt = null;
    let renderSchemaName = null;
    let reviewed = null;
    let reviewAlignment = null;
    let blindFindings = null;
    let withdrawn = null;
    let previousFindings = null;

    if (reviewScope === 'incremental') {
      const previous = A.previousReview;
      if (!isPlainObject(previous)) {
        throw new Error('incremental 复审缺少 args.previousReview：宿主应从 '
          + '<outDir>/reviews/<sliceId>-review-r' + (round - 1) + '.json 读取上一轮结果并注入');
      }
      if (previous.round !== round - 1) {
        throw new Error('args.previousReview.round = ' + JSON.stringify(previous.round)
          + ' 与 round-1（' + (round - 1) + '）不一致：拒绝跳轮或复用旧结果');
      }
      const deltaPath = (typeof A.deltaPath === 'string' && A.deltaPath !== '')
        ? A.deltaPath
        : ((typeof implValue.fixDeltaPath === 'string' && implValue.fixDeltaPath !== '') ? implValue.fixDeltaPath : null);
      const focusedStage = {
        round: round, userFeedback: A.userFeedback, preflight: A.preflight,
        deltaPath: deltaPath,
        changedSymbols: Array.isArray(implValue.changedSymbols) ? implValue.changedSymbols : [],
        previousReview: previous,
        scopeWarning: (typeof A.scopeWarning === 'string') ? A.scopeWarning : '',
        reviewPackage: A.reviewPackage
      };
      if (renderOnly) {
        renderPrompt = focusedReviewPrompt(stageSlice, reviewImpl, focusedStage, true, externalReviewer);
        renderSchemaName = 'FOCUSED_REVIEW_SCHEMA';
      } else if (ingestReview !== null) {
        reviewed = ingestReview;
      } else {
        reviewed = await runPhase(STAGE_DEFS.codeReview, ' r' + round, () => agent(
          focusedReviewPrompt(stageSlice, reviewImpl, focusedStage),
          { label: 'code-review:' + stageSliceId, ...REVIEW, schema: FOCUSED_REVIEW_SCHEMA }));
        recordReview('code-review:' + stageSliceId, reviewed);
      }
      previousFindings = (reviewed && Array.isArray(reviewed.previousFindings)) ? reviewed.previousFindings : null;
      const unresolved = previousFindings
        ? previousFindings.filter((item) => item && item.status !== 'resolved').length : null;
      if (!renderOnly) {
        log('review r' + round + ' focused: previous='
          + (previousFindings === null ? 'missing' : previousFindings.length)
          + ' unresolved=' + (unresolved === null ? '?' : unresolved)
          + ' new=' + ((reviewed && Array.isArray(reviewed.findings)) ? reviewed.findings.length : 0));
        if (previousFindings === null) {
          log('warn: 对账式复审缺少 previousFindings——无法确认上一轮问题是否解决');
        }
      }
    } else {
      // 全量复审（round=1，或宿主判定材料不足/用户要求）：brief 优先取 plan.json → slices[i].brief。
      const briefPath = [A.briefPath, A.briefFile].filter((item) => typeof item === 'string' && item.trim() !== '')[0] || null;
      const planBrief = planBriefOf(stageSlice);
      const stageBrief = (planBrief !== null)
        ? requireStageBrief(planBrief)
        : requireStageBrief(A.brief);
      if (planBrief !== null && A.brief != null && !sameBrief(stageBrief, requireStageBrief(A.brief))) {
        throw new Error('plan.json 的 slices[i].brief 与 args.brief 内容不一致：'
          + 'brief 的唯一事实源是 plan.json，请保持两者一致或去掉 briefFile');
      }
      if (stageBrief.sliceId !== stageSliceId) {
        throw new Error('brief.sliceId = ' + JSON.stringify(stageBrief.sliceId)
          + ' 与 sliceId "' + stageSliceId + '" 不一致：对齐审查必须用本片的 brief');
      }
      const fullStage = {
        round: round, userFeedback: A.userFeedback, preflight: A.preflight,
        briefPath: briefPath, briefArch: stageBrief.architecture, reviewPackage: A.reviewPackage,
        upgradeReason: (typeof A.upgradeReason === 'string') ? A.upgradeReason : null
      };
      if (renderOnly) {
        renderPrompt = codeReviewPrompt(stageSlice, reviewImpl, fullStage, true, externalReviewer);
        renderSchemaName = 'ALIGNED_REVIEW_SCHEMA';
      } else if (ingestReview !== null) {
        reviewed = ingestReview;
      } else {
        reviewed = await runPhase(STAGE_DEFS.codeReview, ' r' + round, () => agent(
          codeReviewPrompt(stageSlice, reviewImpl, fullStage),
          { label: 'code-review:' + stageSliceId, ...REVIEW, schema: ALIGNED_REVIEW_SCHEMA }));
        recordReview('code-review:' + stageSliceId, reviewed);
      }
      const findingsList = (reviewed && Array.isArray(reviewed.findings)) ? reviewed.findings : [];
      const blindTagged = findingsList.filter((item) => item && item.source === 'blind').length;
      const alignTagged = findingsList.filter((item) => item && item.source === 'alignment').length;
      const blindFindingCount = (reviewed && Array.isArray(reviewed.blindFindings))
        ? reviewed.blindFindings.length : null;
      const withdrawnCount = (reviewed && Array.isArray(reviewed.withdrawn)) ? reviewed.withdrawn.length : 0;
      reviewAlignment = {
        applied: true,
        briefPath: briefPath,
        briefSource: briefPath === null ? 'inline' : 'path',
        blindFindingCount: blindFindingCount,
        withdrawnCount: withdrawnCount,
        finalBlind: blindTagged,
        finalAlignment: alignTagged,
        unlabeled: findingsList.length - blindTagged - alignTagged
      };
      blindFindings = (reviewed && Array.isArray(reviewed.blindFindings)) ? reviewed.blindFindings : null;
      withdrawn = (reviewed && Array.isArray(reviewed.withdrawn)) ? reviewed.withdrawn : null;
      log('review r' + round + ' full/two-phase: blind='
        + (blindFindingCount === null ? 'missing' : blindFindingCount)
        + ' alignment=' + alignTagged + ' withdrawn=' + withdrawnCount
        + ' unlabeled=' + reviewAlignment.unlabeled);
      if (!renderOnly && blindFindingCount === null) {
        log('warn: 审查结果缺少 blindFindings——两段式可能未执行（先盲审、再读 brief 对齐）');
      }
      if (!renderOnly && reviewAlignment.unlabeled > 0) {
        log('warn: ' + reviewAlignment.unlabeled + ' 条 finding 未标 source，两段式留痕不完整');
      }
    }

    if (renderOnly) {
      return {
        ok: true, mode: 'review-render', stages: ['codeReview'], sliceId: stageSliceId, title: stageSlice.title,
        round, reviewScope: reviewScope,
        upgradeReason: (typeof A.upgradeReason === 'string' && A.upgradeReason !== '') ? A.upgradeReason : null,
        prompt: renderPrompt + reviewOutputSuffix(renderSchemaName, renderOnly, externalReviewer),
        schemaName: renderSchemaName,
        reviewPackage: (A.reviewPackage !== undefined) ? A.reviewPackage : null,
        reviewStandardPath: EXPECTED_STANDARD,
        reviewStandardConfirmed: reviewConfirmation(),
        routes: ROUTES
      };
    }

    const reds = countReds(reviewed);
    const fixRounds = round - 1;
    const upgradeReason = (typeof A.upgradeReason === 'string' && A.upgradeReason !== '') ? A.upgradeReason : null;
    return {
      ok: true, mode, stages: ['codeReview'], sliceId: stageSliceId, title: stageSlice.title,
      round, fixRounds, patchPath: A.patchPath, docPath: A.docPath,
      verifyResult: (implValue.verifyResult !== undefined) ? implValue.verifyResult : null,
      reviewScope: reviewScope,
      upgradeReason: upgradeReason,
      previousFindings: previousFindings,
      codeReview: reviewed,
      codeReviewVerdict: reviewed ? reviewed.verdict : null,
      redCount: reds,
      blindFindings: blindFindings,
      withdrawn: withdrawn,
      reviewAlignment: reviewAlignment,
      reviewPackage: (A.reviewPackage !== undefined) ? A.reviewPackage : null,
      fixExhausted: !!(reds !== null && reds > 0 && fixRounds >= maxFixRounds),
      reviewStandardPath: EXPECTED_STANDARD,
      reviewStandardConfirmed: reviewConfirmation(),
      routes: ROUTES,
      nextAction: reviewed === null
        ? 'review-again'
        : (reds > 0
          ? ((reds !== null && fixRounds >= maxFixRounds) ? 'ask-user' : 'send-fix')
          : 'deliver')
    };
  }

  if (mode === 'render-implement') {
    const stageSliceId = requireStageString(A.sliceId, 'sliceId');
    const stageSlice = stageSliceOf(A.plan, stageSliceId);
    const gate = discussionGate(stageSlice, stageSliceId);
    if (gate.state === 'ask-user') return discussionBlockedResult(stageSlice, stageSliceId, gate);
    const stageBrief = resolveBrief(stageSlice, stageSliceId, A.brief);
    // 与批处理共用同一构造函数：逐阶段路径默认跳过 briefReview（已归档），故第三参数为 null。
    return {
      ok: true, mode, stages: [], sliceId: stageSliceId, title: stageSlice.title,
      prompt: implementPrompt(stageSlice, stageBrief, null),
      briefReview: null, briefReviewSkipped: true,
      sliceDiscussion: gate.discussion,
      runContext, routes: ROUTES,
      reviewStandardPath: EXPECTED_STANDARD,
      reviewStandardConfirmed: reviewConfirmation()
    };
  }

  // mode === 'render-fix'
  const stageSliceId = requireStageString(A.sliceId, 'sliceId');
  const implValue = requireStageImpl(A.impl);
  const round = requireStageRound(A.round);
  if (!isPlainObject(A.findings) && !Array.isArray(A.findings)) {
    throw new Error('args.findings is required in render-fix mode (the code review JSON object or findings array)');
  }
  if (typeof A.userFeedback !== 'string') {
    throw new Error('args.userFeedback is required in render-fix mode (may be an empty string)');
  }
  const stageSlice = stageSliceOf(A.plan, stageSliceId);
  // 首轮修复前重新校验讨论门禁（后续轮次已经过首轮确认，不重复要求）。
  if (round === 1) {
    const gate = discussionGate(stageSlice, stageSliceId);
    if (gate.state === 'ask-user') return discussionBlockedResult(stageSlice, stageSliceId, gate);
  }
  const stageBrief = resolveBrief(stageSlice, stageSliceId, A.brief);
  return {
    ok: true, mode, stages: [], sliceId: stageSliceId, title: stageSlice.title,
    prompt: fixPrompt(stageSlice, stageBrief, implValue, A.findings, round, A.userFeedback),
    runContext, routes: ROUTES,
    reviewStandardPath: EXPECTED_STANDARD,
    reviewStandardConfirmed: reviewConfirmation()
  };
}

// ========================================================================
// mode = 'plan-only'：按 PLAN_STAGES 跑，返回计划交用户裁决（不硬阻断）
// ========================================================================
if (mode === 'plan-only') {
  const requirement = A.requirement;
  if (typeof requirement !== 'string' || requirement.length === 0) {
    throw new Error('args.requirement is required in plan-only mode (non-empty string)');
  }

  let plan = null;
  let planReview = null;
  let round = 0;
  const history = [];

  for (const stage of PLAN_STAGES) {
    if (stage === 'design') {
      round = 1;
      plan = await runPhase(STAGE_DEFS.design, '', () => agent(planPrompt(requirement, A.discussionDigest), {
        label: 'design-plan', ...DESIGN, schema: PLAN_SCHEMA
      }));
      if (plan === null) {
        return {
          ok: false, mode, stage: 'design',
          routes: ROUTES,
          reviewStandardPath: EXPECTED_STANDARD,
          reviewStandardConfirmed: reviewConfirmation(),
          reason: 'design agent failed (see child session for the error)'
        };
      }
      normalizeResearch(plan);
      history.push({ round, plan, planReview: null });
    } else if (stage === 'planReview') {
      planReview = await runPhase(STAGE_DEFS.planReview, '', () => agent(planReviewPrompt(plan, requirement), {
        label: 'plan-review', ...REVIEW, schema: FINDINGS_SCHEMA
      }));
      recordReview('plan-review', planReview);
      // 修订闭环：revise → 回 design 修订 → 再审查，直到 pass 或达到 maxPlanRounds
      while (planReview && planReview.verdict === 'revise' && round < maxPlanRounds) {
        round++;
        plan = await runPhase(STAGE_DEFS.design, ' 修订 r' + round, () => agent(planRevisePrompt(plan, planReview), {
          label: 'design-revise-' + round, ...DESIGN, schema: PLAN_SCHEMA
        }));
        if (plan === null) break;
        normalizeResearch(plan);
        planReview = await runPhase(STAGE_DEFS.planReview, ' r' + round, () => agent(planReviewPrompt(plan, requirement), {
          label: 'plan-review-' + round, ...REVIEW, schema: FINDINGS_SCHEMA
        }));
        recordReview('plan-review-' + round, planReview);
      }
      history[history.length - 1] = { round, plan, planReview };
    }
  }

  // 计划就是给用户看的，不做硬阻断；由用户裁决后才进入 slice 模式。
  // planReview/planPassed 已随 planReview 归档（恒为 null），保留 planReview 字段只为旧调用方兼容。
  return {
    ok: true,
    mode,
    routes: ROUTES,
    stages: PLAN_STAGES,
    reviewStandardPath: EXPECTED_STANDARD,
    reviewStandardConfirmed: reviewConfirmation(),
    plan,
    planReview
  };
}

// ========================================================================
// mode = 'slice'：按 SLICE_STAGES 跑（严格串行，无并发项）
// ========================================================================
const sliceId = A.sliceId;
if (typeof sliceId !== 'string' || sliceId.length === 0) {
  throw new Error('args.sliceId is required in slice mode (exactly one slice per run)');
}
const plan = A.plan;
if (!plan || !Array.isArray(plan.slices)) {
  throw new Error('args.plan is required in slice mode (pass the plan object returned by a plan-only run)');
}
const slice = plan.slices.filter((s) => s && s.id === sliceId)[0];
if (!slice) {
  throw new Error('args.sliceId "' + sliceId + '" not found in args.plan.slices; available: '
    + plan.slices.map((s) => (s && s.id) ? s.id : '?').join(', '));
}

// 每片讨论门禁：批处理同样不能绕过——没有讨论记录的片不跑。
const batchGate = discussionGate(slice, sliceId);
if (batchGate.state === 'ask-user') {
  return {
    ok: false, mode, stage: 'discussion', sliceId, title: slice.title,
    openQuestions: batchGate.openQuestions, sliceDiscussion: batchGate.discussion,
    routes: ROUTES,
    reviewStandardPath: EXPECTED_STANDARD,
    reviewStandardConfirmed: reviewConfirmation(),
    reason: '本片讨论仍有 ' + batchGate.openQuestions.length + ' 个未决问题，批处理不替用户拍板：'
      + '先与用户确认并更新 plan.json 的 slices[i].discussion，再重跑'
  };
}
log('mode=slice sliceId=' + sliceId + ' discussion='
  + (batchGate.state === 'waived' ? 'waived' : batchGate.discussion.decisions.length + 'decision(s)')
  + '; write-scope=' + (workspace ? 'copy:' + workspace : 'in-repo:' + repoRoot));

// brief 不依赖阶段顺序：即使用户裁剪掉 `brief` 阶段，implement 也必须拿到 plan 里的 brief。
let brief = briefFromPlan(slice, sliceId);
let briefArch = null;
let briefReview = null;
let impl = null;
let codeReview = null;
let fixRounds = 0;

for (const stage of SLICE_STAGES) {
  if (stage === 'brief') {
    // brief 不再派发 agent：主会话已按 design 的 research 把它写进 plan.json。
    brief = briefFromPlan(slice, sliceId);
    if (brief === null) {
      return stageFailure('brief', sliceId,
        '缺少本片 brief：brief 由主会话根据设计结果产出，请先在 plan.json 的 slices[i].brief 写入 '
        + '{sliceId, architecture, details, openQuestions?}（details 需含 file:line 与验证命令），再重跑');
    }
    briefArch = { sliceId: brief.sliceId, architecture: brief.architecture };

  } else if (stage === 'briefReview') {
    // 归档（2026-11-03）：默认阶段表不含，parseStages 会剔除；代码保留供重新启用。
    briefReview = await runPhase(STAGE_DEFS.briefReview, '', () => agent(
      briefReviewPrompt(briefArch, slice, plan, designDocPath, baselineSource), {
        label: 'brief-review:' + sliceId, ...REVIEW, schema: DESIGN_REVIEW_SCHEMA
      }));
    recordReview('brief-review:' + sliceId, briefReview);

  } else if (stage === 'implement') {
    if (brief === null) {
      return stageFailure('implement', sliceId,
        '缺少本片 brief（plan.json 的 slices[i].brief）：不允许用占位文本派发实现，请主会话先补 brief');
    }
    const produced = await runPhase(STAGE_DEFS.implement, '', () => agent(implementPrompt(slice, brief, briefReview), {
      label: 'impl:' + sliceId, ...TASK, schema: IMPL_SCHEMA
    }));
    if (produced === null) {
      return stageFailure('implement', sliceId,
        'implement agent failed（见子会话错误）；batch 不再继续审查，避免对不存在的 patch 下结论');
    }
    impl = produced;

  } else if (stage === 'codeReview') {
    if (impl === null) {
      return stageFailure('codeReview', sliceId, '没有可审的 patch（implement 未产出），拒绝派发代码审查');
    }
    const reviewed = await runPhase(STAGE_DEFS.codeReview, '', () => agent(codeReviewPrompt(slice, impl), {
      label: 'code-review:' + sliceId, ...REVIEW, schema: FINDINGS_SCHEMA
    }));
    if (reviewed === null) {
      return stageFailure('codeReview', sliceId, 'codeReview agent failed（见子会话错误）');
    }
    codeReview = reviewed;
    recordReview('code-review:' + sliceId, codeReview);

  } else if (stage === 'fix') {
    // 修订闭环：🔴 > 0 → 回实现方修 → 复审，直到清 🔴 或达到 maxFixRounds。
    // 修复回生成方（TASK），不是审查方（§3.4）。复审用 REVIEW。
    // 失败用局部变量接收，避免把上一轮可交付的 impl 冲成 null。
    while (countReds(codeReview) !== null && countReds(codeReview) > 0 && fixRounds < maxFixRounds) {
      fixRounds++;
      const fixed = await runPhase(STAGE_DEFS.fix, ' r' + fixRounds, () => agent(fixPrompt(slice, brief, impl, codeReview, fixRounds), {
        label: 'fix-' + fixRounds + ':' + sliceId, ...TASK, schema: IMPL_SCHEMA
      }));
      if (fixed === null) {
        return stageFailure('fix', sliceId,
          'fix agent failed（第 ' + fixRounds + ' 轮）；上一轮 patch 保留在结果里，供人工处置');
      }
      impl = fixed;
      const reviewedFix = await runPhase(STAGE_DEFS.codeReview, ' 复审 r' + fixRounds, () => agent(codeReviewPrompt(slice, impl), {
        label: 'code-review-fix-' + fixRounds + ':' + sliceId, ...REVIEW, schema: FINDINGS_SCHEMA
      }));
      if (reviewedFix === null) {
        return stageFailure('codeReview', sliceId, '第 ' + fixRounds + ' 轮复审 agent failed（见子会话错误）');
      }
      codeReview = reviewedFix;
      recordReview('code-review-fix-' + fixRounds + ':' + sliceId, codeReview);
    }
  }
}

const reds = countReds(codeReview);
const briefReds = countReds(briefReview);

return {
  ok: true,
  mode,
  routes: ROUTES,
  sliceId,
  title: slice.title,
  stages: SLICE_STAGES,
  workspaceMode: workspace ? 'copy' : 'in-repo-with-revert',
  outDir,
  sliceDiscussion: batchGate.discussion,
  brief,
  briefArchitecture: briefArch,
  briefReview,
  briefAlignment: (briefReview && briefReview.alignment) ? briefReview.alignment : null,
  designBaseline: baselineSource,
  reviewStandardPath: EXPECTED_STANDARD,
  reviewStandardConfirmed: reviewConfirmation(),
  briefRedCount: briefReds,
  impl,
  patchPath: (impl && impl.patchPath) ? impl.patchPath : null,
  docPath: (impl && impl.docPath) ? impl.docPath : null,
  patchLineCount: (impl && impl.patchLineCount) ? impl.patchLineCount : null,
  verifyResult: (impl && impl.verifyResult) ? impl.verifyResult : null,
  reverted: (impl && impl.reverted) ? impl.reverted : null,
  codeReview,
  codeReviewVerdict: codeReview ? codeReview.verdict : null,
  redCount: reds,
  fixRounds,
  fixExhausted: !!(hasStage('slice', 'fix') && reds !== null && reds > 0 && fixRounds >= maxFixRounds),
  nextAction: reds === null
    ? (codeReview === null
      ? 'no codeReview stage in this run — deliver patch+doc to the user as-is'
      : 'implementation failed — inspect the child session for the error')
    : (reds > 0
      ? (hasStage('slice', 'fix')
        ? 'fix loop exhausted with ' + reds + ' red finding(s) remaining — report to the user, do NOT silently continue'
        : 'enter the repair loop (repair goes back to the generator, not the reviewer)')
      : 'slice done; ask the user whether to start the next slice')
};
