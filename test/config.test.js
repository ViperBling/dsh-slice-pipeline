import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config, ROLE_KEYS, DEFAULT_ROUTE, DEFAULT_REVIEW_STANDARD_PATH, DEFAULT_REVIEW_DISPATCH_PATH,
  LEGACY_REVIEW_STANDARD_ALIASES, INDEX_PATH, DISPATCH_GUIDE_PATH,
  MODULE_KEYS, MODULE_DEFS, SKILL_MODULES, readValue, readConfig, splitRoute, getConfigPath
} from '../lib/config.js'
import { ConfigV020 } from './fixtures/config-0.2.0.js'
import { DESKTOP_CONFIG, ROLES, existsFrom, fakeModules } from './helpers/fixtures.js'

test('defaults: every module enabled with its default role and path', () => {
  const c = readConfig(Config({}))
  assert.deepEqual(Object.keys(c.modules), MODULE_KEYS)
  assert.equal(c.reviewStandard, 'docs/review/review-standard.md')
  assert.equal(c.reviewDispatch, 'docs/review/review-dispatch.md')
  assert.deepEqual(c.modules.pipeline, { enabled: true })
  assert.deepEqual(c.modules.planning, { enabled: true, role: 'designer', standardPath: 'docs/planning/standard.md' })
  assert.deepEqual(c.modules.patchDelivery, { enabled: true, role: 'task', standardPath: 'docs/patch-delivery/standard.md', templatePath: 'docs/patch-delivery/thin-document-template.md' })
  assert.deepEqual(c.modules.workspaceRecovery, { enabled: true, role: 'default', standardPath: 'docs/workspace-recovery/standard.md' })
  assert.deepEqual(c.modules.review, { enabled: true, role: 'reviewer' })
  assert.deepEqual(c.modules.diagrams, { enabled: true, role: 'designer', standardPath: 'docs/diagrams/standard.md' })
})

test('defaults keep archived review stages out of the stage lists', () => {
  // 2026-11-03：planReview / briefReview 归档不启用；brief 保留在 slice 阶段里（主会话产出/批处理投影）。
  const c = readConfig(Config({}))
  assert.deepEqual(c.stages.plan, ['design'])
  assert.deepEqual(c.stages.slice, ['brief', 'implement', 'codeReview', 'fix'])
  assert.equal(c.stages.slice.includes('briefReview'), false)
  assert.equal(c.stages.plan.includes('planReview'), false)
  // 配置层仍原样保存旧值（兼容），由 workflow 的 ARCHIVED_STAGES 在运行时剔除并告警。
  const custom = readConfig(Config({ stages: { slice: ['brief', 'briefReview', 'implement', 'codeReview'] } }))
  assert.deepEqual(custom.stages.slice, ['brief', 'briefReview', 'implement', 'codeReview'])
})

test('default-filled module leaves are live refs', () => {
  const live = Config({})
  for (const key of MODULE_KEYS) {
    for (const [field, value] of Object.entries(live.modules[key])) {
      assert.equal(typeof value?.get, 'function', `${key}.${field}`)
    }
  }
})

test('current desktop config parses unchanged', () => {
  const c = readConfig(Config(structuredClone(DESKTOP_CONFIG)))
  assert.deepEqual(c.roles, DESKTOP_CONFIG.roles)
  assert.deepEqual(c.stages.plan, ['design'])
  assert.equal(c.reviewStandard, 'review-standard.md')
  assert.equal(c.maxFixRounds, 3)
})

test('rejects unknown role names', () => {
  assert.throws(() => Config({ modules: { planning: { role: 'bogus' } } }))
})

test('readConfig accepts plain values', () => {
  assert.equal(readConfig({ modules: { planning: { enabled: false } } }).modules.planning.enabled, false)
})

test('0.2.0 schema tolerates the modules key (rollback guard)', () => {
  assert.doesNotThrow(() => ConfigV020({ ...DESKTOP_CONFIG, modules: { planning: { enabled: false } } }))
})

test('MODULE_DEFS invariants', () => {
  assert.deepEqual(Object.keys(MODULE_DEFS), MODULE_KEYS)
  assert.deepEqual(MODULE_KEYS.map((k) => MODULE_DEFS[k].role), [null, 'designer', 'task', 'default', 'reviewer', 'designer'])
  assert.deepEqual(Object.keys(SKILL_MODULES), ['slice-pipeline', 'slice-planning', 'slice-patch-delivery', 'slice-workspace-recovery', 'slice-review', 'slice-diagrams'])
  assert.deepEqual(Object.values(SKILL_MODULES), MODULE_KEYS)
  assert.deepEqual(MODULE_KEYS.map((k) => MODULE_DEFS[k].dispatchGuide), [false, true, false, false, true, false])
  assert.deepEqual(MODULE_KEYS.map((k) => MODULE_DEFS[k].related), [[], ['review', 'diagrams'], ['workspaceRecovery', 'review'], [], [], []])
})

