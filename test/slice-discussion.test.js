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

const DISCUSSION = {
  sliceId: 'S1',
  understanding: '本片只落地 S1 的接口增量与写入范围，不做跨片重构',
  decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
  rejected: [{ option: '顺手重构上游模块', reason: '超出本片范围' }],
  openQuestions: [],
  userConfirmed: true
}

const BRIEF = { sliceId: 'S1', architecture: 'arch', details: 'lib/x.js:42 加缓存；验证：exit 0' }

const slice = (discussion) => {
  const entry = { id: 'S1', title: 'T1', scope: 'x', acceptance: 'a', brief: { ...BRIEF } }
  if (discussion !== undefined) entry.discussion = discussion
  return entry
}
const planWith = (discussion) => ({ summary: 's', interfaceContract: 'c', slices: [slice(discussion)] })

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

const briefAgent = (prompt, opts) => {
  const label = String(opts.label || '')
  if (label.startsWith('brief')) return BRIEF
  if (label.startsWith('impl')) {
    return { sliceId: 'S1', patchPath: 'C:/w/AIOut/t/S1.patch', docPath: 'C:/w/AIOut/t/S1.md', verifyResult: 'exit 0' }
  }
  if (label.startsWith('code-review')) return { verdict: 'pass', findings: [], standardPath: ECHO }
  throw new Error('unexpected agent label: ' + label)
}

const briefRun = (plan, extra) => runScript(
  { ...BASE, mode: 'brief', plan, sliceId: 'S1', ...CONTEXT, ...extra },
  briefAgent
)

// ---------------------------------------------------------------------------
// 每片讨论门禁：没有讨论记录不得派发 brief
// ---------------------------------------------------------------------------
test('brief refuses to dispatch when the slice has no discussion record', async () => {
  const run = await briefRun(planWith(undefined))
  assert.ok(run.error, 'expected a hard failure')
  assert.match(run.error.message, /discussion/)
  assert.match(run.error.message, /slices\[i\]\.discussion/)
  assert.equal(run.calls.length, 0, 'no agent may run without a discussion record')
})

test('brief refuses a discussion carried over from another slice', async () => {
  const run = await briefRun(planWith({ ...DISCUSSION, sliceId: 'S2' }))
  assert.ok(run.error)
  assert.match(run.error.message, /与本片不一致/)
  assert.equal(run.calls.length, 0)
})

test('brief refuses a discussion the user has not confirmed', async () => {
  const run = await briefRun(planWith({ ...DISCUSSION, userConfirmed: false }))
  assert.ok(run.error)
  assert.match(run.error.message, /userConfirmed/)
  assert.equal(run.calls.length, 0)
})

test('brief refuses a discussion with no decisions and no waiver', async () => {
  const run = await briefRun(planWith({ ...DISCUSSION, decisions: [] }))
  assert.ok(run.error)
  assert.match(run.error.message, /decisions/)
  assert.equal(run.calls.length, 0)
})

test('brief refuses an empty understanding', async () => {
  const run = await briefRun(planWith({ ...DISCUSSION, understanding: '   ' }))
  assert.ok(run.error)
  assert.match(run.error.message, /understanding/)
  assert.equal(run.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 未决问题：交回用户，不派发 brief
// ---------------------------------------------------------------------------
test('open questions stop the slice and come back as ask-user without dispatching', async () => {
  const run = await briefRun(planWith({ ...DISCUSSION, openQuestions: [' 要不要顺带改缓存层？ '] }))
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 0)
  assert.equal(run.result.stage, 'discussion')
  assert.equal(run.result.nextAction, 'ask-user')
  assert.deepEqual(run.result.openQuestions, ['要不要顺带改缓存层？'])
  assert.equal(run.result.sliceDiscussion.sliceId, 'S1')
})

test('a designer-reported conflict also maps to ask-user instead of spawn-implementer', async () => {
  const run = await briefRun(planWith(DISCUSSION), undefined)
  const conflicted = await runScript(
    { ...BASE, mode: 'brief', plan: planWith(DISCUSSION), sliceId: 'S1', ...CONTEXT },
    () => ({ ...BRIEF, openQuestions: ['契约里的签名与现有调用方冲突'] })
  )
  assert.equal(run.error, null)
  assert.equal(conflicted.error, null)
  assert.equal(conflicted.result.nextAction, 'ask-user')
  assert.deepEqual(conflicted.result.openQuestions, ['契约里的签名与现有调用方冲突'])
})

// ---------------------------------------------------------------------------
// 豁免：必须留用户原话
// ---------------------------------------------------------------------------
test('a waiver without the user quote is rejected', async () => {
  const run = await briefRun(planWith({
    sliceId: 'S1', waiver: { byUser: true, quote: '  ' }, openQuestions: []
  }))
  assert.ok(run.error)
  assert.match(run.error.message, /waiver/)
  assert.equal(run.calls.length, 0)
})

test('a waiver with the user quote skips the decisions requirement and reaches the prompt', async () => {
  const run = await briefRun(planWith({
    sliceId: 'S1', waiver: { byUser: true, quote: '这片不用讨论，直接照 S1 做' }, openQuestions: []
  }))
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 1)
  assert.ok(run.result.brief, 'the brief must be produced')
  assert.ok(run.calls[0].prompt.includes('这片不用讨论，直接照 S1 做'))
  assert.equal(run.result.nextAction, 'spawn-implementer')
})

// ---------------------------------------------------------------------------
// 批处理 mode=slice：同一道门禁
// ---------------------------------------------------------------------------
test('batch slice refuses to run without a discussion record', async () => {
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: planWith(undefined), sliceId: 'S1', ...CONTEXT },
    briefAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /discussion/)
  assert.equal(run.calls.length, 0)
})

