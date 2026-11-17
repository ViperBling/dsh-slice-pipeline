---
name: slice-planning
description: 规划与切片：方案先行（衔接 brainstorming）、长线分段、Slice brief 产出要点
whenToUse: 制定方案或做代码设计、长线或多模块开发、拆分 Slice、写 brief 时加载
---

# slice-planning —— 规划与切片

## 何时使用 / 不负责

- 用于：方案制定或代码设计、长线开发或多 Slice 规划、写 Slice brief。
- 不负责：写实现代码、产出 patch；不负责给出审查结论。
- 不替代 `/brainstorming`：方案先行仍先走 brainstorming 反问澄清，本 Skill 只负责衔接与落计划。

## 入口步骤

1. 读取正文末尾 `## 当前模块配置` 中本模块规范的绝对路径（注入块「规范文件」行），先 read 规范再动手。
2. 该路径标为「（缺失）」或读取失败时：报告该确切路径并询问用户，不自行补规则、不换别的文件。
3. 计划评审（`planReview`）与 brief 审查（`briefReview`）已归档：design 定稿后直接交用户确认，不再需要评审门禁。
4. **每个 Slice 开工前先与用户讨论本片方案**，结论写进主计划的 `slices[i].discussion`（`openQuestions` 清空、`userConfirmed: true`）；用户明说不用讨论时写 `waiver.quote` 原话。缺这条记录流水线会拒绝派发任务书。
5. brief 由主会话根据 design 输出的 `research` 写进 `plan.json` 的 `slices[i].brief`（`details` 必须含 `file:line` 与验证命令）；不单独起 brief agent、不重复调研。
6. 需要评审或配图时，按注入块中「相关模块」行给出的绝对路径加载 `slice-review` / `slice-diagrams`。
7. 派发子代理时，按注入块中「派发角色」行的 provider/model 路由；加载本 Skill 本身不切换当前会话模型。

## 与其他模块

- `slice-review`：代码审查与修复闭环复审；计划/设计评审已归档。
- `slice-diagrams`：计划或设计文档需要结构图、依赖图、流程图时。
- `slice-patch-delivery`：本模块产出 brief（主会话写），由它负责实现与交付。
- 只按注入的绝对路径读取；读不到就报告该路径，禁止 `find /` 或扫描盘符。
