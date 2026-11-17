import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_RESULT_CHARS, createPipelineTool, jobOutcome, validateRunParams
} from '../lib/pipeline-tool.js'
import { readConfig } from '../lib/config.js'
import { ROLES, fakeModules } from './helpers/fixtures.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT_PATH = join(ROOT, 'skills', 'slice-pipeline', 'slice-pipeline.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

const BASE = {
  roles: ROLES,
  modules: fakeModules(),
  reviewStandardPath: 'C:/p/docs/review/standard'
}
const ECHO = 'C:/p/docs/review/standard'
const BRIEF = { sliceId: 'S1', architecture: 'arch', details: 'lib/x.js:42 加缓存；验证：exit 0' }
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
      understanding: '本片只落地 S1 的接口增量与写入范围，不做跨片重构',
      decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
      rejected: [{ option: '顺手重构上游模块', reason: '超出本片范围' }],
      openQuestions: [],
      userConfirmed: true
    }
  }]
}

// 每片讨论记录（plan.json → slices[i].discussion）：brief / slice 阶段的门禁输入。
const DISCUSSION = {
  sliceId: 'S1',
  understanding: '本片只落地 S1 的接口增量与写入范围，不做跨片重构',
  decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
  rejected: [{ option: '顺手重构上游模块', reason: '超出本片范围' }],
  openQuestions: [],
  userConfirmed: true
}
const withDiscussion = (plan, discussion) => ({
  ...plan,
  slices: plan.slices.map((slice) => ({ ...slice, discussion }))
})
const PLAN_D = withDiscussion(PLAN, DISCUSSION)
const IMPL = {
  sliceId: 'S1',
  patchPath: 'C:/w/AIOut/t/S1.patch',
  docPath: 'C:/w/AIOut/t/S1-doc',
  verifyResult: 'exit 0'
}
const CONTEXT = { repoRoot: 'C:/w', outDir: 'C:/w/AIOut/t', taskName: 't' }
const SLICE_ARGS = { plan: PLAN, sliceId: 'S1', ...CONTEXT }

/** 0.9.0：为宿主 render-implement 的 design 溯源校验准备 design.json + designRef。 */
async function seedDesign(outDir, plan) {
  const details = plan.slices[0] && plan.slices[0].brief ? plan.slices[0].brief.details : ''
  const symbols = [...new Set(details.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+/g) || [])]
  const files = [...new Set(symbols.map((item) => item.replace(/:\d+$/, '')))]
  const designPlan = {
    ...plan,
    slices: plan.slices.map((slice) => ({
      ...slice,
      research: { symbols, files, forbidden: [], verify: ['exit 0'] }
    }))
  }
  const designRef = createHash('sha256').update(JSON.stringify(designPlan)).digest('hex')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'design.json'), JSON.stringify({
    designRef, plan: designPlan, decisions: [], openQuestions: [], createdAt: 'test'
  }))
  return { ...plan, designRef }
}

/** Run the bundled workflow script with a scripted agent() double. */
async function runScript(args, responder) {
  const source = await readFile(SCRIPT_PATH, 'utf8')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return responder(prompt, opts, calls)
  }
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'pipeline', 'parallel', source)
  try {
    const result = await fn(args, agent, () => {}, () => {}, async () => {}, async () => {})
    return { result, calls, error: null }
  } catch (error) {
    return { result: null, calls, error }
  }
}

/** Batch agent double used for the pre-S1 snapshot baseline. */
const passingAgent = (prompt, opts) => {
  const label = String(opts.label || '')
  if (label.startsWith('plan-review')) return { verdict: 'pass', findings: [], standardPath: ECHO }
  if (label.startsWith('design')) return PLAN
  if (label.startsWith('brief')) return BRIEF
  if (label.startsWith('impl')) return IMPL
  if (label.startsWith('code-review')) return { verdict: 'pass', findings: [], standardPath: ECHO }
  if (label.startsWith('fix')) return IMPL
  return null
}

/** Batch snapshot: labels / routes / schemas / prompts / result, hashed. */
function batchSnapshot(run) {
  const record = {
    calls: run.calls.map((call) => ({
      label: call.opts.label,
      provider: call.opts.provider,
      model: call.opts.model,
      schema: call.opts.schema ?? null,
      prompt: call.prompt
    })),
    result: run.result
  }
  return sha12(JSON.stringify(record))
}

/** Engine double that really executes the workflow script and reports the agent count. */
function workflowEngine(responder) {
  const runs = []
  return {
    runs,
    start(request) {
      const calls = []
      const run = {
        id: `run-${runs.length + 1}`,
        calls,
        disposed: 0,
        cancel() {},
        dispose: async () => { run.disposed += 1 }
      }
      runs.push(run)
      const agent = async (prompt, opts = {}) => {
        calls.push({ prompt, opts })
        return responder(prompt, opts, calls)
      }
      const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'pipeline', 'parallel', request.script)
      run.result = fn(request.args, agent, () => {}, () => {}, async () => {}, async () => {}).then(
        (value) => ({ stopReason: 'completed', agentsStarted: calls.length, value }),
        (error) => ({
          stopReason: 'error',
          error: String(error?.message ?? error),
          agentsStarted: calls.length
        })
      )
      return run
    }
  }
}

function realTool(engine) {
  return createPipelineTool({
    pluginRoot: ROOT,
    getConfig: () => readConfig({}),
    engine,
    jobs: undefined
  })
}

const exec = (id) => ({ agent: { id }, signal: undefined })
const CONTEXT_PARAMS = { repoRoot: 'C:/w', outDir: 'C:/w/AIOut/t', taskName: 't' }
const PLAN_FILE = 'C:/w/AIOut/t/plan.json'
const BRIEF_FILE = 'C:/w/AIOut/t/brief.json'
const PATCH = 'C:/w/AIOut/t/S1.patch'
const DOC = 'C:/w/AIOut/t/S1-doc'

const VALID = {
  design: { mode: 'design', requirement: 'r', discussionDigest: 'd', ...CONTEXT_PARAMS },
  review: {
    mode: 'review', planFile: PLAN_FILE, sliceId: 'S1', briefFile: BRIEF_FILE,
    impl: { patchPath: PATCH, docPath: DOC, verifyResult: 'exit 0' },
    patchPath: PATCH, docPath: DOC, round: 1, userFeedback: '', preflight: 'git apply --check: exit 0',
    ...CONTEXT_PARAMS
  },
  'render-implement': {
    mode: 'render-implement', planFile: PLAN_FILE, sliceId: 'S1', briefFile: BRIEF_FILE,
    ...CONTEXT_PARAMS
  },
  'render-fix': {
    mode: 'render-fix', planFile: PLAN_FILE, sliceId: 'S1', briefFile: BRIEF_FILE,
    impl: { patchPath: PATCH, docPath: DOC, verifyResult: 'exit 0' },
    findings: { verdict: 'revise', findings: [] }, round: 1, userFeedback: '请改名',
    ...CONTEXT_PARAMS
  }
}

