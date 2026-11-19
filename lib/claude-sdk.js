/**
 * Claude Agent SDK one-shot runner.
 *
 * The plugin deliberately does not declare the Claude Agent SDK as a dependency:
 * it is installed lazily into the DSH home, with `--omit=optional`, and the
 * user's own Claude Code binary is used. That mirrors how a CLI-based plugin
 * stays small while still getting structured output and a permission callback.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DEFAULT_EXTERNAL_SDK_VERSION } from './config.js'

const execFileAsync = promisify(execFile)
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const SDK_ENTRY = 'sdk.mjs'
const ALLOWED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite'])
const DENIED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const READ_ONLY_BASH = /^\s*(codegraph|git\s+(diff|status|log|show)|rg|grep|findstr|type|Get-Content|dir|ls)\b/i

export function resolveClaudeHome(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return resolve(base)
}

/** Read the native CLI settings without ever logging the auth values. */
export function readNativeClaudeSettings(env = process.env) {
  const path = join(resolveClaudeHome(env), 'settings.json')
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    parsed = null
  }
  const settings = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
  const rawEnv = (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) ? settings.env : {}
  const nativeEnv = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string' && value !== '') nativeEnv[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) nativeEnv[key] = String(value)
    else if (typeof value === 'boolean') nativeEnv[key] = value ? 'true' : 'false'
  }
  const model = (typeof settings.model === 'string' && settings.model !== '')
    ? settings.model
    : (typeof nativeEnv.ANTHROPIC_MODEL === 'string' ? nativeEnv.ANTHROPIC_MODEL : '')
  return { path, model, env: nativeEnv }
}

function candidateClaudeBinaries(env = process.env) {
  const names = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd']
    : ['claude']
  const dirs = (env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)))
}

/** Read the native Claude model choices without exposing auth values. */
export function readClaudeModelOptions(env = process.env) {
  const native = readNativeClaudeSettings(env)
  const aliases = {
    sonnet: native.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    opus: native.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
    haiku: native.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || ''
  }
  const options = []
  const seen = new Set()
  const add = (value, label) => {
    if (seen.has(value)) return
    seen.add(value)
    options.push({ value, label })
  }
  const defaultModelName = native.env.ANTHROPIC_MODEL || native.model
  const defaultLabel = defaultModelName !== ''
    ? 'Claude CLI 默认（' + defaultModelName + '）'
    : 'Claude CLI 默认'
  add('', defaultLabel)
  for (const [alias, resolved] of Object.entries(aliases)) {
    if (resolved !== '') add(alias, alias + ' → ' + resolved)
  }
  for (const [alias, resolved] of Object.entries(aliases)) {
    if (resolved !== '') add(resolved, resolved + '（' + alias + ' 的实际模型）')
  }
  if (native.env.ANTHROPIC_MODEL) {
    add(native.env.ANTHROPIC_MODEL, native.env.ANTHROPIC_MODEL + '（ANTHROPIC_MODEL）')
  }
  if (native.env.ANTHROPIC_REASONING_MODEL) {
    add(native.env.ANTHROPIC_REASONING_MODEL, native.env.ANTHROPIC_REASONING_MODEL + '（reasoning）')
  }
  return {
    options,
    current: {
      model: native.model,
      envModel: native.env.ANTHROPIC_MODEL || '',
      aliases
    }
  }
}

/** Resolve the real executable behind the npm Windows shim, when possible. */
function windowsShimTarget(candidate) {
  if (process.platform !== 'win32' || !candidate.toLowerCase().endsWith('.cmd')) return null
  const dir = dirname(candidate)
  const local = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  return existsSync(local) ? local : null
}

export function resolveClaudeBinary(env = process.env) {
  if (typeof env.CLAUDE_BIN === 'string' && env.CLAUDE_BIN !== '' && existsSync(env.CLAUDE_BIN)) {
    return windowsShimTarget(resolve(env.CLAUDE_BIN)) || resolve(env.CLAUDE_BIN)
  }
  for (const candidate of candidateClaudeBinaries(env)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return windowsShimTarget(resolve(candidate)) || resolve(candidate)
      }
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return null
}

function sdkLayout(dshHome, version) {
  const root = join(resolve(dshHome), 'slice-pipeline', 'claude-sdk', version)
  return { root, entry: join(root, 'node_modules', SDK_PACKAGE, SDK_ENTRY), marker: join(root, '.installed.json') }
}

