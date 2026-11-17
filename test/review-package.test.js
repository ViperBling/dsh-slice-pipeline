import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePatchStats, extractThinDocForReview, renderFocusedReviewPackage, renderReviewPackage, MAX_PACKAGE_CHARS } from '../lib/review-package.js'
import { createPipelineTool } from '../lib/pipeline-tool.js'
import { readConfig } from '../lib/config.js'


const ROOT = fileURLToPath(new URL('../', import.meta.url))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const PATCH = [
  'diff --git a/lib/x.js b/lib/x.js',
  'index 111..222 100644',
  '--- a/lib/x.js',
  '+++ b/lib/x.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' module.exports = {}',
  'diff --git a/lib/y.js b/lib/y.js',
  '--- a/lib/y.js',
  '+++ b/lib/y.js',
  '@@ -10,2 +10,2 @@',
  '-old',
  '+new',
  ''
].join('\n')

const BRIEF = {
  sliceId: 'S1',
  architecture: '只在 lib/x.js 加一层缓存，不动上游',
  details: '受影响符号：lib/x.js:1；验证：exit 0；基线 commit abc1234'
}

const PLAN = {
  summary: 's',
  interfaceContract: 'c',
  slices: [{
    id: 'S1',
    title: 'T1',
    scope: '只改 lib/x.js',
    acceptance: 'npm test 退出码 0',
    brief: { ...BRIEF },
    research: {
      symbols: [{ name: 'cacheFn', file: 'lib/x.js', line: '1' }],
      files: ['lib/x.js'],
      forbidden: ['不要改上游模块'],
      verify: ['exit 0']
    },
    discussion: {
      sliceId: 'S1',
      understanding: '本片只落地 S1',
      decisions: [{ topic: '范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
      openQuestions: [],
      userConfirmed: true
    }
  }]
}

// ---------------------------------------------------------------------------
// 纯函数：解析与渲染
// ---------------------------------------------------------------------------
test('parsePatchStats counts files, hunks and changed lines', () => {
  const stats = parsePatchStats(PATCH)
  assert.equal(stats.files.length, 2)
  assert.deepEqual(stats.files[0], { path: 'lib/x.js', hunks: 1, added: 2, removed: 1 })
  assert.deepEqual(stats.files[1], { path: 'lib/y.js', hunks: 1, added: 1, removed: 1 })
  assert.equal(stats.hunks, 2)
  assert.equal(stats.added, 3)
  assert.equal(stats.removed, 2)
})

test('parsePatchStats tolerates an empty or non-diff body', () => {
  assert.deepEqual(parsePatchStats(''), { files: [], hunks: 0, added: 0, removed: 0 })
  assert.deepEqual(parsePatchStats(undefined), { files: [], hunks: 0, added: 0, removed: 0 })
})

test('extractThinDocForReview keeps only sections 1-3', () => {
  const doc = [
    '## 1. 目标与范围', '范围 A',
    '## 2. 接口与行为变更', '接口 B',
    '## 3. 关键设计说明', '设计 C',
    '## 4. 验证记录', '验证 D',
    '## 9. 审查处置摘要', '处置 E'
  ].join('\n')
  const trimmed = extractThinDocForReview(doc)
  assert.equal(trimmed.mode, 'trimmed')
  assert.ok(trimmed.text.includes('设计 C'))
  assert.equal(trimmed.text.includes('验证 D'), false)
  assert.equal(trimmed.text.includes('处置 E'), false)
})

test('extractThinDocForReview accepts 、 and ． numbering and falls back to the full doc', () => {
  const doc = '## 1、目标\nA\n## 2、接口\nB\n## 3、设计\nC\n## 4、验证\nD\n'
  const trimmed = extractThinDocForReview(doc)
  assert.equal(trimmed.mode, 'trimmed')
  assert.equal(trimmed.text.includes('D'), false)

  const custom = '# 自定义薄文档\n只有自评，没有编号节\n'
  const fallback = extractThinDocForReview(custom)
  assert.equal(fallback.mode, 'full')
  assert.equal(fallback.text, custom)
  assert.match(fallback.reason, /1–4/)
})

test('a trimmed package omits self-assessment and keeps the docPath', () => {
  const doc = '## 1. 目标与范围\n范围 A\n## 2. 接口与行为变更\n接口 B\n## 3. 关键设计说明\n设计 C\n## 4. 验证记录\n验证 D\n'
  const body = renderReviewPackage({
    slice: PLAN.slices[0], round: 1, generatedAt: '2026-10-26T00:00:00.000Z', preflight: 'ok',
    userFeedback: '', stats: parsePatchStats(PATCH), patchPath: 'C:/w/AIOut/t/S1.patch',
    docPath: 'C:/w/AIOut/t/S1.md', patchText: PATCH, docText: extractThinDocForReview(doc).text,
    docMode: 'trimmed', mode: 'full'
  })
  assert.ok(body.includes('## 6. 薄文档（仅第 1–3 节）'))
  assert.ok(body.includes('设计 C'))
  assert.equal(body.includes('验证 D'), false)
  assert.ok(body.includes('C:/w/AIOut/t/S1.md'))
})

test('review package carries the change, stats, [DONE] and the retrieval discipline', () => {
  const body = renderReviewPackage({
    slice: PLAN.slices[0],
    round: 2,
    generatedAt: '2026-10-26T00:00:00.000Z',
    preflight: 'git apply --check: exit 0',
    userFeedback: '请把缓存层放到 x.js',
    stats: parsePatchStats(PATCH),
    patchPath: 'C:/w/AIOut/t/S1.patch',
    docPath: 'C:/w/AIOut/t/S1.md',
    patchText: PATCH,
    docText: '# 薄文档\n验证记录：exit 0',
    mode: 'full'
  })
  for (const needle of [
    '# 审查包：S1 第 2 轮',
    '包里的上下文行就是你需要的改动视图',
    'npm test 退出码 0',
    'git apply --check: exit 0',
    '请把缓存层放到 x.js',
    'lib/x.js',
    '+2',
    'diff --git a/lib/x.js',
    '验证记录：exit 0',
    '非「具名风险」不得检索包外代码',
    '不要为复核实现者报告而重跑测试套件',
    '不要派子代理'
  ]) {
    assert.ok(body.includes(needle), `missing ${needle}`)
  }
  // 讨论记录是门禁输入，不进审查包
  assert.equal(body.includes('userConfirmed'), false)
})

test('an oversized package degrades to index-only instead of truncating silently', () => {
  const body = renderReviewPackage({
    slice: PLAN.slices[0],
    round: 1,
    generatedAt: '2026-10-26T00:00:00.000Z',
    preflight: 'ok',
    userFeedback: '',
    stats: parsePatchStats(PATCH),
    patchPath: 'C:/w/AIOut/t/S1.patch',
    docPath: 'C:/w/AIOut/t/S1.md',
    patchText: 'x'.repeat(MAX_PACKAGE_CHARS + 10),
    docText: '',
    mode: 'index-only'
  })
  assert.ok(body.includes('index-only'))
  assert.ok(body.includes('分段 read'))
  assert.equal(body.includes('x'.repeat(1000)), false)
})

// ---------------------------------------------------------------------------
// 宿主：review 模式自动落盘审查包，prompt 指向它
// ---------------------------------------------------------------------------
function engineDouble(responder) {
  const runs = []
  return {
    runs,
    start(request) {
      const calls = []
      const run = { id: 'run-' + (runs.length + 1), calls, cancel() {}, dispose: async () => {} }
      runs.push(run)
      const agent = async (prompt, opts = {}) => {
        calls.push({ prompt, opts })
        return responder(prompt, opts)
      }
      const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'pipeline', 'parallel', request.script)
      run.result = fn(request.args, agent, () => {}, () => {}, async () => {}, async () => {}).then(
        (value) => ({ stopReason: 'completed', agentsStarted: calls.length, value }),
        (error) => ({ stopReason: 'error', error: String(error?.message ?? error), agentsStarted: calls.length })
      )
      return run
    }
  }
}

const reviewer = () => ({
  verdict: 'pass',
  standardPath: 'C:/p/docs/review/standard',
  blindFindings: [],
  findings: []
})

function toolFor(engine) {
  return createPipelineTool({
    pluginRoot: ROOT,
    getConfig: () => readConfig({}),
    engine,
    jobs: undefined
  }).definition
}

test('review mode writes a review package under outDir/reviews and points the reviewer at it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const patchPath = join(outDir, 'S1.patch')
    const docPath = join(outDir, 'S1.md')
    const planFile = join(outDir, 'plan.json')
    const briefFile = join(outDir, 'brief.json')
    await mkdir(outDir, { recursive: true })
    await writeFile(patchPath, PATCH)
    await writeFile(docPath, '# 薄文档\n验证记录：exit 0')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify(BRIEF))

    const engine = engineDouble(reviewer)
    const definition = toolFor(engine)
    const out = await definition.execute({
      mode: 'review', planFile, briefFile, sliceId: 'S1',
      impl: { patchPath, docPath, verifyResult: 'exit 0' },
      patchPath, docPath, round: 1, userFeedback: '', preflight: 'git apply --check: exit 0',
      repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a1' } })

    assert.equal(out.result.ok, true)
    const pkg = out.result.reviewPackage
    assert.equal(pkg.mode, 'full')
    assert.equal(pkg.files, 2)
    assert.equal(pkg.hunks, 2)
    assert.equal(pkg.added, 3)
    assert.equal(pkg.removed, 2)
    assert.ok(pkg.path.startsWith(join(outDir, 'reviews')), pkg.path)

    const body = await readFile(pkg.path, 'utf8')
    assert.ok(body.includes('diff --git a/lib/x.js'), 'package must inline the patch')
    assert.ok(body.includes('验证记录：exit 0'), 'package must inline the thin doc')
    assert.equal(body.includes(BRIEF.architecture), false, 'the brief must stay out of the package')
    assert.equal(body.includes('cacheFn'), false, 'research symbols must stay out of the package')
    assert.equal(body.includes('不要改上游模块'), false, 'research forbidden zones must stay out of the package')

    const prompt = engine.runs[0].calls[0].prompt
    assert.ok(prompt.includes('## 审查包（唯一代码输入）'), 'reviewer must be pointed at the package')
    assert.ok(prompt.includes(pkg.path))
    assert.ok(prompt.includes('不要再逐个 read 改动文件'))
    assert.ok(prompt.includes('两段式审查'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable patch falls back to path-based review and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const planFile = join(outDir, 'plan.json')
    const briefFile = join(outDir, 'brief.json')
    await mkdir(outDir, { recursive: true })
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify(BRIEF))
    const missingPatch = join(outDir, 'missing.patch')

    const engine = engineDouble(reviewer)
    const definition = toolFor(engine)
    const out = await definition.execute({
      mode: 'review', planFile, briefFile, sliceId: 'S1',
      impl: { patchPath: missingPatch, docPath: join(outDir, 'S1.md'), verifyResult: 'exit 0' },
      patchPath: missingPatch, docPath: join(outDir, 'S1.md'), round: 1, userFeedback: '',
      preflight: 'exit 0', repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a1' } })

    assert.equal(out.result.reviewPackage.skipped, true)
    assert.match(out.result.reviewPackage.reason, /patchPath/)
    const prompt = engine.runs[0].calls[0].prompt
    assert.ok(prompt.includes('## 审查包未生成（退回按路径读取）'))
    assert.ok(prompt.includes('严格控制检索范围'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('batch slice review stays path-based (no package section)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const engine = engineDouble((prompt, opts) => {
      const label = String(opts.label || '')
      if (label.startsWith('brief')) return BRIEF
      if (label.startsWith('impl')) {
        return { sliceId: 'S1', patchPath: join(outDir, 'S1.patch'), docPath: join(outDir, 'S1.md'), verifyResult: 'exit 0' }
      }
      return { verdict: 'pass', findings: [], standardPath: 'C:/p/docs/review/standard' }
    })
    const definition = toolFor(engine)
    await definition.execute({
      mode: 'slice', sliceId: 'S1', plan: PLAN, repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a1' } })
    const review = engine.runs[0].calls.find((call) => call.opts.label === 'code-review:S1')
    assert.equal(review.prompt.includes('## 审查包'), false)
    assert.ok(review.prompt.includes('照常返回结果'))
    assert.equal(review.prompt.includes('reviewPath'), false)
    assert.ok(review.prompt.includes('不派子代理'), 'shared reviewer discipline still applies')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dryRun does not write a review package', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const patchPath = join(outDir, 'S1.patch')
    const planFile = join(outDir, 'plan.json')
    const briefFile = join(outDir, 'brief.json')
    await mkdir(outDir, { recursive: true })
    await writeFile(patchPath, PATCH)
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify(BRIEF))
    const engine = engineDouble(reviewer)
    const definition = toolFor(engine)
    const out = await definition.execute({
      mode: 'review', planFile, briefFile, sliceId: 'S1',
      impl: { patchPath, docPath: join(outDir, 'S1.md'), verifyResult: 'exit 0' },
      patchPath, docPath: join(outDir, 'S1.md'), round: 1, userFeedback: '',
      preflight: 'exit 0', dryRun: true, repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a1' } })
    assert.equal(out.kind, 'dry-run')
    assert.equal(out.args.reviewPackage, undefined)
    assert.equal(engine.runs.length, 0)
    const entries = await readdir(join(outDir, 'reviews')).catch(() => [])
    assert.deepEqual(entries, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 聚焦复审（round>=2）：包渲染 + 宿主落盘/读取/升级
// ---------------------------------------------------------------------------
const PATCH_DELTA = [
  'diff --git a/lib/x.js b/lib/x.js',
  '--- a/lib/x.js',
  '+++ b/lib/x.js',
  '@@ -1,2 +1,3 @@',
  ' const a = 1',
  '+const cache = 2',
  ' module.exports = {}',
  ''
].join('\n')

test('focused package carries previous findings, delta and changed symbols (no full patch)', () => {
  const body = renderFocusedReviewPackage({
    slice: PLAN.slices[0],
    round: 2,
    previousReview: {
      round: 1,
      codeReview: {
        verdict: 'revise',
        findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: '缓存未失效', fix: '加失效', evidence: 'e' }]
      }
    },
    deltaText: PATCH_DELTA,
    deltaPath: 'C:/w/AIOut/t/S1-fix-r1.patch',
    changedSymbols: ['cacheFn'],
    files: ['lib/x.js'],
    scopeWarning: '',
    preflight: 'git apply --check: exit 0',
    userFeedback: '修了缓存',
    patchPath: 'C:/w/AIOut/t/S1.patch'
  })
  for (const needle of [
    '# 聚焦复审包：S1 第 2 轮',
    '缓存未失效',
    '本轮修复增量',
    'diff --git a/lib/x.js',
    'cacheFn',
    'codegraph',
    '修了缓存'
  ]) {
    assert.ok(body.includes(needle), `missing ${needle}`)
  }
  assert.equal(body.includes('patched full text placeholder'), false)
  // 0.8.1：聚焦包不提供上一轮的修复建议原文（只给严重度/位置/问题）
  assert.equal(body.includes('加失效'), false)
})

test('round-2 review persists round-1 JSON and runs focused on the delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const patchPath = join(outDir, 'S1.patch')
    const docPath = join(outDir, 'S1.md')
    const planFile = join(outDir, 'plan.json')
    const briefFile = join(outDir, 'brief.json')
    const deltaPath = join(outDir, 'S1-fix-r1.patch')
    await mkdir(outDir, { recursive: true })
    await writeFile(patchPath, PATCH)
    await writeFile(docPath, '# 薄文档\n验证记录：exit 0')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify(BRIEF))
    await writeFile(deltaPath, PATCH_DELTA)

    const responder = (prompt) => {
      if (prompt.includes('对账式复审')) {
        return {
          verdict: 'pass',
          standardPath: 'C:/p/docs/review/standard',
          findings: [],
          previousFindings: [{
            issue: '缓存未失效', file: 'lib/x.js', line: '1', status: 'resolved', evidence: 'lib/x.js:1 已加失效'
          }]
        }
      }
      return {
        verdict: 'revise',
        standardPath: 'C:/p/docs/review/standard',
        blindFindings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: '缓存未失效', fix: '加失效', evidence: 'e' }],
        withdrawn: [],
        findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: '缓存未失效', fix: '加失效', evidence: 'e', source: 'blind' }]
      }
    }
    const engine = engineDouble(responder)
    const definition = toolFor(engine)
    const impl = {
      patchPath, docPath, verifyResult: 'exit 0',
      changedSymbols: ['cacheFn'], filesChanged: 'lib/x.js', fixDeltaPath: deltaPath
    }

    const round1 = await definition.execute({
      mode: 'review', planFile, briefFile, sliceId: 'S1', impl,
      patchPath, docPath, round: 1, userFeedback: '', preflight: 'exit 0',
      repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a1' } })
    assert.equal(round1.result.ok, true)
    assert.equal(round1.result.reviewScope, 'full')
    const saved1 = join(outDir, 'reviews', 'S1-review-r1.json')
    const saved1Text = await readFile(saved1, 'utf8')
    assert.equal(JSON.parse(saved1Text).round, 1)

    const round2 = await definition.execute({
      mode: 'review', planFile, briefFile, sliceId: 'S1', impl,
      patchPath, docPath, round: 2, userFeedback: '修了缓存', preflight: 'exit 0',
      repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a2' } })
    assert.equal(round2.result.ok, true)
    assert.equal(round2.result.reviewScope, 'incremental')
    assert.equal(round2.result.reviewAlignment, null)
    assert.equal(round2.result.previousFindings[0].status, 'resolved')
    const pkg = round2.result.reviewPackage
    assert.equal(pkg.mode, 'focused')
    const body = await readFile(pkg.path, 'utf8')
    assert.ok(body.includes('缓存未失效'))
    assert.ok(body.includes('diff --git a/lib/x.js'))
    const saved2 = JSON.parse(await readFile(join(outDir, 'reviews', 'S1-review-r2.json'), 'utf8'))
    assert.equal(saved2.round, 2)
    assert.equal(saved2.reviewScope, 'incremental')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('contractChanged upgrades round 2 to a full review with a reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const patchPath = join(outDir, 'S1.patch')
    const docPath = join(outDir, 'S1.md')
    const planFile = join(outDir, 'plan.json')
    const briefFile = join(outDir, 'brief.json')
    await mkdir(join(outDir, 'reviews'), { recursive: true })
    await writeFile(patchPath, PATCH)
    await writeFile(docPath, '# 薄文档\n验证记录：exit 0')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify(BRIEF))
    await writeFile(join(outDir, 'reviews', 'S1-review-r1.json'), JSON.stringify({
      round: 1,
      codeReview: { verdict: 'revise', findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'x', fix: 'f', evidence: 'e' }] }
    }))
    const engine = engineDouble(reviewer)
    const definition = toolFor(engine)
    const out = await definition.execute({
      mode: 'review', planFile, briefFile, sliceId: 'S1',
      impl: { patchPath, docPath, verifyResult: 'exit 0', contractChanged: true, changedSymbols: ['cacheFn'] },
      patchPath, docPath, round: 2, userFeedback: '改契约了', preflight: 'exit 0',
      repoRoot: dir, outDir, taskName: 't'
    }, { agent: { id: 'a1' } })
    assert.equal(out.result.reviewScope, 'full')
    assert.match(String(out.result.upgradeReason), /公共签名|契约/)
    assert.equal(out.result.reviewPackage.mode, 'full')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wrong previous round is rejected instead of silently reusing results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const patchPath = join(outDir, 'S1.patch')
    const docPath = join(outDir, 'S1.md')
    const planFile = join(outDir, 'plan.json')
    await mkdir(join(outDir, 'reviews'), { recursive: true })
    await writeFile(patchPath, PATCH)
    await writeFile(docPath, '# 薄文档')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(join(outDir, 'reviews', 'S1-review-r1.json'), JSON.stringify({
      round: 0, codeReview: { verdict: 'pass', findings: [] }
    }))
    const definition = toolFor(engineDouble(reviewer))
    await assert.rejects(
      () => definition.execute({
        mode: 'review', planFile, sliceId: 'S1',
        impl: { patchPath, docPath, verifyResult: 'exit 0', changedSymbols: ['cacheFn'] },
        patchPath, docPath, round: 2, userFeedback: 'r', preflight: 'exit 0',
        repoRoot: dir, outDir, taskName: 't'
      }, { agent: { id: 'a1' } }),
      /不一致/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit incremental without materials is a hard error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-package-'))
  try {
    const outDir = join(dir, 'AIOut', 't')
    const patchPath = join(outDir, 'S1.patch')
    const docPath = join(outDir, 'S1.md')
    const planFile = join(outDir, 'plan.json')
    await mkdir(outDir, { recursive: true })
    await writeFile(patchPath, PATCH)
    await writeFile(docPath, '# 薄文档')
    await writeFile(planFile, JSON.stringify(PLAN))
    const definition = toolFor(engineDouble(reviewer))
    await assert.rejects(
      () => definition.execute({
        mode: 'review', planFile, sliceId: 'S1',
        impl: { patchPath, docPath, verifyResult: 'exit 0' },
        patchPath, docPath, round: 2, userFeedback: 'r', preflight: 'exit 0',
        reviewScope: 'incremental', repoRoot: dir, outDir, taskName: 't'
      }, { agent: { id: 'a1' } }),
      /incremental/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
