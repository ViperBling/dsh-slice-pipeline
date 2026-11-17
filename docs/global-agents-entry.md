# AGENTS.md — DSH 全局轻量入口

本文件会注入每个会话，只保留跨任务必需的规则。详细规范在 `dsh-slice-pipeline` 插件的 Skill 和 `docs/` 中，按任务加载。模块被禁用时，对应 Skill 不会出现；这时按通用最佳实践执行，并告知用户。

## 1. 优先级
系统与工具的硬约束 > 用户当次的明确指令 > 项目 `AGENTS.md` / `CLAUDE.md` > 本文件与插件规范（默认值）。

## 2. 工具调用
- 调用 pwsh、bash 或文件工具时，不携带 `sandbox_permissions` 和 `justification`：既不出现，也不填 `null`。
- 检索代码结构和符号时优先用 codegraph CLI，grep 只用于字面量文本。命令细则见 `slice-review`。
- 已知资源按 Skill 注入的确切路径读取。读不到就报告该路径，禁止 `find /` 或扫描盘符。

## 3. 按任务加载 Skill
| 任务 | Skill |
| :--- | :--- |
| 方案制定或代码设计（先用 brainstorming）、长线或多 Slice 规划、写 Slice brief | `slice-planning` |
| 写代码、产出或修复 patch、写薄文档 | `slice-patch-delivery` |
| 在原仓库验证前记录基线、验证后回退 | `slice-workspace-recovery` |
| 代码、Diff、设计或计划审查，派发审查 | `slice-review` |
| 设计、计划或分析文档配图 | `slice-diagrams` |
| 按 Slice 运行 workflow（先出计划、做第 N 片） | `slice-pipeline` |

## 4. 默认偏好
- 默认交付 raw patch 加薄文档，不直接改用户工作区；用户明确要求时才落盘；不覆盖、不丢弃用户已有的改动。
- 如实报告验证情况：没有编译或运行就写“未验证”，不得声称已通过。
- 方案经用户确认后再实施；下一片只由用户触发（planReview/briefReview 已归档，评审按需人工派发）。
- 闭环时立即同步主计划和索引；compact 之前先把工作状态落盘。
- 模型：遵循用户点名和插件角色表。Opus（`claude-opus-5-5`，max）只审查、不写代码；GPT 审查用 xhigh；不得静默换模型或降档。
- 结构图用 Mermaid：围栏首行必须是图类型关键字，不用 `graph`、`%%{init}%%` 或 frontmatter。禁止 ASCII 画框，ASCII 只用于 UI 草图和清单。
