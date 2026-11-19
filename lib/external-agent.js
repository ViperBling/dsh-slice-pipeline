/**
 * `external_agent_run`: execute one Claude Agent SDK turn as a DSH job.
 *
 * The job is the progress surface: it carries a live progress line and an
 * NDJSON event stream on the observer-only `log` channel. The final structured
 * output is written to `<outDir>/external/...json`, never returned inline.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, dirname, isAbsolute } from 'node:path'
import { createClaudeRunner } from './claude-sdk.js'
import { toCanonicalDefinition } from './tool-schema.js'

export const EXTERNAL_TOOL_NAME = 'external_agent_run'
export const EXTERNAL_JOB_KIND = 'claude'

function sha12(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new Error(message)
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

function assertInside(base, target) {
  const rel = relative(resolve(base), resolve(target))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail('结果路径必须位于 outDir/external 下')
}

function eventLine(event) {
  return JSON.stringify({ v: 1, at: Date.now(), ...event }) + '\n'
}

// The browser can lose a jobs.observe generation while a tab is being
// created. Keep the same NDJSON on disk so the panel can re-read it over the
// plugin's local HTTP route without depending on that stream.
//
// Events are scoped to the owning Session: they live inside that Session's
// directory so another Session (or another profile window) can never list or
// read them. The plugin-data fallback keeps the same shape for hosts whose
// persistence backend does not report a location.
const EVENT_FILES = new Map()
const EVENT_META = new Map()

function fallbackEventsDir(home, sessionId) {
  return join(home, 'slice-pipeline', 'claude-events', safeName(String(sessionId || 'no-session')))
}

function eventsDirFor({ home, sessionDir, sessionId }) {
  return sessionDir
    ? join(sessionDir, 'slice-pipeline', 'claude-events')
    : fallbackEventsDir(home, sessionId)
}

function candidateEventDirs({ home, sessionDir, sessionId }) {
  const dirs = []
  if (sessionDir !== undefined && sessionDir !== '') dirs.push(join(sessionDir, 'slice-pipeline', 'claude-events'))
  if (home !== undefined) dirs.push(fallbackEventsDir(home, sessionId))
  return dirs
}

function readEventMeta(dir, jobId) {
  try {
    return JSON.parse(readFileSync(join(dir, safeName(String(jobId)) + '.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

/**
 * Resolve the persisted directory of one Session. The snapshot's `location`
 * is the session log file; its parent is the Session's own directory.
 * @param persistence - `ctx.get('sessionPersistence')`; may be undefined.
 * @param sessionId - the owning Session id.
 */
export async function sessionDirOf(persistence, sessionId) {
  if (sessionId === undefined || sessionId === null || String(sessionId) === '') return undefined
  try {
    const snapshot = await persistence?.stat?.(String(sessionId))
    const path = snapshot?.location?.path
    return typeof path === 'string' && path !== '' ? dirname(path) : undefined
  } catch {
    return undefined
  }
}

export function getExternalEventFile(jobId, { home, sessionId, sessionDir } = {}) {
  const id = String(jobId)
  const wanted = String(sessionId ?? '')
  const live = EVENT_FILES.get(id)
  if (live !== undefined) {
    if (live.sessionId !== wanted) return undefined
    // Fall through when the file was removed behind our back, so the scan
    // below can return a real path or a clean undefined.
    if (existsSync(live.path)) return live.path
  }
  if (wanted === '') return undefined
  for (const dir of candidateEventDirs({ home, sessionDir, sessionId: wanted })) {
    const path = join(dir, safeName(id) + '.ndjson')
    if (!existsSync(path)) continue
    if (readEventMeta(dir, id).sessionId !== wanted) continue
    return path
  }
  return undefined
}

