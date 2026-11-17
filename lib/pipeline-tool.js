import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { buildPipelineArgs } from './inject.js'
import { resolveModules } from './paths.js'
import { MAX_PACKAGE_CHARS, extractThinDocForReview, parsePatchStats, renderFocusedReviewPackage, renderReviewPackage } from './review-package.js'
import { toCanonicalDefinition } from './tool-schema.js'

export const TOOL_NAME = 'slice_pipeline_run'
export const MAX_RESULT_CHARS = 20000

let toolStatus = { ok: false, reason: 'not attempted' }

/** Snapshot of the last registration attempt, for injection and logging. */
export function pipelineToolStatus() {
  return { ...toolStatus }
}

const RUNTIME_KEYS = [
  'mode', 'requirement', 'sliceId', 'plan', 'repoRoot', 'workspace',
  'outDir', 'taskName', 'designDocPath', 'maxSlices',
  'maxFixRounds', 'stages', 'discussionDigest', 'round', 'impl', 'findings',
  'patchPath', 'docPath', 'userFeedback', 'preflight', 'reviewScope', 'renderReview', 'codeReview'
]

/** 复审范围：auto = 宿主按材料判定；full = 强制全量；incremental = 显式要求增量（缺料报错）。 */
const REVIEW_SCOPES = ['auto', 'full', 'incremental']

/** Stable short fingerprint of the workflow script bytes. */
export function scriptIdOf(script) {
  return createHash('sha256').update(script).digest('hex').slice(0, 12)
}

/** Stable short fingerprint of a rendered stage task book (sha256 prefix). */
export function promptIdOf(prompt) {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 12)
}

const BATCH_MODES = ['plan-only', 'slice']
// mode='brief'（派 designer agent 写 brief）已随 2026-11-03 改版从工具入口移除：
// brief 由主会话写入 plan.json 的 slices[i].brief；脚本层保留该分支仅作手工内联兜底。
const STAGE_MODES = ['design', 'review', 'render-implement', 'render-fix']
const RENDER_MODES = ['render-implement', 'render-fix', 'review-render']
const MODES = [...BATCH_MODES, ...STAGE_MODES]

const PARAM_KEYS = [
  'mode', 'requirement', 'maxSlices', 'sliceId', 'plan', 'repoRoot',
  'workspace', 'outDir', 'taskName', 'designDocPath', 'maxFixRounds', 'stages', 'dryRun',
  'run_in_background', 'discussionDigest', 'planFile', 'briefFile', 'round', 'impl',
  'findings', 'patchPath', 'docPath', 'userFeedback', 'preflight', 'runContext', 'reviewScope',
  'renderReview', 'codeReview'
]
const INJECTED_FIELDS = ['roles', 'modules', 'reviewStandardPath', 'plainLanguagePath']
const STRING_PARAMS = [
  'mode', 'requirement', 'sliceId', 'repoRoot', 'workspace', 'outDir', 'taskName', 'designDocPath',
  'discussionDigest', 'planFile', 'briefFile', 'patchPath', 'docPath', 'userFeedback'
]
const COUNT_PARAMS = ['maxSlices', 'maxFixRounds']
const FLAG_PARAMS = ['dryRun', 'run_in_background']

/** Required / forbidden params per stage mode (checked before any side effect). */
const MODE_RULES = {
  design: { required: ['requirement', 'discussionDigest'], forbidden: ['planFile', 'sliceId', 'impl'] },
  // brief 不再要求 discussionDigest：本片讨论记录放在 plan.json 的 slices[i].discussion，
  // 由脚本的每片讨论门禁硬校验（缺记录 / 未确认 / 有未决问题都不派发）。
  // 2026-11-03 起 brief 由主会话写入 plan.json 的 slices[i].brief，工具入口不再提供 mode='brief'。
  // briefFile 全部可选：brief 优先从 planFile 的 slices[i].brief 读取，briefFile 仅兼容。
  review: {
    required: [
      'planFile', 'sliceId', 'impl', 'patchPath', 'docPath', 'round', 'userFeedback', 'preflight'
    ],
    forbidden: ['requirement']
  },
  'render-implement': { required: ['planFile', 'sliceId'], forbidden: [] },
  'render-fix': {
    required: ['planFile', 'sliceId', 'impl', 'findings', 'round', 'userFeedback'],
    forbidden: []
  }
}
const NON_BLANK_STRING_PARAMS = [
  'requirement', 'discussionDigest', 'planFile', 'briefFile', 'sliceId', 'patchPath', 'docPath'
]
const DELIVERABLE_PATH_FIELDS = ['patchPath', 'docPath']
const RUN_CONTEXT_FIELDS = ['repoRoot', 'workspace', 'outDir', 'taskName']

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Reject unknown keys and ill-typed values; null means "not given". */
function checkParamShape(value) {
  for (const key of Object.keys(value)) {
    if (!PARAM_KEYS.includes(key)) {
      return `未知参数 ${key}：${INJECTED_FIELDS.join('、')} 由宿主注入，不要传；只接受工具参数表中的运行字段`
    }
  }
  for (const key of STRING_PARAMS) {
    if (value[key] != null && typeof value[key] !== 'string') return `${key} 必须是字符串`
  }
  for (const key of COUNT_PARAMS) {
    if (value[key] != null && !(Number.isSafeInteger(value[key]) && value[key] >= 0)) {
      return `${key} 必须是非负安全整数`
    }
  }
  for (const key of FLAG_PARAMS) {
    if (value[key] != null && typeof value[key] !== 'boolean') return `${key} 必须是布尔值`
  }
  if (value.round != null && !(Number.isSafeInteger(value.round) && value.round >= 1)) {
    return 'round 必须是 >=1 的整数'
  }
  for (const key of ['impl', 'runContext']) {
    if (value[key] != null && !isPlainObject(value[key])) return `${key} 必须是对象`
  }
  if (value.findings != null && !isPlainObject(value.findings) && !Array.isArray(value.findings)) {
    return 'findings 必须是对象或数组'
  }
  if (value.preflight != null && typeof value.preflight !== 'string' && !isPlainObject(value.preflight)) {
    return 'preflight 必须是字符串或对象'
  }
  if (value.reviewScope != null && !REVIEW_SCOPES.includes(value.reviewScope)) {
    return `reviewScope 必须是 ${REVIEW_SCOPES.join(' / ')} 之一`
  }
  if (value.renderReview != null && typeof value.renderReview !== 'boolean') return 'renderReview 必须是布尔值'
  if (value.codeReview != null && !isPlainObject(value.codeReview)) return 'codeReview 必须是对象（子智能体返回的 review JSON 或 {reviewPath}）'
  if (isPlainObject(value.codeReview) && value.codeReview.reviewPath != null) {
    if (typeof value.codeReview.reviewPath !== 'string' || value.codeReview.reviewPath.trim() === '') {
      return 'codeReview.reviewPath 必须是非空字符串'
    }
    const mixed = ['verdict', 'findings', 'standardPath', 'blindFindings', 'previousFindings']
      .filter((key) => value.codeReview[key] !== undefined)
    if (mixed.length > 0) {
      return 'codeReview.reviewPath 不能与完整 review 字段混用：' + mixed.join('、')
    }
  }
  if (value.renderReview === true && value.codeReview != null) {
    return 'renderReview 与 codeReview 不能同时使用'
  }
  if (value.plan != null && !isPlainObject(value.plan)) return 'plan 必须是对象（plan-only 的返回值）'
  if (value.stages != null) {
    if (!isPlainObject(value.stages)) return 'stages 必须是对象'
    for (const stageKey of ['plan', 'slice']) {
      if (value.stages[stageKey] != null && !isStringArray(value.stages[stageKey])) {
        return `stages.${stageKey} 必须是字符串数组`
      }
    }
  }
  return null
}