// ---------------------------------------------------------------------------
// Batch regression: prompts and returns must stay byte-identical to the pre-S1
// baseline (hashes recorded from the script before the stage modes were added).
// ---------------------------------------------------------------------------
test('batch plan-only prompts/result match the pre-S1 baseline', async () => {
  const run = await runScript(
    { ...BASE, mode: 'plan-only', requirement: 'r', stages: { plan: ['design', 'planReview'] } },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.deepEqual(run.calls.map((call) => call.opts.label), ['design-plan'])
  assert.equal(batchSnapshot(run), 'ac00809c8477')
})

test('batch slice prompts/result match the pre-S1 baseline', async () => {
  const run = await runScript(
    {
      ...BASE, mode: 'slice', sliceId: 'S1', plan: PLAN_D,
      repoRoot: 'C:/w', workspace: 'C:/w-copy', outDir: 'C:/w/AIOut/t', taskName: 't'
    },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.deepEqual(run.calls.map((call) => call.opts.label), ['impl:S1', 'code-review:S1'])
  assert.equal(batchSnapshot(run), '17ef12e2efee')
})

test('batch slice fix loop prompts/result match the pre-S1 baseline', async () => {
  let codeReviews = 0
  const responder = (prompt, opts) => {
    const label = String(opts.label || '')
    if (label.startsWith('code-review')) {
      codeReviews += 1
      return codeReviews === 1
        ? {
            verdict: 'revise',
            findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e' }],
            standardPath: ECHO
          }
        : { verdict: 'pass', findings: [], standardPath: ECHO }
    }
    return passingAgent(prompt, opts)
  }
  const run = await runScript(
    { ...BASE, mode: 'slice', sliceId: 'S1', plan: PLAN_D, repoRoot: 'C:/w', outDir: 'C:/w/AIOut/t', taskName: 't' },
    responder
  )
  assert.equal(run.error, null)
  assert.deepEqual(run.calls.map((call) => call.opts.label),
    ['impl:S1', 'code-review:S1', 'fix-1:S1', 'code-review-fix-1:S1'])
  assert.equal(batchSnapshot(run), '709a8a4d54bb')
})

// ---------------------------------------------------------------------------
// design mode: plan only, design-only schema variant, nextAction=ask-user.
// ---------------------------------------------------------------------------
test('design mode dispatches one planning agent and returns plan + decisions/openQuestions', async () => {
  const run = await runScript(
    { ...BASE, mode: 'design', requirement: 'r', discussionDigest: '已确认：直接实现 S1', ...CONTEXT },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 1)
  const [call] = run.calls
  assert.equal(call.opts.label, 'design-plan')
  assert.equal(call.opts.schema.required.includes('decisions'), true)
  assert.ok((call.opts.schema.properties.decisions.items.required).includes('topic'))
  assert.ok(call.prompt.includes('已确认：直接实现 S1'))
  assert.equal(call.prompt.includes('diagrams/standard.md'), false)
  assert.ok(call.prompt.includes('plan.summary ≤800 字'))
  const { result } = run
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'design')
  assert.equal(result.nextAction, 'ask-user')
  assert.deepEqual(result.decisions, [])
  assert.deepEqual(result.openQuestions, [])
  assert.deepEqual(result.runContext, { repoRoot: 'C:/w', workspace: null, outDir: 'C:/w/AIOut/t', taskName: 't' })
  assert.equal(result.plan.summary, 's')
})

test('design schema variant is not baked into the batch PLAN_SCHEMA', async () => {
  const design = await runScript(
    { ...BASE, mode: 'design', requirement: 'r', discussionDigest: 'd', ...CONTEXT },
    passingAgent
  )
  assert.equal(design.calls[0].opts.schema.required.includes('decisions'), true)
  const batch = await runScript(
    { ...BASE, mode: 'plan-only', requirement: 'r', stages: { plan: ['design'] } },
    passingAgent
  )
  const batchSchema = batch.calls[0].opts.schema
  assert.deepEqual(batchSchema.required, ['summary', 'interfaceContract', 'slices'])
  assert.equal(batchSchema.properties.decisions, undefined)
  assert.equal(batchSchema.properties.openQuestions, undefined)
})

test('design mode refuses to run without a discussion digest', async () => {
  const run = await runScript({ ...BASE, mode: 'design', requirement: 'r', ...CONTEXT }, passingAgent)
  assert.ok(run.error, 'expected a hard failure')
  assert.match(run.error.message, /design/)
  assert.match(run.error.message, /discussionDigest/)
  assert.equal(run.calls.length, 0)
})

// ---------------------------------------------------------------------------
// brief mode: brief only, briefReview skipped, nextAction=spawn-implementer.
// ---------------------------------------------------------------------------
test('brief mode returns the brief and records the skipped briefReview', async () => {
  const run = await runScript(
    { ...BASE, mode: 'brief', plan: PLAN_D, sliceId: 'S1', ...CONTEXT },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].opts.label, 'brief:S1')
  assert.ok(run.calls[0].prompt.includes('## 本片讨论结论'), 'brief 必须带上本片讨论结论')
  assert.ok(run.calls[0].prompt.includes('只改 lib/x.js'))
  assert.ok(run.calls[0].prompt.includes('已否决的方案'))
  const { result } = run
  assert.equal(result.mode, 'brief')
  assert.deepEqual(result.brief, BRIEF)
  assert.deepEqual(result.sliceDiscussion, DISCUSSION)
  assert.deepEqual(result.openQuestions, [])
  assert.equal(result.briefReview, null)
  assert.equal(result.briefReviewSkipped, true)
  assert.equal(result.nextAction, 'spawn-implementer')
  assert.deepEqual(result.runContext, { repoRoot: 'C:/w', workspace: null, outDir: 'C:/w/AIOut/t', taskName: 't' })
})

test('unknown sliceId fails fast instead of rendering a placeholder brief', async () => {
  const run = await runScript(
    { ...BASE, mode: 'brief', plan: PLAN, sliceId: 'S9', ...CONTEXT },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /S9/)
  assert.equal(run.calls.length, 0)
})

// ---------------------------------------------------------------------------
// review mode: full code review with round / user feedback / preflight.
// ---------------------------------------------------------------------------
const reviewArgs = (extra = {}) => ({
  ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', brief: BRIEF, briefFile: BRIEF_FILE, impl: IMPL,
  patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 1, userFeedback: '', preflight: 'exit 0',
  ...CONTEXT, ...extra
})