test('batch slice stops on open questions instead of implementing', async () => {
  const run = await runScript(
    {
      ...BASE, mode: 'slice', plan: planWith({ ...DISCUSSION, openQuestions: ['切片边界要不要改'] }),
      sliceId: 'S1', ...CONTEXT
    },
    briefAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.calls.length, 0)
  assert.equal(run.result.ok, false)
  assert.equal(run.result.stage, 'discussion')
  assert.deepEqual(run.result.openQuestions, ['切片边界要不要改'])
  assert.match(run.result.reason, /未决问题/)
})

test('batch slice runs end to end once the discussion is settled', async () => {
  const run = await runScript(
    { ...BASE, mode: 'slice', plan: planWith(DISCUSSION), sliceId: 'S1', ...CONTEXT },
    briefAgent
  )
  assert.equal(run.error, null)
  assert.deepEqual(run.calls.map((call) => call.opts.label), ['impl:S1', 'code-review:S1'])
  assert.equal(run.result.ok, true)
  assert.deepEqual(run.result.sliceDiscussion, DISCUSSION)
  // 讨论记录是门禁输入，不进每个阶段的「本片定义」JSON。
  const impl = run.calls.find((call) => call.opts.label === 'impl:S1').prompt
  assert.equal(impl.includes('本片只落地 S1 的接口增量与写入范围'), false)
})

test('render-implement asks the user when the slice discussion is unsettled', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: planWith({ ...DISCUSSION, openQuestions: ['切片边界要不要改'] }), sliceId: 'S1', ...CONTEXT },
    briefAgent
  )
  assert.equal(run.error, null)
  assert.equal(run.result.nextAction, 'ask-user')
  assert.equal(run.result.stage, 'discussion')
  assert.equal(run.result.prompt, undefined)
  assert.equal(run.calls.length, 0)
})

test('render-fix round=1 re-checks the discussion gate, later rounds do not', async () => {
  const base = {
    ...BASE, mode: 'render-fix', plan: planWith({ ...DISCUSSION, openQuestions: ['切片边界要不要改'] }), sliceId: 'S1', impl: {
      sliceId: 'S1', patchPath: 'C:/w/AIOut/t/S1.patch', docPath: 'C:/w/AIOut/t/S1.md', verifyResult: 'exit 0'
    },
    findings: { verdict: 'revise', findings: [] }, userFeedback: '', ...CONTEXT
  }
  const first = await runScript({ ...base, round: 1 }, briefAgent)
  assert.equal(first.error, null)
  assert.equal(first.result.nextAction, 'ask-user')

  const later = await runScript({ ...base, round: 2 }, briefAgent)
  assert.equal(later.error, null)
  assert.ok(later.result.prompt.includes('## 审查意见'))
})

test('render-implement fails fast when the discussion record is missing', async () => {
  const run = await runScript(
    { ...BASE, mode: 'render-implement', plan: planWith(undefined), sliceId: 'S1', ...CONTEXT },
    briefAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /discussion/)
  assert.equal(run.calls.length, 0)
})

test('render-implement fails fast when the discussion is not user-confirmed', async () => {
  const run = await runScript(
    {
      ...BASE, mode: 'render-implement', plan: planWith({ ...DISCUSSION, userConfirmed: false }),
      sliceId: 'S1', ...CONTEXT
    },
    briefAgent
  )
  assert.ok(run.error)
  assert.match(run.error.message, /userConfirmed/)
  assert.equal(run.calls.length, 0)
})
