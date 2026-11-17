import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ROLES, fakeModules } from './helpers/fixtures.js'

const SCRIPT_PATH = fileURLToPath(new URL('../skills/slice-pipeline/slice-pipeline.js', import.meta.url))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const BASE = {
  roles: ROLES,
  modules: fakeModules(),
  reviewStandardPath: 'C:/p/docs/review/standard'
}
const ECHO = 'C:/p/docs/review/standard'
const CONTEXT = { repoRoot: 'C:/w', outDir: 'C:/w/AIOut/t', taskName: 't' }
const BRIEF_FILE = 'C:/w/AIOut/t/brief.json'

const BRIEF = { sliceId: 'S1', architecture: '只在 lib/x.js 增加一层缓存，不动上游', details: 'lib/x.js:10 缓存；验证：exit 0' }
const PLAN = {
  summary: 's',
  interfaceContract: 'c',
  slices: [{
    id: 'S1',
    title: 'T1',
    scope: 'x',
    acceptance: 'a',
    brief: { ...BRIEF },
    discussion: {
      sliceId: 'S1',
      understanding: '本片只落地 S1 的接口增量',
      decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
      openQuestions: [],
      userConfirmed: true
    }
  }]
}
const IMPL = { sliceId: 'S1', patchPath: 'C:/w/AIOut/t/S1.patch', docPath: 'C:/w/AIOut/t/S1.md', verifyResult: 'exit 0' }

async function runScript(args, responder) {
  const source = await readFile(SCRIPT_PATH, 'utf8')
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return responder(prompt, opts, calls)
  }
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'pipeline', 'parallel', source)
  try {
    const result = await fn(args, agent, () => {}, (line) => logs.push(String(line)),
      async () => {}, async () => {})
    return { result, calls, logs, error: null }
  } catch (error) {
    return { result: null, calls, logs, error }
  }
}

const reviewArgs = (extra = {}) => ({
  ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', brief: BRIEF, briefFile: BRIEF_FILE,
  impl: IMPL, patchPath: IMPL.patchPath, docPath: IMPL.docPath,
  round: 1, userFeedback: '', preflight: 'exit 0', ...CONTEXT, ...extra
})

const twoPhaseReview = (extra = {}) => ({
  verdict: 'pass',
  standardPath: ECHO,
  blindFindings: [
    { severity: 'red', file: 'lib/x.js', line: '10', issue: '缓存未失效', fix: 'f', evidence: 'e' }
  ],
  withdrawn: [],
  findings: [
    { severity: 'red', file: 'lib/x.js', line: '10', issue: '缓存未失效', fix: 'f', evidence: 'e', source: 'blind' },
    { severity: 'yellow', file: 'lib/x.js', line: '40', issue: '偏离 brief：顺手改了上游', fix: 'f', evidence: 'e', source: 'alignment' }
  ],
  ...extra
})

// ---------------------------------------------------------------------------
// 两段式：先盲审，再读 brief 对齐
// ---------------------------------------------------------------------------
test('stage review prompt asks for a blind pass first and the brief only afterwards', async () => {
  const run = await runScript(reviewArgs(), twoPhaseReview)
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 1)
  const { prompt, opts } = run.calls[0]
  assert.equal(opts.label, 'code-review:S1')
  assert.ok(prompt.includes('两段式审查'), 'prompt must describe the two-phase protocol')
  assert.ok(prompt.includes('阶段一 · 盲审'))
  assert.ok(prompt.includes('禁止 read'))
  assert.ok(prompt.includes('阶段二 · 对齐'))
  assert.ok(prompt.includes(BRIEF_FILE), 'phase two must cite the brief path')
  const blindAt = prompt.indexOf('阶段一 · 盲审')
  const briefAt = prompt.indexOf(BRIEF_FILE)
  assert.ok(blindAt < briefAt, 'the blind phase must come before the brief path')
  // schema: 盲审结论与撤回都必须落进结构化输出
  assert.ok(opts.schema.required.includes('blindFindings'))
  assert.deepEqual(
    opts.schema.properties.findings.items.properties.source.enum, ['blind', 'alignment']
  )
})