test('review mode maps a clean review to deliver and carries the legacy field names', async () => {
  const run = await runScript(reviewArgs(), passingAgent)
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].opts.label, 'code-review:S1')
  assert.ok(run.calls[0].prompt.includes('round=1'))
  assert.ok(run.calls[0].prompt.includes('exit 0'))
  const { result } = run
  assert.equal(result.mode, 'review')
  assert.equal(result.codeReviewVerdict, 'pass')
  assert.equal(result.redCount, 0)
  assert.equal(result.fixExhausted, false)
  assert.equal(result.verifyResult, 'exit 0')
  assert.equal(result.nextAction, 'deliver')
  assert.equal(result.reviewAlignment.applied, true)
  assert.equal(result.reviewAlignment.briefPath, BRIEF_FILE)
})

test('review mode maps remaining red findings to send-fix', async () => {
  const red = () => ({
    verdict: 'revise',
    findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e' }],
    standardPath: ECHO
  })
  const run = await runScript(reviewArgs(), red)
  assert.equal(run.error, null)
  assert.equal(run.result.redCount, 1)
  assert.equal(run.result.fixExhausted, false)
  assert.equal(run.result.nextAction, 'send-fix')
})

test('review mode reports fixExhausted once the fix rounds are used up', async () => {
  const red = () => ({
    verdict: 'revise',
    findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e' }],
    standardPath: ECHO
  })
  for (const [round, exhausted] of [[1, false], [3, false], [4, true]]) {
    const run = await runScript(reviewArgs({ round, userFeedback: 'u' }), red)
    assert.equal(run.result.round, round)
    assert.equal(run.result.fixRounds, round - 1)
    assert.equal(run.result.fixExhausted, exhausted, `round=${round}`)
  }
})

test('review mode asks for another review when the review agent fails', async () => {
  const run = await runScript(reviewArgs(), () => null)
  assert.equal(run.error, null)
  assert.equal(run.result.redCount, null)
  assert.equal(run.result.codeReviewVerdict, null)
  assert.equal(run.result.nextAction, 'review-again')
})

test('review mode passes user feedback and refuses an empty feedback on later rounds', async () => {
  const run = await runScript(reviewArgs({ round: 2, userFeedback: '把 X 改成 Y' }), passingAgent)
  assert.equal(run.error, null)
  assert.ok(run.calls[0].prompt.includes('把 X 改成 Y'))
  const empty = await runScript(reviewArgs({ round: 2, userFeedback: '' }), passingAgent)
  assert.ok(empty.error)
  assert.match(empty.error.message, /userFeedback/)
  assert.equal(empty.calls.length, 0)
})

// ---------------------------------------------------------------------------
// render-implement / render-fix: no dispatch, task book is the shared builder's output.
// ---------------------------------------------------------------------------
test('render-implement dispatches nothing and equals implementPrompt(fixture)', async () => {
  const rendered = await runScript(
    { ...BASE, mode: 'render-implement', plan: PLAN, sliceId: 'S1', brief: BRIEF, ...CONTEXT },
    passingAgent
  )
  assert.equal(rendered.error, null)
  assert.equal(rendered.calls.length, 0)
  assert.deepEqual(rendered.calls, [])

  const batch = await runScript(
    { ...BASE, mode: 'slice', plan: PLAN_D, sliceId: 'S1', stages: { slice: ['brief', 'implement'] }, ...CONTEXT },
    passingAgent
  )
  const implementPrompt = batch.calls.find((call) => call.opts.label === 'impl:S1').prompt
  assert.equal(rendered.result.prompt, implementPrompt)
  assert.equal(rendered.result.mode, 'render-implement')
  assert.deepEqual(rendered.result.runContext,
    { repoRoot: 'C:/w', workspace: null, outDir: 'C:/w/AIOut/t', taskName: 't' })
})

test('render-implement refuses to render placeholder text for an incomplete brief', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: PLAN, sliceId: 'S1', brief: { sliceId: 'S1', architecture: 'a' }, ...CONTEXT },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /details/)
  assert.equal(run.calls.length, 0)
})

test('render-fix renders the user feedback section ahead of the review findings', async () => {
  const findings = {
    verdict: 'revise',
    findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e' }],
    standardPath: ECHO
  }
  const run = await runScript(
    {
      ...BASE, mode: 'render-fix', plan: PLAN, sliceId: 'S1', brief: BRIEF, impl: IMPL,
      findings, round: 1, userFeedback: '用户要求改名', ...CONTEXT
    },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 0)
  const { prompt } = run.result
  assert.ok(prompt.includes('## 用户意见（优先，最高优先级）'))
  assert.ok(prompt.includes('## 审查意见（findings，JSON，逐条处理）'))
  assert.ok(prompt.indexOf('用户要求改名') < prompt.indexOf('## 审查意见（findings，JSON，逐条处理）'))
  assert.ok(prompt.includes('以用户意见为准'))
  assert.ok(prompt.includes('第 1 轮修订'))
})

test('validateRunParams rejects an impl without the reviewable deliverables', () => {
  for (const mode of ['review', 'render-fix']) {
    const checked = validateRunParams({ ...VALID[mode], impl: {} })
    assert.equal(checked.ok, false, mode)
    assert.ok(checked.error.includes(mode), checked.error)
    assert.ok(checked.error.includes('patchPath'), checked.error)
    assert.ok(checked.error.includes('docPath'), checked.error)
  }
})

