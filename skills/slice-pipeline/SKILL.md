---
name: slice-pipeline
description: 单 Slice 开发流水线：Lead 逐阶段编排（可插话）或一次跑完；一次只跑一片，下一片由用户触发
whenToUse: 需求已收敛要跑流水线：用户说“跑 slice-pipeline”“先出计划”“做第 N 片”“看第一轮 patch 再给意见”
---

# slice-pipeline —— Slice Pipeline 流水线

**运行模型：一次只跑一片，下一片由用户触发。** 每片独立可回退；没有跨 Slice 循环——循环等于自动开启下一片。

两条路径共用同一套 prompt、规范与角色配置，**不要手写阶段 prompt**：
- **逐阶段（主路径）**：用户要插话、要先看第一轮 patch，且 Lead 会话有 `spawn_teammate` → 按 ①–⑧ 逐步调用。
- **批处理（可选）**：用户不想插话，或 profile 未启用 Agent Teams → 一次 `slice_pipeline_run`。

## 前置检查（每次运行前）

1. `slice_pipeline_run` 可用，且正文末尾有 `## 当前插件配置（由 dsh-slice-pipeline 注入）` 与 ```json args 块。注入块写「未注册」时把原因原样转述；缺注入块或 `workflow` 也不可用时停下，不要换工具硬跑。
2. 走逐阶段前确认 Lead 有 `spawn_teammate` / `send_message` / `list_agents`；没有就降级批处理并说明原因。

## 运行方式（首选）

- 调用 `slice_pipeline_run`，**只传工具参数**：脚本与配置由宿主读取/注入，**不要读脚本、不要读注入的 args JSON 来拼工具参数**。
- `render-*` 返回的 `prompt` 是原文块，**原样转交** tasker，不得改写；超长会直接报错（不截断）。
- 批处理：`plan-only` 前台（结果要立刻交用户裁决）；`slice` 建议 `run_in_background: true`，完成后 `job_output` 查看并复述 `status`/`detail`。
- 后台被 kill 或前台中断后，子代理可能已改过工作区：先加载 `slice-workspace-recovery` 确认状态。

## 逐阶段协议 ①–⑧

| # | 做什么 | 调用 / 关键返回 |
| :--- | :--- | :--- |
| ① | 与用户把需求、设计方向讨论透（不派 agent） | Lead 写 `discussionDigest` |
| ② | 出方案 | `mode='design'` + `requirement` + `discussionDigest` → `plan`（含每片 `research`）/`decisions`/`openQuestions`/`runContext`，`nextAction=ask-user` |
| ②c | 用户批准 → Lead 落盘 `<outDir>/plan.json` | 顶层必须带 `designRef`（= design 返回的 `designRef`）；slices 原样保留 design 的 `id/title/scope/acceptance`，不增删切片 |
| ②d | **本片讨论（每片必做，不派 agent）** | 与用户把本片方案/边界/取舍讨论透，结论写进 `plan.json` 的 `slices[i].discussion`，`openQuestions` 清空才继续 |
| ③ | **主会话写 brief（不派 agent）** | 按 design 的 `research` 提炼简化设计，写进 `plan.json` 的 `slices[i].brief`（`{sliceId,architecture,details,openQuestions?}`；`details` 必须含 `file:line` 与验证命令，并引用 ≥2 个 design research 的符号/文件） |
| ③b | 渲染任务书并起 tasker | `mode='render-implement'` + `planFile`/`sliceId` → 宿主校验 `designRef`/`design.json`/切片一致性/brief 引用 research，回 `prompt`/`sha12`/`reasoningEffort` → `subagent`（fresh，名字 tasker-<sliceId>） |
| ③d | **机械预检**（不过不进审查） | 见下；结果作为 ⑤ 的 `preflight` |
| ④ | **用户看第一轮 patch 给意见** | `userFeedback` |
| ⑤ | 首轮全量审查（Lead 侧盲审） | `mode='review'` + `renderReview:true` + `round=1` → `prompt`/`sha12`/`reasoningEffort` → `subagent`（fresh，**禁止 fork**，名字 reviewer-r1）→ 子智能体写 `<outDir>/reviews/<sliceId>-review-r1.payload.json`，只回 `{"reviewPath":"…"}` → `mode='review'` + `codeReview:{reviewPath}` → `redCount`/`reviewAlignment`/`nextAction` |
| ⑥ | 回**同一个** tasker 修 | `mode='render-fix'` → `send_message`；再机械预检 |
| ⑦ | 复审（默认增量） | `renderReview:true` + `round=2..maxFixRounds+1` → 同一 subagent 流程（写 payload、回 `reviewPath`、`codeReview:{reviewPath}` 回收）；只审「上一轮 findings 状态 + 修复 delta + 调用链影响面」，材料不足/契约变更/符号>6 自动升级全量 → `deliver`/`send-fix`/`review-again` |
| ⑧ | 交付 | 按 `slice-patch-delivery` 三件套 |

- `design` 的 `nextAction` **恒为 `ask-user`**：`openQuestions` 非空或用户未批准，不得进入实现；任何 `ask-user` 都必须回到用户。design 成功后会落盘 `<outDir>/design.json` 并返回 `designRef`/`designPath`；返回值被截断时直接读 `design.json` 的 `plan` 写 `plan.json`。**未实现项**：⑧ 自动清理（`render-cleanup`）暂手工。批处理 `slice` 的复审仍是全量（增量只对逐阶段路径生效）。
- **tasker 常驻、每片一个**：用 `subagent`（fresh，名字 `tasker-<sliceId>`；provider/model 取 `roles.task`，effort 取 render 结果的 `reasoningEffort`）派发 implement；fix 用 `send_message` 回同一个 tasker，复用其上下文；⑧ 后结束。任务书要求「最后一次输出只给 JSON」并回显 `sha12`，Lead 按 `IMPL_SCHEMA` 字段机械校验，不合格重发（≤2 次）仍不合格则 `ask-user`。成员共享同一工作目录：按文件/模块切分写入范围。
- **每片讨论门禁（硬校验）**：`render-implement` / `render-fix`（round=1）与批处理 `slice` 都校验 `slices[i].discussion`——缺记录 / 未 `userConfirmed` / 无决策又无豁免 → 直接报错；`openQuestions` 非空 → `ask-user`，不渲染任务书。字段 `{sliceId, understanding, decisions:[{topic,decision,reason}], rejected:[{option,reason}], openQuestions:[], userConfirmed:true}`；用户明说这片不用讨论时写 `waiver:{byUser:true, quote:"原话"}`。

## 归档阶段（不启用）

`planReview`（设计/计划审查）与 `briefReview`（brief 方案审查）已归档：代码与 prompt 保留，但默认阶段表不含，配置或 `stages` 覆盖里出现会被剔除并 `warn`，不可通过配置启用。需要重新启用时从 `ARCHIVED_STAGES` 移除并恢复默认阶段表（README/规划规范有说明）。

## 角色与模型

| 阶段 | 模块 | 角色 |
| :--- | :--- | :--- |
| `design` | planning | `designer` |
| `codeReview`、`fix` 复审 | review | `reviewer` |
| `implement`、`fix`（**仅批处理**） | patchDelivery | `task` |

**逐阶段用 `subagent` 派发**（fresh 上下文）：tasker 取 `roles.task`，reviewer 取 `roles.reviewer`；`reasoning_effort` 取插件设置 `reasoningEfforts`（render 结果会回传建议值，空则用模型默认）。**审查必须 `subagent`，禁止 `subagent_fork`**（继承会话会破坏盲审）。批处理仍走 workflow `agent()`（不支持 effort）。

## 工具参数

| 字段 | 用于 | 说明 |
| :--- | :--- | :--- |
| `mode` | 全部 | `plan-only`/`slice`/`design`/`review`/`render-implement`/`render-fix`（brief 由主会话产出，无 agent 模式） |
| `requirement` / `discussionDigest` | `plan-only`、`design` | 需求非空；digest 写任务级讨论结论。**每片讨论不放这里**——写进 `plan.json` 的 `slices[i].discussion` |
| `planFile` / `briefFile` | `brief`、`review`、`render-*` | `planFile` 宿主读入，brief 从 `slices[i].brief` 取；`briefFile` 仅兼容（不一致报错） |
| `sliceId` | `slice`、`brief`、`review`、`render-*` | 本片 id |
| `impl` | `review`、`render-fix` | 上一轮 tasker 的结构化 JSON |
| `findings`/`round`/`userFeedback` | `review`、`render-fix` | `round≥1`；`round=1` 可空串，之后必填 |
| `patchPath`/`docPath`/`preflight` | `review` | 路径须在 `outDir` 下；`preflight` 为预检结果 |
| `reviewScope` / `renderReview` / `codeReview` | `review` | `auto`（默认）/ `full` / `incremental`；`renderReview:true` 只出任务书；`codeReview:<json>` 只消费子智能体结果（互斥） |
| `runContext` | `brief`、`review`、`render-*` | 上一调用返回值，原样回传；冲突报错 |
| `workspace`/`outDir`/`taskName`/`repoRoot`、`maxFixRounds`/`stages`/`maxSlices`、`dryRun`/`run_in_background` | 全部 | 覆盖注入配置（`null` 视为未给）；`dryRun` 只回 args 与脚本指纹 |

`roles`/`modules`/`reviewStandardPath`/`reasoningEfforts` 由宿主注入，**不要传，传了会被拒绝**。

**机械预检**（③→⑤、⑥→⑦ 之间由 Lead 执行，不过不进审查）：`git apply --check`、`--reverse`、`git diff --check`；仓库不是 git 时用备份哈希 + 文件清单核对。

## 结果解读

- 汇报必须引用工具结果的 `routes`（每阶段实际 role 与 provider/model）与 `scriptId`，不得凭记忆；`reviewStandardConfirmed` 一并报。
- `review`：`deliver` 无 🔴；`send-fix` 有残留 🔴 走 ⑥；`review-again` 审查 agent 失败查子会话；`fixExhausted=true` 时 `nextAction='ask-user'`，把残余 🔴 报用户，不静默继续。`category="over-fix"` 的 finding 属硬门禁：必须最小化修复或用户明确豁免，不能只记"接受理由"。`renderReview:true` 返回任务书（`prompt`/`sha12`/`reasoningEffort`）并生成审查包；子智能体写 `payload.json` 后只回 `{"reviewPath":…}`，`codeReview:{reviewPath}` 由宿主读文件、写 canonical，不派 agent。
- 批处理：`plan-only` → `{ plan, routes, … }`（默认只跑 design，无 planReview）；`slice` → 含 `patchPath`/`docPath`/`redCount`/`fixRounds`/`reverted` 等。`reverted` 异常时加载 `slice-workspace-recovery`。
- 批处理 `slice` 的 `brief` 步骤不派 agent：从 `plan.json` 的 `slices[i].brief` 投影；缺失时返回 `ok:false, stage:'brief'`，提示主会话先补 brief，**不要**回退到旧流程重跑。
- `review` 附带 `reviewScope`（实际范围）、`upgradeReason`（升级原因）、`previousFindings`（round>=2 逐条状态）；round>=2 的 `reviewAlignment=null` 属正常（对账式复审不再有盲审段），不得当作"未盲审"问题。round=1 仍看 `reviewAlignment` 与 `blindFindings`/`withdrawn`：`blindFindingCount=null` 或 `unlabeled>0` 必须说明。`reviewPackage.skipped=true` 时说明原因——本次回退为按路径读取；包落在 `<outDir>/reviews/<sliceId>-package-r<round>.md`（`docMode=trimmed` 表示薄文档只含 1–3 节），round 结果落在 `<sliceId>-review-r<round>.json`，reviewer 的传输文件是 `<sliceId>-review-r<round>.payload.json`（不是 canonical）。
- `reviewStandardConfirmed=false`（含 `ok:false, stage:'design'`）：子代理读到的规范路径与配置不一致，**必须说明**；`null` 表示未确认。主会话职责：机械预检、审查报告落盘、闭环时同步主计划与索引。

## 手工内联回退

仅在工具不可用或用户明确要求时使用：

1. 注入块缺失且用户要求无注入继续时：从本 Skill 的 `<skill_resources>` Base directory 读 `pipeline.yml`/`model-roles.example.yml`/`slice-pipeline.js`（绝不按 cwd）；读不到就报告确切路径，**禁止 find /** 或扫描盘符。
2. `read` 注入块「workflow 脚本」行的绝对路径，内容原样作为 `workflow` 工具的 `script` 传入；**禁止改写、简化或重排脚本**。
3. `args` = 注入 JSON + 运行参数；审查规范由子代理按绝对路径读取，不要读内容再传 `args.reviewStandard`。

## 依赖报错

脚本在首次 `agent()` 前抛 `required plugin modules are unavailable`，逐条列模块、阶段与原因（`disabled`/`missingDoc <路径>`/`not provided`）。**不得绕过**：引导用户启用模块或修正路径，或经同意后用 `stages` 移除对应阶段并说明；可先 `dryRun` 看 args。
