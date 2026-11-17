import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { MODULE_KEYS, MODULE_DEFS, LEGACY_REVIEW_STANDARD_ALIASES, readConfig } from '../lib/config.js'
import { cleanPathInput, isContentLike, toSlash, resolveDocPath, resolveModules } from '../lib/paths.js'
import { DESKTOP_CONFIG, existsFrom } from './helpers/fixtures.js'

const root = path.join(os.tmpdir(), 'fake plugin 插件', 'dsh-slice-pipeline')
const at = (...p) => toSlash(path.join(root, ...p))
const legacyBase = path.join(root, 'skills', 'slice-pipeline')
const base = { defaultPath: 'docs/review/review-standard.md', pluginRoot: root, legacyBase }
const defaultDoc = at(base.defaultPath)
const allDocs = MODULE_KEYS.flatMap((key) => Object.values(MODULE_DEFS[key].docs).map((doc) => at(doc.defaultPath)))

function trackedExists(paths) {
  const calls = []
  const predicate = existsFrom(paths)
  return { calls, exists: async (file) => { calls.push(toSlash(file)); return predicate(file) } }
}

function expectedDefaults() {
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, {
    enabled: true,
    role: MODULE_DEFS[key].role,
    status: 'ok',
    docs: Object.fromEntries(Object.entries(MODULE_DEFS[key].docs).map(([docKey, doc]) => [docKey, at(doc.defaultPath)])),
    missing: [],
    warnings: []
  }]))
}

test('cleanPathInput strips whitespace and one pair of quotes', () => {
  assert.equal(cleanPathInput('  "C:\\a b\\r.md"  '), 'C:\\a b\\r.md')
  assert.equal(cleanPathInput("'docs/x.md'"), 'docs/x.md')
  assert.equal(cleanPathInput(' "  docs/x.md  " '), 'docs/x.md')
  assert.equal(cleanPathInput('"\'docs/x.md\'"'), "'docs/x.md'")
  assert.equal(cleanPathInput('"docs/x.md\''), '"docs/x.md\'')
  assert.equal(cleanPathInput('"'), '"')
  for (const value of [42, undefined, null, false, {}, []]) assert.equal(cleanPathInput(value), '')
})

test('isContentLike flags markdown bodies, newlines and overlong text', () => {
  for (const value of ['# 审查规范', '  \t# 审查规范', 'a\nb', 'a\rb', 'a'.repeat(401)]) {
    assert.equal(isContentLike(value), true, value)
  }
  for (const value of ['', 'docs/x.md', 'docs/#rules.md', 'a'.repeat(400)]) {
    assert.equal(isContentLike(value), false, value)
  }
})

test('toSlash changes only backslash separators', () => {
  assert.equal(toSlash('C:\\fake plugin 插件\\docs\\r.md'), 'C:/fake plugin 插件/docs/r.md')
  assert.equal(toSlash('docs/r.md'), 'docs/r.md')
  assert.equal(toSlash(''), '')
})

test('blank resolves to the default without warning', async () => {
  const result = await resolveDocPath('  ', { ...base, exists: existsFrom([defaultDoc]) })
  assert.deepEqual(result, { path: defaultDoc, exists: true, source: 'default' })
})

test('non-string and quoted blank inputs also resolve to the default', async () => {
  for (const value of [undefined, null, 42, false, ' "  " ', " '' "]) {
    const result = await resolveDocPath(value, { ...base, exists: existsFrom([]) })
    assert.deepEqual(result, { path: defaultDoc, exists: false, source: 'default' })
  }
})

test('default resolution never falls back to the legacy dir', async () => {
  const probe = trackedExists([at('skills/slice-pipeline', base.defaultPath)])
  assert.deepEqual(await resolveDocPath('', { ...base, exists: probe.exists }), {
    path: defaultDoc, exists: false, source: 'default'
  })
  assert.deepEqual(probe.calls, [defaultDoc])
})