test('render-fix refuses to render placeholder paths for an incomplete impl', async () => {
  const run = await runScript(
    {
      ...BASE, mode: 'render-fix', plan: PLAN, sliceId: 'S1', brief: BRIEF,
      impl: { sliceId: 'S1', verifyResult: 'exit 0' },
      findings: { verdict: 'pass', findings: [] }, round: 1, userFeedback: 'u', ...CONTEXT
    },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /patchPath/)
  assert.equal(run.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Host-side validation: required / forbidden params per mode.
// ---------------------------------------------------------------------------
test('validateRunParams accepts every stage mode with its required fields', () => {
  for (const [mode, params] of Object.entries(VALID)) {
    const checked = validateRunParams(params)
    assert.equal(checked.ok, true, `${mode}: ${checked.error}`)
    assert.deepEqual(checked.context.outDir, 'C:/w/AIOut/t')
  }
})

test('validateRunParams names the mode and every missing required field', () => {
  const required = {
    design: ['requirement', 'discussionDigest'],
    review: [
      'planFile', 'sliceId', 'impl', 'patchPath', 'docPath', 'round', 'userFeedback', 'preflight'
    ],
    'render-implement': ['planFile', 'sliceId'],
    'render-fix': ['planFile', 'sliceId', 'impl', 'findings', 'round', 'userFeedback']
  }
  for (const [mode, fields] of Object.entries(required)) {
    for (const field of fields) {
      const params = { ...VALID[mode] }
      delete params[field]
      const checked = validateRunParams(params)
      assert.equal(checked.ok, false, `${mode} without ${field} must fail`)
      assert.ok(checked.error.includes(mode), `${mode}/${field}: ${checked.error}`)
      assert.ok(checked.error.includes(field), `${mode}/${field}: ${checked.error}`)
    }
  }
})

test('validateRunParams rejects forbidden params per mode', () => {
  const cases = [
    ['design', { sliceId: 'S1' }],
    ['design', { planFile: PLAN_FILE }],
    ['design', { impl: {} }],
    ['review', { requirement: 'r' }]
  ]
  for (const [mode, extra] of cases) {
    const checked = validateRunParams({ ...VALID[mode], ...extra })
    assert.equal(checked.ok, false, `${mode} + ${Object.keys(extra)}`)
    for (const key of Object.keys(extra)) {
      assert.ok(checked.error.includes(key), `${mode}/${key}: ${checked.error}`)
    }
  }
})

test('validateRunParams types the stage-only fields', () => {
  for (const bad of [
    { round: 0 },
    { round: 1.5 },
    { impl: 'json' },
    { findings: 5 },
    { runContext: 'ctx' },
    { preflight: 5 },
    { userFeedback: 5 }
  ]) {
    const checked = validateRunParams({ ...VALID.review, ...bad })
    assert.equal(checked.ok, false, JSON.stringify(bad))
    assert.ok(checked.error.includes(Object.keys(bad)[0]), checked.error)
  }
})

test('the removed brief agent mode is rejected by the tool entry', () => {
  const checked = validateRunParams({ mode: 'brief', planFile: PLAN_FILE, sliceId: 'S1' })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /mode 必须是/)
})
test('validateRunParams rejects deliverable paths outside outDir', () => {
  const outside = validateRunParams({ ...VALID.review, patchPath: 'C:/elsewhere/S1.patch' })
  assert.equal(outside.ok, false)
  assert.match(outside.error, /patchPath/)
  assert.match(outside.error, /outDir/)
  const implOutside = validateRunParams({
    ...VALID.review, impl: { ...VALID.review.impl, patchPath: 'C:/elsewhere/S1.patch' }
  })
  assert.equal(implOutside.ok, false)
  assert.match(implOutside.error, /impl\.patchPath/)
  const traversal = validateRunParams({ ...VALID.review, docPath: 'C:/w/AIOut/t/../escape-doc' })
  assert.equal(traversal.ok, false)
})

test('validateRunParams compares the carried runContext field by field', () => {
  const carried = { repoRoot: 'C:/w', workspace: null, outDir: 'C:/w/AIOut/t', taskName: 't' }
  const inherited = validateRunParams({
    mode: 'review', planFile: PLAN_FILE, sliceId: 'S1', briefFile: BRIEF_FILE,
    impl: { patchPath: PATCH, docPath: DOC }, patchPath: PATCH, docPath: DOC,
    round: 1, userFeedback: '', preflight: 'ok', runContext: carried
  })
  assert.equal(inherited.ok, true, inherited.error)
  assert.deepEqual(inherited.context, carried)
  const conflict = validateRunParams({ ...VALID.review, outDir: 'C:/w/AIOut/other', runContext: carried })
  assert.equal(conflict.ok, false)
  assert.match(conflict.error, /runContext\.outDir/)
  const workspace = validateRunParams({
    ...VALID.design, runContext: { ...carried, workspace: 'C:/w-copy' }
  })
  assert.equal(workspace.ok, true, workspace.error)
  assert.equal(workspace.context.workspace, 'C:/w-copy')
})

test('validateRunParams keeps the batch modes exactly as before', () => {
  assert.deepEqual(validateRunParams({ mode: 'plan-only', requirement: 'r' }), { ok: true })
  assert.equal(validateRunParams({ mode: 'plan-only' }).ok, false)
  assert.equal(validateRunParams({ mode: 'slice', sliceId: 'S1', plan: { slices: [] } }).ok, true)
  assert.equal(validateRunParams({ mode: 'slice', sliceId: 'S1' }).ok, false)
  const badMode = validateRunParams({ mode: 'stage' })
  assert.equal(badMode.ok, false)
  for (const mode of ['plan-only', 'slice', 'design', 'review', 'render-implement', 'render-fix']) {
    assert.ok(badMode.error.includes(mode), mode)
  }
})

// ---------------------------------------------------------------------------
// Host-side execution: planFile/briefFile reads, agentsStarted, sha12, raw text.
// ---------------------------------------------------------------------------
test('render-implement host call reads the files, starts no agent and returns a raw prompt + sha12', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const briefFile = join(dir, 'brief.json')
    await writeFile(planFile, JSON.stringify(await seedDesign(dir, PLAN)))
    await writeFile(briefFile, JSON.stringify(BRIEF))

    const engine = workflowEngine(passingAgent)
    const { definition } = realTool(engine)
    const out = await definition.execute({
      mode: 'render-implement', planFile, briefFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
    }, exec('a1'))

    assert.equal(out.kind, 'foreground')
    assert.equal(out.agentsStarted, 0)
    assert.equal(engine.runs[0].calls.length, 0)
    const result = out.result
    assert.equal(result.mode, 'render-implement')
    assert.equal(result.sha12, sha12(result.prompt))
    assert.deepEqual(result.runContext,
      { repoRoot: 'C:/w', workspace: null, outDir: dir, taskName: 't' })

    // Byte-identical to implementPrompt(fixture) from the batch slice path.
    const batchEngine = workflowEngine(passingAgent)
    await realTool(batchEngine).definition.execute({
      mode: 'slice', plan: PLAN_D, sliceId: 'S1', stages: { slice: ['brief', 'implement'] }, ...CONTEXT_PARAMS, outDir: dir
    }, exec('a2'))
    const fixture = batchEngine.runs[0].calls.find((call) => call.opts.label === 'impl:S1').prompt
    assert.equal(result.prompt, fixture)

    // The task book comes back verbatim (no JSON escaping) and carries the fingerprint.
    const [block] = definition.output.render({}, out)
    assert.ok(block.text.includes(result.prompt), 'prompt must appear verbatim in the rendered text')
    assert.ok(block.text.includes(`sha12: ${result.sha12}`))
    const background = jobOutcome({ stopReason: 'completed', agentsStarted: 0, value: result })
    assert.equal(background.status, 'completed')
    assert.ok(background.result.includes(result.prompt))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('render-fix host call renders both sections and starts no agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const briefFile = join(dir, 'brief.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify(BRIEF))
    const engine = workflowEngine(passingAgent)
    const { definition } = realTool(engine)
    const out = await definition.execute({
      mode: 'render-fix', planFile, briefFile, sliceId: 'S1',
      impl: IMPL, findings: { verdict: 'revise', findings: [] },
      round: 1, userFeedback: '用户意见正文', ...CONTEXT_PARAMS
    }, exec('a1'))
    assert.equal(out.agentsStarted, 0)
    assert.equal(engine.runs[0].calls.length, 0)
    assert.ok(out.result.prompt.includes('## 用户意见（优先，最高优先级）'))
    assert.ok(out.result.prompt.includes('用户意见正文'))
    assert.ok(out.result.prompt.includes('## 审查意见（findings，JSON，逐条处理）'))
    assert.equal(out.result.sha12, sha12(out.result.prompt))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing required param fails before any engine start (no placeholder render)', async () => {
  const engine = workflowEngine(passingAgent)
  const { definition } = realTool(engine)
  await assert.rejects(
    () => definition.execute({ mode: 'render-implement', sliceId: 'S1', briefFile: BRIEF_FILE }, exec('a1')),
    (error) => {
      assert.match(error.message, /参数错误/)
      assert.match(error.message, /render-implement/)
      assert.match(error.message, /planFile/)
      return true
    }
  )
  assert.equal(engine.runs.length, 0)
})

test('an unreadable planFile fails before any engine start', async () => {
  const engine = workflowEngine(passingAgent)
  const { definition } = realTool(engine)
  await assert.rejects(
    () => definition.execute({
      mode: 'render-implement', planFile: join(tmpdir(), 'definitely-missing-plan.json'),
      sliceId: 'S1'
    }, exec('a1')),
    /planFile 读取失败/
  )
  assert.equal(engine.runs.length, 0)
})

test('a briefFile missing the architecture layer is rejected, not rendered as a placeholder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const briefFile = join(dir, 'brief.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefFile, JSON.stringify({ sliceId: 'S1', details: 'det' }))
    const engine = workflowEngine(passingAgent)
    const { definition } = realTool(engine)
    await assert.rejects(
      () => definition.execute({
        mode: 'render-implement', planFile, briefFile,
        sliceId: 'S1', ...CONTEXT_PARAMS
      }, exec('a1')),
      (error) => {
        assert.match(error.message, /architecture/)
        return true
      }
    )
    assert.equal(engine.runs.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an oversized task book fails fast instead of being truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const hugePlan = {
      ...PLAN,
      slices: PLAN.slices.map((slice) => ({
        ...slice,
        brief: {
          sliceId: 'S1',
          architecture: 'arch',
          details: 'lib/x.js:1 加缓存；验证：exit 0；' + 'x'.repeat(MAX_RESULT_CHARS + 100)
        }
      }))
    }
    await writeFile(planFile, JSON.stringify(await seedDesign(dir, hugePlan)))
    const engine = workflowEngine(passingAgent)
    const { definition, running } = realTool(engine)
    await assert.rejects(
      () => definition.execute({
        mode: 'render-implement', planFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
      }, exec('a1')),
      (error) => {
        assert.match(error.message, /MAX_RESULT_CHARS/)
        assert.equal(/truncated/.test(error.message), false)
        return true
      }
    )
    assert.equal(engine.runs[0].disposed, 1)
    assert.equal(running.size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('design and review host calls forward the stage params and return the documented fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const briefPath = join(dir, 'brief.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(briefPath, JSON.stringify(BRIEF))
    const engine = workflowEngine(passingAgent)
    const { definition } = realTool(engine)
    const design = await definition.execute({
      mode: 'design', requirement: 'r', discussionDigest: '已确认', ...CONTEXT_PARAMS
    }, exec('a1'))
    assert.equal(design.agentsStarted, 1)
    assert.equal(design.result.nextAction, 'ask-user')
    assert.deepEqual(design.result.openQuestions, [])
    assert.deepEqual(design.result.runContext,
      { repoRoot: 'C:/w', workspace: null, outDir: 'C:/w/AIOut/t', taskName: 't' })

    const review = await definition.execute({
      mode: 'review', planFile, briefFile: briefPath, sliceId: 'S1', impl: IMPL,
      patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 1, userFeedback: '',
      preflight: 'exit 0', ...CONTEXT_PARAMS
    }, exec('a2'))
    assert.equal(review.agentsStarted, 1)
    assert.equal(review.result.codeReviewVerdict, 'pass')
    assert.equal(review.result.redCount, 0)
    assert.equal(review.result.fixExhausted, false)
    assert.equal(review.result.nextAction, 'deliver')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2026-11-03：brief 由主会话写入 plan.json；planReview/briefReview 归档
// ---------------------------------------------------------------------------
test('plan-only forwards discussionDigest to the design prompt', async () => {
  const run = await runScript(
    { ...BASE, mode: 'plan-only', requirement: 'r', discussionDigest: '已确认：只改 lib/x.js' },
    () => PLAN
  )
  assert.equal(run.error, null)
  assert.ok(run.calls[0].prompt.includes('已确认：只改 lib/x.js'))
})

test('batch slice fails fast when plan.json has no brief', async () => {
  const planNoBrief = {
    ...PLAN,
    slices: PLAN.slices.map((slice) => {
      const copy = { ...slice }
      delete copy.brief
      return copy
    })
  }
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: planNoBrief, sliceId: 'S1', ...CONTEXT },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.result.ok, false)
  assert.equal(run.result.stage, 'brief')
  assert.match(run.result.reason, /plan\.json/)
  assert.equal(run.calls.length, 0)
})

test('render-implement renders from the brief embedded in plan.json (no briefFile)', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: PLAN, sliceId: 'S1', ...CONTEXT },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.ok(run.result.prompt.includes(BRIEF.architecture))
  assert.equal(run.calls.length, 0)
})