function validVersion(value) {
  return typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

/**
 * npm install arguments for one SDK layout. Windows runs npm through cmd.exe
 * (`shell: true`), which splits unquoted arguments on spaces; quoting the
 * prefix keeps a home path like "John Doe" in one piece.
 */
export function sdkInstallArgs(layout, version = DEFAULT_EXTERNAL_SDK_VERSION) {
  const prefix = process.platform === 'win32' ? '"' + layout.root + '"' : layout.root
  return [
    'install', `${SDK_PACKAGE}@${version}`,
    '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', prefix
  ]
}

/** Install the pinned SDK into the DSH home on first use. */
export async function ensureClaudeSdk({ dshHome, version = DEFAULT_EXTERNAL_SDK_VERSION, logger = console } = {}) {
  if (!validVersion(version)) throw new Error('externalAgents.sdkVersion 不是合法 semver：' + String(version))
  const layout = sdkLayout(dshHome, version)
  if (existsSync(layout.entry)) return layout.entry
  mkdirSync(layout.root, { recursive: true })
  writeFileSync(join(layout.root, 'package.json'), JSON.stringify({ private: true, type: 'module' }), 'utf8')
  const args = sdkInstallArgs(layout, version)
  logger?.info?.('slice-pipeline: installing ' + SDK_PACKAGE + '@' + version)
  try {
    await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: layout.root,
      timeout: 300000,
      windowsHide: true,
      shell: process.platform === 'win32',
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (error) {
    throw new Error('Claude Agent SDK 安装失败（' + SDK_PACKAGE + '@' + version + '）：'
      + String(error?.stderr || error?.message || error))
  }
  if (!existsSync(layout.entry)) {
    throw new Error('Claude Agent SDK 安装后找不到入口：' + layout.entry
      + '（可检查 npm 网络/权限，或设置 externalAgents.sdkVersion）')
  }
  writeFileSync(layout.marker, JSON.stringify({ version, installedAt: new Date().toISOString() }), 'utf8')
  return layout.entry
}

function permissionDecision(toolName, input) {
  // Claude Code injects this tool when outputFormat=json_schema. It is the
  // only way the agent can hand back validated structured output; denying it
  // makes the run end with text and no structured_output.
  if (toolName === 'StructuredOutput') return { behavior: 'allow', updatedInput: input }
  if (ALLOWED_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input }
  if (toolName === 'Bash') {
    const command = (input && typeof input.command === 'string') ? input.command : ''
    if (READ_ONLY_BASH.test(command)) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: 'slice-pipeline external agent is read-only (bash)' }
  }
  if (DENIED_TOOLS.has(toolName)) {
    return { behavior: 'deny', message: 'slice-pipeline external agent is read-only' }
  }
  return { behavior: 'deny', message: 'slice-pipeline external agent only allows read-only tools' }
}

/** Some proxies ignore output_format and return the JSON as ordinary text. */
function parseJsonResultText(value) {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try { return JSON.parse(text.slice(start, end + 1)) } catch { return undefined }
  }
}

function textBlocks(content) {
  const out = { text: '', thinking: '', tools: [] }
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.text += block.text
    if (block.type === 'thinking' && typeof block.thinking === 'string') out.thinking += block.thinking
    if (block.type === 'reasoning' && typeof block.text === 'string') out.thinking += block.text
    if (block.type === 'tool_use') out.tools.push(block)
  }
  return out
}

function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.command === 'string') return input.command.slice(0, 200)
  if (typeof input.pattern === 'string') return input.pattern
  return ''
}

/**
 * Create a one-shot runner. `loadQuery` and `prepareSdk` are injectable so the
 * tool tests never download or spawn the real Claude CLI.
 */