test('legacy aliases map silently to the new default', async () => {
  for (const value of ['review-standard.md', './review-standard.md', '.\\review-standard.md', 'REVIEW-STANDARD.MD', ' "./Review-Standard.md" ']) {
    const result = await resolveDocPath(value, {
      ...base, aliases: LEGACY_REVIEW_STANDARD_ALIASES, exists: existsFrom([defaultDoc])
    })
    assert.deepEqual(result, { path: defaultDoc, exists: true, source: 'alias' })
  }
})

test('alias comparison normalizes both the configured value and aliases', async () => {
  const result = await resolveDocPath('./review-standard.md', {
    ...base, aliases: ['.\\REVIEW-STANDARD.MD'], exists: existsFrom([])
  })
  assert.deepEqual(result, { path: defaultDoc, exists: false, source: 'alias' })
})

test('content-like values fall back to the default with the exact warning', async () => {
  for (const value of ['# 规范\n- 规则', 'docs/r.md\rother.md', 'a'.repeat(401)]) {
    const result = await resolveDocPath(value, { ...base, exists: existsFrom([]) })
    assert.deepEqual(result, {
      path: defaultDoc,
      exists: false,
      source: 'default',
      warning: `检测到旧版内容型配置（不是文件路径），已改用默认文件 ${base.defaultPath}；请把内容保存为文件并填写路径。`
    })
  }
})

test('content detection takes precedence over alias matching', async () => {
  const result = await resolveDocPath('# rules', { ...base, aliases: ['# rules'], exists: existsFrom([defaultDoc]) })
  assert.equal(result.source, 'default')
  assert.equal(result.exists, true)
  assert.match(result.warning, /内容型配置/)
})

test('absolute, quoted absolute and home paths', async () => {
  const abs = path.join(os.tmpdir(), 'my rules', 'r.md')
  for (const value of [abs, '"' + abs + '"', "'" + abs + "'"]) {
    const result = await resolveDocPath(value, { ...base, exists: existsFrom([abs]) })
    assert.deepEqual(result, { source: 'absolute', path: toSlash(abs), exists: true })
  }
  const home = toSlash(path.join(os.homedir(), 'rules/r.md'))
  for (const value of ['~/rules/r.md', '~\\rules\\r.md', ' "~/rules/r.md" ']) {
    const result = await resolveDocPath(value, { ...base, exists: existsFrom([home]) })
    assert.deepEqual(result, { source: 'home', path: home, exists: true })
  }
})

test('missing absolute and home paths do not use relative fallbacks', async () => {
  const abs = path.join(os.tmpdir(), 'my rules', 'missing.md')
  const probe = trackedExists([])
  assert.deepEqual(await resolveDocPath(abs, { ...base, exists: probe.exists }), {
    source: 'absolute', path: toSlash(abs), exists: false
  })
  const home = toSlash(path.join(os.homedir(), 'rules/missing.md'))
  assert.deepEqual(await resolveDocPath('~/rules/missing.md', { ...base, exists: probe.exists }), {
    source: 'home', path: home, exists: false
  })
  assert.deepEqual(probe.calls, [toSlash(abs), home])
})

test('relative paths: plugin root first, backslashes accepted', async () => {
  const text = 'docs\\custom\\r.md'
  const probe = trackedExists([at('docs/custom/r.md'), at('skills/slice-pipeline/docs/custom/r.md')])
  const result = await resolveDocPath(text, { ...base, exists: probe.exists })
  assert.deepEqual(result, { source: 'plugin-root', path: at('docs/custom/r.md'), exists: true })
  assert.deepEqual(probe.calls, [at('docs/custom/r.md')])
})

test('relative paths fall back once to the old skill dir', async () => {
  const text = 'mine.md'
  const probe = trackedExists([at('skills/slice-pipeline/mine.md')])
  const result = await resolveDocPath(text, { ...base, exists: probe.exists })
  assert.deepEqual(result, {
    source: 'legacy-dir', path: at('skills/slice-pipeline/mine.md'), exists: true,
    warning: `相对路径 ${text} 在插件根目录不存在，已改用旧位置 skills/slice-pipeline/${text}。`
  })
  assert.deepEqual(probe.calls, [at('mine.md'), at('skills/slice-pipeline/mine.md')])
})