test('render-implement rejects a brief that belongs to another slice', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: PLAN, sliceId: 'S1', brief: { ...BRIEF, sliceId: 'S2' }, ...CONTEXT },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /不一致/)
})

test('render-implement rejects a brief without file:line', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: PLAN, sliceId: 'S1', brief: { ...BRIEF, details: '改缓存；验证：exit 0' }, ...CONTEXT },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /file:line/)
})

test('render-implement rejects a brief without a verification command', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: PLAN, sliceId: 'S1', brief: { ...BRIEF, details: 'lib/x.js:42 加缓存' }, ...CONTEXT },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /验证命令/)
})

test('render-implement host call works without briefFile (brief from plan.json)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(await seedDesign(dir, PLAN)))
    const engine = workflowEngine(passingAgent)
    const { definition } = realTool(engine)
    const out = await definition.execute({
      mode: 'render-implement', planFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
    }, exec('a1'))
    assert.equal(out.agentsStarted, 0)
    assert.equal(engine.runs[0].calls.length, 0)
    assert.ok(out.result.prompt.includes(BRIEF.architecture))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('batch slice projects the plan brief even when the brief stage is trimmed', async () => {
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: PLAN, sliceId: 'S1', stages: { slice: ['implement', 'codeReview'] }, ...CONTEXT },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.deepEqual(run.calls.map((call) => call.opts.label), ['impl:S1', 'code-review:S1'])
  assert.ok(run.calls[0].prompt.includes(BRIEF.architecture))
})

