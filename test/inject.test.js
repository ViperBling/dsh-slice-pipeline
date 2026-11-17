import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { ROLE_KEYS, MODULE_KEYS, MODULE_DEFS, readConfig } from '../lib/config.js'
import { resolveModules, toSlash } from '../lib/paths.js'
import {
  PIPELINE_HEADING, MODULE_HEADING, buildPipelineArgs, renderArgsJson,
  renderPipelineBlock, renderModuleBlock
} from '../lib/inject.js'
import { DESKTOP_CONFIG } from './helpers/fixtures.js'

const LONG_ROOT = path.join('C:\\Users\\someone\\.dsh\\profiles\\desktop\\node_modules\\.pnpm\\dsh-slice-pipeline@0.3.0\\node_modules', 'dsh-slice-pipeline')
const CJK_ROOT = path.join(os.tmpdir(), '张三 My Plugins', 'dsh-slice-pipeline')
const cfg = readConfig(DESKTOP_CONFIG)
const states = await resolveModules(cfg, { pluginRoot: LONG_ROOT, exists: async () => true })
const a = buildPipelineArgs(cfg, states)
const statesFor = (c, exists = async () => true, root = LONG_ROOT) => resolveModules(c, { pluginRoot: root, exists })
const noTemplate = await statesFor(cfg, async (p) => !toSlash(p).endsWith('thin-document-template.md'))
const legacyCfg = readConfig({ ...DESKTOP_CONFIG, reviewStandard: '# 规范\n正文' })
const legacyStates = await statesFor(legacyCfg)
const roleCfg = readConfig({ ...DESKTOP_CONFIG, modules: { planning: { role: 'task' } } })
const roleStates = await statesFor(roleCfg)
const cjkStates = await statesFor(cfg, async () => true, CJK_ROOT)
const failedStates = await statesFor(cfg, async () => { throw new Error('probe failed') })
const disabledCfg = readConfig({ ...DESKTOP_CONFIG, modules: { planning: { enabled: false } } })
const disabledStates = await statesFor(disabledCfg)
const missingReview = await statesFor(cfg, async (p) => !p.endsWith('docs/review/review-standard.md'))
const partialStates = await statesFor(cfg, async (p) => {
  if (p.endsWith('thin-document-template.md')) throw new Error('template probe failed')
  return true
})
const missingScript = await statesFor(cfg, async (p) => !p.endsWith('slice-pipeline.js'))
const at = (relative, root = LONG_ROOT) => toSlash(path.resolve(root, relative))

