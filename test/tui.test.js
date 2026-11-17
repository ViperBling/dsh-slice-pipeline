import test from 'node:test'
import assert from 'node:assert/strict'
import { MODULE_DEFS, MODULE_KEYS, ROLE_KEYS, readConfig } from '../lib/config.js'
import { buildTuiSection, registerTuiSettings, PATH_HINT, LEGACY_CONTENT_HINT } from '../lib/tui.js'
import { DESKTOP_CONFIG } from './helpers/fixtures.js'

const fakeLlm = {
  listProviders: () => [{ id: 'p', name: 'P' }],
  listModels: async () => [{ id: 'm' }],
  resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'high' } })
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('one page group per module in order', () => {
  const section = buildTuiSection([], readConfig({}))
  assert.deepEqual(section.groups.map((group) => [group.id, group.mode]), MODULE_KEYS.map((key) => [key, 'page']))
  assert.deepEqual(section.groups.map((group) => group.title), MODULE_KEYS.map((key) => MODULE_DEFS[key].title))
  assert.equal(section.ns, 'dsh-slice-pipeline')
  assert.equal(section.title, 'Slice Pipeline')
})

test('root keeps roles, stages and maxFixRounds; reviewStandard lives in the review group', () => {
  const section = buildTuiSection([], readConfig({}))
  const root = section.fields.filter((field) => !field.group).map((field) => field.path.join('.'))
  assert.deepEqual(root, [
    'roles.default', 'roles.designer', 'roles.task', 'roles.reviewer',
    'stages.plan', 'stages.slice', 'maxFixRounds'
  ])
  assert.equal(section.fields.find((field) => field.path.join('.') === 'reviewStandard').group, 'review')
})

test('pipeline has only enabled; patchDelivery has two path fields', () => {
  const section = buildTuiSection([], readConfig({}))
  const of = (group) => section.fields.filter((field) => field.group === group).map((field) => field.path.join('.'))
  assert.deepEqual(of('pipeline'), ['modules.pipeline.enabled'])
  assert.deepEqual(of('patchDelivery'), [
    'modules.patchDelivery.enabled', 'modules.patchDelivery.role',
    'modules.patchDelivery.standardPath', 'modules.patchDelivery.templatePath'
  ])
})

test('role options show current routes', () => {
  const section = buildTuiSection([], readConfig(DESKTOP_CONFIG))
  const field = section.fields.find((item) => item.path.join('.') === 'modules.review.role')
  assert.deepEqual(field.options.map((option) => option.value), ROLE_KEYS)
  assert.deepEqual(
    field.options.find((option) => option.value === 'reviewer'),
    { value: 'reviewer', label: 'reviewer（paper-anthropic/claude-opus-5-5）' }
  )
})

test('path parse: newline blocks, blank clears, quotes stripped', () => {
  const field = buildTuiSection([], readConfig({})).fields.find((item) => item.path.join('.') === 'modules.planning.standardPath')
  assert.equal(field.parse('a\nb'), undefined)
  assert.deepEqual(field.parse('   '), { kind: 'clear' })
  assert.deepEqual(field.parse('"C:\\r.md"'), { kind: 'set', value: 'C:\\r.md' })
})

test('legacy content is never shown as draft text', () => {
  const field = buildTuiSection([], readConfig({ reviewStandard: '# 规范\n内容' })).fields.find((item) => item.path.join('.') === 'reviewStandard')
  assert.equal(field.format('# 规范\n内容'), '')
  assert.equal(field.hint, LEGACY_CONTENT_HINT)
  assert.deepEqual(
    field.parse('docs/review/review-standard.md'),
    { kind: 'set', value: 'docs/review/review-standard.md' }
  )
})

test('path fields use the path hint for ordinary paths', () => {
  const field = buildTuiSection([], readConfig({})).fields.find((item) => item.path.join('.') === 'modules.planning.standardPath')
  assert.equal(field.hint, PATH_HINT)
  assert.equal(field.format('docs/planning/standard.md'), 'docs/planning/standard.md')
})

