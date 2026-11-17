import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_KEYS, readConfig } from '../lib/config.js'
import { createPipelineTool } from '../lib/pipeline-tool.js'
import { DESKTOP_CONFIG } from './helpers/fixtures.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT_PATH = join(ROOT, 'skills', 'slice-pipeline', 'slice-pipeline.js')
const slash = (path) => path.replaceAll(String.fromCharCode(92), '/')

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

/** Real wiring: no readScript / resolve injection, config from the desktop fixture. */
function realTool(engine, overrides = {}) {
  return createPipelineTool({
    pluginRoot: ROOT,
    getConfig: () => readConfig(DESKTOP_CONFIG),
    engine,
    jobs: undefined,
    ...overrides
  })
}

test('default wiring reads the bundled script bytes and reports their sha256 prefix', async () => {
  const bytes = await readFile(SCRIPT_PATH)
  const expectedId = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: {} })
  const { definition } = realTool(engine)
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  assert.equal(engine.calls.length, 1)
  assert.ok(Buffer.from(engine.calls[0].script, 'utf8').equals(bytes), 'script differs from disk bytes')
  assert.equal(out.scriptId, expectedId)
})

test('default wiring forwards all six modules with ok status and an absolute review path', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: {} })
  const { definition } = realTool(engine)
  await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  const { args } = engine.calls[0]
  assert.deepEqual(Object.keys(args.modules).sort(), [...MODULE_KEYS].sort())
  for (const key of MODULE_KEYS) assert.equal(args.modules[key].status, 'ok', key)
  assert.equal(typeof args.reviewStandardPath, 'string')
  assert.ok(isAbsolute(args.reviewStandardPath), args.reviewStandardPath)
  assert.equal(slash(args.reviewStandardPath), args.reviewStandardPath)
  assert.equal(args.reviewStandardPath.includes(String.fromCharCode(92)), false)
})

test('slice mode forwards sliceId and the same plan object', async () => {
  const plan = {
    summary: 's',
    interfaceContract: 'c',
    slices: [{
      id: 'S1',
      title: 'T1',
      discussion: {
        sliceId: 'S1',
        understanding: '本片只落地 S1 的接口增量',
        decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
        openQuestions: [],
        userConfirmed: true
      }
    }]
  }
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: {} })
  const { definition } = realTool(engine)
  await definition.execute({ mode: 'slice', sliceId: 'S1', plan }, { agent: { id: 'a1' } })
  assert.equal(engine.calls[0].args.mode, 'slice')
  assert.equal(engine.calls[0].args.sliceId, 'S1')
  assert.equal(engine.calls[0].args.plan, plan)
  assert.deepEqual(engine.calls[0].args.plan, plan)
})

test('a pluginRoot without the bundled script rejects with the joined script path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-pipeline-'))
  try {
    const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
    const { definition } = realTool(engine, { pluginRoot: dir })
    const expected = slash(join(dir, 'skills', 'slice-pipeline', 'slice-pipeline.js'))
    await assert.rejects(
      () => definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } }),
      (error) => {
        assert.ok(slash(error.message).includes(expected), error.message)
        return true
      }
    )
    assert.equal(engine.calls.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('foreground failure still disposes the real-wired run exactly once', async () => {
  const engine = fakeEngine({ stopReason: 'error', error: 'boom', agentsStarted: 0 })
  const { definition, running } = realTool(engine)
  await assert.rejects(
    () => definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } }),
    /boom/
  )
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls.disposed, 1)
  assert.equal(running.size, 0)
})