/** Normalize a path string for containment comparison: slashes, no `.`/`..`, no trailing `/`. */
function normalizePathText(value) {
  const raw = String(value).trim().replace(/\\/g, '/')
  const absolute = /^[a-z]:\//i.test(raw) || raw.startsWith('/')
  const segments = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  if (!absolute) return joined
  return raw.startsWith('/') ? `/${joined}` : joined
}

function isAbsolutePathText(text) {
  return /^[a-z]:\//i.test(text) || text.startsWith('/')
}

/** Comparable forms of a path: the literal form plus relative resolutions worth trying. */
function pathVariants(value, repoRoot) {
  const text = normalizePathText(value)
  const variants = [text]
  if (!isAbsolutePathText(text)) {
    variants.push(normalizePathText(`${process.cwd()}/${text}`))
    const root = typeof repoRoot === 'string' ? normalizePathText(repoRoot) : ''
    if (root !== '' && isAbsolutePathText(root)) variants.push(`${root}/${text}`)
  }
  return variants.map((variant) => (
    /^[a-z]:\//i.test(variant) ? variant[0].toLowerCase() + variant.slice(1) : variant
  ))
}

/** True when `child` sits under `parent` after normalizing separators and drive-letter case. */
function isPathUnder(child, parent, repoRoot) {
  const parents = pathVariants(parent, repoRoot)
  const children = pathVariants(child, repoRoot)
  for (const childPath of children) {
    for (const parentPath of parents) {
      if (parentPath === '') continue
      if (childPath.length > parentPath.length && childPath.startsWith(parentPath + '/')) return true
    }
  }
  return false
}

/**
 * Resolve the cross-call run context (`repoRoot` / `workspace` / `outDir` / `taskName`).
 * Explicit params win; a carried runContext fills the gaps and must not conflict.
 */
function resolveRunContext(params) {
  const carried = params.runContext
  const pick = (field) => {
    const explicit = params[field] ?? null
    const inherited = carried == null || carried[field] == null ? null : carried[field]
    if (explicit != null && inherited != null && explicit !== inherited) {
      return { error: `runContext.${field} 与本次参数不一致：回传 ${inherited}，本次 ${explicit}` }
    }
    return { value: explicit ?? inherited }
  }
  const picked = {}
  for (const field of RUN_CONTEXT_FIELDS) {
    const result = pick(field)
    if (result.error !== undefined) return { ok: false, error: result.error }
    picked[field] = result.value
  }
  const repoRoot = picked.repoRoot ?? '.'
  const taskName = picked.taskName ?? 'slice-pipeline'
  const context = {
    repoRoot,
    workspace: picked.workspace ?? null,
    outDir: picked.outDir ?? (repoRoot + '/AIOut/' + taskName),
    taskName
  }
  for (const field of ['repoRoot', 'outDir', 'taskName']) {
    if (typeof context[field] !== 'string' || context[field].trim() === '') {
      return { ok: false, error: `runContext.${field} 必须是非空字符串` }
    }
  }
  if (context.workspace !== null
    && (typeof context.workspace !== 'string' || context.workspace.trim() === '')) {
    return { ok: false, error: 'runContext.workspace 必须是非空字符串或 null' }
  }
  return { ok: true, context }
}

/** Deliverable paths must stay inside outDir (no path traversal into the user's workspace). */
function checkDeliverablePaths(params, context) {
  const candidates = []
  for (const field of DELIVERABLE_PATH_FIELDS) {
    if (params[field] != null) candidates.push([field, params[field]])
  }
  if (isPlainObject(params.impl)) {
    for (const field of DELIVERABLE_PATH_FIELDS) {
      if (params.impl[field] != null) candidates.push([`impl.${field}`, params.impl[field]])
    }
  }
  for (const [field, value] of candidates) {
    if (typeof value !== 'string' || value.trim() === '') return `${field} 必须是非空字符串`
    if (!isPathUnder(value, context.outDir, context.repoRoot)) {
      return `${field} 必须位于 outDir 之下（outDir=${context.outDir}，实际=${value}）`
    }
  }
  return null
}

/** Reviewable deliverables must be named, otherwise the task book would show placeholders. */
function checkImplFields(params) {
  if (!isPlainObject(params.impl)) return null
  const missing = DELIVERABLE_PATH_FIELDS.filter(
    (field) => typeof params.impl[field] !== 'string' || params.impl[field].trim() === ''
  )
  if (missing.length > 0) return `${params.mode} 的 impl 缺少字段：${missing.join('、')}`
  return null
}

/** A required param counts as given only when it carries the type the mode needs. */
function isMissingParam(key, value) {
  const given = value[key]
  if (given == null) return true
  if (NON_BLANK_STRING_PARAMS.includes(key)) return typeof given !== 'string' || given.trim() === ''
  if (key === 'userFeedback') return typeof given !== 'string'
  if (key === 'round') return !(Number.isSafeInteger(given) && given >= 1)
  if (key === 'preflight') return typeof given === 'string' ? given.trim() === '' : !isPlainObject(given)
  return false
}

