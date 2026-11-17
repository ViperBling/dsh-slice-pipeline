# Slice Pipeline 本机人工派发约定

> 适用范围：用户点名模型、人工派发审查或核对 reasoning 档位；由 `slice-planning` / `slice-review` Skill 按需加载。
> 规范内容直接在本文件中维护；本文件不替代插件设置。

- 常规 Slice Pipeline 使用插件注入的 roles；本文件不替代插件设置。
- 用户明确点名模型优先于默认路由。发生冲突时报告，不以默认模型冒充指定模型。
- ID 与 provider 是否可用，以当前 DSH 配置为准；名字失效时不全盘搜索或静默换模型。

### 5.3 模型约定

本环境中用户说"Opus"时，默认对应配置中写入的模型 **`claude-opus-5-5`**。

派发"Opus 审查 / Opus 评审"等审查类任务时，若所用工具支持 provider/model 覆盖，应显式覆盖为 `claude-opus-5-5`，不得用默认子代理模型冒充 Opus。**Opus 仅用于审查并给出意见，不承担代码生成 / 修复验证任务；修复闭环（[审查派发规范「审查-修复闭环」](../review/review-dispatch.md)）中生成修复 Diff 与执行编译验证必须使用默认模型，不得覆盖为 `claude-opus-5-5`。**

审查任务默认按[审查派发规范「审查模型分层」](../review/review-dispatch.md)选择模型：高风险 Slice 或用户明确说"Opus 审查"才用 `claude-opus-5-5`；中/低风险用默认模型，按条件升级。不要每个 Slice 默认全量 Opus。

**审查派发的思考深度（用户要求）**：Opus（`claude-opus-5-5`）固定 `max`，GPT（`paper-openai` 的 `gpt-6.1-sol` ）固定 `xhigh`；派发时**只指定模型即可取到该档位**——档位来自路由默认值（`paper-anthropic.reasoning: max`、`paper-openai.reasoning: xhigh`），这两条默认值不得改低。**注意：指定模型＝换路由，会取消子代理对父会话 effort 的继承**（`preflightChildLlmRoute` 的 `!routeChanged` 前提），换模型后不要指望沿用父会话档位；需要显式传 `reasoning_effort` 的场景见下方条目。

- 用户明确说"Opus 审查 / 派发 Opus"时，忽略分档、全量 Opus；未指定时按[审查派发规范「审查模型分层」](../review/review-dispatch.md)执行，并在派发说明里写一句分档依据。
- 派发到这两个路由之外、或子代理模型选择已开启（`subagentModelSelectionPolicy` 非空）时，必须**显式传 `reasoning_effort`**（Opus→`max`、GPT→`xhigh`），不依赖默认值。

用户在后续更新该约定时会明确告知；收到更新后必须同步修改本条约定的模型标识。

**角色 → 模型、流程 → 阶段 的单一真源：`dsh-slice-pipeline` 插件设置。**

- 角色集合固定：`default`（兜底）、`designer`（设计 / 主计划 / brief）、`task`（实现）、`reviewer`（审查）。
- 在 dsh-tui `/settings` → Slice Pipeline，或 desktop/web 设置 → 插件 → Slice Pipeline 中配置；provider/model 选项来自 DSH 当前实际配置，不写死。
- skill 正文会注入当前配置；主会话首选调用 `slice_pipeline_run` 工具（只传运行参数，配置由宿主注入）；仅在该工具不可用、或用户明确要求时才手工内联注入的 args JSON 并调用 `workflow` 工具。workflow 脚本无 fs API，不要自己读旧配置文件。
- `agent()` **不支持 `effort`**；档位由所选 provider 路由的 `reasoning` 默认值决定。需要不同角色不同 effort 时，配置多个同端点、不同 `reasoning` 的 provider 路由，再让角色选择对应路由。
- 阶段→角色默认分工，可在设置的功能模块中调整：`designer`=design，`reviewer`=codeReview 与 fix 复审，`task`=implement/fix。`planReview` / `briefReview` 已归档不启用；brief 由主会话产出，不占角色。

## 工具能力与本机满档偏好

- 人工指定审查时，保留“Opus 只审查、max；GPT 审查 xhigh；未经同意不降档”的偏好。
- 原因：会话跑在 `danger-full-access` 预设（`approval: never`）下，而 `@deepseek-ai/dsh-sandbox` 的 `WIDER_MODES` 里没有 `danger-full-access` 这一档，所以**任何**提权取值都被拒（`sandbox escalation to "…" is not strictly wider than this call's current "danger-full-access" mode`）；填 `null` 又过不了本地 schema 校验（`must be a string`）。唯一合法写法就是省略这两个字段。
- 不给工具添加未支持的参数。workflow agent() 当前不接受 per-role effort；使用 provider 路由默认值并如实说明限制。只有当前工具明确支持该参数时才传入。
- 普通开发或问答不加载本文件；不复制 credentials 或 API 密钥。
