# 外部 Claude CLI 已知问题与 workaround

> 适用：`externalAgents.designer/reviewer` 通过 `external_agent_run` 调用本机 Claude Code CLI 时的环境问题。
> 这里只记录现场事实和可回退操作；不要把本文件当成模型能力或 DSH 路由的通用说明。

## 2026-11-18 opus 长时间无首事件 / 50 分钟超时

### 现场症状

- `external_agent_run` 已经启动 `claude.exe`，进程存活并连接到 `tc-paperhub` 网关；
- CLI 已发出 `system init`，侧边栏能看到：
  ```json
  {"t":"phase","phase":"starting","label":"启动 Claude","model":"claude-opus-5-5"}
  ```
- 但之后没有 assistant / tool / stream 事件，面板长时间停在“启动中”；
- 测试会话报告上游原始错误：
  ```text
  ValidationException: "thinking.type.enabled" is not supported for this model.
  Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
  ```
- 报告称 CLI 在 `CLAUDE_CODE_EFFORT_LEVEL=max` 下发送旧版
  `thinking={type:"enabled",budget_tokens:N}`，Bedrock 返回 400，CLI 重试到
  `API_TIMEOUT_MS`，表面表现为“一个事件都不吐”。

### 现场检查结果

- 本机 `~/.claude/settings.json` 的 `env` 确实发生过以下变化：
  - 备份：`C:\Users\songtao\.claude\settings.json.bak-20261118-120924`
  - 备份中有 `CLAUDE_CODE_EFFORT_LEVEL=max`，没有 `MAX_THINKING_TOKENS`
  - 当前有 `MAX_THINKING_TOKENS=0`，没有 `CLAUDE_CODE_EFFORT_LEVEL`
- 备份与当前文件的 env 差异仅这两项（其余 env 相同）；
- 在 `.claude`、DSH session、job 事件文件中**没有检索到该 ValidationException 原文**，因此它是测试会话中的上游报告，不是本机持久日志。
- 用备份 settings 建临时配置目录、复跑一个很小的 schema 请求：
  - 仍然成功，`structured_output={"ok":true}`，约 8 秒，`thinking_tokens=106`；
  - 所以“旧配置对所有请求必然 400”在本机没有被简单复现；大任务/长请求触发该问题的条件仍待保留现场复现。
- 当前 settings 下外部 agent 已能跑 design/review，因此把这次变更按“现场 workaround”记录，而不是已完全证实的唯一根因。

### workaround

当前 settings：

```json
"env": {
  "MAX_THINKING_TOKENS": "0"
}
```

并删除：

```json
"CLAUDE_CODE_EFFORT_LEVEL": "max"
```

回退：

```powershell
Copy-Item 'C:\Users\songtao\.claude\settings.json.bak-20261118-120924' 'C:\Users\songtao\.claude\settings.json' -Force
```

### 相关使用约定

- 外部 CLI 的 model 用 `opus`（native alias），不要传 `paper-anthropic/claude-opus-5-5`；后者不是 CLI 模型名，会得到 “There's an issue with the selected model”。
- 大设计建议显式传：
  ```json
  {
    "model": "opus",
    "maxTurns": 200,
    "timeoutMs": 3600000,
    "firstResponseTimeoutMs": 1800000,
    "showThinking": true
  }
  ```
- 当前 workaround 的 `MAX_THINKING_TOKENS=0` **会关闭 thinking**：侧边栏只剩工具调用，没有思考块或 thinking tokens，这是预期行为，不是丢事件。
- `showThinking` 只能展示上游返回的 thinking 文本；本机 raw stream 曾出现
  `thinking` 块正文为空、只有 `signature_delta` 的情况，此时只能显示
  `thinking_tokens` 计数，不能伪造思考内容。
- 排查时优先保存：
  - `<DSH_HOME>/slice-pipeline/claude-events/<jobId>.ndjson`（宿主写出的原始事件）；
  - Claude CLI 的 stderr；
  - `~/.claude/settings.json` 与备份的 diff。

## 官方文档补充：Opus 5.5 的 thinking / effort

依据：
- https://code.claude.com/docs/en/model-config.md#extended-thinking
- https://code.claude.com/docs/en/model-config.md#adjust-effort-level
- https://code.claude.com/docs/en/settings-reference.md#showthinkingsummaries

关键点：

- Opus 5.5 使用 **adaptive reasoning**，由 **effort level** 控制思考量；默认 `medium`。
- Opus 5.5 **不能关闭 thinking**；`MAX_THINKING_TOKENS=0` 对它无效。
- 默认 `showThinkingSummaries=false`，Anthropic API 会 **redact thinking blocks**，界面只显示折叠 stub；要看到完整 thinking summary，需设置：
  ```json
  "showThinkingSummaries": true
  ```
- effort 的优先级（官方顺序）：
  1. `CLAUDE_CODE_EFFORT_LEVEL`
  2. 会话内 `/effort` 或 `/model` picker
  3. `--effort`
  4. `modelSettings` 中的 per-model `effortLevel` 或顶层 `effortLevel`
  5. 模型默认 effort
- Opus 5.5 的顶层 `effortLevel` 不生效，应使用 `modelSettings["claude-opus-5-5"].effortLevel` 或环境变量。
- `max` 是最深级别，但容易 overthinking；官方建议按任务测试后采用。
- `MAX_THINKING_TOKENS` 只适用于旧的固定预算模型（如 Opus 4.6/Sonnet 4.6，配合 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`），不适用于 Opus 5.5。

推荐配置（用户级 `~/.claude/settings.json`）：

```json
{
  "showThinkingSummaries": true,
  "modelSettings": {
    "claude-opus-5-5": {
      "effortLevel": "xhigh"
    }
  }
}
```

或使用环境变量覆盖：

```json
"env": {
  "CLAUDE_CODE_EFFORT_LEVEL": "xhigh"
}
```

注意：`CLAUDE_CODE_EFFORT_LEVEL` 优先于 settings；两者不要同时设成不同值。

## 插件 dispatch 参数

`external_agent_run` 现在支持：

```json
{
  "effortLevel": "xhigh",
  "showThinkingSummaries": true
}
```

- `effortLevel`：映射到 Claude Agent SDK `effort`，取值 `low/medium/high/xhigh/max`；省略时用 native settings 或模型默认。
- `showThinkingSummaries`：默认 `true`，映射到 SDK `settings.showThinkingSummaries`；这是官方 `showThinkingSummaries` 设置，不是伪造 thinking。
- 插件设置页也可配置默认的“外部 CLI effort”和“显示 thinking summaries”。
