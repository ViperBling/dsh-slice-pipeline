# dsh-slice-pipeline

面向 **DeepSeek Harness (DSH)** 的可配置开发流水线插件。把一次开发拆成可回退的 Slice：方案 → brief → 实现 → 审查 → 修复 → 交付；一次只跑一片，下一片由用户触发。

## 六个 Skill

| Skill | 模块键 | 职责 |
| :--- | :--- | :--- |
| `slice-pipeline` | `pipeline` | 单 Slice workflow 调度；一次只跑一片 |
| `slice-planning` | `planning` | 方案先行、长线分段、Slice brief 要点 |
| `slice-patch-delivery` | `patchDelivery` | raw patch、编译验证、机械预检与薄文档 |
| `slice-workspace-recovery` | `workspaceRecovery` | 原仓库验证前记录基线、验证后安全回退 |
| `slice-review` | `review` | 审查、派发、十维清单与审查-修复闭环 |
| `slice-diagrams` | `diagrams` | 设计 / 计划 / 分析文档的 Mermaid 配图 |

```text
plan-only : design
slice     : brief（主会话投影）→ implement → codeReview → fix
```

- brief 由主会话从 design 的 `research` 提炼，写进 `plan.json` 的 `slices[i].brief`；`brief` 阶段不派 agent。
- 审查默认是 fresh `subagent` 盲审 + brief 对齐两段式；round>=2 默认只审上一轮 findings 与修复 delta。
- 交付物是 raw patch + 薄文档；代码审查通过才进入交付。

## 安装

```sh
# 本地目录
dsh plugin --profile web add C:\path\to\dsh-slice-pipeline

# GitHub
dsh plugin --profile web add github:<you>/dsh-slice-pipeline

# npm（发布后）
dsh plugin --profile web add dsh-slice-pipeline
```

`web`、`dsh-tui`、`headless` 与自定义 profile 用上面的 `dsh plugin`。`desktop` profile 的插件管理走 Desktop 内置命令/UI，npm CLI 会拒绝。

安装后重启 profile，并用 `dsh --profile web --dump-config` 确认组合层出现插件行。

卸载：

```sh
dsh plugin --profile web remove dsh-slice-pipeline
```

## 配置

角色固定为 `default` / `designer` / `task` / `reviewer`，provider/model 选项来自 DSH 当前实际配置。

| 角色 | 默认用于 |
| :--- | :--- |
| `default` | `workspaceRecovery` |
| `designer` | `planning`、`diagrams` |
| `task` | `patchDelivery`（实现 / 修复） |
| `reviewer` | `review`（代码审查与 fix 复审） |

### 设置入口

- **dsh-tui**：`/settings` → **Slice Pipeline**，按模块分页。
- **Desktop / Web**：**设置 → 插件 → Slice Pipeline**，按模块卡片展示。

每个模块可独立启用、指定派发角色与文档路径。`pipeline` 只有启用开关；`patchDelivery` 另有薄文档模板路径。

### 模块与默认文档

| 模块键 | Skill | 默认文档 / 脚本 |
| :--- | :--- | :--- |
| `pipeline` | `slice-pipeline` | `skills/slice-pipeline/slice-pipeline.js` |
| `planning` | `slice-planning` | `docs/planning/standard.md` |
| `patchDelivery` | `slice-patch-delivery` | `docs/patch-delivery/standard.md`、`docs/patch-delivery/thin-document-template.md` |
| `workspaceRecovery` | `slice-workspace-recovery` | `docs/workspace-recovery/standard.md` |
| `review` | `slice-review` | `reviewStandard` → `docs/review/review-standard.md`（reviewer 运行时）；`reviewDispatch` → `docs/review/review-dispatch.md`（Lead 派发/闭环） |
| `diagrams` | `slice-diagrams` | `docs/diagrams/standard.md` |

配置 schema 根键：`roles` / `stages` / `maxFixRounds` / `reviewStandard` / `reviewDispatch` / `reasoningEfforts` / `designProvenance` / `modules`。

- 设置页只保存路径，不显示或编辑规范内容；路径相对插件根目录或绝对路径均可。
- 关闭模块后对应 Skill 不再出现；被依赖模块关闭时，workflow 会在第一次 `agent()` 前报错。
- `designProvenance` 控制实现前的 design 溯源校验：`enforce`（默认）/ `warn` / `off`（旧任务兼容）。

### 生效方式

- 设置保存后，下一次 Skill 加载就会拿到新配置；workflow 脚本每次运行重新读取，不需要为改设置重启。
- 修改 `lib/` 或 `cordis.patch.yml` 后，需要完整重启 Desktop / dsh-tui。

