import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientHarness } from './helpers/client-harness.js'

function flatten(node) {
  if (Array.isArray(node)) return node.flat()
  return node
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.children || [])
  return ''
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children || [], predicate, out)
  return out
}

function claudeTab(exports, stream) {
  const tabs = []
  const job = {
    id: 'claude-4', kind: 'claude', label: 'Claude reviewer', status: 'completed',
    startedAt: Date.now() - 1000, finishedAt: Date.now()
  }
  const snapshot = { rows: { s1: [job] }, observed: { 'claude-4': { text: stream } } }
  const jobs = {
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    watchRows: () => () => {}, observe: () => () => {}, kill: async () => true
  }
  const sidebar = {
    registerTab(descriptor) { tabs.push(descriptor); return () => {} },
    getSnapshot: () => ({ sessionId: 's1' }), subscribeState: () => () => {}, openTab() {}
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', revision: 1, value: {} }),
    subscribe: () => () => {}, mutate: async () => true
  }
  const ctx = {
    configForms: { get: () => form },
    slots: { inject() {}, register() { return () => {} } },
    remote: { session: { modelCatalog: async () => ({ groups: [] }) }, $on: () => () => {} },
    on: () => () => {},
    get(name) {
      if (name === 'jobs') return jobs
      if (name === 'betterSidebar') return sidebar
      return undefined
    },
    inject(services, callback) {
      callback({ betterSidebar: sidebar, jobs, effect(fn) { fn(); return () => {} } })
    }
  }
  exports.apply(ctx)
  return tabs[0].component({ ctx, scope: { sessionId: 's1' }, visible: true })
}

