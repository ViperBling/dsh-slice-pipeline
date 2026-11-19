import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExternalAgentTool } from '../lib/external-agent.js'

function externalConfig(overrides = {}) {
  return {
    externalAgents: {
      autoOpen: true,
      showThinking: true,
      sdkVersion: '0.3.287',
      designer: { enabled: true, cli: 'claude', model: '' },
      reviewer: { enabled: true, cli: 'claude', model: '' },
      ...overrides
    }
  }
}

function fakeJobs() {
  const jobs = []
  let next = 1
  return {
    jobs,
    start(spec) {
      const id = 'claude-' + next++
      const chunks = []
      let progress = ''
      const handle = {
        id,
        append(text, options) { chunks.push({ text, channel: options?.channel }) },
        updateProgress(line) { progress = line }
      }
      const run = spec.run(handle)
      const record = { id, spec, chunks, progress: () => progress, run }
      jobs.push(record)
      return id
    },
    async wait(id) {
      const record = jobs.find((job) => job.id === id)
      const outcome = await record.run.done
      return { ...outcome, id }
    },
    kill() {}
  }
}

async function tempOut() {
  const root = await mkdtemp(join(tmpdir(), 'slice-external-'))
  const outDir = join(root, 'out')
  await mkdir(outDir, { recursive: true })
  return { root, outDir }
}