## 使用

前置条件：目标 profile 启用 `workflow` 并加载 `workflowEngine`（`slice_pipeline_run` 工具据此注册）；已配置可用模型路由；`slice` 模式依赖 git。

1. 让模型使用 `slice-pipeline`，例如：`用 slice-pipeline，先出计划：<需求>`。
2. 模型调用 `slice_pipeline_run`；`plan-only` 返回计划、切片与每片 `research`。
3. 你确认计划后，主会话把 `designRef` 和 `slices[i].brief` 写进 `plan.json`，再说“做 S1”。
4. `slice` 模式校验 design 溯源后产出 patch、薄文档与审查结论；耗时较长时用 `run_in_background: true`。
5. 每片结束即停，等用户触发下一片；规范与模块路径见 `docs/INDEX.md`。

如果 Skill 正文没有注入配置，会回退读取 `skills/slice-pipeline/pipeline.yml` 与 `model-roles.example.yml` 并明确告知；回退模板不是配置真源。

## 迁移到新机器

1. 在新机器安装同一版本的 `dsh-slice-pipeline`。
2. 把 `docs/global-agents-entry.md` 复制为 `~/.dsh/AGENTS.md`（Windows：`C:\Users\<你>\.dsh\AGENTS.md`），作为全局轻量入口。
3. 重新配置四个角色的 provider/model；模型路由与机器相关，不能照搬。
4. 确认目标 profile 启用 `workflow`，重启 Desktop / dsh-tui 后再使用。

## 回滚

1. 用备份的 `lib/` 与 `skills/` 整体替换当前插件；从旧的 `plugin-0.2.0` 回滚时，先删除 0.3.0 新增的五个 Skill 目录。
2. 从备份恢复 `~/.dsh/AGENTS.md`，避免旧入口引用新 Skill。
3. 若 0.3.0 设置里把 `reviewStandard` 存成了 `docs/review/review-standard.md`，回滚后改回 `review-standard.md`（旧位置 / 别名）。
4. 完整重启 Desktop / dsh-tui。

## 包内结构

npm 包只包含 `package.json` 的 `files` 白名单；`test/`、`docs/superpowers/`、`AIOut/` 不进包。

```text
dsh-slice-pipeline/
├─ package.json
├─ cordis.patch.yml
├─ README.md / LICENSE
├─ lib/
│  ├─ index.js              # host 入口、配置注入、dsh-tui 设置
│  ├─ client.js             # Desktop / Web 设置页
│  ├─ config.js             # 配置 schema 与模块定义
│  ├─ paths.js              # 路径解析
│  ├─ inject.js             # Skill 正文注入
│  ├─ pipeline-tool.js      # slice_pipeline_run 工具
│  ├─ tool-schema.js        # 参数 / output schema 方言转换
│  ├─ skills.js             # Skill 发现与加载
│  └─ tui.js                # dsh-tui 设置分区
├─ skills/
│  ├─ slice-pipeline/       # workflow 脚本、回退模板、旧位置跳转
│  └─ 另外五个模块 Skill
└─ docs/
   ├─ INDEX.md
   ├─ global-agents-entry.md
   └─ planning/ patch-delivery/ workspace-recovery/ review/ diagrams/ shared/
```

`skills/slice-pipeline/review-standard.md` 是旧别名跳转，实际规范在 `docs/review/review-standard.md`。

## 版本要点

- **0.11**：审查规范按读者拆分；`renderReview` 生成审查包、薄文档只含 1–3 节；review prompt 不再泄漏 brief/research；render 路径写 `payload.json` 并只回 `reviewPath`；design 去掉制图规范并加输出预算。
- **0.10**：Lead 侧 `subagent` 审查；`reasoningEfforts` 可配置。
- **0.9**：`design.json` 与 `designRef` 溯源，brief 必须引用 research。
- **0.5–0.8**：两段式审查、审查包、每片讨论门禁、白话化、性能权重、增量复审。

## 说明

- host 侧依赖 `@deepseek-ai/schemastery`，注册 `slice_pipeline_run`；后台模式还需要 `@deepseek-ai/dsh-jobs` 与 `@deepseek-ai/dsh-tool-jobs`（缺失只影响后台模式）。
- 浏览器侧通过 DSH module loader 使用 `react` 与 DSH client services。
- 插件不改变 DSH `workflow` 工具的执行方式；它负责 Skill 打包、配置界面与配置注入。
