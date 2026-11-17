# Slice Pipeline 规划与切片规范

> 适用范围：方案制定或代码设计、长线或多 Slice 规划、写 Slice brief；由 `slice-planning` Skill 加载。
> 规范内容直接在本文件中维护；本规范不替代 brainstorming，只负责衔接。
> 2026-11-03：`planReview` / `briefReview` 归档不启用；`design` 直接交用户确认，brief 改由主会话产出（见本文「4. Slice brief」）。

## 1. 方案先行（brainstorming 优先）

**方案制定类任务**（技术选型、架构/API/数据库设计、给出实现方案/多种做法对比、重构方案等，即"需求已明确、但方案由 AI 决定"的场景）以及任何代码设计，**默认必须先调用 skill：`/brainstorming`**，通过苏格拉底式反问把目标、约束、成功标准、候选方案及其取舍理清，并让用户确认后再给出/实施方案。

**禁止跳过反问直接自行拍板方案或直接写代码**；brainstorming 完成后才进入评审、实现或 Diff 产出。设计评审标准仍按[审查运行时规范「十维审查清单」](../review/review-standard.md)与[审查派发规范「设计原则清单」](../review/review-dispatch.md)执行，代码交付流程仍按[补丁交付规范「3. 交付流程」](../patch-delivery/standard.md)执行。

## 2. 长线开发的分段策略

适用场景：一条主线、多个模块步骤、每个模块可能占满 DSH 上下文的长线开发任务。

**核心规则：跨模块边界 → 换新 Session；模块内部 → compact。记忆靠文档与 git，不靠模型上下文。**

1. **主线文档**：任务开始时先由主会话或项目明确指定主线计划路径（沿用项目已有路径；新任务默认 `<outDir>/plan.md`，结构化计划另存 `<outDir>/plan.json`），不按文件名搜索主计划，记录模块清单、依赖顺序、接口契约、状态、关键决策；同时维护一张 Slice 状态表（文档名 → 状态 → 基线 commit → 验证结果）。**计划定稿后进入实现**；接口契约与切片边界冻结，片内实现细节调整不重新评审。
2. **每模块一个新 Session**：开局只读四样——全局轻量入口、项目 `CLAUDE.md`/`AGENTS.md`、**主线计划中本模块对应小节（不是整份计划）**、本模块 `brief.md`/spec，然后开始实施。
3. **模块交接**：模块结束时按[补丁交付规范「3. 交付流程」](../patch-delivery/standard.md)与[薄文档模板](../patch-delivery/thin-document-template.md)产出三件套并**闭环立即同步主线计划状态表与决策日志**（不要留到人工落盘时），记录做了什么、改了哪些接口、验证命令与结果、遗留问题；这是跨模块记忆的唯一载体。
4. **模块内 compact 时机**：上下文将满或明显变慢时，先把工作状态落到文件（代码提交 / 写入），再执行 `/compact`；压缩后让模型重读本模块 spec 再继续。禁止在状态只存在于对话中时直接 compact。
5. **例外**：探索性 / 头脑风暴类、状态尚未落盘的工作，优先 compact 而不是换新 Session，避免丢失未落盘的思考链路。
6. **判据**：换新 Session 单轮 token 成本低、注意力集中；长 Session 输入成本近似 O(n²) 增长，上下文缓存省不到增长中的历史；compact 是有损压缩，不能作为跨模块记忆。

## 3. 计划与切片边界评审（已归档，不启用）

> 2026-11-03 起 `planReview` 与 `briefReview` 归档：`design` 输出直接交用户确认，不再强制计划评审；brief 由主会话产出，不送审。代码与 prompt 保留在 workflow 脚本里（`ARCHIVED_STAGES`），配置或 `stages` 覆盖里出现会被剔除并告警。**重新启用**：从 `ARCHIVED_STAGES` 移除、恢复默认阶段表与本文原评审流程。

用户主动要求时仍可人工派发一次计划评审（报告落盘 `<项目根目录>/AIOut/<任务名>/reviews/plan-review-<YYYYMMDD>.md`），但它是可选项，不再是进入实现的必要条件。

## 4. Slice brief