/** Validate the runtime parameters before any side effect starts. */
export function validateRunParams(params) {
  const value = params ?? {}
  if (!isPlainObject(value)) return { ok: false, error: '参数必须是对象' }
  const shapeError = checkParamShape(value)
  if (shapeError !== null) return { ok: false, error: shapeError }
  if (!MODES.includes(value.mode)) {
    return { ok: false, error: `mode 必须是 ${MODES.join(' / ')} 之一` }
  }
  if (value.mode === 'plan-only'
    && (typeof value.requirement !== 'string' || value.requirement.trim() === '')) {
    return { ok: false, error: 'plan-only 需要非空 requirement' }
  }
  if (value.mode === 'slice' && (
    typeof value.sliceId !== 'string' || value.sliceId.trim() === ''
    || value.plan === null || value.plan === undefined
  )) {
    return { ok: false, error: 'slice 需要非空白 sliceId 与 plan（plan-only 的返回值）' }
  }
  if (BATCH_MODES.includes(value.mode)) return { ok: true }
  const rule = MODE_RULES[value.mode]
  const missing = rule.required.filter((key) => isMissingParam(key, value))
  if (missing.length > 0) {
    return { ok: false, error: `${value.mode} 缺少必填参数：${missing.join('、')}` }
  }
  const forbidden = rule.forbidden.filter((key) => value[key] != null)
  if (forbidden.length > 0) {
    return { ok: false, error: `${value.mode} 不接受参数：${forbidden.join('、')}` }
  }
  if (value.mode === 'review' && value.round > 1
    && (typeof value.userFeedback !== 'string' || value.userFeedback.trim() === '')) {
    return { ok: false, error: `review 在 round=${value.round} 需要非空 userFeedback（round=1 才允许空串）` }
  }
  const implError = rule.required.includes('impl') ? checkImplFields(value) : null
  if (implError !== null) return { ok: false, error: implError }
  const context = resolveRunContext(value)
  if (!context.ok) return context
  const pathError = checkDeliverablePaths(value, context.context)
  if (pathError !== null) return { ok: false, error: pathError }
  return { ok: true, context: context.context }
}

/** Build workflow args: host-injected fields stay fixed, runtime fields may override. */
export function buildRunArgs({ params, config, states, pluginRoot }) {
  const checked = validateRunParams(params)
  if (!checked.ok) return checked
  const args = { ...buildPipelineArgs(config, states, pluginRoot) }
  for (const key of RUNTIME_KEYS) {
    if (params[key] != null) args[key] = params[key]
  }
  return { ok: true, args }
}