export function createClaudeRunner({ dshHome, version = DEFAULT_EXTERNAL_SDK_VERSION, logger = console, loadQuery, prepareSdk } = {}) {
  const prepare = prepareSdk || (() => ensureClaudeSdk({ dshHome, version, logger }))
  const load = loadQuery || (async (entry) => {
    const module = await import(pathToFileURL(entry).href)
    if (typeof module.query !== 'function') throw new Error('Claude Agent SDK entry exposes no query(): ' + entry)
    return module.query
  })
  return async function runClaudeOneShot({
    prompt, schema, cwd, model = '', showThinking = true, maxTurns = 120, timeoutMs = 1_800_000, firstResponseTimeoutMs = 600_000, effort = '', showThinkingSummaries = true, signal, onEvent
  }) {
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('external agent prompt 为空')
    if (!schema || typeof schema !== 'object') throw new Error('external agent schema 缺失')
    const entry = await prepare()
    const query = await load(entry)
    const native = readNativeClaudeSettings()
    // Blank means "let the CLI resolve its own model": settings.json model,
    // ANTHROPIC_MODEL and aliases keep their native precedence.
    const selectedModel = model || ''
    const selectedEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(effort)) ? String(effort) : ''
    const started = Date.now()
    const abort = new AbortController()
    let abortReason = null
    const abortWith = (reason) => {
      if (abort.signal.aborted) return
      abortReason = reason
      abort.abort()
    }
    const onAbort = () => abortWith('cancelled')
    if (signal) {
      if (signal.aborted) abortWith('cancelled')
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => abortWith('overall-timeout'), Math.max(1000, Number(timeoutMs) || 1_800_000))
    const firstResponseTimer = setTimeout(() => {
      if (!firstMessage) abortWith('no-first-response')
    }, Math.max(1000, Number(firstResponseTimeoutMs) || 600_000))
    let result = null
    let seen = 0
    let initModel = null
    let firstMessage = false
    let sawThinkingDelta = false
    const emit = (event) => { try { onEvent?.(event) } catch { /* progress must not break the run */ } }
    if (String(native.env?.MAX_THINKING_TOKENS ?? '') === '0') {
      emit({ v: 1, t: 'thinking-disabled' })
    }
    const heartbeat = setInterval(() => {
      if (!firstMessage) emit({ v: 1, t: 'heartbeat', phase: 'starting', elapsedMs: Date.now() - started })
    }, 5000)
    let streamError = null
    try {
      const q = query({
        prompt,
        options: {
          cwd,
          model: selectedModel || undefined,
          ...(selectedEffort !== '' ? { effort: selectedEffort } : {}),
          ...(showThinking ? { thinking: { type: 'adaptive' } } : {}),
          settings: { showThinkingSummaries: showThinkingSummaries !== false },
          permissionMode: 'default',
          settingSources: [],
          disallowedTools: [...DENIED_TOOLS],
          canUseTool: async (toolName, input) => permissionDecision(toolName, input),
          outputFormat: { type: 'json_schema', schema },
          persistSession: false,
          maxTurns,
          includePartialMessages: true,
          env: { ...process.env, ...native.env },
          abortController: abort,
          stderr: (data) => emit({ v: 1, t: 'stderr', text: String(data).slice(0, 1000) }),
          ...(resolveClaudeBinary() ? { pathToClaudeCodeExecutable: resolveClaudeBinary() } : {})
        }
      })
      for await (const message of q) {
        if (!message || typeof message !== 'object') continue
        if (message.type === 'assistant' || message.type === 'stream_event' || message.type === 'user' || message.type === 'result') {
          firstMessage = true
          clearTimeout(firstResponseTimer)
          clearInterval(heartbeat)
        }
        if (message.type === 'system' && message.subtype === 'init') {
          initModel = message.model ?? selectedModel
          emit({ v: 1, t: 'phase', phase: 'starting', label: '启动 Claude', model: initModel, cwd })
          continue
        }
        if (message.type === 'stream_event' && message.event && message.event.type === 'content_block_delta') {
          const delta = message.event.delta
          if (delta && delta.type === 'thinking_delta') {
            const text = String(delta.thinking ?? delta.text ?? '')
            if (text !== '') {
              sawThinkingDelta = true
              emit({ v: 1, t: 'thinking', text })
            }
          }
          continue
        }
        if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
          const blocks = textBlocks(message.message.content)
          if (showThinking && !sawThinkingDelta && blocks.thinking !== '') emit({ v: 1, t: 'thinking', text: blocks.thinking.slice(0, 2000) })
          if (blocks.text !== '') emit({ v: 1, t: 'text', text: blocks.text.slice(0, 4000) })
          for (const tool of blocks.tools) {
            seen += 1
            emit({
              v: 1, t: 'tool', id: String(tool.id ?? 'tool-' + seen), name: String(tool.name ?? 'tool'),
              target: toolTarget(tool.name, tool.input), status: 'start'
            })
          }
          continue
        }
        if (message.type === 'user' && message.message && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block && block.type === 'tool_result') {
              emit({
                v: 1, t: 'tool', id: String(block.tool_use_id ?? ''), status: 'end',
                ok: block.is_error !== true
              })
            }
          }
          continue
        }
        if (message.type === 'result') {
          result = message
          const failed = message.is_error === true || message.subtype !== 'success'
          emit({
            v: 1, t: 'done', status: failed ? 'failed' : 'completed',
            detail: message.result ?? message.error ?? message.subtype,
            ...(message.structured_output !== undefined ? { structured: message.structured_output } : {}),
            usage: message.usage, costUsd: message.total_cost_usd
          })
          break
        }
      }
    } catch (error) {
      streamError = error
    } finally {
      clearTimeout(timer)
      clearTimeout(firstResponseTimer)
      clearInterval(heartbeat)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (result === null) {
      if (abortReason === 'no-first-response') {
        throw new Error('Claude 在 ' + Math.round((Number(firstResponseTimeoutMs) || 600_000) / 60000)
          + ' 分钟内没有返回首个内容响应；已中止。请检查 native CLI 的模型/代理是否可用（当前可能卡在 unrecognized_model）')
      }
      if (abortReason === 'overall-timeout') throw new Error('Claude 执行超时')
      if (abortReason === 'cancelled') throw new Error('Claude 执行被取消')
      if (streamError !== null) throw streamError
      throw new Error('Claude Agent SDK 未返回 result 消息')
    }
    if (result.is_error === true || result.subtype !== 'success') {
      throw new Error('Claude 执行失败：' + String(result.error ?? result.result ?? result.subtype ?? 'unknown'))
    }
    const structured = result.structured_output !== undefined && result.structured_output !== null
      ? result.structured_output
      : parseJsonResultText(result.result)
    if (structured === undefined || structured === null) {
      throw new Error('Claude 未返回 structured_output（检查 model / proxy 的 JSON-schema 支持；也没有可解析的 JSON 文本）')
    }
    return {
      structuredOutput: structured,
      resultText: typeof result.result === 'string' ? result.result : '',
      usage: result.usage ?? null,
      modelUsage: result.modelUsage ?? null,
      costUsd: result.total_cost_usd ?? null,
      model: initModel || selectedModel || null,
      configuredModel: selectedModel || null,
      durationMs: Date.now() - started
    }
  }
}
