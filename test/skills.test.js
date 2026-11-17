import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Config as SharedConfig, readConfig } from '../lib/config.js'
import { resolveModules, toSlash } from '../lib/paths.js'
import { MODULE_HEADING, PIPELINE_HEADING } from '../lib/inject.js'
import { createSkillProvider } from '../lib/skills.js'
import * as host from '../lib/index.js'

const { Config, apply } = host
const root = fileURLToPath(new URL('./fixtures/plugin/', import.meta.url))
const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const make = (cfg, extra = {}) => createSkillProvider({
  name: 'dsh-slice-pipeline', pluginRoot: root, getConfig: () => cfg, ...extra
})
const names = async (p) => (await p.list({})).map((c) => c.name).sort()
const candidate = async (p, name) => (await p.list({})).find((c) => c.name === name)

function makeContext() {
  const handlers = {}
  const state = { invalidations: 0 }
  const ctx = {
    skills: {
      registerProvider(create) {
        state.provider = create({
          signal: new AbortController().signal,
          invalidate: () => { state.invalidations++ }
        })
        return () => {}
      }
    },
    on(event, fn) { (handlers[event] ??= []).push(fn); return () => {} },
    inject() {},
    get() {},
    logger: { warn() {} }
  }
  return { ctx, handlers, state }
}

test('list hides disabled modules and keeps unknown skill dirs', async () => {
  assert.deepEqual(await names(make(readConfig({}))), ['custom-extra', 'slice-planning', 'slice-review'])
  const disabled = readConfig({ modules: { planning: { enabled: false } } })
  assert.deepEqual(await names(make(disabled)), ['custom-extra', 'slice-review'])
})

test('get returns undefined for a disabled module', async () => {
  const c = await candidate(make(readConfig({})), 'slice-planning')
  const p = make(readConfig({ modules: { planning: { enabled: false } } }))
  assert.equal(await p.get(c, {}), undefined)
})

test('get appends the module block and reports missing docs', async () => {
  const p = make(readConfig({}))
  const review = await p.get(await candidate(p, 'slice-review'), {})
  assert.ok(review.content.startsWith('review body\n'))
  assert.ok(review.content.includes(MODULE_HEADING))
  assert.ok(review.content.includes('状态：missingDoc'))
  assert.ok(review.content.includes('（缺失）'))
  assert.ok(review.content.includes(toSlash(join(root, 'docs/review/review-standard.md'))))
  const planning = await p.get(await candidate(p, 'slice-planning'), {})
  assert.ok(planning.content.startsWith('planning body\n'))
  assert.ok(planning.content.includes(MODULE_HEADING))
  assert.ok(planning.content.includes('状态：ok'))
  assert.ok(planning.content.includes(toSlash(join(root, 'docs/planning/standard.md'))))
  assert.ok(planning.content.includes(toSlash(join(root, 'docs/INDEX.md'))))
  assert.ok(planning.content.includes(toSlash(join(root, 'docs/shared/dispatch-guide.md'))))
})

test('unknown skills get no injected block', async () => {
  const p = make(readConfig({}), { resolve: () => { throw new Error('must not resolve') } })
  const skill = await p.get(await candidate(p, 'custom-extra'), {})
  assert.equal(skill.content.trim(), 'extra body')
  assert.equal(skill.content.includes(PIPELINE_HEADING), false)
  assert.equal(skill.content.includes(MODULE_HEADING), false)
})

test('a failing resolver degrades to a warning block', async () => {
  const p = make(readConfig({}), { resolve: async () => { throw new Error('boom') } })
  const skill = await p.get(await candidate(p, 'slice-planning'), {})
  assert.equal(skill.content, 'planning body\n\n\n' + PIPELINE_HEADING +
    '\n\n- 警告：配置注入失败：boom\n')
})

test('apply invalidates the catalog on loader/volatile-update', async () => {
  const { ctx, handlers, state } = makeContext()
  await apply(ctx, Config({}))
  handlers['loader/volatile-update'].forEach((fn) => fn([['modules', 'planning', 'enabled']]))
  assert.equal(state.invalidations, 1)
  assert.equal(state.provider.name, 'dsh-slice-pipeline')
})

test('discovery and get preserve the 0.2.0 candidate and skill fields', async () => {
  const p = make(readConfig({}))
  const c = await candidate(p, 'slice-planning')
  const common = {
    name: 'slice-planning', description: 'Planning fixture skill',
    whenToUse: 'When planning a slice',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom', provider: 'dsh-slice-pipeline',
    path: join(root, 'skills/slice-planning/SKILL.md'),
    metadata: {
      name: 'slice-planning', description: 'Planning fixture skill',
      whenToUse: 'When planning a slice'
    }
  }
  assert.deepEqual(c, { ...common, rank: 550, locator: join(root, 'skills/slice-planning') })
  const skill = await p.get(c, {})
  assert.deepEqual(skill, {
    ...common, resourceBase: { kind: 'directory', path: c.locator }, content: skill.content
  })
  assert.ok(skill.content.startsWith('planning body\n'))
})

