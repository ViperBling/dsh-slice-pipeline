import test from 'node:test'
import assert from 'node:assert/strict'
import { MODULE_DEFS, MODULE_KEYS } from '../lib/config.js'
import { cleanPathInput, isContentLike } from '../lib/paths.js'
import { LEGACY_CONTENT_HINT } from '../lib/tui.js'
import { loadClientHarness } from './helpers/client-harness.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

function collectByProp(node, prop, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByProp(child, prop, out)
    return out
  }
  if (node.props && node.props[prop] !== undefined) out.push(node.props[prop])
  if (node.children) collectByProp(node.children, prop, out)
  return out
}

test('registers the Slice Pipeline tab', async () => {
  const { registration } = (await loadClientHarness()).mount({})
  assert.equal(registration.slot, 'settings.plugins.tab')
  assert.equal(registration.def.id, 'dsh-slice-pipeline')
})

test('renders six module cards in order', async () => {
  const { tree } = (await loadClientHarness()).mount({})
  assert.deepEqual(collectByProp(tree, 'data-module'), MODULE_KEYS)
})

test('toggle and role changes write path-level ops', async () => {
  const m = (await loadClientHarness()).mount({})
  m.byField('modules.planning.enabled').props.onChange({ target: { checked: false } })
  m.byField('modules.review.role').props.onChange({ target: { value: 'task' } })
  await settle()
  assert.deepEqual(m.mutations, [
    [{ op: 'set', path: ['modules', 'planning', 'enabled'], value: false }],
    [{ op: 'set', path: ['modules', 'review', 'role'], value: 'task' }]
  ])
})

test('path blur: newline rejected, blank unsets, unchanged is silent, quotes stripped', async () => {
  const m = (await loadClientHarness()).mount({ reviewStandard: 'docs/x.md' })
  const f = m.byField('reviewStandard')
  f.props.onBlur({ target: { value: 'a\nb' } })
  f.props.onBlur({ target: { value: 'docs/x.md' } })
  f.props.onBlur({ target: { value: '' } })
  f.props.onBlur({ target: { value: '"C:' + String.fromCharCode(92) + 'r.md"' } })
  await settle()
  assert.ok(m.stateWrites.some((v) => typeof v === 'string' && v.includes('换行')))
  assert.deepEqual(m.mutations, [
    [{ op: 'unset', path: ['reviewStandard'] }],
    [{ op: 'set', path: ['reviewStandard'], value: 'C:' + String.fromCharCode(92) + 'r.md' }]
  ])
})

test('content-like path input is rejected without mutation', async () => {
  const m = (await loadClientHarness()).mount({})
  m.byField('reviewStandard').props.onBlur({ target: { value: '# 标题 内容' } })
  await settle()
  assert.deepEqual(m.mutations, [])
  assert.ok(m.stateWrites.some((v) => typeof v === 'string' && v.includes('换行')))
})

test('blank blur clears a legacy content-like stored value', async () => {
  const m = (await loadClientHarness()).mount({ reviewStandard: '# 审查规范\n正文' })
  m.byField('reviewStandard').props.onBlur({ target: { value: '' } })
  await settle()
  assert.deepEqual(m.mutations, [[{ op: 'unset', path: ['reviewStandard'] }]])
})

test('doc path inputs render the path hint', async () => {
  const m = (await loadClientHarness()).mount({})
  assert.ok(m.text().includes('相对插件根目录，或填写绝对路径；内容请直接编辑文件'))
})

test('legacy content is never rendered; alias shows the mapping note', async () => {
  const h = await loadClientHarness()
  const legacy = h.mount({ reviewStandard: '# 审查规范\n秘密正文' })
  assert.equal(legacy.text().includes('秘密正文'), false)
  assert.equal(legacy.byField('reviewStandard').props.defaultValue, '')
  assert.ok(legacy.text().includes('检测到旧版内容型配置'))
  assert.ok(h.mount({ reviewStandard: 'review-standard.md' }).text().includes('已自动映射到 docs/review/review-standard.md'))
})

test('client definitions match the host', async () => {
  const { MODULES, cleanPathInput: c, isContentLike: i } = (await loadClientHarness()).exports.helpers
  assert.deepEqual(MODULES.map((m) => m.key), MODULE_KEYS)
  assert.deepEqual(MODULES.map((m) => m.title), MODULE_KEYS.map((key) => MODULE_DEFS[key].title))
  assert.deepEqual(MODULES.map((m) => m.role), MODULE_KEYS.map((key) => MODULE_DEFS[key].role))
  for (const [index, key] of MODULE_KEYS.entries()) {
    const expectedDocs = Object.entries(MODULE_DEFS[key].docs)
      .filter(([, doc]) => doc.configPath !== null)
      .map(([docKey, doc]) => ({
        docKey,
        label: doc.label,
        defaultPath: doc.defaultPath,
        configPath: doc.configPath
      }))
    assert.deepEqual(MODULES[index].docs, expectedDocs)
  }
  for (const s of ['  "a b"  ', "'x'", '', 'docs' + String.fromCharCode(92) + 'y.md']) assert.equal(c(s), cleanPathInput(s))
  for (const s of ['# h', 'a\nb', 'x'.repeat(401), 'ok.md']) assert.equal(i(s), isContentLike(s))
})

test('alias mapping note is scoped to the review doc', async () => {
  const { MODULES, describeStoredPath } = (await loadClientHarness()).exports.helpers
  const planningDoc = MODULES.find((m) => m.key === 'planning').docs[0]
  assert.equal(describeStoredPath(planningDoc, 'review-standard.md').note, null)
})

test('legacy content note matches the TUI hint exactly', async () => {
  const { describeStoredPath } = (await loadClientHarness()).exports.helpers
  assert.equal(describeStoredPath({}, '# h').note, LEGACY_CONTENT_HINT)
})