async function readJsonFile(path, label) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`${label} 读取失败：${path}（${error?.message ?? String(error)}）`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${path}（${error?.message ?? String(error)}）`)
  }
}

function assertPlanObject(plan, mode) {
  if (!isPlainObject(plan)) throw new Error(`${mode} 的 planFile 必须解析成对象`)
  return plan
}

/** The brief task book must carry both layers: rendering placeholder text instead is forbidden. */
const BRIEF_FILE_LINE = /[A-Za-z0-9_./\\-]+:\d+/
const BRIEF_VERIFY_HINT = /验证|verify|exit|ctest|cmake|ninja|make|msbuild|cargo|npm|node --test/i

function assertBriefObject(brief, mode) {
  if (!isPlainObject(brief)) throw new Error(`${mode} 的 briefFile 必须解析成对象`)
  const missing = ['sliceId', 'architecture', 'details'].filter(
    (key) => typeof brief[key] !== 'string' || brief[key].trim() === ''
  )
  if (missing.length > 0) throw new Error(`${mode} 的 briefFile 缺少字段：${missing.join('、')}`)
  // 与脚本侧 assertBriefShape 同一口径：brief 必须能直接交给 Tasker 执行。
  if (!BRIEF_FILE_LINE.test(brief.details)) {
    throw new Error(`${mode} 的 briefFile 的 details 必须包含至少一个 file:line（如 lib/x.js:42）`)
  }
  if (!BRIEF_VERIFY_HINT.test(brief.details)) {
    throw new Error(`${mode} 的 briefFile 的 details 必须写明验证命令（如 cmake --build … / ctest / node --test / exit 0）`)
  }
  return brief
}

/** Host-side file reads: the workflow VM has no fs, so plan/brief files are read here. */
async function readStageFiles(params) {
  const files = {}
  if (params.planFile != null) {
    files.plan = assertPlanObject(await readJsonFile(params.planFile, 'planFile'), params.mode)
  }
  if (params.briefFile != null) {
    files.brief = assertBriefObject(await readJsonFile(params.briefFile, 'briefFile'), params.mode)
  }
  return files
}

const REVIEW_DIR = 'reviews'

function reviewJsonPath(context, sliceId, round) {
  return join(context.outDir, REVIEW_DIR, `${sliceId}-review-r${round}.json`)
}

/** Lead 派发的 reviewer 只回 reviewPath：读取 payload 文件，拒绝越界/非 JSON。 */
async function readReviewPayload(reviewPath, context) {
  const absolute = resolve(String(reviewPath))
  const base = resolve(context.outDir, REVIEW_DIR)
  const rel = relative(base, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('codeReview.reviewPath 必须位于 ' + base + ' 下：' + reviewPath)
  }
  if (!/\.json$/i.test(absolute)) {
    throw new Error('codeReview.reviewPath 必须是 .json 文件：' + reviewPath)
  }
  let text
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    throw new Error('codeReview.reviewPath 读取失败：' + reviewPath + '（' + (error?.message ?? String(error)) + '）')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('codeReview.reviewPath 不是合法 JSON：' + reviewPath + '（' + (error?.message ?? String(error)) + '）')
  }
  if (!isPlainObject(parsed)) {
    throw new Error('codeReview.reviewPath 必须解析成对象：' + reviewPath)
  }
  return parsed
}

/** 盲审只给 brief 路径，不给内容；宿主把 plan.json 的架构层写成独立文件供对齐阶段读取。 */
function briefArchPath(context, sliceId, round) {
  return join(context.outDir, REVIEW_DIR, `${sliceId}-brief-arch-r${round}.md`)
}

async function ensureBriefArchFile({ context, params, files }) {
  const plan = files && files.plan
  const slice = (plan && Array.isArray(plan.slices))
    ? plan.slices.filter((item) => item && item.id === params.sliceId)[0]
    : null
  const architecture = (slice && isPlainObject(slice.brief) && typeof slice.brief.architecture === 'string')
    ? slice.brief.architecture.trim()
    : ''
  if (architecture === '') return null
  const path = briefArchPath(context, params.sliceId, params.round)
  try {
    await mkdir(join(context.outDir, REVIEW_DIR), { recursive: true })
    await writeFile(path, '# 本片 brief 架构层\n\n' + architecture + '\n', 'utf8')
    return path
  } catch {
    return null
  }
}

/** 读上一轮 review 落盘结果；错轮直接抛错（不允许跳轮/复用旧结果），缺文件返回 ok:false。 */
async function readPreviousReview({ context, params }) {
  const path = reviewJsonPath(context, params.sliceId, params.round - 1)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ok: false, reason: '上一轮 review 结果缺失：' + path }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: '上一轮 review 结果不是合法 JSON：' + path }
  }
  if (!isPlainObject(parsed) || typeof parsed.round !== 'number') {
    return { ok: false, reason: '上一轮 review 结果格式不正确：' + path }
  }
  if (parsed.round !== params.round - 1) {
    throw new Error('上一轮 review 结果 round=' + parsed.round
      + ' 与 round-1（' + (params.round - 1) + '）不一致：拒绝跳轮或复用旧结果（' + path + '）')
  }
  return { ok: true, previousReview: parsed, path }
}

function implFileList(impl) {
  const raw = isPlainObject(impl) ? impl.filesChanged : ''
  if (typeof raw !== 'string') return []
  return raw.split(/[\n,;]+/).map((item) => item.trim()).filter((item) => item !== '')
}

function previousFindingFiles(previousReview) {
  const review = previousReview && previousReview.codeReview
  const findings = (review && Array.isArray(review.findings)) ? review.findings : []
  return new Set(findings
    .map((item) => item && item.file)
    .filter((file) => typeof file === 'string' && file !== '' && file !== 'N/A'))
}

async function readDeltaText({ context, params, impl }) {
  const declared = (isPlainObject(impl) && typeof impl.fixDeltaPath === 'string' && impl.fixDeltaPath !== '')
    ? impl.fixDeltaPath
    : ''
  const path = declared || join(context.outDir, `${params.sliceId}-fix-r${params.round - 1}.patch`)
  if (declared && !isPathUnder(declared, context.outDir, context.repoRoot)) {
    return { ok: false, path, reason: '增量 patch 路径不在 outDir 下：' + declared }
  }
  try {
    return { ok: true, path, text: await readFile(path, 'utf8') }
  } catch {
    return { ok: false, path, reason: '本轮修复增量 patch 缺失：' + path }
  }
}

/** 判定本轮 review 实际范围；显式 incremental 不满足条件时报错，不静默降级。 */
async function resolveReviewScope({ params, context, impl }) {
  const explicitIncremental = params.reviewScope === 'incremental'
  const full = (reason) => {
    if (explicitIncremental) {
      throw new Error('reviewScope=incremental 条件不满足：' + reason + '；如需继续请改用 reviewScope=full')
    }
    return { scope: 'full', reason, previousReview: null, delta: null, changedSymbols: null, files: null, scopeWarning: '' }
  }
  if (params.reviewScope === 'full') return full('用户要求全量复审')
  if (params.round <= 1) return full('round=1（首轮必须全量）')
  const previous = await readPreviousReview({ context, params })
  if (!previous.ok) return full(previous.reason)
  const implValue = isPlainObject(impl) ? impl : {}
  if (implValue.contractChanged === true) return full('修复声明改了公共签名/共享布局/默认行为')
  const changedSymbols = Array.isArray(implValue.changedSymbols)
    ? implValue.changedSymbols.filter((item) => typeof item === 'string' && item !== '')
    : []
  if (changedSymbols.length > 6) return full('变更符号 ' + changedSymbols.length + ' 个（>6）')
  const delta = await readDeltaText({ context, params, impl: implValue })
  if (!delta.ok) return full(delta.reason)
  if (delta.text.length > MAX_PACKAGE_CHARS) return full('增量 patch 过大（>' + MAX_PACKAGE_CHARS + ' 字符）')
  const deltaFiles = parsePatchStats(delta.text).files.map((file) => file.path)
  const missing = implFileList(implValue).filter((file) => !deltaFiles.includes(file))
  if (missing.length > 0) return full('增量 patch 未覆盖 filesChanged：' + missing.join('、'))
  const knownFiles = previousFindingFiles(previous.previousReview)
  const outOfSet = deltaFiles.filter((file) => !knownFiles.has(file))
  const scopeNote = typeof implValue.scopeNote === 'string' ? implValue.scopeNote.trim() : ''
  if (outOfSet.length > 0 && scopeNote === '') {
    return full('修复改到上一轮 findings 之外的文件且未给 scopeNote：' + outOfSet.join('、'))
  }
  return {
    scope: 'incremental',
    reason: null,
    previousReview: previous.previousReview,
    delta,
    changedSymbols,
    files: deltaFiles,
    scopeWarning: outOfSet.length > 0
      ? '本轮改动包含上一轮 findings 之外的文件：' + outOfSet.join('、') + '（impl.scopeNote：' + scopeNote + '）'
      : ''
  }
}

/** 把本次 review 结果落盘，供下一轮增量复审读取。 */
async function persistReviewResult({ context, params, value }) {
  if (!isPlainObject(value) || value.mode !== 'review' || !isPlainObject(value.codeReview)) return null
  if (typeof value.round !== 'number') return null
  const dir = join(context.outDir, REVIEW_DIR)
  const path = reviewJsonPath(context, params.sliceId, value.round)
  const payload = {
    round: value.round,
    sliceId: (typeof value.sliceId === 'string') ? value.sliceId : params.sliceId,
    reviewScope: value.reviewScope ?? null,
    verdict: value.codeReviewVerdict ?? null,
    redCount: value.redCount ?? null,
    upgradeReason: value.upgradeReason ?? null,
    previousFindings: value.previousFindings ?? null,
    codeReview: value.codeReview,
    savedAt: new Date().toISOString()
  }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
    return path
  } catch {
    return null
  }
}

// --- design 溯源（0.9.0） ---------------------------------------------------
// 目的：render-implement 之前必须真的跑过 design；plan.json 必须原样保留 design 的切片，
// brief 必须引用 design research 里的 file:line/文件，不能凭记忆手写。
const DESIGN_FILE = 'design.json'
const DESIGN_SLICE_FIELDS = ['title', 'scope', 'acceptance']

function designJsonPath(context) {
  return join(context.outDir, DESIGN_FILE)
}

/** 设计结果的稳定指纹：同一份 plan 的 JSON 序列化哈希。 */
function designRefOf(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

/** 把 design 结果落盘；写入失败也返回 designRef（便于报错时对照），designPath 为 null。 */
async function writeDesignArtifact({ context, value }) {
  if (!isPlainObject(value) || value.mode !== 'design' || !isPlainObject(value.plan)) return null
  const designRef = designRefOf(value.plan)
  const path = designJsonPath(context)
  const payload = {
    designRef,
    plan: value.plan,
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
    openQuestions: Array.isArray(value.openQuestions) ? value.openQuestions : [],
    createdAt: new Date().toISOString()
  }
  try {
    await mkdir(context.outDir, { recursive: true })
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
    return { designRef, designPath: path }
  } catch {
    return { designRef, designPath: null }
  }
}

function researchRefsOf(slice) {
  const research = isPlainObject(slice && slice.research) ? slice.research : {}
  const symbols = Array.isArray(research.symbols) ? research.symbols : []
  const files = Array.isArray(research.files) ? research.files : []
  return [...symbols, ...files]
    .filter((item) => typeof item === 'string' && item.trim() !== '')
}

/** render-implement 前的 design 溯源校验；config.designProvenance 控制 enforce/warn/off。 */
async function enforceDesignProvenance({ params, context, files, config, logger }) {
  const mode = (config && config.designProvenance) || 'enforce'
  if (mode === 'off') return
  const plan = isPlainObject(files.plan) ? files.plan : null
  if (plan === null) return
  const planSlices = Array.isArray(plan.slices) ? plan.slices : []
  const problems = []
  const designRef = typeof plan.designRef === 'string' ? plan.designRef.trim() : ''
  if (designRef === '') {
    problems.push('plan.json 缺少 designRef：请先运行 mode="design"，把返回的 designRef 写进 plan.json 顶层（不要绕过设计手写 brief）')
  } else {
    let design = null
    try {
      design = JSON.parse(await readFile(designJsonPath(context), 'utf8'))
    } catch {
      problems.push('design.json 不存在或不可读：请先运行 design（' + designJsonPath(context) + '）')
    }
    if (design !== null) {
      if (designRefOf(design.plan) !== designRef) {
        problems.push('designRef 与 design.json 不匹配：plan.json 不是由这份 design 产出的')
      }
      const designSlices = Array.isArray(design.plan && design.plan.slices) ? design.plan.slices : []
      const byId = new Map(designSlices.map((slice) => [slice && slice.id, slice]))
      const designIds = designSlices.map((slice) => slice && slice.id)
      const planIds = planSlices.map((slice) => slice && slice.id)
      if (JSON.stringify(planIds) !== JSON.stringify(designIds)) {
        problems.push('plan.slices 与 design 的切片集合不一致：不得在 design 之外增删切片')
      }
      planSlices.forEach((slice) => {
        const source = byId.get(slice && slice.id)
        if (!source) return
        DESIGN_SLICE_FIELDS.forEach((key) => {
          if (String(slice[key] ?? '') !== String(source[key] ?? '')) {
            problems.push('slice ' + String(slice.id) + ' 的 ' + key + ' 与 design 不一致：plan.json 必须原样保留 design 的切片定义')
          }
        })
      })
      const planSlice = planSlices.find((slice) => slice && slice.id === params.sliceId)
      const brief = isPlainObject(planSlice && planSlice.brief)
        ? planSlice.brief
        : (isPlainObject(files.brief) ? files.brief : null)
      const target = byId.get(params.sliceId)
      if (brief !== null && target) {
        const refs = researchRefsOf(target)
        const details = typeof brief.details === 'string' ? brief.details : ''
        const hits = refs.filter((ref) => details.includes(ref)).length
        const required = refs.length === 0 ? 0 : Math.min(2, refs.length)
        if (refs.length > 0 && hits < required) {
          problems.push('brief.details 只引用了 ' + hits + '/' + required + ' 个 design research 符号：'
            + 'brief 必须从 design 的 research 提炼，不能凭记忆写 file:line')
        }
      }
    }
  }
  if (problems.length === 0) return
  const message = 'design 溯源校验失败：' + problems.join('；')
  if (mode === 'warn') {
    logger.warn('slice-pipeline: ' + message + '（warn 模式，继续）')
    return
  }
  throw new Error('slice_pipeline_run 参数错误：' + message)
}

/**
 * 生成一次审查的审查包：patch 全文 + 薄文档 + 统计 + 范围/验收 + 预检结果。
 * 读不到 patch 时返回 skip 原因（调用方记 warning 并回退到按路径读取），不阻塞审查。
 */
async function buildReviewPackage({ params, context, files, scopeInfo }) {
  const plan = files && files.plan
  const slice = (plan && Array.isArray(plan.slices))
    ? plan.slices.filter((item) => item && item.id === params.sliceId)[0]
    : null
  if (!slice) return { ok: false, reason: 'plan 里找不到 sliceId "' + params.sliceId + '"' }
  const dir = join(context.outDir, REVIEW_DIR)
  const filePath = join(dir, params.sliceId + '-package-r' + params.round + '.md')
  // 聚焦复审包：只给上一轮 findings + delta + 变更符号，不内联全量 patch。
  if (scopeInfo && scopeInfo.scope === 'incremental') {
    const deltaText = (scopeInfo.delta && typeof scopeInfo.delta.text === 'string') ? scopeInfo.delta.text : ''
    const stats = parsePatchStats(deltaText)
    const body = renderFocusedReviewPackage({
      slice,
      round: params.round,
      previousReview: scopeInfo.previousReview,
      deltaText,
      deltaPath: (scopeInfo.delta && scopeInfo.delta.path) ? scopeInfo.delta.path : '',
      changedSymbols: scopeInfo.changedSymbols,
      files: scopeInfo.files,
      scopeWarning: scopeInfo.scopeWarning,
      preflight: params.preflight,
      userFeedback: params.userFeedback,
      patchPath: params.patchPath
    })
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, body, 'utf8')
    return {
      ok: true,
      meta: {
        path: filePath,
        mode: 'focused',
        bytes: Buffer.byteLength(body),
        files: stats.files.length,
        hunks: stats.hunks,
        added: stats.added,
        removed: stats.removed,
        docMissing: false
      }
    }
  }
  let patchText
  try {
    patchText = await readFile(params.patchPath, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'patchPath 读取失败：' + params.patchPath }
  }
  let docText = ''
  let docMissing = false
  if (typeof params.docPath === 'string' && params.docPath !== '') {
    try {
      docText = await readFile(params.docPath, 'utf8')
    } catch (error) {
      docMissing = true
    }
  }
  const stats = parsePatchStats(patchText)
  const mode = (patchText.length + docText.length > MAX_PACKAGE_CHARS) ? 'index-only' : 'full'
  const trimmed = extractThinDocForReview(docText)
  const body = renderReviewPackage({
    slice,
    round: params.round,
    generatedAt: new Date().toISOString(),
    preflight: params.preflight,
    userFeedback: params.userFeedback,
    stats,
    patchPath: params.patchPath,
    docPath: params.docPath,
    patchText,
    docText: docMissing ? '（薄文档读取失败：请按路径确认它是否存在）' : trimmed.text,
    docMode: docMissing ? 'full' : trimmed.mode,
    docModeReason: trimmed.reason ?? '',
    mode
  })
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, body, 'utf8')
  return {
    ok: true,
    meta: {
      path: filePath,
      mode,
      bytes: Buffer.byteLength(body),
      files: stats.files.length,
      hunks: stats.hunks,
      added: stats.added,
      removed: stats.removed,
      docMissing,
      docMode: docMissing ? 'full' : trimmed.mode
    }
  }
}

/** Stage modes carry the resolved context in args so the VM computes the same runContext. */
function applyStageArgs(args, { context, files, briefPath }) {
  args.repoRoot = context.repoRoot
  args.taskName = context.taskName
  args.outDir = context.outDir
  if (context.workspace != null) args.workspace = context.workspace
  if (files.plan !== undefined) args.plan = files.plan
  if (files.brief !== undefined) args.brief = files.brief
  // 两段式审查要对齐阶段自己 read 这份 brief：只传路径，内容不进盲审阶段的上下文。
  if (briefPath != null) args.briefPath = briefPath
}

/** 0.10.0：把该角色配置的 reasoning effort 附到任务书结果里，Lead 直接传给 subagent。 */
function attachDispatchHints(value, config) {
  if (!isPlainObject(value)) return value
  const efforts = (config && config.reasoningEfforts) || {}
  if (value.mode === 'review-render') {
    return { ...value, reasoningEffort: efforts.reviewer || null }
  }
  if (value.mode === 'render-implement' || value.mode === 'render-fix') {
    return { ...value, reasoningEffort: efforts.task || null }
  }
  return value
}

/** Attach the host-side sha12 and fail fast instead of truncating an oversized task book. */
function finalizeStageValue(value) {
  if (!isPlainObject(value) || typeof value.prompt !== 'string' || !RENDER_MODES.includes(value.mode)) {
    return value
  }
  if (value.prompt.length > MAX_RESULT_CHARS) {
    throw new Error(`slice_pipeline_run ${value.mode} 的任务书 ${value.prompt.length} 字符，`
      + `超过 MAX_RESULT_CHARS=${MAX_RESULT_CHARS}；按契约不截断，请缩小 brief / impl 后重试`)
  }
  return { ...value, sha12: promptIdOf(value.prompt) }
}

/** Follow-up contract appended after the raw prompt: the tasker must echo sha12. */
function renderStagePromptText(value) {
  if (value.mode === 'review-render') {
    return `${value.prompt}\n\n## 任务书指纹（宿主附加）\nsha12: ${value.sha12}\n`
      + '最终只输出符合 schema 的 JSON（不要 markdown 围栏、不要解释），并回显上面的 sha12。\n'
  }
  return `${value.prompt}\n\n## 任务书指纹（宿主附加）\nsha12: ${value.sha12}\n`
    + '最终只输出一个 JSON：sliceId / patchPath / patchLineCount / docPath / filesChanged / '
    + 'verifyCommand / verifyResult / reverted / changedSymbols / contractChanged / scopeNote / fixDeltaPath，'
    + '并回显上面的 sha12。'
}

