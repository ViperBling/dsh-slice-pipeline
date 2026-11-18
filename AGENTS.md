# AGENTS.md — dsh-slice-pipeline（项目级）

本文件只写本仓库特有的事实与约束；通用纪律见全局 `~/.dsh/AGENTS.md`，详细规范按任务从 `docs/INDEX.md` 定位。

## 1. 项目定位与流程适用范围

- 这是一个 **DSH 插件**，不是独立应用：host 侧注册 Skill provider、`slice_pipeline_run` / `external_agent_run` 工具与设置页路由；browser 侧提供 Desktop / Web 设置页与 BetterSidebar `Claude` 进度 tab。
- 按全局入口的「不适用」条款，**本仓库自身开发不走 slice-pipeline 流程**（它是被开发的插件，不是使用方）；直接实现 + 测试 + 如实报告验证情况。
- 交付物是插件包，只由 `package.json` 的 `files` 白名单决定；`test/`、`AIOut/`、`docs/superpowers/` 不进包。

## 2. 命令

| 用途 | 命令 |
| :--- | :--- |
| 全量测试 | `npm test`（= `node --test "test/**/*.test.js"`；基线 313 通过 / 0 失败，约 2–4s） |
| 单文件测试 | `node --test test/config.test.js` |
| 开发机加载插件 | `dsh plugin --profile web add <本目录>`，之后完整重启 Desktop / dsh-tui |
| 确认组合层 | `dsh --profile web --dump-config` |

- 没有 build、lint、typecheck 脚本；`engines.node >= 22.19.0`。
- 改 `lib/` 或 `cordis.patch.yml` 后必须完整重启 DSH；改插件设置不需要重启（下一次 Skill 加载即生效）；改 `docs/` 或 `SKILL.md` 后由下一次 Skill 加载 / 会话重读生效，不保证当前会话热更新。

## 3. 代码地图

| 路径 | 职责 |
| :--- | :--- |
| `lib/index.js` | host 入口：注册 Skill provider、两个工具、web 路由（`claude-models`、`claude-events`、`claude-events-list`）、tui 设置 seam |
| `lib/config.js` | 唯一配置真源：`ROLE_KEYS`、`MODULE_DEFS`、schemastery `Config`、`readConfig`（live / plain 投影） |
| `lib/skills.js` | 扫描 `skills/` 生成 provider（rank 550、source `custom`），把注入块追加到 `SKILL.md` 正文 |
| `lib/inject.js` | 渲染 pipeline args JSON 与模块配置块（注入内容的形状由此决定） |
| `lib/paths.js` | 文档路径解析：插件根相对 / 绝对 / `~/` / 旧别名回退 |
| `lib/pipeline-tool.js` | `slice_pipeline_run`：参数校验、输出 schema、design 溯源、后台 job、审查包接线 |
| `lib/review-package.js` | 审查包与薄文档抽取 |
| `lib/external-agent.js` | `external_agent_run` 工具 + NDJSON job 事件 |
| `lib/claude-sdk.js` | Claude Agent SDK 惰性安装与只读 one-shot runner |
| `lib/tool-schema.js` | 面向作者的 schema 方言 → 宿主规范 JSON Schema |
| `lib/client.js` | 浏览器设置页与进度 tab（`MODULES`、角色键、旧别名在浏览器侧各有一份副本） |
| `lib/tui.js` | dsh-tui 设置分区 |
| `skills/slice-pipeline/slice-pipeline.js` | 工作流脚本本体（stages、prompt、schema、门禁），由宿主读取后交给 `workflow` 引擎 |
| `docs/` | 注入给 Skill 的规范；`docs/INDEX.md` 是索引，`docs/global-agents-entry.md` 是全局入口模板 |

## 4. 运行时不变量

