import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from './helpers/run-workflow.js'
import { resolveModules } from '../lib/paths.js'
import { readConfig } from '../lib/config.js'
import { buildPipelineArgs } from '../lib/inject.js'
import { DESKTOP_CONFIG, ROLES, fakeModules } from './helpers/fixtures.js'

const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url))

const BRIEF = {
  sliceId: 'S1',
  architecture: '只在 lib/x.js 增加缓存层，不动上游',
  details: 'lib/x.js:42 增加缓存；验证：node --test test/x.test.js（exit 0）'
}
const PLAN = {
  summary: 's',
  interfaceContract: 'c',
  slices: [{
    id: 'S1',
    title: 'T1',
    scope: 'x',
    acceptance: 'a',
    brief: BRIEF,
    discussion: {
      sliceId: 'S1',
      understanding: '本片只落地 S1 的接口增量',
      decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
      openQuestions: [],
      userConfirmed: true
    }
  }]
}
const base = {
  roles: ROLES,
  modules: fakeModules(),
  reviewStandardPath: 'C:/p/docs/review/review-standard.md'
}
const slice = (extra) => runWorkflow({ ...base, mode: 'slice', sliceId: 'S1', plan: PLAN, ...extra })
const planOnly = (extra) => runWorkflow({
  ...base, mode: 'plan-only', requirement: 'r',
  stages: { plan: ['design'] }, ...extra
})
const route = (call) => call.opts.provider + '/' + call.opts.model

test('legacy args (no modules) still run and log the skipped checks', async () => {
  const { result, logs } = await runWorkflow({
    mode: 'plan-only', requirement: 'r', roles: ROLES, stages: { plan: ['design'] }
  })
  assert.equal(result.ok, true)
  assert.ok(logs.some((l) => l.includes('legacy call')))
})

test('real injected JSON drives the workflow end to end', async () => {
  const config = readConfig(DESKTOP_CONFIG)
  const states = await resolveModules(config, { pluginRoot: PLUGIN_ROOT })
  const injected = buildPipelineArgs(config, states, PLUGIN_ROOT)
  const { result, error, calls } = await runWorkflow({
    ...injected, mode: 'slice', sliceId: 'S1', plan: PLAN
  })
  assert.equal(error, null)
  assert.equal(result.ok, true)
  assert.equal(calls[0].opts.label, 'impl:S1')
  assert.equal(route(calls.find((c) => c.opts.label === 'impl:S1')), 'deepseek-official/deepseek-v4.1-flash')
  assert.equal(route(calls.find((c) => c.opts.label === 'code-review:S1')), 'paper-anthropic/claude-opus-5-5')
  assert.equal(result.reviewStandardConfirmed, true)
  // S3：宿主注入的产出语言规范绝对路径进入各阶段 prompt。
  assert.ok(injected.plainLanguagePath.endsWith('docs/shared/plain-language.md'))
  assert.ok(calls.find((c) => c.opts.label === 'impl:S1').prompt.includes(injected.plainLanguagePath))
  assert.ok(calls.find((c) => c.opts.label === 'code-review:S1').prompt.includes(injected.reviewStandardPath))
})

test('default modules keep the stage→role mapping (brief is not dispatched)', async () => {
  const { calls } = await slice({})
  assert.deepEqual(calls.map((c) => [c.opts.label, route(c)]), [
    ['impl:S1', 'ptask/mtask'], ['code-review:S1', 'prev/mrev']
  ])
})

test('module roles remap stage routes', async () => {
  const planRun = await planOnly({ modules: fakeModules({ planning: { role: 'task' } }) })
  assert.deepEqual(planRun.calls.map(route), ['ptask/mtask'])
  const sliceRun = await slice({ modules: fakeModules({ review: { role: 'designer' } }) })
  assert.equal(route(sliceRun.calls.find((c) => c.opts.label === 'code-review:S1')), 'pdes/mdes')
})

test('disabled review blocks before any agent call', async () => {
  const { error, calls } = await slice({
    modules: fakeModules({ review: { enabled: false, status: 'disabled' } })
  })
  assert.equal(calls.length, 0)
  assert.match(error.message, /review \(needed by codeReview, fix\): disabled/)
  assert.match(error.message, /Slice Pipeline/)
})

test('missing template blocks implement and names the file', async () => {
  const missing = 'C:/p/docs/patch-delivery/thin-document-template.md'
  const { error, calls } = await slice({
    modules: fakeModules({ patchDelivery: { status: 'missingDoc', missing: [missing] } })
  })
  assert.equal(calls.length, 0)
  assert.ok(error.message.includes('patchDelivery (needed by implement, fix): missingDoc ' + missing))
})

test('disabled workspaceRecovery blocks implement', async () => {
  const { error } = await slice({
    modules: fakeModules({ workspaceRecovery: { enabled: false, status: 'disabled' } })
  })
  assert.match(error.message, /workspaceRecovery \(needed by implement, fix\): disabled/)
})