// Catches route strings leaking into args and pipeline/empty optional fields leaking out.
test('pipeline args expand roles, mirror the review path and omit the pipeline role', () => {
  assert.deepEqual(a.roles.reviewer, { provider: 'paper-anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(Object.keys(a.roles), ROLE_KEYS)
  assert.equal(a.reviewStandardPath, at('docs/review/review-standard.md'))
  assert.equal(a.reviewStandardPath, a.modules.review.docs.standard)
  assert.equal('role' in a.modules.pipeline, false)
  assert.equal('missing' in a.modules.planning, false)
  assert.deepEqual(a.stages, DESKTOP_CONFIG.stages)
  assert.equal(a.maxFixRounds, 3)
  assert.equal(a.plainLanguagePath, 'docs/shared/plain-language.md')
})

// Catches invalid JSON or multi-line module values in the workflow payload.
test('renderArgsJson round-trips with one module per line', () => {
  const json = renderArgsJson(a)
  assert.deepEqual(JSON.parse(json), a)
  assert.match(json, /^ {4}"planning": \{.*\},?$/m)
  assert.equal(json.split('\n')[0], '{')
  assert.equal(json.split('\n').at(-1), '}')
})

// Catches a wrong script path, lost safety instructions or an oversized injection.
test('pipeline block: heading, script, no-scan rule, parseable JSON, ≤3,500 bytes on a long root', () => {
  const block = renderPipelineBlock(cfg, states, { pluginRoot: LONG_ROOT })
  assert.ok(block.startsWith('\n\n' + PIPELINE_HEADING))
  assert.ok(block.includes('slice-pipeline/slice-pipeline.js`'))
  assert.ok(block.includes('- workflow 脚本（仅手工内联回退时使用）：`' + at('skills/slice-pipeline/slice-pipeline.js') + '`（read 后原样作为 workflow 工具的 script 传入；首选路径用 slice_pipeline_run 工具，不要读脚本）'))
  assert.ok(block.includes('- 文档索引：`' + at('docs/INDEX.md') + '`'))
  assert.ok(block.includes('下面的 JSON：首选路径下不要用它拼工具参数（工具会自行注入配置）；仅手工内联回退时作为 workflow args 传入；读取其中的路径（如 modules.planning.docs.standard）是允许的。'))
  assert.ok(block.includes('slice_pipeline_run'))
  assert.ok(block.includes('不要读取规范内容再传 reviewStandard'))
  assert.ok(block.includes('禁止 find /'))
  assert.deepEqual(JSON.parse(block.split('```json\n')[1].split('\n```')[0]),
    { ...a, plainLanguagePath: at('docs/shared/plain-language.md') })
  assert.ok(Buffer.byteLength(block) <= 3500, String(Buffer.byteLength(block)))
})

// Catches path-dropping used to meet budgets or accidental multiline prose.
test('module blocks stay within 15 lines and 1,500 bytes', () => {
  for (const k of MODULE_KEYS.filter((k) => k !== 'pipeline')) {
    const b = renderModuleBlock(k, cfg, states, { pluginRoot: LONG_ROOT })
    assert.ok(b.startsWith('\n\n' + MODULE_HEADING), k)
    assert.ok(b.trim().split('\n').length <= 15, k)
    assert.ok(Buffer.byteLength(b) <= 1500, `${k}: ${Buffer.byteLength(b)}`)
    assert.ok(b.includes('- 模块：' + MODULE_DEFS[k].title + '（' + k + '）· 状态：ok'), k)
    for (const [docKey, doc] of Object.entries(MODULE_DEFS[k].docs)) {
      assert.ok(b.includes('- ' + doc.label + '：`' + states[k].docs[docKey] + '`'), k)
    }
    assert.ok(b.includes('- 文档索引：`' + at('docs/INDEX.md') + '`'), k)
    assert.ok(b.includes('读不到时报告该路径，禁止 find / 或扫描盘符。'), k)
  }
})

test('related modules and dispatch guide appear only where defined', () => {
  const block = (k) => renderModuleBlock(k, cfg, states, { pluginRoot: LONG_ROOT })
  for (const s of ['相关模块 审查', '相关模块 制图', '人工派发约定']) assert.ok(block('planning').includes(s), s)
  for (const s of ['薄文档模板', '相关模块 工作区恢复', '相关模块 审查']) assert.ok(block('patchDelivery').includes(s), s)
  for (const k of MODULE_KEYS.filter((key) => key !== 'pipeline')) {
    assert.equal(block(k).includes('人工派发约定'), MODULE_DEFS[k].dispatchGuide, k)
    assert.equal(block(k).split('\n').filter((l) => l.startsWith('- 相关模块 ')).length, MODULE_DEFS[k].related.length, k)
  }
  assert.ok(block('planning').includes('- 相关模块 审查（ok）：`' + at('docs/review/review-standard.md') + '`'))
  assert.ok(block('planning').includes('- 人工派发约定：`' + at('docs/shared/dispatch-guide.md') + '`'))
  assert.equal(block('diagrams').includes('相关模块'), false)
})


// Catches missing markers inferred from status instead of the missing-path array.
test('missing files are marked and warnings collapse into one line', () => {
  const block = renderModuleBlock('patchDelivery', cfg, noTemplate, { pluginRoot: LONG_ROOT })
  assert.ok(block.includes('- 薄文档模板：`' + at('docs/patch-delivery/thin-document-template.md') + '`（缺失）'))
  assert.ok(block.includes('- 规范文件：`' + at('docs/patch-delivery/standard.md') + '`\n'))
  const b = renderModuleBlock('review', legacyCfg, legacyStates, { pluginRoot: LONG_ROOT })
  assert.equal(b.split('\n').filter((l) => l.startsWith('- 警告：')).length, 1)
  assert.ok(b.includes('- 警告：' + legacyStates.review.warnings.join('；')))
  const related = renderModuleBlock('planning', cfg, missingReview, { pluginRoot: LONG_ROOT })
  assert.ok(related.includes('- 相关模块 审查（missingDoc）：`' + at('docs/review/review-standard.md') + '`（缺失）'))
})

test('role line follows the module role', () => {
  const block = renderModuleBlock('planning', roleCfg, roleStates, { pluginRoot: LONG_ROOT })
  assert.ok(block.includes('task → deepseek-official/deepseek-v4.1-flash'))
  assert.ok(block.includes('（仅派发子代理时使用，不切换当前会话模型）'))
})

test('non-ASCII roots are injected verbatim', () => {
  assert.ok(renderModuleBlock('planning', cfg, cjkStates, { pluginRoot: CJK_ROOT }).includes(toSlash(CJK_ROOT)))
  const pipeline = renderPipelineBlock(cfg, cjkStates, { pluginRoot: CJK_ROOT })
  assert.ok(pipeline.includes(at('docs/INDEX.md', CJK_ROOT)))
  assert.ok(pipeline.includes(at('skills/slice-pipeline/slice-pipeline.js', CJK_ROOT)))
})

// R4: catches absent doc keys being interpolated or filled with invented paths.
test('resolution failures preserve docs and render unresolved placeholders without undefined', () => {
  const args = buildPipelineArgs(cfg, failedStates)
  assert.equal(args.reviewStandardPath, null)
  assert.deepEqual(JSON.parse(renderArgsJson(args)), args)
  for (const k of MODULE_KEYS) {
    assert.equal(failedStates[k].status, 'missingDoc')
    assert.deepEqual(failedStates[k].missing, [])
    const expectedDocs = Object.fromEntries(Object.entries(failedStates[k].docs)
      .filter(([docKey]) => !(k === 'review' && docKey === 'dispatch')))
    assert.deepEqual(args.modules[k].docs, expectedDocs)
    assert.equal('missing' in args.modules[k], false)
    const b = renderModuleBlock(k, cfg, failedStates, { pluginRoot: LONG_ROOT })
    assert.equal(b.includes('undefined'), false, k)
    for (const doc of Object.values(MODULE_DEFS[k].docs)) assert.ok(b.includes('- ' + doc.label + '：（未解析）'), k)
  }
  const planning = renderModuleBlock('planning', cfg, failedStates, { pluginRoot: LONG_ROOT })
  assert.ok(planning.includes('- 相关模块 审查（missingDoc）：（未解析）'))
  assert.ok(planning.includes('- 相关模块 制图（missingDoc）：（未解析）'))
  assert.equal(renderPipelineBlock(cfg, failedStates, { pluginRoot: LONG_ROOT }).includes('undefined'), false)
  const partial = renderModuleBlock('patchDelivery', cfg, partialStates, { pluginRoot: LONG_ROOT })
  assert.ok(partial.includes('- 规范文件：`' + at('docs/patch-delivery/standard.md') + '`\n'))
  assert.ok(partial.includes('- 薄文档模板：（未解析）'))
  assert.equal(partial.includes('（缺失）'), false)
})

// Catches hidden warnings in args, dropped missing paths and stale enablement/roles.
test('args preserve resolved module fields without warnings or mutation', () => {
  const before = JSON.stringify({ cfg, noTemplate, disabledCfg, disabledStates, legacyStates, roleStates })
  const args = buildPipelineArgs(cfg, noTemplate)
  assert.deepEqual(Object.keys(args), ['roles', 'stages', 'maxFixRounds', 'reviewStandardPath', 'reasoningEfforts', 'plainLanguagePath', 'modules'])
  assert.deepEqual(Object.keys(args.modules), MODULE_KEYS)
  for (const k of MODULE_KEYS) {
    const expected = {
      enabled: true,
      ...(k === 'pipeline' ? {} : { role: MODULE_DEFS[k].role }),
      status: k === 'patchDelivery' ? 'missingDoc' : 'ok',
      docs: Object.fromEntries(Object.entries(MODULE_DEFS[k].docs)
        .filter(([docKey]) => !(k === 'review' && docKey === 'dispatch'))
        .map(([docKey, doc]) => [docKey, at(doc.defaultPath)])),
      ...(k === 'patchDelivery' ? { missing: [at('docs/patch-delivery/thin-document-template.md')] } : {})
    }
    assert.deepEqual(args.modules[k], expected, k)
    assert.equal('warnings' in buildPipelineArgs(legacyCfg, legacyStates).modules[k], false, k)
  }
  assert.equal(buildPipelineArgs(roleCfg, roleStates).modules.planning.role, 'task')
  const disabled = buildPipelineArgs(disabledCfg, disabledStates)
  assert.equal(disabled.modules.planning.enabled, false)
  assert.equal(disabled.modules.planning.status, 'disabled')
  assert.ok(renderModuleBlock('planning', disabledCfg, disabledStates, { pluginRoot: LONG_ROOT }).includes('状态：disabled'))
  renderPipelineBlock(cfg, noTemplate, { pluginRoot: LONG_ROOT })
  assert.equal(JSON.stringify({ cfg, noTemplate, disabledCfg, disabledStates, legacyStates, roleStates }), before)
})

test('pipeline warnings join every titled warning on one line and stay out of JSON', () => {
  const block = renderPipelineBlock(cfg, failedStates, { pluginRoot: LONG_ROOT })
  const warnings = block.split('\n').filter((l) => l.startsWith('- 警告：'))
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0], '- 警告：' + MODULE_KEYS.map((k) => MODULE_DEFS[k].title + '：路径解析失败：probe failed').join('；'))
  assert.equal(renderPipelineBlock(cfg, states, { pluginRoot: LONG_ROOT }).includes('- 警告：'), false)
  assert.equal(block.split('```json\n')[1].includes('warnings'), false)
  const missing = renderPipelineBlock(cfg, missingScript, { pluginRoot: LONG_ROOT })
  assert.ok(missing.includes('- workflow 脚本（仅手工内联回退时使用）：`' + at('skills/slice-pipeline/slice-pipeline.js') + '`（缺失）'))
})

