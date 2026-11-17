/**
 * 审查包（review package）：把 reviewer 需要的东西打包成一个文件。
 *
 * 目的：reviewer 只 read 一个文件、不跑 git 命令、不无目标地爬代码库——这是
 * 审查环节 token 与耗时的主要来源。方法参照 superpowers 的 scripts/review-package，
 * 但我们的交付物是 raw patch + 副本树，没有 commit 区间，所以统计量直接从 patch 解析。
 */

/** 超过这个字符数就不再内联 patch / 薄文档正文，退化为索引模式。 */
export const MAX_PACKAGE_CHARS = 900_000

const FENCE = '~~~'

/**
 * 从 unified diff 里数出文件清单与增删行。
 * 不认识的行（index/---/+++/mode 等元信息）直接跳过。
 */
export function parsePatchStats(text) {
  const files = []
  let current = null
  let hunks = 0
  let added = 0
  let removed = 0

  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      const path = match ? match[2] : line.slice('diff --git '.length).trim()
      current = { path, hunks: 0, added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (line.startsWith('@@')) {
      hunks += 1
      if (current) current.hunks += 1
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      added += 1
      if (current) current.added += 1
      continue
    }
    if (line.startsWith('-')) {
      removed += 1
      if (current) current.removed += 1
    }
  }

  return { files, hunks, added, removed }
}

/** 本片定义里对审查有意义的部分（讨论记录是门禁输入，brief/research 是执行细节，均不进审查包）。 */
function sliceForReview(slice) {
  const copy = {}
  Object.keys(slice ?? {}).forEach((key) => {
    if (key !== 'discussion' && key !== 'brief' && key !== 'research') copy[key] = slice[key]
  })
  return copy
}

function fenced(label, body) {
  return [`${FENCE}${label}`, String(body ?? ''), FENCE].join('\n')
}

/**
 * 薄文档只把 1–3 节发给 reviewer：验证记录、审查处置、变更历史都是实现方自述，
 * 既费 token 又会锚定审查结论。找不到完整的 1–4 编号节时退回全文，不丢信息。
 * @returns {{ text: string, mode: 'trimmed' | 'full', reason?: string }}
 */
export function extractThinDocForReview(docText) {
  const text = String(docText ?? '')
  const start = /^##\s*1\s*[.、．]\s*/m.exec(text)
  const end = /^##\s*4\s*[.、．]\s*/m.exec(text)
  if (start === null || end === null || end.index <= start.index) {
    return { text, mode: 'full', reason: '未找到完整的 1–4 编号节' }
  }
  return { text: text.slice(start.index, end.index).trim(), mode: 'trimmed' }
}

/**
 * 渲染审查包正文。纯函数：调用方负责读写文件。
 * `mode = 'full'` 内联 patch 与薄文档；`'index-only'` 只给统计与清单。
 */
export function renderReviewPackage({
  slice,
  round,
  generatedAt,
  preflight,
  userFeedback,
  stats,
  patchPath,
  docPath,
  patchText,
  docText,
  docMode = 'full',
  docModeReason = '',
  mode = 'full'
}) {
  const lines = []
  const fileName = (slice && slice.id) ? slice.id : 'slice'
  lines.push(`# 审查包：${fileName} 第 ${round} 轮`)
  lines.push('')
  lines.push('> 这是一个自包含的审查输入。先读这个文件，**不要重跑 git 命令**，')
  lines.push('> 也不要为了"多看看"去爬代码库：包里的上下文行就是你需要的改动视图。')
  lines.push('')
  lines.push(`- 生成时间：${generatedAt}`)
  lines.push(`- patch：${patchPath}`)
  lines.push(`- 薄文档：${docPath}`)
  lines.push(`- 规模：${stats.files.length} 个文件 / ${stats.hunks} 个 hunk / +${stats.added} / -${stats.removed}`)
  lines.push(`- 打包模式：${mode === 'full' ? 'full（内联 patch 与薄文档）' : 'index-only（patch 过大，只给清单与统计）'}`)
  lines.push('')
  lines.push('## 1. 允许改动范围与验收标准')
  lines.push('')
  lines.push(fenced('json', JSON.stringify(sliceForReview(slice), null, 2)))
  lines.push('')
  lines.push('## 2. 机械预检结果（Lead 提供，仅作线索，不替代实际读 patch）')
  lines.push('')
  lines.push(typeof preflight === 'string' ? preflight : fenced('json', JSON.stringify(preflight, null, 2)))
  lines.push('')
  lines.push('## 3. 用户对上一轮 patch 的意见')
  lines.push('')
  lines.push((typeof userFeedback === 'string' && userFeedback !== '') ? userFeedback : '（本轮无用户意见）')
  lines.push('')
  lines.push('## 4. 改动文件与规模')
  lines.push('')
  if (stats.files.length === 0) {
    lines.push('（patch 里没有解析出 diff --git 段：确认传的是 unified diff 而不是空文件）')
  } else {
    lines.push('| 文件 | hunks | 新增 | 删除 |')
    lines.push('| :--- | ---: | ---: | ---: |')
    stats.files.forEach((file) => {
      lines.push(`| \`${file.path}\` | ${file.hunks} | +${file.added} | -${file.removed} |`)
    })
  }
  lines.push('')

  if (mode === 'full') {
    lines.push('## 5. patch 全文')
    lines.push('')
    lines.push(fenced('diff', patchText))
    lines.push('')
    lines.push(docMode === 'trimmed'
      ? '## 6. 薄文档（仅第 1–3 节）'
      : '## 6. 薄文档全文')
    lines.push('')
    if (docMode === 'trimmed') {
      lines.push('> 验证记录、审查处置摘要、变更历史与自评不发给审查者；需要时可按 docPath 读取，但不作为结论依据。')
      lines.push('')
    } else {
      lines.push(`> 薄文档没有完整的 1–4 编号节（${docModeReason || '未匹配'}），退回全文；自评与验证记录不作为结论依据。`)
      lines.push('')
    }
    lines.push(fenced('markdown', (typeof docText === 'string' && docText !== '') ? docText : '（薄文档为空）'))
    lines.push('')
  } else {
    lines.push('## 5. patch 与薄文档未内联')
    lines.push('')
    lines.push(`patch 正文超过打包上限（${MAX_PACKAGE_CHARS} 字符）。按上面的文件清单分段 read 上面的 patch 路径；`)
    lines.push('核对行号时以 post-image 副本树为准，不要按 patch 行号引用。')
    lines.push('')
  }

  lines.push('## 7. 审查范围纪律')
  lines.push('')
  lines.push('- 非「具名风险」不得检索包外代码；每个具名风险只做**一次**定向核实，并在结论里写明查了什么、得到什么。')
  lines.push('- 不要为复核实现者报告而重跑测试套件；只有读代码产生具体疑问时，才跑一次针对性测试并写明疑问与结果。')
  lines.push('- 实现者的自述（含 verifyResult、设计理由）是未经验证的主张，不降低任何 finding 的等级。')
  lines.push('- 审查对这个 checkout 是只读的：不要改动工作树 / index / HEAD；需要别的工作副本时用一次性临时目录。')
  lines.push('- 不要派子代理去分段审查或找第二意见；diff 太长就自己分遍读，并在报告里说明。')
  lines.push('')

  return lines.join('\n')
}