test('legacy fallback normalizes separators but keeps cleaned input in the warning', async () => {
  const text = 'custom\\r.md'
  const result = await resolveDocPath(' " ' + text + ' " ', {
    ...base, exists: existsFrom([at('skills/slice-pipeline/custom/r.md')])
  })
  assert.deepEqual(result, {
    source: 'legacy-dir', path: at('skills/slice-pipeline/custom/r.md'), exists: true,
    warning: `相对路径 ${text} 在插件根目录不存在，已改用旧位置 skills/slice-pipeline/${text}。`
  })
})

test('missing relative path reports the plugin-root path and never uses cwd', async () => {
  const probe = trackedExists([path.resolve('only-in-cwd.md')])
  const result = await resolveDocPath('only-in-cwd.md', { ...base, exists: probe.exists })
  assert.deepEqual(result, { path: at('only-in-cwd.md'), exists: false, source: 'plugin-root' })
  assert.deepEqual(probe.calls, [at('only-in-cwd.md'), at('skills/slice-pipeline/only-in-cwd.md')])
})

test('roots with spaces and non-ASCII are kept verbatim', async () => {
  const result = await resolveDocPath('', { ...base, exists: existsFrom([]) })
  assert.ok(result.path.includes('fake plugin 插件'))
  assert.equal(result.path, defaultDoc)
})

test('resolveModules: defaults all ok, disabled wins, missing template reported', async () => {
  const ok = await resolveModules(readConfig({}), { pluginRoot: root, exists: existsFrom(allDocs) })
  assert.deepEqual(ok, expectedDefaults())
  assert.equal(ok.review.docs.standard, at('docs/review/review-standard.md'))
  const config = readConfig({ modules: { planning: { enabled: false } } })
  const partial = allDocs.filter((file) => !file.endsWith('thin-document-template.md') && !file.endsWith('docs/planning/standard.md'))
  const states = await resolveModules(config, { pluginRoot: root, exists: existsFrom(partial) })
  assert.equal(states.planning.status, 'disabled')
  assert.equal(states.planning.enabled, false)
  assert.deepEqual(states.planning.missing, [at('docs/planning/standard.md')])
  assert.equal(states.patchDelivery.status, 'missingDoc')
  assert.deepEqual(states.patchDelivery.missing, [at('docs/patch-delivery/thin-document-template.md')])
  assert.deepEqual(states.patchDelivery.warnings, [])
})

test('resolveModules uses configured roles and document paths but keeps pipeline.script fixed', async () => {
  const recovery = path.join(os.tmpdir(), 'custom recovery', 'standard.md')
  const diagrams = toSlash(path.join(os.homedir(), 'custom/diagrams.md'))
  const config = readConfig({
    reviewStandard: 'custom/review.md',
    modules: {
      planning: { role: 'reviewer', standardPath: 'custom\\planning.md' },
      patchDelivery: { role: 'designer', standardPath: 'custom/delivery.md', templatePath: 'custom-template.md' },
      workspaceRecovery: { role: 'task', standardPath: '"' + recovery + '"' },
      review: { role: 'default' },
      diagrams: { role: 'task', standardPath: '~\\custom\\diagrams.md' }
    }
  })
  config.modules.pipeline.script = 'untrusted.js'
  config.modules.pipeline.scriptPath = 'untrusted.js'
  const expected = expectedDefaults()
  expected.planning.role = 'reviewer'
  expected.planning.docs.standard = at('custom/planning.md')
  expected.patchDelivery.role = 'designer'
  expected.patchDelivery.docs = { standard: at('custom/delivery.md'), template: at('skills/slice-pipeline/custom-template.md') }
  expected.patchDelivery.warnings = ['相对路径 custom-template.md 在插件根目录不存在，已改用旧位置 skills/slice-pipeline/custom-template.md。']
  expected.workspaceRecovery.role = 'task'
  expected.workspaceRecovery.docs.standard = toSlash(recovery)
  expected.review.role = 'default'
  expected.review.docs.standard = at('custom/review.md')
  expected.diagrams.role = 'task'
  expected.diagrams.docs.standard = diagrams
  const paths = Object.values(expected).flatMap((module) => Object.values(module.docs))
  assert.deepEqual(await resolveModules(config, { pluginRoot: root, exists: existsFrom(paths) }), expected)
})