test('batch slice refuses to implement without a plan brief even when the brief stage is trimmed', async () => {
  const planNoBrief = {
    ...PLAN,
    slices: PLAN.slices.map((slice) => {
      const copy = { ...slice }
      delete copy.brief
      return copy
    })
  }
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: planNoBrief, sliceId: 'S1', stages: { slice: ['implement', 'codeReview'] }, ...CONTEXT },
    passingAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.result.ok, false)
  assert.equal(run.result.stage, 'implement')
  assert.equal(run.calls.length, 0)
})

test('design schema requires a complete research block', async () => {
  const run = await runScript(
    { ...BASE, mode: 'design', requirement: 'r', discussionDigest: 'd' },
    () => ({ ...PLAN, decisions: [], openQuestions: [] })
  )
  const research = run.calls[0].opts.schema.properties.slices.items.properties.research
  assert.deepEqual(research.required, ['symbols', 'files', 'verify'])
  assert.ok(Array.isArray(research.properties.symbols.items.required))
})

test('batch slice rejects a plan brief that belongs to another slice', async () => {
  const planWrongBrief = {
    ...PLAN,
    slices: [{ ...PLAN.slices[0], brief: { ...BRIEF, sliceId: 'S2' } }]
  }
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: planWrongBrief, sliceId: 'S1', ...CONTEXT },
    passingAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /不一致/)
  assert.equal(run.calls.length, 0)
})

test('round-2 incremental review uses the focused prompt and schema', async () => {
  const previousReview = {
    round: 1,
    codeReview: {
      verdict: 'revise',
      findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: '缓存未失效', fix: 'FIX_MARKER_SHOULD_NOT_APPEAR', evidence: 'EVIDENCE_MARKER_SHOULD_NOT_APPEAR' }]
    }
  }
  const run = await runScript({
    ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1',
    impl: { ...IMPL, changedSymbols: ['cacheFn'] },
    patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 2, userFeedback: '修了缓存',
    preflight: 'exit 0', reviewScope: 'incremental', previousReview,
    deltaPath: 'C:/w/AIOut/t/S1-fix-r1.patch', ...CONTEXT
  }, () => ({
    verdict: 'pass',
    findings: [],
    standardPath: ECHO,
    previousFindings: [{ issue: '缓存未失效', file: 'lib/x.js', line: '1', status: 'resolved', evidence: 'lib/x.js:1' }]
  }))
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 1)
  assert.ok(run.calls[0].prompt.includes('对账式复审'))
  assert.ok(run.calls[0].prompt.includes('缓存未失效'))
  assert.ok(run.calls[0].prompt.includes('S1-fix-r1.patch'))
  // 0.8.1：聚焦复审不喂上一轮模型输出原文（只给位置与问题）
  assert.equal(run.calls[0].prompt.includes('FIX_MARKER_SHOULD_NOT_APPEAR'), false)
  assert.equal(run.calls[0].prompt.includes('EVIDENCE_MARKER_SHOULD_NOT_APPEAR'), false)
  assert.ok(run.calls[0].prompt.includes('本次是代码质量与风险审查'))
  assert.ok(run.calls[0].prompt.includes('不要求复现'))
  assert.equal(run.calls[0].opts.schema.required.includes('previousFindings'), true)
  assert.equal(run.result.reviewScope, 'incremental')
  assert.equal(run.result.reviewAlignment, null)
  assert.equal(run.result.previousFindings[0].status, 'resolved')
})

test('incremental review rejects a previous review from the wrong round', async () => {
  const run = await runScript({
    ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', impl: IMPL,
    patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 2, userFeedback: '修了',
    preflight: 'exit 0', reviewScope: 'incremental',
    previousReview: { round: 0, codeReview: { verdict: 'pass', findings: [] } }, ...CONTEXT
  }, passingAgent)
  assert.ok(run.error)
  assert.match(run.error.message, /不一致/)
})

test('incremental review without previousReview fails fast', async () => {
  const run = await runScript({
    ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', impl: IMPL,
    patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 2, userFeedback: '修了',
    preflight: 'exit 0', reviewScope: 'incremental', ...CONTEXT
  }, passingAgent)
  assert.ok(run.error)
  assert.match(run.error.message, /previousReview/)
})

test('full review round 2 carries the upgrade reason', async () => {
  const run = await runScript({
    ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', impl: IMPL,
    patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 2, userFeedback: '修了',
    preflight: 'exit 0', reviewScope: 'full', upgradeReason: '变更符号 8 个（>6）', ...CONTEXT
  }, () => ({
    verdict: 'pass', findings: [], standardPath: ECHO, blindFindings: [], withdrawn: []
  }))
  assert.equal(run.error, null)
  assert.ok(run.calls[0].prompt.includes('本轮由增量复审升级为全量'))
  assert.ok(run.calls[0].prompt.includes('变更符号 8 个'))
  assert.equal(run.result.reviewScope, 'full')
  assert.equal(run.result.upgradeReason, '变更符号 8 个（>6）')
})