test('list and get tolerate absent options and honor cancellation', async () => {
  const p = make(readConfig({}))
  assert.deepEqual((await p.list()).map((c) => c.name).sort(), await names(p))
  const c = await candidate(p, 'slice-planning')
  assert.ok((await p.get(c)).content.includes(MODULE_HEADING))
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await p.list({ signal: controller.signal }), [])
  assert.equal(await p.get(c, { signal: controller.signal }), undefined)
  assert.equal(await p.get({ ...c, path: join(root, 'missing-SKILL.md') }), undefined)
})

test('enable filtering reads current config and keys off the directory, not candidate name', async () => {
  let config = readConfig({})
  const p = make(config, { getConfig: () => config })
  const c = await candidate(p, 'slice-planning')
  config = readConfig({ modules: { planning: { enabled: false } } })
  assert.deepEqual(await names(p), ['custom-extra', 'slice-review'])
  assert.equal(await p.get({ ...c, name: 'custom-extra' }), undefined)
  config.modules.planning.enabled = 'true'
  assert.deepEqual(await names(p), ['custom-extra', 'slice-review'])
  config.modules.planning.enabled = true
  assert.ok((await p.get(c)).content.includes('状态：ok'))
})

test('pipeline uses the same plugin root for resolution and rendering with plain config', async () => {
  const config = readConfig({ maxFixRounds: 0, modules: { review: { enabled: false } } })
  const exists = async () => false
  let calls = 0
  const p = make(config, {
    pluginRoot,
    exists,
    resolve: async (received, options) => {
      calls++
      assert.equal(received, config)
      assert.equal(options.pluginRoot, pluginRoot)
      assert.equal(options.exists, exists)
      return resolveModules(received, options)
    }
  })
  const skill = await p.get(await candidate(p, 'slice-pipeline'))
  assert.equal(calls, 1)
  assert.ok(skill.content.includes(PIPELINE_HEADING))
  assert.equal(skill.content.includes(MODULE_HEADING), false)
  assert.ok(skill.content.includes(toSlash(join(pluginRoot, 'docs/INDEX.md'))))
  const args = JSON.parse(skill.content.split(PIPELINE_HEADING).at(-1).match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(args.maxFixRounds, 0)
  assert.equal(args.modules.review.status, 'disabled')
  assert.equal(args.modules.pipeline.docs.script, toSlash(join(pluginRoot, 'skills/slice-pipeline/slice-pipeline.js')))
})

test('renderer failures also degrade to the warning block', async () => {
  const p = make(readConfig({}), { resolve: async () => ({}) })
  const skill = await p.get(await candidate(p, 'slice-planning'))
  assert.ok(skill.content.startsWith('planning body\n\n\n' + PIPELINE_HEADING))
  assert.ok(skill.content.includes('- 警告：配置注入失败：'))
})

test('non-Error resolver failures keep a readable warning', async () => {
  const p = make(readConfig({}), { resolve: () => { throw 'boom' } })
  const skill = await p.get(await candidate(p, 'slice-planning'))
  assert.ok(skill.content.includes('配置注入失败：boom'))
})

test('host exports stay stable and use the shared schema', () => {
  assert.deepEqual(Object.keys(host).sort(), ['Config', 'apply', 'default', 'inject', 'name'])
  assert.equal(Config, SharedConfig)
  assert.deepEqual(host.inject, ['skills', 'llm'])
  assert.equal(host.name, 'dsh-slice-pipeline')
  assert.deepEqual(host.default, { Config, apply, inject: host.inject, name: host.name })
})

test('apply reads volatile leaves as plain config before and after settings saves', async () => {
  let enabled = true
  let rounds = 3
  let route = 'provider/initial'
  const raw = Config({})
  raw.modules.pipeline.enabled = { get: () => enabled }
  raw.maxFixRounds = { get: () => rounds }
  raw.roles.designer = { get: () => route }
  const { ctx, handlers, state } = makeContext()
  await apply(ctx, raw)
  const c = await candidate(state.provider, 'slice-pipeline')
  const argsOf = (skill) => JSON.parse(
    skill.content.split(PIPELINE_HEADING).at(-1).match(/```json\n([\s\S]*?)\n```/)[1]
  )
  const initial = argsOf(await state.provider.get(c))
  assert.deepEqual(initial.roles.designer, { provider: 'provider', model: 'initial' })
  assert.equal(initial.modules.pipeline.enabled, true)
  assert.equal(initial.modules.pipeline.docs.script, toSlash(join(pluginRoot, 'skills/slice-pipeline/slice-pipeline.js')))
  enabled = false
  handlers['loader/volatile-update'].forEach((fn) => fn())
  assert.equal(state.invalidations, 1)
  assert.equal((await state.provider.list()).some((item) => item.name === 'slice-pipeline'), false)
  assert.equal(await state.provider.get(c), undefined)
  enabled = true
  rounds = 0
  route = 'provider/updated'
  handlers['loader/volatile-update'].forEach((fn) => fn())
  const updated = argsOf(await state.provider.get(c))
  assert.equal(state.invalidations, 2)
  assert.equal(updated.maxFixRounds, 0)
  assert.deepEqual(updated.roles.designer, { provider: 'provider', model: 'updated' })
})
