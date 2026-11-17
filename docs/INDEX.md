# dsh-slice-pipeline 文档索引

> 适用范围：定位本插件的 6 个 Skill、模块默认角色与规范文档；由主会话按需读取。
> 文档内容直接在各规范文件中维护；只按 Skill 注入的绝对路径读取，不按文件名搜索主计划或规范文件。

## 模块、Skill、默认角色与文档

| 模块键 | Skill | 默认角色 | 默认文档 |
| :--- | :--- | :--- | :--- |
| `pipeline` | `slice-pipeline` | 无（阶段角色由各模块角色决定） | `skills/slice-pipeline/slice-pipeline.js`（workflow 脚本）；会话入口是 `slice_pipeline_run` 工具，脚本由宿主读取 |
| `planning` | `slice-planning` | `designer` | `docs/planning/standard.md`；用户点名模型时另读 `docs/shared/dispatch-guide.md` |
| `patchDelivery` | `slice-patch-delivery` | `task` | `docs/patch-delivery/standard.md`、`docs/patch-delivery/thin-document-template.md` |
| `workspaceRecovery` | `slice-workspace-recovery` | `default` | `docs/workspace-recovery/standard.md` |
| `review` | `slice-review` | `reviewer` | `docs/review/review-standard.md`（运行时规范，reviewer 读取；顶层 `reviewStandard`）、`docs/review/review-dispatch.md`（派发与闭环，Lead 读取；顶层 `reviewDispatch`）；用户点名模型时另读 `docs/shared/dispatch-guide.md` |
| `diagrams` | `slice-diagrams` | `designer` | `docs/diagrams/standard.md` |

- 默认文档路径与 `lib/config.js` 的 `MODULE_DEFS` 一致；可在插件设置里覆盖，Skill 注入的是解析后的绝对路径。
- 共享规范：`docs/shared/plain-language.md`（产出文档语言：读者假设、先结论后依据、findings 三段式）；`docs/shared/dispatch-guide.md`（人工派发约定）。
- 2026-11-03：workflow 的 `planReview` / `briefReview` 已归档（代码保留、不启用），`brief` 改由主会话写入 `plan.json` 的 `slices[i].brief`；相关流程说明见规划规范与审查规范里的"归档"节。
- 只按注入的绝对路径读取（路径由 Skill 注入）；读不到时报告该路径，禁止 `find /` 或扫描盘符。
- `docs/global-agents-entry.md` 是用于重建或替换全局 `~/.dsh/AGENTS.md` 的入口模板，不由 Skill 正文加载。

## 旧 AGENTS.md 章节迁移表

| 旧章节 | 新位置 |
| :--- | :--- |
| §0 速览决策表 | 全局入口的“按任务加载 Skill”表，以及 `docs/INDEX.md` |
| §1.1 Diff 事实源与落盘顺序 | `docs/patch-delivery/standard.md` |
| §1.2 第 0 步（Slice brief） | `docs/planning/standard.md`，由 patch-delivery 引用 |
| §1.2 第 1、3、5–9 步 | `docs/patch-delivery/standard.md` |
| §1.2 第 2、4 步（验证场地、基线快照、回退） | `docs/workspace-recovery/standard.md` |
| §1.3 薄文档模板 | `docs/patch-delivery/thin-document-template.md` |
| §2.1–§2.4 审查派发 | `docs/review/review-dispatch.md` |
| §2.5 工具调用纪律 | `docs/review/review-dispatch.md` 2.5（行为）+ `docs/shared/dispatch-guide.md`（本机原因）+ 全局入口（字段禁令） |
| §3 审查标准 | `docs/review/review-standard.md`（十维与分级）+ `docs/review/review-dispatch.md`（设计原则与闭环） |
| §4 codegraph 约定 | `docs/review/review-standard.md`（权威），全局入口保留一句偏好 |
| §5.1 brainstorming 优先 | `docs/planning/standard.md`，复用 brainstorming Skill |
| §5.2 长线分段 | `docs/planning/standard.md` |
| §5.3 模型约定 | `docs/shared/dispatch-guide.md`，全局入口保留一句提醒 |
| §5.4 制图规范 | `docs/diagrams/standard.md`，全局入口保留一句 |
| §5.5 计划评审门禁（已归档，见规划规范「3. 计划与切片边界评审（已归档，不启用）」） | `docs/planning/standard.md` |
| §6 生效说明 | 全局入口保留一句；删除与 `~/.claude/CLAUDE.md` 同步的条款 |

- 迁移表只用于定位旧章节；新文档之间不再使用裸章节号引用。