test('getConfigPath walks the plain config', () => {
  const c = readConfig({})
  assert.equal(getConfigPath(c, ['modules', 'patchDelivery', 'templatePath']), 'docs/patch-delivery/thin-document-template.md')
  assert.equal(getConfigPath(c, ['reviewStandard']), 'docs/review/review-standard.md')
  assert.equal(getConfigPath(c, ['reviewDispatch']), 'docs/review/review-dispatch.md')
  assert.equal(getConfigPath(c, ['modules', 'absent', 'standardPath']), undefined)
  assert.equal(getConfigPath(c, []), c)
})

test('exported role, route and document constants match the contract', () => {
  assert.deepEqual(ROLE_KEYS, ['default', 'designer', 'task', 'reviewer'])
  assert.equal(DEFAULT_ROUTE, 'deepseek-official/deepseek-flash')
  assert.equal(DEFAULT_REVIEW_STANDARD_PATH, 'docs/review/review-standard.md')
  assert.equal(DEFAULT_REVIEW_DISPATCH_PATH, 'docs/review/review-dispatch.md')
  assert.deepEqual(LEGACY_REVIEW_STANDARD_ALIASES, ['review-standard.md', './review-standard.md'])
  assert.equal(INDEX_PATH, 'docs/INDEX.md')
  assert.equal(DISPATCH_GUIDE_PATH, 'docs/shared/dispatch-guide.md')
})

test('plain and volatile fields preserve overrides and fall back only when nullish', () => {
  const raw = structuredClone(DESKTOP_CONFIG)
  raw.maxFixRounds = 0
  raw.reviewStandard = ''
  raw.reviewDispatch = ''
  raw.stages.slice = []
  raw.modules = {}
  for (const key of MODULE_KEYS) {
    raw.modules[key] = { enabled: false }
    if (MODULE_DEFS[key].role !== null) raw.modules[key].role = 'reviewer'
    for (const doc of Object.values(MODULE_DEFS[key].docs)) {
      if (doc.configPath?.[0] === 'modules') raw.modules[key][doc.configPath[2]] = ''
    }
  }
  const live = Config(structuredClone(raw))
  raw.designProvenance = 'enforce'
  raw.reasoningEfforts = { default: '', designer: '', task: '', reviewer: '' }
  assert.deepEqual(readConfig(live), raw)
  assert.deepEqual(readConfig(raw), raw)
  for (const key of MODULE_KEYS) {
    for (const field of Object.values(live.modules[key])) assert.equal(typeof field.get, 'function')
  }
  assert.deepEqual(readConfig(null), readConfig(Config({})))
  assert.deepEqual(readConfig({ modules: { planning: { enabled: null, role: null, standardPath: null } } }), readConfig({}))
})

test('readValue reads live refs and leaves plain values unchanged', () => {
  assert.equal(readValue(Config({}).maxFixRounds), 3)
  for (const value of [undefined, null, false, 0, '', 'route', { get: 'plain' }]) assert.equal(readValue(value), value)
})

test('splitRoute splits only the first slash and handles missing models', () => {
  for (const [key, role] of Object.entries(ROLES)) {
    assert.deepEqual(splitRoute(`${role.provider}/${role.model}`), role, key)
  }
  assert.deepEqual(splitRoute('provider/group/model'), { provider: 'provider', model: 'group/model' })
  assert.deepEqual(splitRoute('provider'), { provider: 'provider', model: '' })
  assert.deepEqual(splitRoute('/model'), { provider: '/model', model: '' })
  assert.deepEqual(splitRoute(undefined), { provider: '', model: '' })
})

test('fakeModules supplies the exact downstream shape and shallow module overrides', () => {
  const modules = fakeModules()
  assert.deepEqual(modules, {
    pipeline: { enabled: true, status: 'ok', docs: { script: 'C:/p/skills/slice-pipeline/slice-pipeline.js' } },
    planning: { enabled: true, role: 'designer', status: 'ok', docs: { standard: 'C:/p/docs/planning/standard.md' } },
    patchDelivery: { enabled: true, role: 'task', status: 'ok', docs: { standard: 'C:/p/docs/patch-delivery/standard.md', template: 'C:/p/docs/patch-delivery/thin-document-template.md' } },
    workspaceRecovery: { enabled: true, role: 'default', status: 'ok', docs: { standard: 'C:/p/docs/workspace-recovery/standard.md' } },
    review: { enabled: true, role: 'reviewer', status: 'ok', docs: { standard: 'C:/p/docs/review/review-standard.md', dispatch: 'C:/p/docs/review/review-dispatch.md' } },
    diagrams: { enabled: true, role: 'designer', status: 'ok', docs: { standard: 'C:/p/docs/diagrams/standard.md' } }
  })
  assert.deepEqual(fakeModules({ review: { enabled: false } }), { ...modules, review: { ...modules.review, enabled: false } })
  assert.deepEqual(fakeModules({ review: { docs: { custom: 'C:/custom' } } }).review.docs, { custom: 'C:/custom' })
})

test('existsFrom normalizes both stored and queried path separators', async () => {
  const backslash = String.fromCharCode(92)
  const exists = existsFrom(['C:/p/docs/standard.md', ['C:', 'p', 'docs', 'other.md'].join(backslash)])
  assert.equal(await exists(['C:', 'p', 'docs', 'standard.md'].join(backslash)), true)
  assert.equal(await exists('C:/p/docs/other.md'), true)
  assert.equal(await exists('C:/p/docs/missing.md'), false)
})