test('folds consecutive tool calls into one line and keeps the failing group open', async () => {
  const { exports } = await loadClientHarness()
  const ndjson = [
    { v: 1, t: 'tool', id: 'r1', name: 'Read', target: 'C:/proj/read-me.cpp', status: 'start' },
    { v: 1, t: 'tool', id: 'r1', status: 'end', ok: true },
    { v: 1, t: 'tool', id: 'g1', name: 'Grep', target: 'SceneAssetRegistry', status: 'start' },
    { v: 1, t: 'tool', id: 'g1', status: 'end', ok: true },
    { v: 1, t: 'thinking', text: '看一下实现' },
    { v: 1, t: 'tool', id: 'b1', name: 'Bash', target: 'git rev-parse --short HEAD', status: 'start' },
    { v: 1, t: 'tool', id: 'b1', status: 'end', ok: false },
    { v: 1, t: 'done', status: 'completed', detail: 'ok' }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n'
  const tree = claudeTab(exports, ndjson)

  const heads = findAll(tree, (node) => node.type === 'div'
    && Array.isArray(node.children)
    && node.children.some((child) => child && child.type === 'span' && textOf(child).includes('次工具调用')))
  assert.equal(heads.length, 2, 'consecutive calls collapse into one row per run')
  assert.match(textOf(heads[0]), /2 次工具调用/)
  assert.match(textOf(heads[0]), /Grep ×1 · Read ×1/)
  assert.match(textOf(heads[1]), /1 次工具调用/)
  assert.match(textOf(heads[1]), /1 失败/)
  assert.equal(findAll(tree, (node) => node.type === 'span' && textOf(node) === 'Bash').length, 1,
    'the failing group opens so the failing call is visible')
  assert.equal(findAll(tree, (node) => node.type === 'span' && textOf(node) === 'Read').length, 0,
    'completed groups without failures stay folded')
})

test('folds raw structured-output text and keeps short prose visible', async () => {
  const { exports } = await loadClientHarness()
  const result = JSON.stringify({
    verdict: 'pass',
    findings: [{ severity: 'info', category: 'x', message: 'm'.repeat(600) }]
  }, null, 2)
  const ndjson = [
    JSON.stringify({ v: 1, t: 'text', text: '我先看一下实现。' }),
    JSON.stringify({ v: 1, t: 'text', text: result }),
    JSON.stringify({ v: 1, t: 'done', status: 'completed', detail: result })
  ].join('\n') + '\n'
  const tabs = []
  const job = {
    id: 'claude-3', kind: 'claude', label: 'Claude reviewer', status: 'completed',
    startedAt: Date.now() - 1000, finishedAt: Date.now()
  }
  const snapshot = { rows: { s1: [job] }, observed: { 'claude-3': { text: ndjson } } }
  const jobs = {
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    watchRows: () => () => {},
    observe: () => () => {},
    kill: async () => true
  }
  const sidebar = {
    registerTab(descriptor) { tabs.push(descriptor); return () => {} },
    getSnapshot: () => ({ sessionId: 's1' }),
    subscribeState: () => () => {},
    openTab() {}
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', revision: 1, value: { externalAgents: { autoOpen: true } } }),
    subscribe: () => () => {},
    mutate: async () => true
  }
  const ctx = {
    configForms: { get: () => form },
    slots: { inject() {}, register() { return () => {} } },
    remote: { session: { modelCatalog: async () => ({ groups: [] }) }, $on: () => () => {} },
    on: () => () => {},
    get(name) {
      if (name === 'jobs') return jobs
      if (name === 'betterSidebar') return sidebar
      return undefined
    },
    inject(services, callback) {
      callback({ betterSidebar: sidebar, jobs, effect(fn) { fn(); return () => {} } })
    }
  }
  exports.apply(ctx)
  const tree = tabs[0].component({ ctx, scope: { sessionId: 's1' }, visible: true })

  const folds = findAll(tree, (node) => node.type === 'details'
    && textOf(node).includes('原始输出（' + result.length + ' 字符'))
  assert.equal(folds.length, 1, 'raw JSON text renders as one collapsed details block')
  assert.ok(textOf(folds[0]).includes(result), 'expanding the fold still reaches the raw text')
  assert.equal(
    findAll(tree, (node) => node.type === 'div'
      && Array.isArray(node.children) && node.children.length === 1
      && node.children[0] === '我先看一下实现。').length,
    1,
    'short prose text stays visible'
  )
})

test('renders the structured output instead of the assistant text result', async () => {
  const { exports } = await loadClientHarness()
  const textResult = JSON.stringify({ summary: 's', designMarkdown: '# plan' })
  const ndjson = JSON.stringify({
    v: 1, t: 'done', status: 'completed', detail: textResult,
    structured: {
      summary: '设计摘要',
      interfaceContract: '契约',
      slices: [{ id: 'S1', title: '切片一', scope: '范围', acceptance: '验收' }],
      decisions: [],
      openQuestions: []
    }
  }) + '\n'
  const tree = claudeTab(exports, ndjson)
  assert.ok(textOf(tree).includes('Design result'), 'design card renders from structured output')
  assert.ok(textOf(tree).includes('切片一'))
  assert.ok(textOf(tree).includes('1 slices'))
})

test('review findings render workflow fields (issue/file/line/fix) and unverifiable text', async () => {
  const { exports } = await loadClientHarness()
  const structured = {
    verdict: 'revise',
    standardPath: 'docs/review/review-standard.md',
    findings: [{ severity: 'red', file: 'src/a.cpp', line: '12', issue: '空指针风险', fix: '先判空', evidence: 'p->x()' }],
    blindFindings: [],
    unverifiable: 'GPU 路径未验证'
  }
  const ndjson = JSON.stringify({ v: 1, t: 'done', status: 'completed', detail: 'ok', structured }) + '\n'
  const tree = claudeTab(exports, ndjson)
  assert.ok(textOf(tree).includes('Review result'))
  assert.ok(textOf(tree).includes('空指针风险'))
  assert.ok(textOf(tree).includes('src/a.cpp:12'))
  assert.ok(textOf(tree).includes('建议：先判空'))
  assert.ok(textOf(tree).includes('GPU 路径未验证'))
})

test('renders a custom external schema as a readable general card instead of raw JSON', async () => {
  const { exports } = await loadClientHarness()
  const structured = {
    summary: 'Slice02 方案：造型图只在像素级采样一次',
    designMarkdown: '# 方案\n\n第一段\n第二段',
    decisions: [{ topic: '采样位置', decision: '像素级每列一次' }],
    openQuestions: ['是否需要 Inspector 分组'],
    risks: ['HLSL tab 缩进必须保持']
  }
  const ndjson = JSON.stringify({ v: 1, t: 'done', status: 'completed', detail: 'ok', structured }) + '\n'
  const tree = claudeTab(exports, ndjson)
  const text = textOf(tree)
  assert.ok(text.includes('Design result（通用格式）'))
  assert.ok(text.includes('Slice02 方案：造型图只在像素级采样一次'))
  assert.ok(text.includes('正文（'))
  assert.ok(text.includes('采样位置：像素级每列一次'))
  assert.ok(text.includes('是否需要 Inspector 分组'))
  assert.ok(text.includes('HLSL tab 缩进必须保持'))
  assert.equal(text.includes('{\\"summary\\"'), false, 'raw JSON is not printed')
})

test('registers the Claude BetterSidebar tab and auto-opens it for a running job', async () => {
  const { exports } = await loadClientHarness()
  const tabs = []
  let opened = 0
  let watched = 0
  const job = {
    id: 'claude-1', kind: 'claude', label: 'Claude reviewer', status: 'running',
    startedAt: Date.now() - 1000, progress: '分析代码'
  }
  const snapshot = { rows: { s1: [job] }, observed: {} }
  const jobs = {
    state: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    watchRows: () => { watched += 1; return () => {} },
    observe: () => () => {},
    kill: async () => true
  }
  const sidebar = {
    registerTab(descriptor) { tabs.push(descriptor); return () => {} },
    getSnapshot: () => ({ sessionId: 's1' }),
    subscribeState: () => () => {},
    openTab(seed, scope) { opened += 1; assert.deepEqual(scope, { sessionId: 's1' }); assert.equal(seed.type, 'slice-pipeline:claude') }
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', revision: 1, value: { externalAgents: { autoOpen: true } } }),
    subscribe: () => () => {},
    mutate: async () => true
  }
  const ctx = {
    configForms: { get: () => form },
    slots: { inject() {}, register() { return () => {} } },
    remote: { session: { modelCatalog: async () => ({ groups: [] }) }, $on: () => () => {} },
    on: () => () => {},
    get(name) {
      if (name === 'jobs') return jobs
      if (name === 'betterSidebar') return sidebar
      return undefined
    },
    inject(services, callback) {
      const child = {
        betterSidebar: sidebar,
        jobs,
        effect(fn) { fn(); return () => {} }
      }
      callback(child)
    }
  }
  exports.apply(ctx)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'slice-pipeline:claude')
  assert.equal(tabs[0].single, true)
  assert.equal(opened, 1)
  assert.equal(watched, 1)

  const tree = tabs[0].component({ ctx, scope: { sessionId: 's1' }, visible: true })
  assert.ok(JSON.stringify(tree).includes('Claude'))
})