/**
 * 聚焦复审包（round>=2）：只给「上一轮 findings + 本轮修复增量 + 变更符号/文件」，
 * 不内联全量 patch（全量 patch 只给路径，供定位）。
 */
export function renderFocusedReviewPackage({
  slice,
  round,
  previousReview,
  deltaText,
  deltaPath,
  changedSymbols,
  files,
  scopeWarning,
  preflight,
  userFeedback,
  patchPath,
  upgradeReason
}) {
  const lines = []
  lines.push(`# 聚焦复审包：${(slice && slice.id) ? slice.id : 'slice'} 第 ${round} 轮`)
  lines.push('')
  lines.push('> 这是一次**对账式复审**：只核对上一轮问题是否修好、审本轮修复增量、核调用链影响面。')
  lines.push('> 不要重读全量 patch；全量 patch 只用于定位行号。')
  lines.push('')
  lines.push(`- 全量 patch（仅定位）：${patchPath}`)
  lines.push(`- 本轮修复增量：${deltaPath}`)
  if (upgradeReason) lines.push(`- 升级说明：${upgradeReason}`)
  lines.push(`- 变更符号：${(changedSymbols && changedSymbols.length) ? changedSymbols.join('、') : '（未提供）'}`)
  lines.push('')
  lines.push('## 1. 上一轮 findings（逐条对账）')
  lines.push('')
  const previousFindings = (previousReview && previousReview.codeReview && Array.isArray(previousReview.codeReview.findings))
    ? previousReview.codeReview.findings
    : []
  if (previousFindings.length === 0) {
    lines.push('（上一轮没有 findings；本轮仍只审增量与调用链影响面）')
  } else {
    lines.push('| 严重程度 | 文件:行 | 问题 |')
    lines.push('| :--- | :--- | :--- |')
    previousFindings.forEach((finding) => {
      const location = `${finding.file || 'N/A'}${finding.line ? ':' + finding.line : ''}`
      lines.push(`| ${finding.severity || '?'} | \`${location}\` | ${finding.issue || ''} |`)
    })
  }
  lines.push('')
  lines.push('## 2. 本轮修复增量（delta 全文）')
  lines.push('')
  lines.push(fenced('diff', deltaText || '（delta 为空：材料不足，不能声称已审过修复）'))
  lines.push('')
  lines.push('## 3. 变更文件')
  lines.push('')
  if (Array.isArray(files) && files.length > 0) {
    files.forEach((file) => lines.push(`- \`${file}\``))
  } else {
    lines.push('（未提供）')
  }
  lines.push('')
  lines.push('## 4. 机械预检结果（Lead 提供，仅作线索）')
  lines.push('')
  lines.push(typeof preflight === 'string' ? preflight : fenced('json', JSON.stringify(preflight, null, 2)))
  lines.push('')
  lines.push('## 5. 用户对上一轮 patch 的意见')
  lines.push('')
  lines.push((typeof userFeedback === 'string' && userFeedback !== '') ? userFeedback : '（本轮无用户意见）')
  lines.push('')
  if (typeof scopeWarning === 'string' && scopeWarning !== '') {
    lines.push('## 6. 范围提醒')
    lines.push('')
    lines.push(scopeWarning)
    lines.push('')
  }
  lines.push('## 7. 审查范围纪律')
  lines.push('')
  lines.push('- 只审：上一轮 findings 的对账、delta 本身、以及 delta 触及符号的调用链影响面。')
  lines.push('- 每个变更符号做一次 codegraph `impact`/`callers` 定向核实，结论写清查了什么、得到什么。')
  lines.push('- 影响调用点过多或涉及公共契约/共享布局时，写进 unverifiable 并建议升级全量，不要局部放行。')
  lines.push('- 不重复报上一轮已解决/已接受的问题；新问题必须给证据（代码位置或命令输出）。')
  lines.push('- 审查对当前 checkout 只读：不改工作树 / index / HEAD。')
  lines.push('')
  return lines.join('\n')
}
