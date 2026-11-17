import test from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from '../lib/config.js'
import { resolveModules } from '../lib/paths.js'
import { buildPipelineArgs } from '../lib/inject.js'
import {
  TOOL_NAME, MAX_RESULT_CHARS, scriptIdOf, validateRunParams, buildRunArgs,
  summarizeResult, jobOutcome, renderValue
} from '../lib/pipeline-tool.js'

const config = readConfig({})
const states = await resolveModules(config, {
  pluginRoot: '/p',
  exists: async () => true
})

test('tool name is stable', () => {
  assert.equal(TOOL_NAME, 'slice_pipeline_run')
})

test('scriptIdOf is 12 hex chars and stable', () => {
  assert.match(scriptIdOf('abc'), /^[0-9a-f]{12}$/)
  assert.equal(scriptIdOf('abc'), scriptIdOf('abc'))
  assert.notEqual(scriptIdOf('abc'), scriptIdOf('abd'))
})

test('validateRunParams rejects bad mode and missing fields', () => {
  assert.equal(validateRunParams({ mode: 'x' }).ok, false)
  assert.match(validateRunParams({ mode: 'x' }).error, /mode/)
  assert.equal(validateRunParams({ mode: 'plan-only' }).ok, false)
  assert.match(validateRunParams({ mode: 'plan-only' }).error, /requirement/)
  assert.equal(validateRunParams({ mode: 'slice', sliceId: 'S1' }).ok, false)
  assert.match(validateRunParams({ mode: 'slice', sliceId: 'S1' }).error, /plan/)
  assert.equal(validateRunParams({ mode: 'slice', sliceId: 'S1', plan: { slices: [] } }).ok, true)
})

test('buildRunArgs merges runtime fields over the injected base', () => {
  const r = buildRunArgs({ params: { mode: 'plan-only', requirement: 'r', repoRoot: '/r', maxFixRounds: 1 }, config, states })
  assert.equal(r.ok, true)
  assert.equal(r.args.mode, 'plan-only')
  assert.equal(r.args.requirement, 'r')
  assert.equal(r.args.repoRoot, '/r')
  assert.equal(r.args.maxFixRounds, 1)
  assert.deepEqual(r.args.modules, buildPipelineArgs(config, states).modules)
  assert.equal(r.args.reviewStandardPath, buildPipelineArgs(config, states).reviewStandardPath)
})

test('buildRunArgs keeps injected maxFixRounds when the param is absent', () => {
  const r = buildRunArgs({ params: { mode: 'plan-only', requirement: 'r' }, config, states })
  assert.equal(r.args.maxFixRounds, buildPipelineArgs(config, states).maxFixRounds)
})

test('buildRunArgs treats null params as not given and keeps injected values', () => {
  const base = buildPipelineArgs(config, states)
  const r = buildRunArgs({
    params: { mode: 'plan-only', requirement: 'r', stages: null, maxFixRounds: null },
    config, states
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.args.stages, base.stages)
  assert.equal(r.args.maxFixRounds, base.maxFixRounds)
})

test('buildRunArgs rejects attempts to override injected fields', () => {
  const r = buildRunArgs({
    params: { mode: 'plan-only', requirement: 'r', roles: { default: { provider: 'x', model: 'y' } },
              modules: { review: { enabled: false } }, reviewStandardPath: 'C:/evil.md' },
    config, states
  })
  assert.equal(r.ok, false)
  assert.equal(r.args, undefined)
  assert.match(r.error, /roles/)
  assert.match(r.error, /宿主/)
})

test('summarizeResult lists only the fields that exist', () => {
  const full = summarizeResult({ value: { mode: 'slice', sliceId: 'S1', patchPath: 'p.patch', docPath: 'p.md',
    codeReviewVerdict: 'revise', fixRounds: 2, nextAction: 'slice done' }, scriptId: 'ab12cd34ef56', agentsStarted: 5 })
  assert.match(full, /5 个 agent/)
  assert.match(full, /ab12cd34ef56/)
  assert.match(full, /patch: p\.patch/)
  assert.match(full, /nextAction: slice done/)
  const bare = summarizeResult({ value: { mode: 'plan-only' }, scriptId: 'ab12cd34ef56', agentsStarted: 1 })
  assert.equal(bare.includes('patch:'), false)
})

test('jobOutcome maps the three stop reasons', () => {
  assert.deepEqual(jobOutcome({ stopReason: 'completed', agentsStarted: 3, value: { ok: true } }).status, 'completed')
  assert.deepEqual(jobOutcome({ stopReason: 'cancelled' }), { status: 'killed' })
  assert.match(jobOutcome({ stopReason: 'error', error: 'boom' }).detail, /boom/)
})

test('renderValue truncates over MAX_RESULT_CHARS', () => {
  const big = renderValue({ s: 'x'.repeat(MAX_RESULT_CHARS + 50) })
  assert.match(big, /\[truncated: \d+ more characters\]/)
})

test('buildRunArgs overrides stages only when provided', () => {
  const custom = { plan: ['design'], slice: ['brief'] }
  const overridden = buildRunArgs({
    params: { mode: 'plan-only', requirement: 'r', stages: custom }, config, states
  })
  assert.deepEqual(overridden.args.stages, custom)
  const kept = buildRunArgs({ params: { mode: 'plan-only', requirement: 'r' }, config, states })
  assert.deepEqual(kept.args.stages, buildPipelineArgs(config, states).stages)
})

test('summarizeResult formats code review details and never prints undefined', () => {
  const text = summarizeResult({
    value: { codeReviewVerdict: 'revise', redCount: 2, fixRounds: 2 },
    scriptId: 'ab12cd34ef56', agentsStarted: 2
  })
  assert.match(text, /codeReview: revise（2 🔴，已修复 2 轮）/)
  assert.equal(text.includes('undefined'), false)
})

test('jobOutcome completed includes agent count and rendered value', () => {
  const outcome = jobOutcome({
    stopReason: 'completed', agentsStarted: 3, value: { ok: true }, scriptId: 'ab12cd34ef56'
  })
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.detail, '3 agents')
  assert.match(outcome.result, /"ok": true/)
  assert.match(outcome.result, /script=ab12cd34ef56/)
})