test('does not auto-open the Claude tab when autoOpen is disabled', async () => {
  const { exports } = await loadClientHarness()
  let opened = 0
  const job = { id: 'claude-2', kind: 'claude', label: 'Claude', status: 'running', startedAt: Date.now() }
  const jobs = {
    state: { getSnapshot: () => ({ rows: { s1: [job] }, observed: {} }), subscribe: () => () => {} },
    watchRows: () => () => {}, observe: () => () => {}, kill: async () => true
  }
  const sidebar = {
    registerTab() { return () => {} },
    getSnapshot: () => ({ sessionId: 's1' }),
    subscribeState: () => () => {},
    openTab() { opened += 1 }
  }
  const form = {
    getSnapshot: () => ({ revision: 1, value: { externalAgents: { autoOpen: false } } }),
    subscribe: () => () => {}, mutate: async () => true
  }
  const ctx = {
    configForms: { get: () => form },
    slots: { inject() {}, register() { return () => {} } },
    remote: { session: { modelCatalog: async () => ({ groups: [] }) }, $on: () => () => {} },
    on: () => () => {},
    get(name) { if (name === 'jobs') return jobs; if (name === 'betterSidebar') return sidebar; return undefined },
    inject(services, callback) { callback({ betterSidebar: sidebar, jobs, effect(fn) { fn(); return () => {} } }) }
  }
  exports.apply(ctx)
  assert.equal(opened, 0)
})
