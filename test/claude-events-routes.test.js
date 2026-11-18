import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const BASE = '/plugins/dsh-slice-pipeline'

function writeSessionEvents(project, sessionId, jobId, startedAt) {
  const dir = join(project, sessionId, 'slice-pipeline', 'claude-events')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, jobId + '.ndjson'), '{"v":1,"t":"done","status":"completed"}\n')
  writeFileSync(join(dir, jobId + '.json'), JSON.stringify({
    jobId, label: sessionId + '-' + jobId, startedAt, outDir: project, sessionId
  }))
  return dir
}

async function callRoute(handler, { url, method = 'GET' }) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {} },
    end(body) { this.body = body === undefined ? '' : String(body) }
  }
  await handler({ url, method }, res)
  return res
}

function routesFor(home) {
  const routes = new Map()
  const ctx = {
    skills: { registerProvider(create) { create({ invalidate() {} }); return () => {} } },
    on() { return () => {} },
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'sessionPersistence') {
        return {
          async stat(sessionId) {
            return { location: { kind: 'jsonl', path: join(home, 'sessions', 'proj', sessionId, 'session.v4.jsonl.zstd') } }
          }
        }
      }
      return undefined
    },
    inject(services, callback) {
      if (!services.includes('webServer')) return
      const child = {
        webServer: {
          register(route) { routes.set(route.path, route); return () => {} }
        },
        effect(fn) { fn(); return () => {} }
      }
      callback(child)
    },
    logger: { info() {}, warn() {} }
  }
  return { routes, ctx }
}

test('Claude history routes expose only the requesting Session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-events-'))
  try {
    const { apply } = await import('../lib/index.js')
    const project = join(home, 'sessions', 'proj')
    const s1Dir = writeSessionEvents(project, 's1', 'job1', 1)
    writeSessionEvents(project, 's2', 'job2', 2)
    // Legacy global archives carry no sessionId and must stay hidden.
    const legacyDir = join(home, 'slice-pipeline', 'claude-events')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'job3.ndjson'), '{}\n')
    writeFileSync(join(legacyDir, 'job3.json'), JSON.stringify({ jobId: 'job3', label: 'old', startedAt: 3 }))

    const { routes, ctx } = routesFor(home)
    await apply(ctx, {})

    const list = routes.get(BASE + '/claude-events-list')
    const events = routes.get(BASE + '/claude-events')
    assert.ok(list && events, 'event routes are registered')

    const s1 = await callRoute(list.handler, { url: BASE + '/claude-events-list?sessionId=s1' })
    assert.equal(s1.status, 200)
    assert.deepEqual(JSON.parse(s1.body).jobs.map((job) => job.jobId), ['job1'])

    const s2 = await callRoute(list.handler, { url: BASE + '/claude-events-list?sessionId=s2' })
    assert.deepEqual(JSON.parse(s2.body).jobs.map((job) => job.jobId), ['job2'])

    const anonymous = await callRoute(list.handler, { url: BASE + '/claude-events-list' })
    assert.deepEqual(JSON.parse(anonymous.body).jobs, [])

    const foreign = await callRoute(events.handler, { url: BASE + '/claude-events?jobId=job1&sessionId=s2' })
    assert.equal(foreign.status, 404)
    const own = await callRoute(events.handler, { url: BASE + '/claude-events?jobId=job1&sessionId=s1' })
    assert.equal(own.status, 200)
    assert.match(own.body, /"completed"/)

    const deniedDelete = await callRoute(events.handler, {
      url: BASE + '/claude-events?jobId=job1&sessionId=s2', method: 'DELETE'
    })
    assert.equal(deniedDelete.status, 404)
    assert.equal(existsSync(join(s1Dir, 'job1.ndjson')), true)

    const deleteOk = await callRoute(events.handler, {
      url: BASE + '/claude-events?jobId=job1&sessionId=s1', method: 'DELETE'
    })
    assert.equal(deleteOk.status, 200)
    assert.equal(existsSync(join(s1Dir, 'job1.ndjson')), false)
    assert.equal(existsSync(join(s1Dir, 'job1.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