test('batch code review stays a pure blind pass', async () => {
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: PLAN, sliceId: 'S1', ...CONTEXT },
    (prompt, opts) => {
      const label = String(opts.label || '')
      if (label.startsWith('brief')) return BRIEF
      if (label.startsWith('impl')) return IMPL
      if (label.startsWith('code-review')) return { verdict: 'pass', findings: [], standardPath: ECHO }
      throw new Error('unexpected label ' + label)
    }
  )
  assert.equal(run.error, null)
  const review = run.calls.find((call) => call.opts.label === 'code-review:S1')
  assert.equal(review.prompt.includes('两段式审查'), false)
  assert.equal(review.prompt.includes(BRIEF_FILE), false)
})

test('stage review surfaces the two-phase bookkeeping', async () => {
  const run = await runScript(reviewArgs(), twoPhaseReview)
  const { result } = run
  assert.equal(result.reviewAlignment.applied, true)
  assert.equal(result.reviewAlignment.briefSource, 'path')
  assert.equal(result.reviewAlignment.blindFindingCount, 1)
  assert.equal(result.reviewAlignment.finalBlind, 1)
  assert.equal(result.reviewAlignment.finalAlignment, 1)
  assert.equal(result.reviewAlignment.unlabeled, 0)
  assert.equal(result.reviewAlignment.withdrawnCount, 0)
  assert.equal(result.blindFindings.length, 1)
  assert.equal(result.redCount, 1)
  assert.equal(result.nextAction, 'send-fix')
})

test('withdrawn blind findings are reported back and logged', async () => {
  const responder = () => twoPhaseReview({
    withdrawn: [{ file: 'lib/x.js', line: '10', issue: '缓存未失效', reason: 'brief 明确要求本期不做失效' }],
    findings: [{ severity: 'yellow', file: 'lib/x.js', line: '40', issue: '偏离 brief', fix: 'f', evidence: 'e', source: 'alignment' }]
  })
  const run = await runScript(reviewArgs(), responder)
  assert.equal(run.result.reviewAlignment.withdrawnCount, 1)
  assert.equal(run.result.withdrawn[0].reason, 'brief 明确要求本期不做失效')
  assert.equal(run.result.redCount, 0)
  assert.equal(run.result.nextAction, 'deliver')
})

test('unlabeled findings are counted and warned about', async () => {
  const responder = () => twoPhaseReview({
    blindFindings: [],
    findings: [{ severity: 'green', file: 'lib/x.js', line: '1', issue: 'nit', fix: 'f', evidence: 'e' }]
  })
  const run = await runScript(reviewArgs(), responder)
  assert.equal(run.result.reviewAlignment.unlabeled, 1)
  assert.ok(run.logs.some((line) => line.includes('未标 source')))
})

test('a review without blindFindings is flagged instead of silently passing', async () => {
  const responder = () => ({ verdict: 'pass', findings: [], standardPath: ECHO })
  const run = await runScript(reviewArgs(), responder)
  assert.equal(run.error, null)
  assert.equal(run.result.reviewAlignment.blindFindingCount, null)
  assert.equal(run.result.blindFindings, null)
  assert.ok(run.logs.some((line) => line.includes('缺少 blindFindings')))
})

// ---------------------------------------------------------------------------
// brief 必填 + 必须是本片
// ---------------------------------------------------------------------------
test('review refuses to run without the brief of this slice', async () => {
  const planWithoutBrief = {
    ...PLAN,
    slices: PLAN.slices.map((slice) => {
      const copy = { ...slice }
      delete copy.brief
      return copy
    })
  }
  const missing = await runScript(reviewArgs({ brief: undefined, plan: planWithoutBrief }), twoPhaseReview)
  assert.ok(missing.error)
  assert.match(missing.error.message, /brief/)
  assert.equal(missing.calls.length, 0)

  const mismatch = await runScript(
    reviewArgs({ brief: { ...BRIEF, sliceId: 'S2' } }), twoPhaseReview
  )
  assert.ok(mismatch.error)
  assert.match(mismatch.error.message, /与本片不一致|不一致/)
  assert.equal(mismatch.calls.length, 0)
})

test('without a brief path the alignment phase embeds the architecture inline', async () => {
  const run = await runScript(reviewArgs({ briefFile: undefined }), twoPhaseReview)
  assert.equal(run.error, null)
  assert.equal(run.result.reviewAlignment.briefSource, 'inline')
  assert.ok(run.calls[0].prompt.includes(BRIEF.architecture))
})
