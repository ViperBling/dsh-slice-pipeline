// dsh-slice-pipeline: slice-pipeline skill provider + settings for the DeepSeek Harness.
//
// Host half:
//   - registers one skill provider into the HOST layer of `ctx.skills`;
//   - resolves the six module configs and injects each Skill's absolute doc
//     paths plus the slice-pipeline args JSON (roles / stages / maxFixRounds /
//     modules / reviewStandardPath);
//   - invalidates the skill catalog on loader/volatile-update, and when the
//     dsh-tui `tuiSettingsSections` seam is present, registers a native
//     settings section whose provider/model choices are read from the live
//     DSH llm registry instead of being hardcoded.
//
// The browser half lives in ./client.js and registers a web/desktop settings
// tab that reads the same plugin config and the DSH model catalog.
//
// @module dsh-slice-pipeline
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Config, readConfig } from './config.js'
import { createSkillProvider } from './skills.js'
import { registerPipelineTool, pipelineToolStatus } from './pipeline-tool.js'
import { registerExternalAgentTool, getExternalEventFile, listExternalEventFiles, deleteExternalEventFiles, adoptLegacyEvents, sessionDirOf } from './external-agent.js'
import { readClaudeModelOptions } from './claude-sdk.js'
import { registerTuiSettings } from './tui.js'

const name = 'dsh-slice-pipeline'
const inject = ['skills', 'llm']

/**
 * Host plugin entry.
 * @param ctx - Cordis context.
 * @param rawConfig - Loader-resolved plugin config.
 */
async function apply(ctx, rawConfig) {
  const homeService = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
  const dshHome = (typeof homeService === 'function' ? homeService() : homeService) || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const currentConfig = () => readConfig(rawConfig)
  let invalidate

  ctx.skills.registerProvider((control) => {
    invalidate = control.invalidate
    return createSkillProvider({ name, pluginRoot, getConfig: currentConfig })
  })
  ctx.on('loader/volatile-update', () => invalidate())

  ctx.inject(['tools', 'workflowEngine'], (child) => {
    child.effect(
      () => registerPipelineTool(child, { pluginRoot, getConfig: currentConfig }),
      'dsh-slice-pipeline: pipeline tool'
    )
  })

  ctx.inject(['tools'], (child) => {
    child.effect(
      () => registerExternalAgentTool(child, { pluginRoot, getConfig: currentConfig }),
      'dsh-slice-pipeline: external agent tool'
    )
  })

  // Settings page reads this route to offer the native Claude Code model
  // choices (aliases + resolved ids); only model names are exposed.
  ctx.inject(['webServer'], (child) => {
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-slice-pipeline/claude-models',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        let payload
        try {
          payload = JSON.stringify(readClaudeModelOptions())
        } catch (error) {
          payload = JSON.stringify({ options: [], error: String(error?.message ?? error) })
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        })
        if (req.method === 'HEAD') res.end()
        else res.end(payload)
      }
    }), 'dsh-slice-pipeline: claude model options route')
    // Diagnostics fallback: the Claude tab can read the same NDJSON from
    // disk even if its jobs.observe generation never attached. Events are
    // scoped to the requesting Session, so one Session cannot read another's.
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-slice-pipeline/claude-events',
      handler: async (req, res) => {
        let jobId = ''
        let sessionId = ''
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          jobId = url.searchParams.get('jobId') || ''
          sessionId = url.searchParams.get('sessionId') || ''
        } catch { /* malformed URL */ }
        const sessionDir = await sessionDirOf(ctx.get('sessionPersistence'), sessionId)
        if (req.method === 'DELETE') {
          const removed = (jobId === '' || sessionId === '')
            ? 0
            : deleteExternalEventFiles(jobId, { home: dshHome, sessionId, sessionDir })
          res.writeHead(removed > 0 ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: removed > 0, jobId, removed }))
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD, DELETE' })
          res.end()
          return
        }
        const file = (jobId === '' || sessionId === '')
          ? undefined
          : getExternalEventFile(jobId, { home: dshHome, sessionId, sessionDir })
        if (file === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(req.method === 'HEAD' ? undefined : 'unknown job\n')
          return
        }
        let text
        try { text = readFileSync(file, 'utf8') } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(req.method === 'HEAD' ? undefined : String(error?.message ?? error))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store'
        })
        if (req.method === 'HEAD') res.end()
        else res.end(text)
      }
    }), 'dsh-slice-pipeline: claude event file route')
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-slice-pipeline/claude-events-list',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        let sessionId = ''
        try { sessionId = new URL(req.url || '/', 'http://localhost').searchParams.get('sessionId') || '' } catch { /* malformed URL */ }
        let jobs = []
        if (sessionId !== '') {
          const sessionDir = await sessionDirOf(ctx.get('sessionPersistence'), sessionId)
          // Pre-isolation archives have no sessionId; adopt the ones this
          // session's own log recorded, once, so its history is not lost.
          await adoptLegacyEvents({
            home: dshHome,
            sessionId,
            sessionDir,
            readSessionInfo: async (id) => {
              const query = ctx.get('sessionQuery')
              if (typeof query?.readSession !== 'function') return undefined
              const snapshot = await query.readSession(id)
              const events = snapshot?.events ?? []
              // Only external_agent_run results may attribute a job id; a
              // generic tool result that merely lists the archive must not.
              const callNames = new Map()
              for (const event of events) {
                if (event?.type === 'tool/call') callNames.set(String(event.data?.callId ?? ''), String(event.data?.name ?? ''))
              }
              const texts = []
              for (const event of events) {
                if (event?.type !== 'tool/result') continue
                const callId = String(event.data?.message?.source?.callId ?? '')
                if (callNames.get(callId) !== 'external_agent_run') continue
                texts.push(JSON.stringify(event.data))
              }
              return { cwd: snapshot?.session?.cwd, text: texts.join('\n') }
            }
          }).catch(() => 0)
          jobs = listExternalEventFiles({ home: dshHome, sessionId, sessionDir })
            .map(({ path: _path, ...meta }) => meta)
        }
        const payload = JSON.stringify({ jobs })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        if (req.method === 'HEAD') res.end()
        else res.end(payload)
      }
    }), 'dsh-slice-pipeline: claude event list route')
  })

  const status = pipelineToolStatus()
  if (status.ok) {
    ctx.logger?.info?.('dsh-slice-pipeline: slice_pipeline_run registered')
  } else {
    ctx.logger?.warn?.('dsh-slice-pipeline: slice_pipeline_run NOT registered: ' + status.reason)
  }

  ctx.inject(['tuiSettingsSections'], (child) => {
    child.effect(
      () => registerTuiSettings(ctx, child.tuiSettingsSections, currentConfig),
      'dsh-slice-pipeline: tui settings section'
    )
  })
}

export { Config } from './config.js'
export { apply, inject, name }
export default { Config, apply, inject, name }