export function listExternalEventFiles({ home, sessionId, sessionDir } = {}) {
  const wanted = String(sessionId ?? '')
  const found = new Map()
  if (wanted === '') return []
  for (const dir of candidateEventDirs({ home, sessionDir, sessionId: wanted })) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ndjson')) continue
        const jobId = name.slice(0, -'.ndjson'.length)
        const meta = readEventMeta(dir, jobId)
        if (meta.sessionId !== wanted) continue
        found.set(jobId, {
          jobId,
          label: meta.label || jobId,
          ...(typeof meta.role === 'string' ? { role: meta.role } : {}),
          startedAt: meta.startedAt || 0,
          ...(meta.finishedAt !== undefined ? { finishedAt: meta.finishedAt } : {}),
          status: meta.status
        })
      }
    } catch { /* archive not created yet */ }
  }
  for (const [jobId, entry] of EVENT_FILES) {
    if (EVENT_META.get(jobId)?.sessionId !== wanted) continue
    found.set(jobId, { jobId, path: entry.path, ...(found.get(jobId) || {}), ...(EVENT_META.get(jobId) || {}) })
  }
  const startedOf = (entry) => {
    const value = entry.startedAt
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const parsed = Date.parse(String(value ?? ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return [...found.values()].sort((left, right) => startedOf(right) - startedOf(left))
}

// Sessions already checked for pre-isolation archives; adoption runs once per
// session per process so the list poll never re-reads a session log.
const ADOPTION_CHECKED = new Set()
const ADOPTION_RUNNING = new Set()

/** True when `child` is `parent` itself or lives under it (case-insensitive, both separators). */
function isUnderPath(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || parent.trim() === '') return false
  const normalize = (value) => resolve(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const target = normalize(child)
  const base = normalize(parent)
  return target === base || target.startsWith(base + '/')
}

function legacyDirFor(home) {
  return home === undefined ? undefined : join(home, 'slice-pipeline', 'claude-events')
}

function sessionEventsDir(sessionDir) {
  return join(sessionDir, 'slice-pipeline', 'claude-events')
}

/**
 * Undo copies made into the wrong Session by the earlier adoption pass: a
 * session-scoped archive that is byte-identical to a legacy archive whose
 * `outDir` lies outside the Session's cwd cannot belong to this Session.
 * The legacy source is left untouched.
 */
export function repairAdoptedEvents({ home, sessionDir, cwd }) {
  const legacyDir = legacyDirFor(home)
  if (legacyDir === undefined || sessionDir === undefined || sessionDir === '') return 0
  if (typeof cwd !== 'string' || cwd === '') return 0
  const targetDir = sessionEventsDir(sessionDir)
  let names
  try { names = readdirSync(targetDir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue
    const jobId = name.slice(0, -'.ndjson'.length)
    const legacyPath = join(legacyDir, name)
    if (!existsSync(legacyPath)) continue
    const meta = readEventMeta(legacyDir, jobId)
    if (typeof meta.outDir === 'string' && isUnderPath(meta.outDir, cwd)) continue
    try {
      if (statSync(legacyPath).size !== statSync(join(targetDir, name)).size) continue
      unlinkSync(join(targetDir, name))
      unlinkSync(join(targetDir, safeName(jobId) + '.json'))
      removed += 1
    } catch { /* best effort */ }
  }
  return removed
}

/**
 * One-time adoption of pre-isolation archives (`~/.dsh/slice-pipeline/claude-events`).
 * A legacy sidecar has no `sessionId`; a job is adopted only when the Session
 * actually ran it (its `external_agent_run` tool result names the job id) and
 * the job's outDir lies under that Session's cwd. Sources stay untouched.
 * @param sessionId - the requesting Session.
 * @param sessionDir - that Session's directory, when known.
 * @param readSessionInfo - resolves `{ cwd, text }` for a Session, where text
 *   holds only `external_agent_run` tool results.
 * @returns how many legacy jobs were adopted.
 */
export async function adoptLegacyEvents({ home, sessionId, sessionDir, readSessionInfo }) {
  const wanted = String(sessionId ?? '')
  if (wanted === '' || sessionDir === undefined || sessionDir === '') return 0
  if (typeof readSessionInfo !== 'function') return 0
  if (ADOPTION_CHECKED.has(wanted) || ADOPTION_RUNNING.has(wanted)) return 0
  const legacyDir = legacyDirFor(home)
  if (legacyDir === undefined) return 0
  let names
  try { names = readdirSync(legacyDir) } catch { return 0 }
  const legacyJobs = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((jobId) => readEventMeta(legacyDir, jobId).sessionId === undefined)
  if (legacyJobs.length === 0) return 0
  const info = await readSessionInfo(wanted).catch(() => undefined)
  if (info === undefined || info === null) return 0
  const cwd = typeof info.cwd === 'string' ? info.cwd : undefined
  repairAdoptedEvents({ home, sessionDir, cwd })
  const text = typeof info.text === 'string' ? info.text : ''
  ADOPTION_RUNNING.add(wanted)
  try {
    let adopted = 0
    // An empty text is a definitive answer (this session never ran an external
    // agent), not a transient failure: cache it so the 5s poll stops re-reading
    // the whole session log.
    if (text !== '') {
      const targetDir = eventsDirFor({ home, sessionDir, sessionId: wanted })
      for (const jobId of legacyJobs) {
        const meta = readEventMeta(legacyDir, jobId)
        if (cwd !== undefined && typeof meta.outDir === 'string' && !isUnderPath(meta.outDir, cwd)) continue
        if (!text.includes(jobId)) continue
        try {
          mkdirSync(targetDir, { recursive: true })
          copyFileSync(join(legacyDir, safeName(jobId) + '.ndjson'), join(targetDir, safeName(jobId) + '.ndjson'))
          writeFileSync(join(targetDir, safeName(jobId) + '.json'),
            JSON.stringify({ ...meta, jobId, sessionId: wanted }, null, 2), 'utf8')
          adopted += 1
        } catch { /* adoption is best effort */ }
      }
    }
    ADOPTION_CHECKED.add(wanted)
    return adopted
  } finally {
    ADOPTION_RUNNING.delete(wanted)
  }
}

export function createExternalAgentTool({
  getConfig,
  jobs,
  dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'),
  logger = console,
  runnerFactory = null,
  sessionDirFor = null
} = {}) {
  const getJobs = () => (typeof jobs === 'function' ? jobs() : jobs)
  const definitions = new Map()
  const homeDir = () => (typeof dshHome === 'function' ? dshHome() : dshHome)
  const runnerFor = (config) => {
    if (runnerFactory) return runnerFactory
    const key = config.externalAgents?.sdkVersion || ''
    if (!definitions.has(key)) {
      definitions.set(key, createClaudeRunner({
        dshHome: homeDir(),
        version: config.externalAgents?.sdkVersion || undefined,
        logger
      }))
    }
    return definitions.get(key)
  }

  async function execute(params, exec) {
    const config = getConfig()
    const role = params.role
    if (role !== 'designer' && role !== 'reviewer') fail('role 必须是 designer 或 reviewer')
    const external = config.externalAgents?.[role]
    if (!external || external.enabled !== true) fail(role + ' 未启用外部 agent（externalAgents.' + role + '.enabled=false）')
    if (external.cli !== 'claude') fail('当前只支持 claude CLI')
    if (typeof params.outDir !== 'string' || params.outDir.trim() === '') fail('outDir 不能为空')
    let prompt = params.prompt
    if (typeof params.promptPath === 'string' && params.promptPath !== '') {
      const promptFile = resolve(params.promptPath)
      const promptBase = resolve(params.outDir || '', 'external')
      const rel = relative(promptBase, promptFile)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail('promptPath 必须位于 outDir/external 下')
      prompt = await readFile(promptFile, 'utf8').catch(() => {
        fail('promptPath 读取失败：' + promptFile)
      })
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') fail('prompt / promptPath 不能为空')
    if (!isPlainObject(params.schema)) fail('schema 必须是 JSON Schema 对象')
    if (sha12(prompt) !== params.promptSha12) fail('promptSha12 与任务书不一致：任务书被改写或指纹过期')
    if (typeof params.cwd !== 'string' || params.cwd.trim() === '') fail('cwd 不能为空')
    const cwd = resolve(params.cwd)
    const outDir = resolve(params.outDir)
    const cwdStat = await stat(cwd).catch(() => null)
    if (cwdStat === null || !cwdStat.isDirectory()) fail('cwd 不存在或不是目录：' + cwd)
    const externalDir = join(outDir, 'external')
    await ensureDir(externalDir)
    const resultPath = join(externalDir, safeName(role) + '-' + Date.now() + '.json')
    assertInside(externalDir, resultPath)
    const registry = getJobs()
    if (!registry || typeof registry.start !== 'function') fail('jobs 服务不可用：无法展示外部 agent 进度')

    const owner = exec?.agent?.id
    const sessionId = owner === undefined ? '' : String(owner)
    const sessionDir = sessionDirFor === null || sessionId === ''
      ? undefined
      : await Promise.resolve().then(() => sessionDirFor(sessionId)).catch(() => undefined)
    const archiveDir = eventsDirFor({ home: homeDir(), sessionDir, sessionId })
    // Settings win over the tool defaults; explicit per-call params win over both.
    const configuredTimeoutMs = Math.max(60_000, (Number(config.externalAgents?.timeoutMinutes) || 30) * 60_000)
    const configuredFirstResponseMs = Math.max(30_000, (Number(config.externalAgents?.firstResponseTimeoutMinutes) || 10) * 60_000)
    const timeoutMs = Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : configuredTimeoutMs
    const firstResponseTimeoutMs = Number(params.firstResponseTimeoutMs) > 0
      ? Number(params.firstResponseTimeoutMs)
      : configuredFirstResponseMs
    const controller = new AbortController()
    let outcome = null
    let cancelReason = null
    const label = params.label || ('Claude ' + role)
    const jobId = registry.start({
      kind: EXTERNAL_JOB_KIND,
      label,
      ...(owner !== undefined ? { owner } : {}),
      outputLimitBytes: 1_000_000,
      run: (job) => {
        job.updateProgress('启动 Claude…')
        const eventPaths = []
        try {
          mkdirSync(archiveDir, { recursive: true })
          const archivePath = join(archiveDir, safeName(String(job.id)) + '.ndjson')
          writeFileSync(archivePath, '', 'utf8')
          eventPaths.push(archivePath)
          EVENT_FILES.set(String(job.id), { path: archivePath, sessionId })
          EVENT_META.set(String(job.id), { label, startedAt: job.startedAt ?? Date.now(), sessionId, role })
          writeFileSync(join(archiveDir, safeName(String(job.id)) + '.json'), JSON.stringify({
            jobId: String(job.id), label, role, startedAt: job.startedAt ?? Date.now(), outDir, sessionId
          }, null, 2), 'utf8')
        } catch { /* archive is best effort; job still runs */ }
        const appendEvent = (event) => {
          const line = eventLine(event)
          try { job.append(line, { channel: 'log' }) } catch { /* observer stream may be gone */ }
          for (const path of eventPaths) {
            try { appendFileSync(path, line, 'utf8') } catch { /* diagnostics are best effort */ }
          }
        }
        appendEvent({ t: 'phase', phase: 'starting', label: '启动 Claude' })
        const done = (async () => {
          try {
            const result = await runnerFor(config)({
              prompt,
              schema: params.schema,
              cwd,
              model: params.model ?? external.model ?? '',
              showThinking: params.showThinking ?? config.externalAgents.showThinking,
              maxTurns: params.maxTurns ?? config.externalAgents.maxTurns ?? 120,
              timeoutMs,
              firstResponseTimeoutMs,
              effort: params.effortLevel ?? config.externalAgents.effortLevel ?? '',
              showThinkingSummaries: params.showThinkingSummaries ?? config.externalAgents.showThinkingSummaries ?? true,
              signal: controller.signal,
              onEvent: (event) => {
                if (event.t === 'tool' && event.status === 'start') {
                  job.updateProgress('分析代码 · ' + (event.name || 'tool') + (event.target ? ' ' + event.target : ''))
                } else if (event.t === 'thinking') {
                  job.updateProgress('思考中…')
                } else if (event.t === 'text') {
                  job.updateProgress('生成结果…')
                } else if (event.t === 'heartbeat') {
                  job.updateProgress('等待模型响应… ' + Math.round((event.elapsedMs || 0) / 1000) + 's')
                } else if (event.t === 'stderr') {
                  job.updateProgress('Claude: ' + String(event.text || '').slice(0, 120))
                } else if (event.t === 'done') {
                  job.updateProgress(event.status === 'completed' ? '完成' : '失败')
                }
                appendEvent(event)
              }
            })
            await writeFile(resultPath, JSON.stringify(result.structuredOutput, null, 2), 'utf8')
            outcome = result
            return {
              status: 'completed',
              detail: (role + ' 完成，' + Math.round(result.durationMs / 1000) + 's'
                + (result.costUsd != null ? '，$' + Number(result.costUsd).toFixed(3) : ''))
            }
          } catch (error) {
            const message = String(error?.message || error)
            appendEvent({ t: 'done', status: 'failed', detail: message })
            if (cancelReason !== null || controller.signal.aborted) {
              return { status: 'killed', detail: cancelReason || 'cancelled' }
            }
            return { status: 'failed', detail: message }
          }
        })()
        // Record the real final status/time on the sidecar so a later history
        // view does not have to guess from the event stream.
        const tracked = done.then((outcome) => {
          try {
            const metaPath = join(archiveDir, safeName(String(job.id)) + '.json')
            const current = JSON.parse(readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, ''))
            writeFileSync(metaPath, JSON.stringify({
              ...current, status: outcome.status, finishedAt: Date.now()
            }, null, 2), 'utf8')
          } catch { /* sidecar is best effort */ }
          return outcome
        })
        return {
          done: tracked,
          cancel: (reason) => {
            cancelReason = reason || 'cancelled'
            controller.abort()
          }
        }
      }
    })

    let view
    try {
      view = await registry.wait(jobId, timeoutMs, owner, exec?.signal)
    } catch (error) {
      // The caller cancelled (turn aborted): stop the job too, otherwise the
      // external CLI keeps running until its own timeout.
      try { registry.kill(jobId, owner, 'caller cancelled') } catch { /* job may already be settled */ }
      throw error
    }
    if (view.status === 'running' || view.status === 'stopping') {
      registry.kill(jobId, owner, '外部 agent 超时')
      throw new Error('外部 agent 超时（' + timeoutMs + 'ms），job=' + jobId)
    }
    if (view.status !== 'completed') {
      throw new Error('外部 agent 失败（job=' + jobId + '）：' + String(view.detail || view.status))
    }
    if (outcome === null) throw new Error('外部 agent 已结算但没有结果：job=' + jobId)
    return {
      ok: true,
      jobId,
      resultPath,
      role,
      cli: 'claude',
      routeSource: 'claude-cli',
      model: outcome.model,
      configuredModel: outcome.configuredModel ?? null,
      durationMs: outcome.durationMs,
      usage: outcome.usage,
      costUsd: outcome.costUsd
    }
  }

  const definition = {
    name: EXTERNAL_TOOL_NAME,
    description: '用本机 Claude Code（Claude Agent SDK one-shot）执行 Designer/Reviewer 任务；进度写入 DSH job，结果写到 outDir/external。',
    parameters: {
      role: { type: 'string', required: true, enum: ['designer', 'reviewer'] },
      prompt: { type: 'string', description: 'render 结果返回的任务书原文；与 promptPath 二选一' },
      promptPath: { type: 'string', description: 'render 结果返回的任务书文件绝对路径（推荐，避免复制长 prompt）' },
      promptSha12: { type: 'string', required: true, description: '任务书 sha256 前 12 位' },
      schema: { type: 'json', required: true, description: '输出 JSON Schema' },
      cwd: { type: 'string', required: true, description: '外部 agent 的工作目录（通常是 repoRoot）' },
      outDir: { type: 'string', required: true, description: '本片任务目录；结果写到 <outDir>/external/' },
      label: { type: 'string', description: '进度面板显示的一行标签' },
      model: { type: 'string', description: '留空 = 使用 Claude CLI 配置' },
      showThinking: { type: 'boolean', description: '是否把 thinking 写入进度流' },
      timeoutMs: { type: 'integer', description: '超时（毫秒），默认 30 分钟' },
      firstResponseTimeoutMs: { type: 'integer', description: '首个内容响应超时（毫秒），默认 10 分钟' },
      maxTurns: { type: 'integer', description: '最大回合数，默认 120' },
      effortLevel: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: '外部 CLI effort（省略则用 native settings/模型默认）' },
      showThinkingSummaries: { type: 'boolean', description: '是否请求 thinking summaries，默认 true' }
    },
    output: {
      // Keep the registry-enforced schema inside DSH's supported subset: a
      // single object root with additionalProperties. Nullable unions are not
      // accepted by the tool registry, and the result fields are already
      // validated by the producer.
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{
        type: 'text',
        text: 'external_agent_run ' + String(value?.role ?? args.role)
          + ' 完成；resultPath=' + String(value?.resultPath ?? '(none)')
          + (value?.jobId ? '；job=' + value.jobId : '')
      }]
    },
    execute
  }

  return { definition: toCanonicalDefinition(definition), execute }
}

let externalToolStatus = { ok: false, reason: 'not attempted' }

/** Registration status for host diagnostics. */
export function getExternalToolStatus() {
  return externalToolStatus
}

export function registerExternalAgentTool(ctx, { pluginRoot, getConfig }) {
  try {
    const homePath = ctx.get('dshHomePath')
    const resolvedHome = typeof homePath === 'function' ? homePath() : homePath
    const tool = createExternalAgentTool({
      getConfig,
      jobs: () => ctx.get('jobs'),
      dshHome: resolvedHome || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'),
      logger: ctx.logger,
      sessionDirFor: (sessionId) => sessionDirOf(ctx.get('sessionPersistence'), sessionId)
    })
    const dispose = ctx.tools.register(tool.definition)
    externalToolStatus = { ok: true, reason: 'registered' }
    ctx.logger?.info?.('dsh-slice-pipeline: external_agent_run registered')
    return dispose
  } catch (error) {
    externalToolStatus = { ok: false, reason: String(error?.message ?? error) }
    ctx.logger?.warn?.('dsh-slice-pipeline: external_agent_run NOT registered: ' + externalToolStatus.reason)
    return () => {}
  }
}

export function deleteExternalEventFiles(jobId, { home, sessionId, sessionDir } = {}) {
  const id = String(jobId)
  const wanted = String(sessionId ?? '')
  if (wanted === '') return 0
  const paths = new Set()
  let removed = 0
  const live = EVENT_FILES.get(id)
  if (live !== undefined) {
    if (live.sessionId !== wanted) return 0
    paths.add(live.path)
  }
  for (const dir of candidateEventDirs({ home, sessionDir, sessionId: wanted })) {
    const meta = readEventMeta(dir, id)
    if (meta.sessionId !== wanted) continue
    const archivePath = join(dir, safeName(id) + '.ndjson')
    if (existsSync(archivePath)) paths.add(archivePath)
    if (typeof meta.outDir === 'string') {
      const outPath = join(meta.outDir, 'external', '.events', safeName(id) + '.ndjson')
      if (existsSync(outPath)) paths.add(outPath)
    }
    // The sidecar counts as a removal: a job whose only remaining file is the
    // sidecar must still answer 200, or the panel never refreshes the list.
    try {
      unlinkSync(join(dir, safeName(id) + '.json'))
      removed += 1
    } catch { /* sidecar is optional */ }
  }
  for (const path of paths) {
    try {
      unlinkSync(path)
      removed += 1
    } catch { /* already gone */ }
  }
  EVENT_FILES.delete(id)
  EVENT_META.delete(id)
  return removed
}