test('root role select keeps an unknown current route visible and handles no options', () => {
  const config = readConfig({ roles: { designer: 'gone/model' } })
  const section = buildTuiSection([{ value: 'p/m', label: 'P / M' }], config)
  const field = section.fields.find((item) => item.path.join('.') === 'roles.designer')
  assert.deepEqual(field.options, [
    { value: 'gone/model', label: 'gone/model（当前配置，未检测到）' },
    { value: 'p/m', label: 'P / M' }
  ])
  const empty = buildTuiSection([], readConfig({ roles: { designer: '' } }))
  const emptyField = empty.fields.find((item) => item.path.join('.') === 'roles.designer')
  assert.deepEqual(emptyField.options, [{ value: '', label: '（未检测到可用 provider/model）' }])
})

function makeTuiContext() {
  const listeners = {}
  const ctx = {
    get: () => fakeLlm,
    logger: { warn() {} },
    on(event, fn) {
      (listeners[event] ??= []).push(fn)
      return () => {
        listeners[event] = listeners[event].filter((item) => item !== fn)
      }
    }
  }
  return { ctx, listeners }
}

test('re-registers on both update events and cleans up', async () => {
  const { ctx, listeners } = makeTuiContext()
  const registered = []
  let disposed = 0
  const tuiSettings = {
    register(section) {
      registered.push(section)
      return () => { disposed++ }
    }
  }
  const dispose = registerTuiSettings(ctx, tuiSettings, () => readConfig({}))
  await settle()
  assert.equal(registered.length, 1)
  listeners['loader/volatile-update'].forEach((fn) => fn())
  await settle()
  assert.equal(registered.length, 2)
  listeners['llm/adapters-updated'].forEach((fn) => fn())
  await settle()
  assert.equal(registered.length, 3)
  assert.equal(disposed, 2)
  dispose()
  assert.equal(listeners['loader/volatile-update'].length, 0)
  assert.equal(listeners['llm/adapters-updated'].length, 0)
  assert.equal(disposed, 3)
})

test('apply wires the native TUI settings seam with plain config', async () => {
  const { apply } = await import('../lib/index.js')
  const handlers = {}
  let section
  let dispose
  let disposed = 0
  const ctx = {
    skills: {
      registerProvider(create) {
        create({ signal: new AbortController().signal, invalidate() {} })
        return () => {}
      }
    },
    on(event, fn) {
      (handlers[event] ??= []).push(fn)
      return () => {}
    },
    inject(services, callback) {
      if (services[0] === 'tools') return
      assert.deepEqual(services, ['tuiSettingsSections'])
      callback({
        tuiSettingsSections: {
          register(value) {
            section = value
            return () => { disposed++ }
          }
        },
        effect(create, label) {
          assert.equal(label, 'dsh-slice-pipeline: tui settings section')
          dispose = create()
        }
      })
    },
    get: () => ({
      listProviders: () => [{ id: 'provider', name: 'Provider' }],
      listModels: async () => [{ id: 'model', name: 'Model' }],
      resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'max' } })
    }),
    logger: { warn() {} }
  }
  await apply(ctx, { roles: { designer: { get: () => 'provider/model' } } })
  await settle()
  assert.equal(section.ns, 'dsh-slice-pipeline')
  assert.equal(section.title, 'Slice Pipeline')
  assert.equal(section.fields.length, 25)
  const designer = section.fields.find((field) => field.path.join('.') === 'roles.designer')
  assert.deepEqual(designer.options, [{ value: 'provider/model', label: 'Provider / Model · max' }])
  const plan = section.fields.find((field) => field.path.join('.') === 'stages.plan')
  assert.equal(plan.format(['design', 'planReview']), 'design, planReview')
  assert.deepEqual(plan.parse('design, , planReview'), { kind: 'set', value: ['design', 'planReview'] })
  handlers['llm/adapters-updated'].forEach((fn) => fn())
  await settle()
  assert.equal(disposed, 1)
  dispose()
  assert.equal(disposed, 2)
})