/** Pretty-print a result value, capping the returned text size. */
export function renderValue(value) {
  const json = JSON.stringify(value, null, 2) ?? 'null'
  if (json.length <= MAX_RESULT_CHARS) return json
  // Never cut a surrogate pair in half: step back off a lone high surrogate.
  const last = json.charCodeAt(MAX_RESULT_CHARS - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_RESULT_CHARS - 1 : MAX_RESULT_CHARS
  return json.slice(0, end)
    + `\n… [truncated: ${json.length - end} more characters]`
}

/** Compact human summary; optional lines appear only when their value exists. */
export function summarizeResult({ value, scriptId, agentsStarted }) {
  const result = value ?? {}
  const facts = []
  if (result.mode != null) facts.push(`mode=${result.mode}`)
  if (result.sliceId != null) facts.push(`sliceId=${result.sliceId}`)
  facts.push(`${agentsStarted ?? 0} 个 agent`)
  if (scriptId != null) facts.push(`script=${scriptId}`)
  const lines = [`slice-pipeline 完成（${facts.join('，')}）`]
  if (result.patchPath != null) lines.push(`- patch: ${result.patchPath}`)
  if (result.docPath != null) lines.push(`- 薄文档: ${result.docPath}`)
  if (result.codeReviewVerdict != null) {
    const details = []
    if (result.redCount != null) details.push(`${result.redCount} 🔴`)
    if (result.fixRounds != null) details.push(`已修复 ${result.fixRounds} 轮`)
    lines.push(`- codeReview: ${result.codeReviewVerdict}${details.length ? `（${details.join('，')}）` : ''}`)
  }
  if (result.nextAction != null) lines.push(`- nextAction: ${result.nextAction}`)
  return lines.join('\n')
}

/**
 * Map a workflow stop reason to the job service's settlement shape.
 * @param {{ stopReason: string, agentsStarted?: number, value?: unknown, error?: string, scriptId?: string }} result
 */
export function jobOutcome(result) {
  if (result?.stopReason === 'completed') {
    const value = result.value ?? {}
    const agentsStarted = result.agentsStarted ?? 0
    const summary = summarizeResult({ value, scriptId: result.scriptId, agentsStarted })
    const body = isPlainObject(value) && typeof value.prompt === 'string' && RENDER_MODES.includes(value.mode)
      ? renderStagePromptText(value)
      : `Return value:\n${renderValue(value)}`
    return {
      status: 'completed',
      detail: `${agentsStarted} agents`,
      result: `${summary}\n\n${body}`
    }
  }
  if (result?.stopReason === 'cancelled') return { status: 'killed' }
  return { status: 'failed', detail: result?.error ?? 'unknown error' }
}

const META = {
  name: 'slice-pipeline',
  description: '单 Slice 开发流水线：批处理 plan-only / slice，或逐阶段 design / brief / review / render-*'
}

const OUTPUT_SCHEMA = { oneOf: [
  { type: 'object', additionalProperties: false,
    properties: { kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                  runId: { type: 'string' } } },
  { type: 'object', additionalProperties: false,
    properties: { kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  agentsStarted: { type: 'integer', required: true },
                  result: { type: 'json', required: true },
                  scriptId: { type: 'string' } } },
  { type: 'object', additionalProperties: false,
    properties: { kind: { type: 'string', required: true, const: 'dry-run' },
                  scriptId: { type: 'string', required: true },
                  args: { type: 'json', required: true } } }
] }

const PARAMETERS = {
  mode: { type: 'string', required: true, enum: MODES,
          description: '运行模式：plan-only / slice 批处理；design / review 逐阶段派发；'
            + 'render-implement / render-fix 只渲染任务书、不派发（brief 由主会话写入 plan.json，无 agent 模式）' },
  requirement: { type: 'string', description: 'plan-only / design 必填：需求描述' },
  discussionDigest: { type: 'string', description: 'design 必填：用户已确认的讨论结论（Lead 写）；'
            + 'plan-only 可选透传。slice 阶段的讨论不放这里——写进 plan.json 的 slices[i].discussion，由每片讨论门禁校验' },
  maxSlices: { type: 'integer', description: 'plan-only 可选：最大切片数' },
  sliceId: { type: 'string', description: 'slice / brief / review / render-* 必填：切片编号，如 S1' },
  plan: { type: 'object', additionalProperties: true,
          description: 'slice 必填：plan-only 返回的 plan 对象（含每片 research 与主会话写入的 slices[i].brief）' },
  planFile: { type: 'string', description: 'brief / review / render-* 必填：plan JSON 文件绝对路径（宿主读入；'
            + 'brief 从 plan.json 的 slices[i].brief 读取，briefFile 仅兼容）' },
  briefFile: { type: 'string', description: '可选（兼容）：独立 brief JSON 绝对路径。brief 优先取 plan.json 的 '
            + 'slices[i].brief；两者同时存在且不一致会报错' },
  repoRoot: { type: 'string', description: '可选：仓库根目录' },
  workspace: { type: 'string', description: '可选：工作区副本路径' },
  outDir: { type: 'string', description: '可选：输出目录' },
  taskName: { type: 'string', description: '可选：任务名' },
  runContext: { type: 'json',
                description: 'design / brief / render-* 返回的 {repoRoot,workspace,outDir,taskName}；后续调用原样回传' },
  designDocPath: { type: 'string', description: '可选：设计上位基准（mode=brief 兜底与归档的 briefReview 使用）' },
  maxFixRounds: { type: 'integer', description: '可选：覆盖注入的最大修复轮次' },
  stages: { type: 'object', additionalProperties: true,
            description: '可选：覆盖阶段序列，如 { plan: [...], slice: [...] }' },
  round: { type: 'integer', description: 'review / render-fix 必填：>=1 的轮次（review 的 round=1 是首轮全量审查）' },
  impl: { type: 'json', description: 'review / render-fix 必填：上一轮实现者返回的 JSON（IMPL_SCHEMA）' },
  findings: { type: 'json', description: 'render-fix 必填：review 返回的 codeReview（或 findings 数组）' },
  patchPath: { type: 'string', description: 'review 必填：待审 patch 路径，必须位于 outDir 之下' },
  docPath: { type: 'string', description: 'review 必填：待审薄文档路径，必须位于 outDir 之下' },
  userFeedback: { type: 'string', description: 'review / render-fix 必填：用户修改意见；review 的 round=1 允许空串' },
  preflight: { type: 'json', description: 'review 必填：Lead 机械预检结果（git apply --check / --reverse / diff --check）' },
  reviewScope: { type: 'string', enum: REVIEW_SCOPES,
                 description: 'review 可选：auto=宿主按材料判定（默认）；full=强制全量；incremental=强制增量（缺料报错）' },
  dryRun: { type: 'boolean', description: '可选：只返回组装好的 args 与脚本指纹，不启动' },
  run_in_background: { type: 'boolean', description: '可选：后台任务，立即返回 jobId' }
}

function renderResult(args, value) {
  if (value?.kind === 'dry-run') {
    return [{
      type: 'text',
      text: `slice_pipeline_run dry-run：script=${value.scriptId}；args 已组装，未启动。\n`
        + renderValue(value.args)
    }]
  }
  if (value?.kind === 'foreground') {
    const result = value.result
    const summary = summarizeResult({
      value: result, scriptId: value.scriptId, agentsStarted: value.agentsStarted
    })
    // render-* returns the task book as a raw text block, never JSON-escaped.
    if (isPlainObject(result) && typeof result.prompt === 'string' && RENDER_MODES.includes(result.mode)) {
      return [{ type: 'text', text: `${summary}\n\n${renderStagePromptText(result)}` }]
    }
    return [{ type: 'text', text: `${summary}\n\nReturn value:\n${renderValue(result)}` }]
  }
  if (value?.kind === 'background') {
    return [{
      type: 'text',
      text: `slice-pipeline 已在后台启动，job ${value.jobId}。`
        + '返回值随完成通知到达；用 job_output 查看、job_kill 停止。'
    }]
  }
  return [{ type: 'text', text: renderValue(value) }]
}

/**
 * Build the slice_pipeline_run tool. `engine`, `jobs` are injected by the host
 * at registration; `readScript` / `resolve` default to disk reads and module scan.
 */
export function createPipelineTool({ pluginRoot, getConfig, readScript, engine, jobs, resolve, logger = console }) {
  const readScriptImpl = readScript
    ?? (async () => readFile(join(pluginRoot, 'skills/slice-pipeline/slice-pipeline.js'), 'utf8'))
  const resolveImpl = resolve
    ?? (async () => resolveModules(getConfig(), { pluginRoot }))
  const running = new Map()
  const getJobs = () => (typeof jobs === 'function' ? jobs() : jobs)

  function assertIdle(agentId) {
    if (running.has(agentId)) {
      const held = running.get(agentId)
      throw new Error(`slice_pipeline_run 已在运行（${held.jobId ?? held.runId}），等它结束后再试`)
    }
  }

  async function execute(params = {}, exec = {}) {
    const parent = exec?.agent
    if (parent == null) {
      throw new Error('slice_pipeline_run 需要调用方 agent（exec.agent 为空）')
    }
    assertIdle(parent.id)
    const checked = validateRunParams(params)
    if (!checked.ok) throw new Error(`slice_pipeline_run 参数错误：${checked.error}`)
    const stageMode = STAGE_MODES.includes(params.mode)
    const script = await readScriptImpl()
    const scriptId = scriptIdOf(script)
    const config = getConfig()
    const built = buildRunArgs({ params, config, states: await resolveImpl(), pluginRoot })
    if (!built.ok) throw new Error(`slice_pipeline_run 参数错误：${built.error}`)
    // planFile / briefFile are read here: the workflow script VM has no fs.
    if (stageMode) {
      const files = await readStageFiles(params)
      // 0.11.0：Lead 侧 reviewer 只回 {reviewPath}；宿主读文件后再交给 workflow。
      if (params.mode === 'review' && params.dryRun !== true
        && isPlainObject(params.codeReview) && typeof params.codeReview.reviewPath === 'string') {
        try {
          built.args.codeReview = await readReviewPayload(params.codeReview.reviewPath, checked.context)
        } catch (error) {
          throw new Error('slice_pipeline_run 参数错误：' + (error?.message ?? String(error)))
        }
      }
      applyStageArgs(built.args, {
        context: checked.context,
        files,
        briefPath: params.briefFile ?? null
      })
      // 0.9.0：实现前必须证明 plan/brief 真的来自 design，避免跳过设计手写 brief。
      if (params.mode === 'render-implement' && params.dryRun !== true) {
        await enforceDesignProvenance({ params, context: checked.context, files, config, logger })
      }
      // dryRun 只回 args 与脚本指纹，不落盘任何文件。
      if (params.mode === 'review' && params.dryRun !== true) {
        let scopeInfo
        try {
          scopeInfo = await resolveReviewScope({ params, context: checked.context, impl: params.impl })
        } catch (error) {
          throw new Error('slice_pipeline_run 参数错误：' + (error?.message ?? String(error)))
        }
        built.args.reviewScope = scopeInfo.scope
        if (scopeInfo.reason) built.args.upgradeReason = scopeInfo.reason
        if (scopeInfo.previousReview) built.args.previousReview = scopeInfo.previousReview
        if (scopeInfo.delta) built.args.deltaPath = scopeInfo.delta.path
        if (scopeInfo.scopeWarning) built.args.scopeWarning = scopeInfo.scopeWarning
        // 盲审保证：没有独立 briefFile 时，把 plan.json 的 brief 架构层写成文件，
        // 只把路径交给对齐阶段；否则 alignmentSection 会内联 brief，round=1 就不盲了。
        if (built.args.briefPath == null) {
          const archPath = await ensureBriefArchFile({ context: checked.context, params, files })
          if (archPath !== null) built.args.briefPath = archPath
        }
        // 0.11.0：renderReview 也生成审查包（reviewer 只读包，不逐个 read patch/薄文档）；
        // codeReview 只消费子智能体结果，不需要包。
        if (params.codeReview == null) {
          const pkg = await buildReviewPackage({ params, context: checked.context, files, scopeInfo })
          if (pkg.ok) {
            built.args.reviewPackage = pkg.meta
          } else {
            built.args.reviewPackage = { skipped: true, reason: pkg.reason }
            logger.warn('slice-pipeline: 审查包未生成（' + pkg.reason + '），本次 review 回退为按路径读取')
          }
        }
        if (params.reviewScope === 'incremental' && scopeInfo.scope !== 'incremental') {
          throw new Error('slice_pipeline_run 参数错误：reviewScope=incremental 条件不满足：' + scopeInfo.reason)
        }
      }
    }
    if (params.dryRun === true) return { kind: 'dry-run', scriptId, args: built.args }
    // Re-check after the async setup, then claim the slot before any engine call.
    assertIdle(parent.id)
    // Ownership-checked release: only free the slot if this run still holds it.
    let claim
    const releaseIfOwner = () => {
      if (claim !== undefined && running.get(parent.id) === claim) running.delete(parent.id)
    }
    if (params.run_in_background === true) {
      const availableJobs = getJobs()
      if (availableJobs === undefined) {
        throw new Error('background jobs unavailable: 需要 @deepseek-ai/dsh-jobs 与 @deepseek-ai/dsh-tool-jobs')
      }
      let runId
      // The job's starter runs synchronously inside jobs.start. Cache the single
      // run + handle so repeated run() invocations share one engine run and one
      // dispose, and never start a second run.
      let handle
      const jobId = availableJobs.start({
        kind: 'workflow',
        label: 'slice-pipeline',
        owner: parent.id,
        run: () => {
          if (handle !== undefined) return handle
          // No exec.signal: the run belongs to the job and is cancelled through it.
          const run = engine.start({ script, meta: META, args: built.args, parent })
          runId = run.id
          // jobId is not yet assigned (jobs.start returns synchronously after run()).
          claim = { runId: run.id, startedAt: Date.now() }
          running.set(parent.id, claim)
          const finish = async (result) => {
            let value = result?.value
            try {
              if (result?.stopReason === 'completed' && value && value.mode === 'review') {
                const saved = await persistReviewResult({ context: checked.context, params, value })
                if (saved === null) logger.warn('slice-pipeline: 本轮 review 结果未能落盘，下一轮将回退全量复审')
              }
              if (result?.stopReason === 'completed' && value && value.mode === 'design') {
                const artifact = await writeDesignArtifact({ context: checked.context, value })
                if (artifact) {
                  if (artifact.designPath === null) {
                    logger.warn('slice-pipeline: design 结果未能落盘（' + designJsonPath(checked.context) + '），render-implement 会被 design 溯源校验拦住')
                  }
                  value = { ...value, ...artifact }
                }
              }
            } catch (error) {
              logger.warn('slice-pipeline: 结果落盘失败', error)
            }
            try { await run.dispose() } catch (error) { logger.warn('slice-pipeline: dispose failed', error) }
            finally { releaseIfOwner() }
            if (stageMode) {
              try {
                value = attachDispatchHints(value, config)
                return jobOutcome({ ...result, value: finalizeStageValue(value), scriptId })
              } catch (error) {
                return { status: 'failed', detail: String(error?.message ?? error) }
              }
            }
            return jobOutcome({ ...result, scriptId })
          }
          handle = {
            cancel: (reason) => {
              run.cancel(reason ?? 'background slice-pipeline job killed')
              releaseIfOwner()
            },
            // done owns disposal; the then-callback fires once, so dispose is single.
            done: run.result.then(finish, (error) => finish({ stopReason: 'error', error: String(error) }))
          }
          return handle
        }
      })
      if (claim !== undefined) claim.jobId = jobId
      return { kind: 'background', jobId, ...(runId !== undefined ? { runId } : {}) }
    }
    const run = engine.start({ script, meta: META, args: built.args, parent, signal: exec.signal })
    claim = { runId: run.id, startedAt: Date.now() }
    running.set(parent.id, claim)
    try {
      const result = await run.result
      if (result?.stopReason === 'completed') {
        let value = result.value
        if (value && value.mode === 'review') {
          const saved = await persistReviewResult({ context: checked.context, params, value })
          if (saved === null) logger.warn('slice-pipeline: 本轮 review 结果未能落盘，下一轮将回退全量复审')
        }
        if (value && value.mode === 'design') {
          const artifact = await writeDesignArtifact({ context: checked.context, value })
          if (artifact) {
            if (artifact.designPath === null) {
              logger.warn('slice-pipeline: design 结果未能落盘（' + designJsonPath(checked.context) + '），render-implement 会被 design 溯源校验拦住')
            }
            value = { ...value, ...artifact }
          }
        }
        return { kind: 'foreground', runId: run.id,
                 agentsStarted: result.agentsStarted ?? 0,
                 result: stageMode ? finalizeStageValue(attachDispatchHints(value, config)) : value,
                 scriptId }
      }
      const reason = result?.error ?? `stopReason=${result?.stopReason ?? 'unknown'}`
      throw new Error(`slice_pipeline_run 运行失败（script=${scriptId}，`
        + `agentsStarted=${result?.agentsStarted ?? 0}）：${reason}`)
    } finally {
      try {
        await run.dispose()
      } finally {
        releaseIfOwner()
      }
    }
  }

  return {
    running,
    definition: {
      name: TOOL_NAME,
      description: '运行 slice-pipeline 流水线（脚本由宿主从磁盘读取，配置由宿主注入）',
      parameters: PARAMETERS,
      output: { schema: OUTPUT_SCHEMA, render: renderResult },
      execute
    }
  }
}

/** Register slice_pipeline_run with the host tool registry when a workflow engine exists. */
export function registerPipelineTool(ctx, { pluginRoot, getConfig }) {
  try {
    const engine = ctx.get('workflowEngine')
    if (engine === undefined) {
      toolStatus = { ok: false, reason: 'workflowEngine unavailable' }
      return () => {}
    }
    const { definition } = createPipelineTool({
      pluginRoot,
      getConfig,
      engine,
      jobs: () => ctx.get('jobs'),
      logger: ctx.logger
    })
    const dispose = ctx.tools.register(toCanonicalDefinition(definition))
    toolStatus = { ok: true, reason: 'registered' }
    return dispose
  } catch (error) {
    toolStatus = { ok: false, reason: String(error && error.message || error) }
    return () => {}
  }
}