test('fix prompt asks for a delta patch and the new impl fields', async () => {
  let reviewCalls = 0
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: PLAN_D, sliceId: 'S1', ...CONTEXT },
    (prompt, opts) => {
      const label = String(opts.label || '');
      if (label.startsWith('impl')) {
        return { sliceId: 'S1', patchPath: IMPL.patchPath, docPath: IMPL.docPath, verifyResult: 'exit 0' }
      }
      if (label.startsWith('code-review')) {
        reviewCalls += 1
        return reviewCalls === 1
          ? { verdict: 'revise', findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e' }], standardPath: ECHO }
          : { verdict: 'pass', findings: [], standardPath: ECHO }
      }
      return { sliceId: 'S1', patchPath: IMPL.patchPath, docPath: IMPL.docPath, verifyResult: 'exit 0' }
    }
  )
  assert.equal(run.error, null)
  const fixCall = run.calls.find((call) => String(call.opts.label).startsWith('fix-1'))
  assert.ok(fixCall, 'fix stage must run')
  assert.ok(fixCall.prompt.includes('git stash create'))
  assert.ok(fixCall.prompt.includes('S1-fix-r1.patch'))
  assert.ok(fixCall.opts.schema.properties.changedSymbols)
  assert.ok(fixCall.opts.schema.properties.fixDeltaPath)
  // S2：最小修复约束与过度修复检查
  assert.ok(fixCall.prompt.includes('最小修复（硬约束）'))
  const implCall = run.calls.find((call) => String(call.opts.label).startsWith('impl'))
  assert.ok(implCall.prompt.includes('最小实现'))
  const reviewCall = run.calls.find((call) => String(call.opts.label).startsWith('code-review'))
  assert.ok(reviewCall.prompt.includes('over-fix'))
  const findingProps = reviewCall.opts.schema.properties.findings.items.properties
  assert.deepEqual(findingProps.category.enum, ['defect', 'over-fix', 'over-design', 'performance'])
  // 0.8.0：CPU/GPU 热路径清单移到运行时规范，prompt 只引用规范
  const runtime = await readFile(join(ROOT, 'docs', 'review', 'review-standard.md'), 'utf8')
  assert.ok(reviewCall.prompt.includes('十维清单'))
  assert.ok(runtime.includes('CPU 热路径'))
  assert.ok(runtime.includes('GPU 热路径'))
  assert.ok(runtime.includes('可能影响性能'))
  assert.ok(implCall.prompt.includes('最小防御'))
  assert.ok(fixCall.prompt.includes('最小防御'))
})

test('prompts cite the injected plain-language path (S3)', async () => {
  const plain = 'C:/p/docs/shared/plain-language.md'
  const run = await runScript({
    ...BASE, mode: 'design', requirement: 'r', discussionDigest: 'd', plainLanguagePath: plain,
    repoRoot: 'C:/w', outDir: 'C:/w/AIOut/t', taskName: 't'
  }, () => PLAN)
  assert.equal(run.error, null)
  assert.ok(run.calls[0].prompt.includes('产出语言规范'))
  assert.ok(run.calls[0].prompt.includes(plain))
})