test('external_agent_run starts a job, emits NDJSON log events and writes the result file', async () => {
  const { root, outDir } = await tempOut()
  try {
    const jobs = fakeJobs()
    const tool = createExternalAgentTool({
      getConfig: () => externalConfig(),
      jobs,
      dshHome: root,
      runnerFactory: async ({ onEvent }) => {
        onEvent({ t: 'phase', phase: 'starting', label: '启动', model: 'sonnet' })
        onEvent({ t: 'tool', id: 't1', name: 'Read', target: 'a.md', status: 'start' })
        onEvent({ t: 'thinking', text: '先看调用链' })
        onEvent({ t: 'tool', id: 't1', status: 'end', ok: true })
        onEvent({ t: 'usage', turns: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.01 })
        onEvent({ t: 'done', status: 'completed', detail: 'ok' })
        return {
          structuredOutput: { verdict: 'pass', findings: [] },
          usage: { inputTokens: 10 }, costUsd: 0.01, model: 'sonnet', durationMs: 12
        }
      }
    })
    const prompt = 'REVIEW THIS'
    const { createHash } = await import('node:crypto')
    const params = {
      role: 'reviewer', prompt,
      promptSha12: createHash('sha256').update(prompt).digest('hex').slice(0, 12),
      schema: { type: 'object' }, cwd: root, outDir, label: 'reviewer test'
    }
    const result = await tool.execute(params, { agent: { id: 'agent-1' } })
    assert.equal(typeof tool.definition.output.render, 'function')
    assert.equal(tool.definition.output.schema.type, 'object')
    assert.equal(result.ok, true)
    assert.equal(result.role, 'reviewer')
    assert.equal(result.model, 'sonnet')
    assert.equal(result.configuredModel, null)
    assert.equal(result.routeSource, 'claude-cli')
    assert.match(result.resultPath, /[\\/]out[\\/]external[\\/]reviewer-\d+\.json$/)
    assert.deepEqual(JSON.parse(await readFile(result.resultPath, 'utf8')), { verdict: 'pass', findings: [] })
    assert.equal(jobs.jobs.length, 1)
    assert.equal(jobs.jobs[0].spec.kind, 'claude')
    assert.equal(jobs.jobs[0].spec.owner, 'agent-1')
    const log = jobs.jobs[0].chunks.filter((chunk) => chunk.channel === 'log').map((chunk) => chunk.text).join('')
    assert.match(log, /"t":"phase"/)
    assert.match(log, /"t":"tool"/)
    assert.match(log, /"t":"thinking"/)
    assert.match(log, /"t":"done"/)
    // The sidecar records the real settle status and finish time for history.
    const meta = JSON.parse(await readFile(join(root, 'slice-pipeline', 'claude-events', 'agent-1', result.jobId + '.json'), 'utf8'))
    assert.equal(meta.status, 'completed')
    assert.equal(typeof meta.finishedAt, 'number')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('external_agent_run rejects a changed prompt fingerprint', async () => {
  const { root, outDir } = await tempOut()
  try {
    const tool = createExternalAgentTool({ getConfig: () => externalConfig(), jobs: fakeJobs(), dshHome: root })
    await assert.rejects(
      () => tool.execute({
        role: 'designer', prompt: 'original', promptSha12: '000000000000',
        schema: { type: 'object' }, cwd: root, outDir
      }, { agent: { id: 'a' } }),
      /promptSha12/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('external_agent_run refuses when the role is not enabled', async () => {
  const { root, outDir } = await tempOut()
  try {
    const tool = createExternalAgentTool({
      getConfig: () => externalConfig({ reviewer: { enabled: false, cli: 'claude', model: '' } }),
      jobs: fakeJobs(), dshHome: root
    })
    await assert.rejects(
      () => tool.execute({
        role: 'reviewer', prompt: 'p', promptSha12: '000000000000',
        schema: { type: 'object' }, cwd: root, outDir
      }, { agent: { id: 'a' } }),
      /未启用外部 agent/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('external_agent_run accepts a promptPath written under outDir/external', async () => {
  const { root, outDir } = await tempOut()
  try {
    const externalDir = join(outDir, 'external')
    await mkdir(externalDir, { recursive: true })
    const promptPath = join(externalDir, 'designer-1.prompt.txt')
    await writeFile(promptPath, 'PROMPT FROM FILE')
    const { createHash } = await import('node:crypto')
    const tool = createExternalAgentTool({
      getConfig: () => externalConfig(),
      jobs: fakeJobs(),
      dshHome: root,
      runnerFactory: async ({ prompt }) => {
        assert.equal(prompt, 'PROMPT FROM FILE')
        return { structuredOutput: { ok: true }, usage: null, costUsd: null, model: null, durationMs: 1 }
      }
    })
    const result = await tool.execute({
      role: 'designer', promptPath,
      promptSha12: createHash('sha256').update('PROMPT FROM FILE').digest('hex').slice(0, 12),
      schema: { type: 'object' }, cwd: root, outDir
    }, { agent: { id: 'a1' } })
    assert.equal(result.ok, true)
    assert.match(result.resultPath, /external[\\/]designer-\d+\.json$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('events live in the owning Session directory and stay invisible to other Sessions', async () => {
  const { root, outDir } = await tempOut()
  const sessionDir = join(root, 'sessions', 'proj', 's1')
  try {
    const { listExternalEventFiles, getExternalEventFile, deleteExternalEventFiles } = await import('../lib/external-agent.js')
    const tool = createExternalAgentTool({
      getConfig: () => externalConfig(),
      jobs: fakeJobs(),
      dshHome: root,
      sessionDirFor: async (sessionId) => (sessionId === 's1' ? sessionDir : undefined),
      runnerFactory: async ({ onEvent }) => {
        onEvent({ t: 'done', status: 'completed', detail: 'ok' })
        return { structuredOutput: { ok: true }, usage: null, costUsd: null, model: null, durationMs: 1 }
      }
    })
    const { createHash } = await import('node:crypto')
    const prompt = 'P'
    const result = await tool.execute({
      role: 'reviewer', prompt,
      promptSha12: createHash('sha256').update(prompt).digest('hex').slice(0, 12),
      schema: { type: 'object' }, cwd: root, outDir
    }, { agent: { id: 's1' } })
    assert.equal(result.ok, true)

    const listed = listExternalEventFiles({ home: root, sessionId: 's1', sessionDir })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].jobId, result.jobId)

    const file = getExternalEventFile(result.jobId, { home: root, sessionId: 's1', sessionDir })
    assert.ok(file.startsWith(sessionDir), 'archive lives under the Session directory')
    assert.equal(getExternalEventFile(result.jobId, { home: root, sessionId: 's2' }), undefined)
    assert.deepEqual(listExternalEventFiles({ home: root, sessionId: 's2' }), [])
    assert.equal(deleteExternalEventFiles(result.jobId, { home: root, sessionId: 's2' }), 0)
    assert.equal(getExternalEventFile(result.jobId, { home: root, sessionId: 's1', sessionDir }), file)
    // ndjson + sidecar are both removed and counted.
    assert.equal(deleteExternalEventFiles(result.jobId, { home: root, sessionId: 's1', sessionDir }), 2)
    assert.equal(getExternalEventFile(result.jobId, { home: root, sessionId: 's1', sessionDir }), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-isolation archives are adopted into the session whose log recorded the job id', async () => {
  const { root } = await tempOut()
  try {
    const legacy = join(root, 'slice-pipeline', 'claude-events')
    await mkdir(legacy, { recursive: true })
    for (const jobId of ['job-a', 'job-b']) {
      await writeFile(join(legacy, jobId + '.ndjson'), '{"v":1,"t":"done"}\n')
      await writeFile(join(legacy, jobId + '.json'), JSON.stringify({ jobId, label: jobId, startedAt: 1 }))
    }
    const sessionDir = join(root, 'sessions', 'p', 's1')
    const { adoptLegacyEvents, listExternalEventFiles } = await import('../lib/external-agent.js')
    const readSessionInfo = async () => ({ cwd: root, text: 'external_agent_run reviewer 完成；job=job-a' })
    assert.equal(await adoptLegacyEvents({ home: root, sessionId: 's1', sessionDir, readSessionInfo }), 1)
    assert.deepEqual(
      listExternalEventFiles({ home: root, sessionId: 's1', sessionDir }).map((job) => job.jobId),
      ['job-a']
    )
    // Adoption runs once per session per process.
    assert.equal(await adoptLegacyEvents({ home: root, sessionId: 's1', sessionDir, readSessionInfo }), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy adoption skips other workspaces and repairs earlier copies', async () => {
  const { root } = await tempOut()
  try {
    const jobId = 'job-other'
    const meta = {
      jobId, label: 'vultana', startedAt: 1,
      outDir: 'D:/SampleProjects/CG/Vultana/AIOut/Slice7'
    }
    const legacy = join(root, 'slice-pipeline', 'claude-events')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, jobId + '.ndjson'), '{"v":1,"t":"done"}\n')
    await writeFile(join(legacy, jobId + '.json'), JSON.stringify(meta))
    const sessionDir = join(root, 'sessions', 'p', 's-other')
    const target = join(sessionDir, 'slice-pipeline', 'claude-events')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, jobId + '.ndjson'), '{"v":1,"t":"done"}\n')
    await writeFile(join(target, jobId + '.json'), JSON.stringify({ ...meta, sessionId: 's-other' }))
    const { adoptLegacyEvents } = await import('../lib/external-agent.js')
    const adopted = await adoptLegacyEvents({
      home: root, sessionId: 's-other', sessionDir,
      readSessionInfo: async () => ({ cwd: 'D:/Projects/X3_Testbed_Dev', text: 'job=' + jobId })
    })
    assert.equal(adopted, 0)
    assert.equal(existsSync(join(target, jobId + '.ndjson')), false, 'copy from another workspace is removed')
    assert.equal(existsSync(join(target, jobId + '.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('external agent timeouts follow settings, and per-call params win', async () => {
  const { root, outDir } = await tempOut()
  try {
    let captured
    const config = externalConfig()
    config.externalAgents.timeoutMinutes = 5
    config.externalAgents.firstResponseTimeoutMinutes = 2
    const tool = createExternalAgentTool({
      getConfig: () => config,
      jobs: fakeJobs(),
      dshHome: root,
      runnerFactory: async (options) => {
        captured = options
        return { structuredOutput: {}, usage: null, costUsd: null, model: null, durationMs: 1 }
      }
    })
    const { createHash } = await import('node:crypto')
    const prompt = 'P'
    const base = {
      role: 'designer', prompt,
      promptSha12: createHash('sha256').update(prompt).digest('hex').slice(0, 12),
      schema: { type: 'object' }, cwd: root, outDir
    }
    await tool.execute(base, { agent: { id: 'a' } })
    assert.equal(captured.timeoutMs, 300_000)
    assert.equal(captured.firstResponseTimeoutMs, 120_000)
    await tool.execute({ ...base, timeoutMs: 60_000, firstResponseTimeoutMs: 5_000 }, { agent: { id: 'a' } })
    assert.equal(captured.timeoutMs, 60_000)
    assert.equal(captured.firstResponseTimeoutMs, 5_000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('history lists newest first, reads the session log once, and deletes sidecar-only jobs', async () => {
  const { root } = await tempOut()
  try {
    const legacy = join(root, 'slice-pipeline', 'claude-events')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'job-old.ndjson'), '{}\n')
    await writeFile(join(legacy, 'job-old.json'), JSON.stringify({ jobId: 'job-old', label: 'old', startedAt: 100 }))
    const sessionDir = join(root, 'sessions', 'p', 's-order')
    const target = join(sessionDir, 'slice-pipeline', 'claude-events')
    await mkdir(target, { recursive: true })
    for (const [jobId, startedAt] of [['job-a', 200], ['job-b', 300]]) {
      await writeFile(join(target, jobId + '.ndjson'), '{}\n')
      await writeFile(join(target, jobId + '.json'), JSON.stringify({ jobId, startedAt, sessionId: 's-order' }))
    }
    const { adoptLegacyEvents, listExternalEventFiles, deleteExternalEventFiles } = await import('../lib/external-agent.js')
    let reads = 0
    const readSessionInfo = async () => { reads += 1; return { cwd: root, text: '' } }
    assert.equal(await adoptLegacyEvents({ home: root, sessionId: 's-order', sessionDir, readSessionInfo }), 0)
    assert.equal(await adoptLegacyEvents({ home: root, sessionId: 's-order', sessionDir, readSessionInfo }), 0)
    assert.equal(reads, 1, 'an empty result is cached, not re-read by every poll')
    assert.deepEqual(
      listExternalEventFiles({ home: root, sessionId: 's-order', sessionDir }).map((job) => job.jobId),
      ['job-b', 'job-a']
    )
    await rm(join(target, 'job-a.ndjson'))
    assert.equal(deleteExternalEventFiles('job-a', { home: root, sessionId: 's-order', sessionDir }), 1)
    assert.equal(existsSync(join(target, 'job-a.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cancelled caller also kills the running external job', async () => {
  const { root, outDir } = await tempOut()
  try {
    const killed = []
    const jobs = {
      start(spec) {
        const handle = { id: 'claude-x', append() {}, updateProgress() {} }
        spec.run(handle)
        return 'claude-x'
      },
      async wait() { throw new Error('aborted') },
      kill(id, owner, reason) { killed.push({ id, owner, reason }) }
    }
    const tool = createExternalAgentTool({
      getConfig: () => externalConfig(),
      jobs, dshHome: root,
      runnerFactory: async () => {
        await new Promise(() => {})
      }
    })
    const { createHash } = await import('node:crypto')
    const prompt = 'P'
    await assert.rejects(
      () => tool.execute({
        role: 'reviewer', prompt,
        promptSha12: createHash('sha256').update(prompt).digest('hex').slice(0, 12),
        schema: { type: 'object' }, cwd: root, outDir
      }, { agent: { id: 's1' }, signal: new AbortController().signal }),
      /aborted/
    )
    assert.equal(killed.length, 1)
    assert.equal(killed[0].reason, 'caller cancelled')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('registration accepts the function-shaped dshHomePath service', async () => {
  const { registerExternalAgentTool } = await import('../lib/external-agent.js')
  let definition
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return () => 'C:/dsh-home'
      if (name === 'jobs') return {}
      return undefined
    },
    tools: { register(value) { definition = value; return () => {} } },
    logger: { info() {}, warn() {} }
  }
  const dispose = registerExternalAgentTool(ctx, { pluginRoot: 'C:/p', getConfig: () => ({ externalAgents: {} }) })
  assert.equal(definition.name, 'external_agent_run')
  assert.equal(typeof dispose, 'function')
})