test('renderArgsJson keeps top-level values on single two-space-indented lines', () => {
  const expected = [
    '{', '  "roles": {"default":{"provider":"p","model":"m"}},',
    '  "stages": {"plan":[]},', '  "maxFixRounds": 0,',
    '  "reviewStandardPath": null,', '  "modules": {',
    '    "pipeline": {"enabled":false,"status":"disabled","docs":{}}', '  }', '}'
  ].join('\n')
  assert.equal(renderArgsJson({ roles: { default: { provider: 'p', model: 'm' } }, stages: { plan: [] }, maxFixRounds: 0, reviewStandardPath: null, modules: { pipeline: { enabled: false, status: 'disabled', docs: {} } } }), expected)
})

test('pipeline block reports the registered tool as the preferred route', () => {
  const block = renderPipelineBlock(cfg, states, { pluginRoot: LONG_ROOT, toolStatus: { ok: true } })
  assert.ok(block.includes('- 工具 slice_pipeline_run：已注册（首选路径；下面的 workflow 脚本与 args JSON 仅手工内联回退时使用）'))
  assert.equal(block.includes('未注册'), false)
})

test('pipeline block reports an unregistered tool and its reason', () => {
  const block = renderPipelineBlock(cfg, states, { pluginRoot: LONG_ROOT, toolStatus: { ok: false, reason: 'boom' } })
  assert.ok(block.includes('- 工具 slice_pipeline_run：未注册（原因：boom）。'))
  assert.ok(block.includes('若刚升级插件请完整重启 Desktop / dsh-tui'))
  assert.equal(block.includes('已注册'), false)
})

test('pipeline block defaults missing tool status to not attempted', () => {
  const block = renderPipelineBlock(cfg, states, { pluginRoot: LONG_ROOT })
  assert.ok(block.includes('未注册（原因：not attempted）'))
})