test('validateRunParams rejects unknown keys and names the injected fields', () => {
  for (const key of ['roles', 'modules', 'reviewStandardPath']) {
    const r = validateRunParams({ mode: 'plan-only', requirement: 'r', [key]: {} })
    assert.equal(r.ok, false, key)
    assert.ok(r.error.includes(key), `${key} missing from: ${r.error}`)
    for (const injected of ['roles', 'modules', 'reviewStandardPath']) {
      assert.ok(r.error.includes(injected), `${injected} missing from: ${r.error}`)
    }
    assert.match(r.error, /宿主/)
  }
})

test('validateRunParams rejects wrong value types', () => {
  assert.equal(validateRunParams({ mode: 'slice', sliceId: 'S1', plan: '[]' }).ok, false)
  assert.match(validateRunParams({ mode: 'slice', sliceId: 'S1', plan: '[]' }).error, /plan/)
  assert.equal(validateRunParams({ mode: 'slice', sliceId: 'S1', plan: [] }).ok, false)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 'r', dryRun: 'true' }).ok, false)
  assert.match(validateRunParams({ mode: 'plan-only', requirement: 'r', dryRun: 'true' }).error, /dryRun/)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 'r', maxFixRounds: '2' }).ok, false)
  assert.match(validateRunParams({ mode: 'plan-only', requirement: 'r', maxFixRounds: '2' }).error, /maxFixRounds/)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 'r', run_in_background: 1 }).ok, false)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 7 }).ok, false)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 'r', maxSlices: -1 }).ok, false)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 'r', stages: { plan: 'design' } }).ok, false)
  assert.match(validateRunParams({ mode: 'plan-only', requirement: 'r', stages: { plan: [1] } }).error, /stages/)
  assert.equal(validateRunParams({ mode: 'plan-only', requirement: 'r', stages: [] }).ok, false)
})

test('validateRunParams requires a non-blank sliceId', () => {
  assert.equal(validateRunParams({ mode: 'slice', sliceId: '  ', plan: { slices: [] } }).ok, false)
  assert.match(validateRunParams({ mode: 'slice', sliceId: '  ', plan: { slices: [] } }).error, /sliceId/)
  assert.equal(validateRunParams({ mode: 'slice', sliceId: ' S1 ', plan: { slices: [] } }).ok, true)
})

test('validateRunParams treats null params as not given', () => {
  assert.equal(validateRunParams({
    mode: 'plan-only', requirement: 'r', stages: null, maxFixRounds: null
  }).ok, true)
})

test('renderValue never ends the truncated string on a lone high surrogate', () => {
  const value = { s: 'x'.repeat(MAX_RESULT_CHARS - 11) + '😀' + 'y'.repeat(50) }
  assert.equal(JSON.stringify(value, null, 2).charCodeAt(MAX_RESULT_CHARS - 1), 0xd83d)
  const out = renderValue(value)
  const body = out.slice(0, out.indexOf('\n… [truncated'))
  assert.equal(/[\uD800-\uDBFF]$/.test(body), false, 'truncated body ends on a lone high surrogate')
  assert.ok(body.endsWith('x'))
})