test('resolveModules collects content warnings and all missing documents', async () => {
  const config = readConfig({ reviewStandard: '# old standard' })
  const states = await resolveModules(config, { pluginRoot: root, exists: existsFrom([]) })
  for (const key of MODULE_KEYS) {
    assert.equal(states[key].status, 'missingDoc')
    assert.deepEqual(states[key].missing, Object.values(states[key].docs))
  }
  assert.deepEqual(states.review.warnings, [
    `检测到旧版内容型配置（不是文件路径），已改用默认文件 ${base.defaultPath}；请把内容保存为文件并填写路径。`
  ])
})

test('resolveModules never throws when exists() throws', async () => {
  const states = await resolveModules(readConfig({}), {
    pluginRoot: root, exists: async () => { throw new Error('boom') }
  })
  for (const key of MODULE_KEYS) {
    assert.equal(states[key].status, 'missingDoc')
    assert.deepEqual(states[key].warnings, ['路径解析失败：boom'])
    assert.deepEqual(states[key].docs, {})
    assert.deepEqual(states[key].missing, [])
    assert.equal(states[key].role, MODULE_DEFS[key].role)
  }
})

test('resolveModules isolates resolution errors and disabled still wins', async () => {
  const config = readConfig({ modules: { planning: { enabled: false, role: 'reviewer' } } })
  const existing = existsFrom(allDocs)
  const states = await resolveModules(config, {
    pluginRoot: root,
    exists: async (file) => {
      if (toSlash(file) === at('docs/planning/standard.md')) throw new Error('planning failed')
      return existing(file)
    }
  })
  assert.deepEqual(states.planning, {
    enabled: false, role: 'reviewer', status: 'disabled', docs: {}, missing: [],
    warnings: ['路径解析失败：planning failed']
  })
  for (const key of MODULE_KEYS.filter((key) => key !== 'planning')) {
    assert.deepEqual(states[key], expectedDefaults()[key])
  }
})

test('resolveModules retains already resolved docs and warnings when a later doc throws', async () => {
  const config = readConfig({ modules: { patchDelivery: { standardPath: 'old.md' } } })
  const existing = existsFrom([...allDocs, at('skills/slice-pipeline/old.md')])
  const states = await resolveModules(config, {
    pluginRoot: root,
    exists: async (file) => {
      if (toSlash(file).endsWith('thin-document-template.md')) throw 'template failed'
      return existing(file)
    }
  })
  assert.deepEqual(states.patchDelivery, {
    enabled: true, role: 'task', status: 'missingDoc',
    docs: { standard: at('skills/slice-pipeline/old.md') }, missing: [],
    warnings: [
      '相对路径 old.md 在插件根目录不存在，已改用旧位置 skills/slice-pipeline/old.md。',
      '路径解析失败：template failed'
    ]
  })
  assert.equal(states.diagrams.status, 'ok')
})

test('resolveModules catches invalid root resolution within each module', async () => {
  const config = readConfig({ modules: { pipeline: { enabled: false } } })
  const states = await resolveModules(config, { pluginRoot: null, exists: existsFrom([]) })
  for (const key of MODULE_KEYS) {
    assert.equal(states[key].status, key === 'pipeline' ? 'disabled' : 'missingDoc')
    assert.equal(states[key].warnings.length, 1)
    assert.match(states[key].warnings[0], /^路径解析失败：/)
  }
})

test('desktop alias config resolves review to the new default', async () => {
  const states = await resolveModules(readConfig(DESKTOP_CONFIG), {
    pluginRoot: root, exists: existsFrom([at('docs/review/review-standard.md'), at('docs/review/review-dispatch.md')])
  })
  assert.deepEqual(states.review, expectedDefaults().review)
})