test('design prompt does not advertise diagrams even when the module is enabled', async () => {
  const disabled = await runWorkflow({
    mode: 'plan-only', requirement: 'r', roles: ROLES,
    modules: fakeModules({ diagrams: { enabled: false, status: 'disabled' } }),
    stages: { plan: ['design'] }
  })
  assert.equal(disabled.result.ok, true)
  assert.equal(disabled.calls[0].prompt.includes('docs/diagrams/standard.md'), false)

  const enabled = await runWorkflow({
    mode: 'plan-only', requirement: 'r', roles: ROLES,
    modules: fakeModules(), stages: { plan: ['design'] }
  })
  assert.equal(enabled.result.ok, true)
  assert.equal(enabled.calls[0].prompt.includes('C:/p/docs/diagrams/standard.md'), false)
})

test('prompts carry their stage standards', async () => {
  const { calls } = await slice({})
  const impl = calls.find((c) => c.opts.label === 'impl:S1').prompt
  const review = calls.find((c) => c.opts.label === 'code-review:S1').prompt
  assert.ok(impl.includes('C:/p/docs/patch-delivery/standard.md'))
  assert.ok(impl.includes('代码放置与 include 顺序'), 'implement prompt must cite the placement standard')
  assert.ok(review.includes('代码放置与 include 顺序'), 'code review prompt must cite the placement standard')
  assert.ok(impl.includes('C:/p/docs/patch-delivery/thin-document-template.md'))
  assert.ok(impl.includes('C:/p/docs/workspace-recovery/standard.md'))
  assert.ok(review.includes('C:/p/docs/review/review-standard.md'))
  assert.ok(review.includes('standardPath'))
})

test('inline reviewStandard overrides the path and tolerates a missing review doc', async () => {
  const { result, calls, logs } = await slice({
    reviewStandard: '# 自定义\n- 规则 A',
    modules: fakeModules({ review: { status: 'missingDoc', missing: ['C:/p/x.md'] } })
  })
  assert.equal(result.ok, true)
  assert.ok(calls.find((c) => c.opts.label === 'code-review:S1').prompt.includes('规则 A'))
  assert.equal(result.reviewStandardConfirmed, null)
  assert.ok(logs.some((l) => l.includes('inline override')))
})

test('echo differing only in case and separators confirms', async () => {
  const { result } = await runWorkflow(
    { ...base, mode: 'slice', sliceId: 'S1', plan: PLAN },
    { echo: 'c:\\p\\docs\\review\\review-standard.md' }
  )
  assert.equal(result.reviewStandardConfirmed, true)
})

test('mismatched echo yields false and a warning', async () => {
  const { result, logs } = await runWorkflow(
    { ...base, mode: 'slice', sliceId: 'S1', plan: PLAN },
    { echo: 'C:/other.md' }
  )
  assert.equal(result.reviewStandardConfirmed, false)
  assert.ok(logs.some((l) => l.includes('standardPath mismatch')))
})

test('fallback guide no longer cites ~/.dsh/AGENTS.md', async () => {
  const { calls } = await runWorkflow({ mode: 'slice', sliceId: 'S1', plan: PLAN, roles: ROLES })
  const p = calls.find((c) => c.opts.label === 'code-review:S1').prompt
  assert.equal(p.includes('~/.dsh/AGENTS.md'), false)
  assert.ok(p.includes('fallback'))
})

test('malformed modules fail fast', async () => {
  assert.match((await slice({ modules: [] })).error.message, /args\.modules must be an object/)
  assert.match(
    (await slice({ modules: { planning: { enabled: 'yes' } } })).error.message,
    /args\.modules\.planning\.enabled must be a boolean/
  )
})

test('archived review stages are dropped and never dispatched', async () => {
  const { calls, logs } = await slice({
    stages: { slice: ['brief', 'briefReview', 'implement', 'codeReview'] }
  })
  assert.equal(calls.some((c) => c.opts.label === 'brief-review:S1'), false)
  assert.ok(calls.some((c) => c.opts.label === 'code-review:S1'))
  assert.ok(logs.some((l) => l.includes('briefReview') && l.includes('已归档')))
  const review = calls.find((c) => c.opts.label === 'code-review:S1')
  assert.ok(review.opts.schema.required.includes('standardPath'))
})

test('slice result carries the actual resolved route for every stage role', async () => {
  const { result } = await slice({})
  assert.equal(result.routes.review.route, 'prev/mrev')
  assert.equal(result.routes.planning.role, 'designer')
  assert.deepEqual(result.routes.delivery, { role: 'task', route: 'ptask/mtask' })
})

test('plan-only result carries the same routes object', async () => {
  const { result } = await planOnly({})
  assert.equal(result.routes.planning.route, 'pdes/mdes')
  assert.equal(result.routes.review.role, 'reviewer')
})

test('design failure result still carries routes', async () => {
  const { result } = await runWorkflow(
    { ...base, mode: 'plan-only', requirement: 'r', stages: { plan: ['design'] } },
    { failLabels: ['design-plan'] }
  )
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'design')
  assert.equal(result.routes.planning.role, 'designer')
  assert.equal(result.routes.planning.route, 'pdes/mdes')
})

test('plan-only drops archived planReview and logs a warning', async () => {
  const run = await runWorkflow({
    ...base, mode: 'plan-only', requirement: 'r',
    stages: { plan: ['design', 'planReview'] }
  })
  assert.deepEqual(run.calls.map((c) => c.opts.label), ['design-plan'])
  assert.ok(run.logs.some((l) => l.includes('planReview') && l.includes('已归档')))
})