- 工作流脚本执行时只有全局 `args` / `agent` / `phase` / `log` / `pipeline` / `parallel`：**不能 import、不能用 fs/网络/定时器、不能直接读仓库文件**；数据必须经 `args` 传入，结果经返回值带出。测试用 `test/helpers/run-workflow.js` 以 `AsyncFunction` 模拟同一环境。
- 阶段：批处理 `plan-only` = `design`；`slice` = `brief → implement → codeReview → fix`。单阶段派发 `design` / `review` / `render-implement` / `render-fix`。`brief` 由主会话写进 `plan.json` 的 `slices[i].brief`，不派 agent。
- `plan.json` 必须带 `designRef` 且与 `design.json` 匹配（`designProvenance` 默认 `enforce`）；绕过 design 手写 brief 会被 `render-implement` 拒绝。
- 外部 Agent 严格只读：工具白名单只有 `Read`/`Grep`/`Glob`/`LS`/`NotebookRead`/`TodoWrite`，`Edit`/`Write` 被禁，bash 仅白名单命令；`settingSources: []`，不加载项目 `CLAUDE.md` / hooks。外部失败只报错，**不静默退回 DSH 路由**；批处理 `plan-only`/`slice` 遇到外部开关直接报错。
- 外部 Agent 的进度事件按 Session 隔离：写在 `<sessionDir>/slice-pipeline/claude-events/`；`claude-events` / `claude-events-list` 路由与删除都必须带 `sessionId` 并校验 sidecar，旧全局 `claude-events` 目录不再读取。
- patch 新增行禁止出现切片 id / 标题 / 序号（`slice-leak` 硬门禁）。
- 配置里的文档字段是**路径**不是内容；内容型取值会回退到默认文件并给 warning。
- `slice_pipeline_run` 只在 profile 启用 `workflow` 且加载 `workflowEngine` 时注册；缺失时插件仍加载、工具不出现（`pipelineToolStatus` 记录原因）。

## 5. 改动的连带更新

| 改动 | 必须同步 |
| :--- | :--- |
| `MODULE_KEYS` / `MODULE_DEFS` | `docs/INDEX.md` 模块表、`README.md` 模块表、`lib/client.js` 的 `MODULES` 副本、`test/config.test.js` 与 `test/client.test.js` |
| 配置 schema / 字段 | `lib/config.js`、`lib/client.js`、`lib/tui.js`、`lib/inject.js` 及对应 `test/config*`、`test/client*`、`test/tui*` |
| 版本号 | `package.json`、`test/package.test.js`（硬断言 `0.12.0`）、`README.md` 版本要点 |
| 规范文档内容 | `docs/INDEX.md`、`test/fixtures/rule-anchors.json` 的锚点、`package.json` 的 `files` |
| `docs/global-agents-entry.md` | ≤3500 bytes、覆盖六个 Skill、与用户 `~/.dsh/AGENTS.md` 保持一致 |
| `SKILL.md` | frontmatter 只允许 `name` / `description` / `whenToUse`；预算见下 |
| 新增或重命名 `skills/` 子目录 | 必须与六个模块一一对应；`skills/slice-pipeline/` 目录恰好 5 个运行时文件 |

## 6. 测试里的硬门禁（改文档前先看）

- `test/docs.test.js`：文档必须存在；除 `INDEX.md` 外禁止 `§`；相对 Markdown 链接必须能解析；`rule-anchors.json` 每条锚点必须仍在指定文档；`global-agents-entry.md` ≤3500 B 且点名六个 Skill；`review-standard.md` ≤12000 B 且保留「现象 / 建议」。
- `test/skills-files.test.js`：`skills/` 恰好六个目录；frontmatter 三键且值单行；`slice-pipeline/SKILL.md` ≤100 行、其余 ≤80 行；description+whenToUse 每个 ≤400 B、合计 ≤2400 B；注入块 pipeline ≤3500 B、模块 ≤15 行且 ≤1500 B；六个模块 `status: ok`。
- `test/package.test.js`：版本、描述、`scripts.test` 与 `files` 数组都是精确断言，改包结构要一起改。
- `test/stage-modes.test.js` 是最大的行为测试；改工作流阶段先跑它。

## 7. 代码风格与依赖

- ESM（`"type": "module"`）；运行时依赖只有 `@deepseek-ai/schemastery`，其余用 Node 内置模块；浏览器侧运行时使用 DSH client 包（由宿主提供）。默认不加依赖、不引入构建工具。
- 代码风格：无分号、2 空格缩进、单引号；导出函数写 JSDoc（英文）。
- 代码注释与 JSDoc 用英文；用户可见文案、prompt、`docs/` 与 `README` 用中文。文档按 `docs/shared/plain-language.md` 的读者假设写。

## 8. 工作区纪律

- 当前工作区有未提交的在途改动（外部 Agent / Claude SDK 相关）；不要 `git checkout --` / `git reset` / 覆盖未提交文件，也不要顺手重排无关代码。
- `AIOut/`、`docs/superpowers/`、`*.bak*` 被 `.gitignore` 忽略：`AIOut/` 是流水线默认输出目录与本地版本产物，不要提交。
- `skills/slice-pipeline/review-standard.md` 只是旧路径跳转（≤10 行），真实规范在 `docs/review/review-standard.md`。
- 检索符号优先 codegraph CLI（仓库内已有 `.codegraph/`），grep 只查字面量文本。
- 完成前跑 `npm test` 并如实写验证结论；没有运行就写「未验证」。