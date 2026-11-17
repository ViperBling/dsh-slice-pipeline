import test from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from '../lib/config.js'
import { resolveModules } from '../lib/paths.js'
import { buildPipelineArgs } from '../lib/inject.js'
import { createPipelineTool } from '../lib/pipeline-tool.js'

const config = readConfig({})
const states = await resolveModules(config, {
  pluginRoot: '/p',
  exists: async () => true
})

/** Engine double: records every start request, returns a controlled run handle. */
function fakeEngine(result) {
  const calls = []
  return {
    calls,
    start(request) {
      calls.push(request)
      return {
        id: 'run-1',
        result: Promise.resolve(result),
        cancel() {},
        dispose: async () => { calls.disposed = (calls.disposed ?? 0) + 1 }
      }
    }
  }
}

const tool = (engine, extra = {}) => createPipelineTool({
  pluginRoot: '/p',
  getConfig: () => readConfig({}),
  readScript: async () => 'SCRIPT',
  resolve: async () => states,
  engine,
  jobs: undefined,
  ...extra
})

test('foreground passes the script verbatim and returns the value', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 2, value: { plan: { slices: [{ id: 'S1' }] } } })
  const { definition } = tool(engine)
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' }, signal: undefined })
  assert.equal(engine.calls[0].script, 'SCRIPT')
  assert.equal(engine.calls[0].meta.name, 'slice-pipeline')
  assert.equal(engine.calls[0].parent.id, 'a1')
  assert.deepEqual(out.result, { plan: { slices: [{ id: 'S1' }] } })
  assert.equal(engine.calls.disposed, 1)
})

test('missing agent throws before start', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = tool(engine)
  await assert.rejects(() => definition.execute({ mode: 'plan-only', requirement: 'r' }, {}), /exec\.agent/)
  assert.equal(engine.calls.length, 0)
})

test('error stop reason surfaces the script error', async () => {
  const engine = fakeEngine({ stopReason: 'error', error: 'slice-pipeline: required plugin modules are unavailable', agentsStarted: 0 })
  const { definition } = tool(engine)
  await assert.rejects(() => definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } }),
    /required plugin modules are unavailable/)
})

test('concurrent call for the same agent is refused', async () => {
  let release
  const engine = { calls: [], start() { return { id: 'run-1', result: new Promise((r) => { release = r }), cancel() {}, dispose: async () => {} } } }
  const { definition } = tool(engine)
  const first = definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  await assert.rejects(() => definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } }), /run-1/)
  release({ stopReason: 'completed', agentsStarted: 1, value: {} })
  await first
})

test('dryRun does not start', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = tool(engine)
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r', dryRun: true }, { agent: { id: 'a1' } })
  assert.equal(out.kind, 'dry-run')
  assert.match(out.scriptId, /^[0-9a-f]{12}$/)
  assert.equal(engine.calls.length, 0)
})

test('render shows the JSON for foreground', () => {
  const { definition } = tool(fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: {} }))
  const blocks = definition.output.render({}, { kind: 'foreground', runId: 'run-1', agentsStarted: 1, result: { ok: true } })
  assert.match(blocks[0].text, /Return value:/)
  assert.match(blocks[0].text, /"ok": true/)
})

test('declared schema uses the implicit required dialect', () => {
  const { definition } = tool(fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} }))
  assert.equal(definition.parameters.mode.required, true)
  assert.equal(definition.parameters.mode.enum.includes('plan-only'), true)
  assert.equal(Array.isArray(definition.parameters.mode.required), false)
  assert.equal(definition.output.schema.oneOf.length, 3)
})

test('script is re-read on every call (no caching)', async () => {
  const scripts = ['S1', 'S2']
  let i = 0
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => scripts[i++], resolve: async () => states, engine, jobs: undefined })
  await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  assert.deepEqual(engine.calls.map((c) => c.script), ['S1', 'S2'])
})

test('bad mode rejects with zero engine calls', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = tool(engine)
  await assert.rejects(() => definition.execute({ mode: 'bad' }, { agent: { id: 'a1' } }), /参数错误/)
  assert.equal(engine.calls.length, 0)
})

test('slice mode missing fields rejects with zero engine calls', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = tool(engine)
  await assert.rejects(() => definition.execute({ mode: 'slice' }, { agent: { id: 'a1' } }), /参数错误/)
  assert.equal(engine.calls.length, 0)
})

test('foreground run disposes once, clears running, returns runId and scriptId', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 2, value: { ok: true } })
  const { definition, running } = tool(engine)
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  assert.equal(engine.calls.disposed, 1)
  assert.equal(running.size, 0)
  assert.equal(out.kind, 'foreground')
  assert.equal(out.runId, 'run-1')
  assert.match(out.scriptId, /^[0-9a-f]{12}$/)
})

test('start request forwards mode/requirement, keeps injected roles/modules, shares signal', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: {} })
  const { definition } = tool(engine)
  const signal = AbortSignal.abort()
  const exec = { agent: { id: 'a1' }, signal }
  await definition.execute({ mode: 'plan-only', requirement: 'r' }, exec)
  assert.equal(engine.calls[0].args.mode, 'plan-only')
  assert.equal(engine.calls[0].args.requirement, 'r')
  const base = buildPipelineArgs(config, states)
  assert.deepEqual(engine.calls[0].args.roles, base.roles)
  assert.deepEqual(engine.calls[0].args.modules, base.modules)
  assert.equal(typeof engine.calls[0].args.roles, 'object')
  assert.equal(typeof engine.calls[0].args.modules, 'object')
  assert.ok(Object.keys(engine.calls[0].args.modules).length > 0)
  assert.equal(engine.calls[0].signal, signal)
})

test('injected fields are rejected as unknown params before start', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = tool(engine)
  await assert.rejects(
    () => definition.execute({ mode: 'plan-only', requirement: 'r', roles: { hacked: true } },
      { agent: { id: 'a1' } }),
    /roles/
  )
  assert.equal(engine.calls.length, 0)
})

test('dryRun leaves running empty and its render template mentions the scriptId', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition, running } = tool(engine)
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r', dryRun: true }, { agent: { id: 'a1' } })
  assert.equal(out.kind, 'dry-run')
  assert.equal(running.size, 0)
  assert.equal(engine.calls.length, 0)
  const blocks = definition.output.render({}, out)
  assert.match(blocks[0].text, /dry-run/)
  assert.ok(blocks[0].text.includes(out.scriptId))
})

test('render is exposed only via output, assertIdle stays private', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = tool(engine)
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(definition.render, undefined)
  const module = await import('../lib/pipeline-tool.js')
  assert.equal(module.assertIdle, undefined)
})
