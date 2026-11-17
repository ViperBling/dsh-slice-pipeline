import test from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from '../lib/config.js'
import { resolveModules } from '../lib/paths.js'
import { createPipelineTool } from '../lib/pipeline-tool.js'

const states = await resolveModules(readConfig({}), {
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

/** Jobs double: records start specs; starter runs synchronously like the host. */
function fakeJobs() {
  const started = []
  const handles = []
  let next = 0
  return {
    started,
    handles,
    start(spec) {
      started.push(spec)
      const jobId = `job-${++next}`
      handles.push(spec.run({ id: jobId }))
      return jobId
    }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Engine double whose run results settle only when the test says so. */
function controllableEngine() {
  const calls = []
  const runs = []
  return {
    calls,
    runs,
    start(request) {
      calls.push(request)
      const settled = deferred()
      const run = {
        id: `run-${runs.length + 1}`,
        result: settled.promise,
        resolve: settled.resolve,
        reject: settled.reject,
        cancelled: [],
        cancel(reason) { run.cancelled.push(reason) },
        dispose: async () => { run.disposed = (run.disposed ?? 0) + 1 }
      }
      runs.push(run)
      return run
    }
  }
}

test('background registers a workflow job and returns jobId', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: { ok: true } })
  const jobs = fakeJobs()
  const { definition } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}), readScript: async () => 'S',
    resolve: async () => states, engine, jobs })
  const out = await definition.execute({ mode: 'slice', sliceId: 'S1', plan: { slices: [] }, run_in_background: true }, { agent: { id: 'a1' } })
  assert.equal(out.kind, 'background')
  assert.equal(out.jobId, 'job-1')
  assert.equal(out.runId, 'run-1')
  assert.equal(jobs.started[0].kind, 'workflow')
  assert.equal(jobs.started[0].label, 'slice-pipeline')
  assert.equal(jobs.started[0].owner, 'a1')
  assert.equal(engine.calls[0].signal, undefined)
})

test('job done maps completed and disposes once', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 2, value: { ok: true } })
  const jobs = fakeJobs()
  const { definition } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}), readScript: async () => 'S',
    resolve: async () => states, engine, jobs })
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  const outcome = await jobs.started[0].run({ id: 'job-1' }).done
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.detail, '2 agents')
  assert.match(outcome.result, /"ok": true/)
  assert.equal(engine.calls.disposed, 1)
})

test('job done maps killed and failed', async () => {
  const killed = fakeJobs()
  const e1 = fakeEngine({ stopReason: 'cancelled' })
  await createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}), readScript: async () => 'S',
    resolve: async () => states, engine: e1, jobs: killed }).definition
    .execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  assert.deepEqual(await killed.started[0].run({ id: 'job-1' }).done, { status: 'killed' })

  const failed = fakeJobs()
  const e2 = fakeEngine({ stopReason: 'error', error: 'boom' })
  await createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}), readScript: async () => 'S',
    resolve: async () => states, engine: e2, jobs: failed }).definition
    .execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  const out = await failed.started[0].run({ id: 'job-1' }).done
  assert.equal(out.status, 'failed')
  assert.match(out.detail, /boom/)
})

test('cancel forwards to run.cancel and clears the running map', async () => {
  let cancelled
  const engine = { calls: [], start() { return { id: 'run-1', result: new Promise(() => {}), cancel: (r) => { cancelled = r }, dispose: async () => {} } } }
  const jobs = fakeJobs()
  const { definition, running } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => 'S', resolve: async () => states, engine, jobs })
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  assert.equal(running.size, 1)
  jobs.started[0].run({ id: 'job-1' }).cancel('用户停止')
  assert.equal(cancelled, '用户停止')
  assert.equal(running.size, 0)
})

test('double cancel does not double dispose', async () => {
  const engine = fakeEngine({ stopReason: 'cancelled' })
  const jobs = fakeJobs()
  const { definition } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => 'S', resolve: async () => states, engine, jobs })
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  const handle = jobs.started[0].run({ id: 'job-1' })
  handle.cancel('a'); handle.cancel('b')
  await handle.done
  assert.equal(engine.calls.disposed, 1)
})