**brief 由主会话根据设计结果产出（不派 agent）**：`design` 阶段已输出每片 `research`（受影响符号 `file:line`、涉及文件、禁改区、验证命令）；用户确认设计后，主会话把 brief 写进 `plan.json` 的 `slices[i].brief`，字段 `{sliceId, architecture, details, openQuestions?}`：

- `architecture`（≤1 页）：本片改动落在哪些模块、依赖方向、接口/契约增量、被拒绝的替代方案；
- `details`：受影响符号的 `file:line`、禁改区、验证命令、验收标准——**必须含至少一个 `file:line` 与一条验证命令**，`render-implement` 会硬校验；
- brief 不再单独起调研：设计阶段的 `research` 是唯一代码调研来源，缺失或编造行号视为设计未完成，回到 `design` 补。

brief 是后续生成与审查模型的上下文入口；`briefReview` 已归档，brief 写完直接进实现。brief 文字按[产出文档语言规范](../shared/plain-language.md)写：先结论后依据、术语首次出现解释、不写流程黑话。

### 4.1 每片开头的讨论（不可跳过）

**每个 Slice 开工前，主会话必须先与用户把**本片**方案讨论透**——不是复用任务级那份 `discussionDigest`，而是针对本片的目标理解、边界、取舍、验收口径单独过一遍。讨论结论写进主计划文件的 `slices[i].discussion`：

```json
{
  "sliceId": "S2",
  "understanding": "本片解决什么、不解决什么",
  "decisions": [{ "topic": "写入范围", "decision": "只改 lib/x.js", "reason": "S2 边界内" }],
  "rejected": [{ "option": "顺手重构上游", "reason": "超出本片范围" }],
  "openQuestions": [],
  "userConfirmed": true
}
```

- **机械校验**：`render-implement` / `render-fix`（round=1）与批处理 `slice` 都会校验该字段——缺记录、`sliceId` 与本片不符、`userConfirmed != true`、无决策又无豁免 → 直接报错且不渲染任务书；`openQuestions` 非空 → 返回 `nextAction=ask-user`。
- **豁免**：用户明说本片不用讨论时写 `waiver: { "byUser": true, "quote": "用户原话" }`，原话照抄；豁免不等于可以自行拍板，仍受主计划接口契约与切片边界约束。
- **冲突回流**：主会话写 brief 时发现讨论结论与设计/代码现实冲突，必须交回用户；不得自行改方向或静默按旧结论实现。
- `discussion` 是门禁输入，不进各阶段 prompt 的「本片定义」JSON；本片决策由 brief 的 `architecture` 层体现。

### 4.2 brief 产出后的第一道检查

主会话写完 `slices[i].brief` 后，用 `render-implement` 渲染任务书；brief 缺字段、`sliceId` 不一致、`details` 缺 `file:line` 或验证命令都会在这里报错——修 brief 即可。`mode='brief'`（派 agent 写 brief）已从工具入口移除（脚本层仅保留手工内联兜底），不要回退重跑 agent，那会重复调研。

## 5. 与 slice-pipeline 的衔接

**执行方式（一次一片，用户触发）**：按 `slice-pipeline` skill 执行。skill 随 `dsh-slice-pipeline` 插件分发；主会话加载 skill 后，调用 `slice_pipeline_run` 工具（只传运行参数：mode、requirement 或 sliceId/plan 等），配置由宿主注入；仅当该工具不可用、或用户明确要求手工内联时，才读取注入的 args JSON 并调用 `workflow` 工具。默认：`mode='plan-only'` 只跑 `design`（计划评审已归档）；`mode='slice'` 跑 `brief（投影）` → `implement` → `codeReview` → `fix`。**是否开启下一个 Slice 严格由用户触发**——一次运行只处理一片。交互式方案讨论仍在主会话完成、不进 workflow；**每个 Slice 开工前先在主会话完成本片讨论（见「4.1 每片开头的讨论」）**；文档/主计划同步在主会话闭环时完成。写入与交付约束按[补丁交付规范「3. 交付流程」](../patch-delivery/standard.md)；单 Slice 内部严格串行。

加载规范不等于启动完整 workflow；单次小改动、独立审查不强制运行多 Slice 流水线。