// ---------------------------------------------------------------------------
// 0.9.0：design 溯源（designRef + design.json + brief research 引用）
// ---------------------------------------------------------------------------
test('design host call persists design.json and returns designRef', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const engine = workflowEngine(passingAgent)
    const { definition } = realTool(engine)
    const out = await definition.execute({
      mode: 'design', requirement: 'r', discussionDigest: '已确认', ...CONTEXT_PARAMS, outDir: dir
    }, exec('a1'))
    assert.match(out.result.designRef, /^[0-9a-f]{64}$/)
    assert.equal(out.result.designPath, join(dir, 'design.json'))
    const saved = JSON.parse(await readFile(join(dir, 'design.json'), 'utf8'))
    assert.equal(saved.designRef, out.result.designRef)
    assert.equal(saved.plan.slices[0].id, 'S1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('render-implement rejects a plan without designRef', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    const { definition } = realTool(workflowEngine(passingAgent))
    await assert.rejects(
      () => definition.execute({
        mode: 'render-implement', planFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
      }, exec('a1')),
      /designRef/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('render-implement rejects slices edited after design', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const seeded = await seedDesign(dir, PLAN)
    const tampered = {
      ...seeded,
      slices: [{ ...seeded.slices[0], title: 'T2' }]
    }
    await writeFile(planFile, JSON.stringify(tampered))
    const { definition } = realTool(workflowEngine(passingAgent))
    await assert.rejects(
      () => definition.execute({
        mode: 'render-implement', planFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
      }, exec('a1')),
      /不一致/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('render-implement rejects a brief that ignores design research', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    const seeded = await seedDesign(dir, PLAN)
    const plan = {
      ...seeded,
      slices: [{
        ...seeded.slices[0],
        brief: { ...BRIEF, details: 'lib/y.js:7 加缓存；验证：exit 0' }
      }]
    }
    await writeFile(planFile, JSON.stringify(plan))
    const { definition } = realTool(workflowEngine(passingAgent))
    await assert.rejects(
      () => definition.execute({
        mode: 'render-implement', planFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
      }, exec('a1')),
      /research/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('designProvenance=off keeps legacy plans renderable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    const definition = createPipelineTool({
      pluginRoot: ROOT,
      getConfig: () => readConfig({ designProvenance: 'off' }),
      engine: workflowEngine(passingAgent),
      jobs: undefined
    }).definition
    const out = await definition.execute({
      mode: 'render-implement', planFile, sliceId: 'S1', ...CONTEXT_PARAMS, outDir: dir
    }, exec('a1'))
    assert.equal(out.result.mode, 'render-implement')
    assert.ok(out.result.prompt.includes(BRIEF.architecture))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 0.10.0：Lead 侧 subagent 复审（renderReview / codeReview）
// ---------------------------------------------------------------------------
test('renderReview returns the review task book without dispatching an agent', async () => {
  const run = await runScript({
    ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', impl: IMPL,
    patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 1, userFeedback: '',
    preflight: 'exit 0', renderReview: true, reviewPackage: { path: 'pkg.md', mode: 'full' }, ...CONTEXT
  }, passingAgent)
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 0)
  assert.equal(run.result.mode, 'review-render')
  assert.equal(run.result.schemaName, 'ALIGNED_REVIEW_SCHEMA')
  assert.ok(run.result.prompt.includes('最终只输出一个 JSON'))
  assert.ok(run.result.prompt.includes('.payload.json'))
  assert.ok(run.result.prompt.includes('reviewPath'))
  assert.ok(run.result.prompt.includes('两段式审查'))
})

test('codeReview ingest computes redCount/nextAction without dispatching an agent', async () => {
  const run = await runScript({
    ...BASE, mode: 'review', plan: PLAN, sliceId: 'S1', impl: IMPL,
    patchPath: IMPL.patchPath, docPath: IMPL.docPath, round: 1, userFeedback: '',
    preflight: 'exit 0', ...CONTEXT,
    codeReview: {
      verdict: 'revise', standardPath: ECHO, blindFindings: [], withdrawn: [],
      findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e', source: 'blind' }]
    }
  }, passingAgent)
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 0)
  assert.equal(run.result.reviewScope, 'full')
  assert.equal(run.result.redCount, 1)
  assert.equal(run.result.nextAction, 'send-fix')
})

test('host renderReview returns prompt + sha12 + reviewer effort and starts no agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n')
    await writeFile(docPath, '## 1. 目标与范围\n范围\n## 2. 接口与行为变更\n接口\n## 3. 关键设计说明\n设计\n## 4. 验证记录\n验证\n')
    await writeFile(planFile, JSON.stringify(PLAN))
    const engine = workflowEngine(passingAgent)
    const definition = createPipelineTool({
      pluginRoot: ROOT,
      getConfig: () => readConfig({ reasoningEfforts: { reviewer: 'max' } }),
      engine,
      jobs: undefined
    }).definition
    const out = await definition.execute({
      mode: 'review', renderReview: true, planFile, sliceId: 'S1', impl: { patchPath, docPath, verifyResult: 'exit 0' },
      patchPath, docPath, round: 1, userFeedback: '', preflight: 'exit 0',
      ...CONTEXT_PARAMS, outDir
    }, exec('a1'))
    assert.equal(out.agentsStarted, 0)
    assert.equal(engine.runs[0].calls.length, 0)
    assert.ok(out.result.prompt.includes('最终只输出一个 JSON'))
    assert.ok(out.result.reviewPackage, 'renderReview must build a review package')
    assert.equal(out.result.reviewPackage.docMode, 'trimmed')
    assert.ok(out.result.reviewPackage.path.startsWith(join(outDir, 'reviews')))
    assert.ok(out.result.prompt.includes(out.result.reviewPackage.path))
    assert.equal(out.result.sha12, sha12(out.result.prompt))
    assert.equal(out.result.reasoningEffort, 'max')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('round-1 review prompt hides the plan brief and research from the blind pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    const plan = {
      ...PLAN,
      slices: [{
        ...PLAN.slices[0],
        research: { symbols: ['SECRET_SYMBOL_7a'], files: [], forbidden: [], verify: [] },
        brief: { ...BRIEF, architecture: 'SECRET_ARCH_9f' }
      }]
    }
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n')
    await writeFile(docPath, '# doc')
    await writeFile(planFile, JSON.stringify(plan))
    const definition = createPipelineTool({
      pluginRoot: ROOT, getConfig: () => readConfig({}), engine: workflowEngine(passingAgent), jobs: undefined
    }).definition
    const out = await definition.execute({
      mode: 'review', renderReview: true, planFile, sliceId: 'S1',
      impl: { patchPath, docPath, verifyResult: 'exit 0' },
      patchPath, docPath, round: 1, userFeedback: '', preflight: 'exit 0',
      ...CONTEXT_PARAMS, outDir
    }, exec('a1'))
    assert.equal(out.result.prompt.includes('SECRET_ARCH_9f'), false)
    assert.equal(out.result.prompt.includes('SECRET_SYMBOL_7a'), false)
    assert.ok(out.result.prompt.includes('-brief-arch-r1.md'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('host codeReview ingest persists the review and returns nextAction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n')
    await writeFile(docPath, '# doc')
    await writeFile(planFile, JSON.stringify(PLAN))
    const definition = realTool(workflowEngine(passingAgent)).definition
    const out = await definition.execute({
      mode: 'review', planFile, sliceId: 'S1', impl: { patchPath, docPath, verifyResult: 'exit 0' }, patchPath, docPath,
      round: 1, userFeedback: '', preflight: 'exit 0', ...CONTEXT_PARAMS, outDir,
      codeReview: { verdict: 'pass', standardPath: ECHO, blindFindings: [], withdrawn: [], findings: [] }
    }, exec('a1'))
    assert.equal(out.agentsStarted, 0)
    assert.equal(out.result.redCount, 0)
    assert.equal(out.result.nextAction, 'deliver')
    const saved = JSON.parse(await readFile(join(outDir, 'reviews', 'S1-review-r1.json'), 'utf8'))
    assert.equal(saved.round, 1)
    assert.equal(saved.verdict, 'pass')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('host codeReview accepts {reviewPath} and writes the canonical envelope separately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    const reviews = join(outDir, 'reviews')
    await mkdir(reviews, { recursive: true })
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n')
    await writeFile(docPath, '# doc')
    await writeFile(planFile, JSON.stringify(PLAN))
    const payload = join(reviews, 'S1-review-r1.payload.json')
    await writeFile(payload, JSON.stringify({
      verdict: 'revise', standardPath: ECHO, blindFindings: [], withdrawn: [],
      findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e', source: 'blind' }]
    }))
    const definition = realTool(workflowEngine(passingAgent)).definition
    const out = await definition.execute({
      mode: 'review', planFile, sliceId: 'S1', impl: { patchPath, docPath, verifyResult: 'exit 0' }, patchPath, docPath,
      round: 1, userFeedback: '', preflight: 'exit 0', ...CONTEXT_PARAMS, outDir,
      codeReview: { reviewPath: payload }
    }, exec('a1'))
    assert.equal(out.result.redCount, 1)
    assert.equal(out.result.nextAction, 'send-fix')
    const canonical = JSON.parse(await readFile(join(reviews, 'S1-review-r1.json'), 'utf8'))
    assert.equal(canonical.round, 1)
    assert.equal(canonical.codeReview.verdict, 'revise')
    assert.equal(JSON.parse(await readFile(payload, 'utf8')).verdict, 'revise')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reviewPath cannot be mixed with a full review payload', () => {
  const checked = validateRunParams({
    mode: 'review', planFile: 'C:/w/plan.json', sliceId: 'S1', impl: {}, patchPath: 'C:/w/S1.patch',
    docPath: 'C:/w/S1.md', round: 1, userFeedback: '', preflight: 'exit 0',
    codeReview: { reviewPath: 'C:/w/reviews/S1-review-r1.payload.json', verdict: 'pass' }
  })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /不能与完整 review 字段混用/)
})

test('reviewPath outside outDir/reviews is rejected before the workflow starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-modes-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    const outside = join(dir, 'outside.json')
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n')
    await writeFile(docPath, '# doc')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(outside, JSON.stringify({ verdict: 'pass', standardPath: ECHO, findings: [] }))
    const definition = realTool(workflowEngine(passingAgent)).definition
    await assert.rejects(() => definition.execute({
      mode: 'review', planFile, sliceId: 'S1', impl: { patchPath, docPath, verifyResult: 'exit 0' }, patchPath, docPath,
      round: 1, userFeedback: '', preflight: 'exit 0', ...CONTEXT_PARAMS, outDir,
      codeReview: { reviewPath: outside }
    }, exec('a1')), /outDir\/reviews|必须位于/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
