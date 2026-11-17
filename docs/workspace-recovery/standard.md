# Slice Pipeline 工作区恢复规范

> 适用范围：在原仓库验证前记录基线、验证后回退、核对工作区是否回到基线、workflow 的 `reverted` 异常；由 `slice-workspace-recovery` Skill 加载。
> 规范内容直接在本文件中维护；未经用户确认的破坏性清理不在此授权。

## 1. 验证场地与基线快照

- **大型仓库（如 UE 源码等引擎级仓库，拷贝 / `git worktree` 成本不可接受）→ 默认在原项目仓库内执行验证**，并按本文「2. 回退到基线」完整回退；
- 其余情况优先 **Scratch 副本**（临时拷贝 / `git worktree` / 临时目录中的项目副本），不触碰用户工作区；
- 在原仓库验证前，必须先记录基线：`git status --porcelain` 快照 **+ 内容级快照** `git diff > <任务名>-baseline.patch`、`git diff --cached > <任务名>-baseline-staged.patch`、`git ls-files --others --exclude-standard > <任务名>-baseline-untracked.txt`（只记名字/状态无法恢复内容）。

## 2. 回退到基线

**回退（仅原仓库验证时执行）**：恢复到验证前基线。**禁止无条件用 `git checkout -- .` 回退**——若开工前已存在未提交的**已跟踪**改动，它会被一并丢弃，而状态快照只能让你"发现"、无法恢复内容。按基线是否干净分两条路：
- **基线干净**（`git status --porcelain` 为空）：`git checkout -- .` 安全，按原流程执行；
- **基线不干净**：开工前先 `git stash push -u -m dsh-verify-baseline`（既有改动含未跟踪一并暂存，工作区回到 HEAD），此后按"基线干净"流程回退，最后 `git stash pop` 恢复既有改动；stash 不可用时，用本文「1. 验证场地与基线快照」记录的 baseline patch 逐份 `git apply` 恢复。

## 3. 写入范围

写入范围由 `args.workspace` 决定。**写入与交付约束（对齐 [补丁交付规范「3. 交付流程」](../patch-delivery/standard.md)）**：指定了工作区副本（`args.workspace`）时**只允许改副本、严禁触碰原工作区**，副本无需回退；未指定时允许在原仓库改，但**产出 patch 后必须回退到基线**（workflow 的实现 agent 自己记录基线；脏基线先 `git stash push -u -m dsh-verify-baseline`，见本文「2. 回退到基线」）。交付物**只有 patch 与薄文档**（写入 `outDir`，默认 `AIOut/<taskName>/`）；编译验证、机械预检（`git apply --check`）、审查报告落盘与主计划/索引同步仍在主会话按[补丁交付规范「3. 交付流程」](../patch-delivery/standard.md)完成。单 Slice 内部严格串行（brief → 设计审查 → 实现 → 代码审查，环环依赖），**无并发项**。

## 4. 核对与异常

无论哪条路：只清理**验证过程中新增**的未跟踪文件与构建产物（基线里不存在的），基线里已有的未跟踪文件一律保留；完成后用 `git status --porcelain` 与基线比对确认完全一致，并用 `git diff` 核对内容与 `baseline.patch` 一致。Scratch 副本无需回退，验证后弃用即可。

- `reverted` 异常或为空时（in-repo 模式），**先确认工作区已回到基线**再继续。