test('missing jobs rejects only the background path', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const { definition } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}), readScript: async () => 'S',
    resolve: async () => states, engine, jobs: undefined })
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  assert.equal(out.kind, 'foreground')
  assert.equal(engine.calls.length, 1)
  await assert.rejects(() => definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } }), /dsh-jobs/)
  assert.equal(engine.calls.length, 1)
})

test('a late done from a killed run does not free the newer slot', async () => {
  const engine = controllableEngine()
  const jobs = fakeJobs()
  const { definition, running } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => 'S', resolve: async () => states, engine, jobs })
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  const first = jobs.handles[0]
  first.cancel('stop A')
  assert.equal(running.size, 0)
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  assert.equal(running.get('a1').runId, 'run-2')
  engine.runs[0].resolve({ stopReason: 'cancelled' })
  assert.deepEqual(await first.done, { status: 'killed' })
  assert.equal(running.size, 1)
  assert.equal(running.get('a1').runId, 'run-2')
  await assert.rejects(
    () => definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } }),
    /job-2/)
  assert.equal(engine.calls.length, 2)
  engine.runs[1].resolve({ stopReason: 'cancelled' })
  await jobs.handles[1].done
  assert.equal(running.size, 0)
})

test('job done frees the slot for the next call', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 1, value: {} })
  const jobs = fakeJobs()
  const { definition, running } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => 'S', resolve: async () => states, engine, jobs })
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  await jobs.handles[0].done
  assert.equal(running.size, 0)
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r' }, { agent: { id: 'a1' } })
  assert.equal(out.kind, 'foreground')
  assert.equal(engine.calls.length, 2)
})

test('rejected run.result settles failed and still releases the slot', async () => {
  const engine = controllableEngine()
  const jobs = fakeJobs()
  const warns = []
  const { definition, running } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => 'S', resolve: async () => states, engine, jobs,
    logger: { warn: (...args) => warns.push(args) } })
  await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  engine.runs[0].reject(new Error('boom'))
  const outcome = await jobs.handles[0].done
  assert.deepEqual(outcome, { status: 'failed', detail: 'Error: boom' })
  assert.equal(running.size, 0)
  assert.equal(engine.runs[0].disposed, 1)
  assert.equal(warns.length, 0)
})

test('background render hint names job_output and job_kill', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  const jobs = fakeJobs()
  const { definition } = createPipelineTool({ pluginRoot: '/p', getConfig: () => readConfig({}),
    readScript: async () => 'S', resolve: async () => states, engine, jobs })
  const out = await definition.execute({ mode: 'plan-only', requirement: 'r', run_in_background: true }, { agent: { id: 'a1' } })
  const [block] = definition.output.render({}, out)
  assert.match(block.text, /job-1/)
  assert.match(block.text, /job_output/)
  assert.match(block.text, /job_kill/)
  await jobs.handles[0].done
})

test('jobs may be a late-bound getter resolved on every call', async () => {
  const engine = fakeEngine({ stopReason: 'completed', agentsStarted: 0, value: {} })
  let available = fakeJobs()
  const { definition } = createPipelineTool({
    pluginRoot: '/p', getConfig: () => readConfig({}), readScript: async () => 'S',
    resolve: async () => states, engine, jobs: () => available
  })

  const out = await definition.execute(
    { mode: 'plan-only', requirement: 'r', run_in_background: true },
    { agent: { id: 'a1' } }
  )
  assert.equal(out.kind, 'background')
  assert.equal(out.jobId, 'job-1')
  await available.handles[0].done

  available = undefined
  await assert.rejects(
    () => definition.execute(
      { mode: 'plan-only', requirement: 'r', run_in_background: true },
      { agent: { id: 'a1' } }
    ),
    /dsh-jobs/
  )
})
