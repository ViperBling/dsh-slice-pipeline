import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_MODULES } from '../lib/config.js'

const DOCS_ROOT = fileURLToPath(new URL('../docs/', import.meta.url))
// Runtime docs only; docs/superpowers/** holds design/plan documents and is intentionally excluded.
const DOCS = [
  'INDEX.md', 'planning/standard.md', 'patch-delivery/standard.md', 'patch-delivery/thin-document-template.md',
  'workspace-recovery/standard.md', 'review/review-standard.md', 'review/review-dispatch.md', 'diagrams/standard.md',
  'shared/dispatch-guide.md', 'shared/plain-language.md', 'global-agents-entry.md'
]
const RULES = JSON.parse(readFileSync(new URL('./fixtures/rule-anchors.json', import.meta.url), 'utf8'))
const readDoc = (rel) => readFileSync(path.join(DOCS_ROOT, rel), 'utf8')
const existsDoc = (rel) => existsSync(path.join(DOCS_ROOT, rel))

test('every planned doc exists', () => {
  for (const rel of DOCS) assert.ok(existsDoc(rel), `missing docs/${rel}`)
})

test('no section sign outside INDEX.md', () => {
  for (const rel of DOCS) {
    if (rel === 'INDEX.md') continue
    assert.equal(readDoc(rel).includes('§'), false, `unexpected § in docs/${rel}`)
  }
})

test('no stale draft references', () => {
  const stale = /development-guide\.md|diagram-guide\.md|同目录|~\/\.dsh\/AGENTS\.md 第|~\/\.dsh\/model-roles\.yml|落盘时回写/
  for (const rel of DOCS) assert.doesNotMatch(readDoc(rel), stale, `stale reference in docs/${rel}`)
})

test('relative markdown links resolve', () => {
  const link = /\]\((?!https?:|#)([^)#]+)(#[^)]*)?\)/g
  for (const rel of DOCS) {
    const fromDir = path.dirname(path.join(DOCS_ROOT, rel))
    for (const match of readDoc(rel).matchAll(link)) {
      const target = match[1].trim()
      assert.ok(existsSync(path.resolve(fromDir, target)), `${rel} -> ${target}`)
    }
  }
})

test('every rule anchor lands in its expected doc', () => {
  // 锚点比对忽略行内代码的反引号与空白：规范里把 `.h` / `.hpp` 写成行内代码是允许的，
  // 规则文本本身不该因为一次排版调整就被判定为丢失。
  const squash = (value) => value.replace(/[`\s]/g, '')
  for (const { anchor, files } of RULES) {
    for (const file of files) {
      assert.ok(squash(readDoc(file)).includes(squash(anchor)), `missing "${anchor}" in docs/${file}`)
    }
  }
})

test('global entry template fits 3,500 bytes and routes all six skills', () => {
  const text = readDoc('global-agents-entry.md')
  assert.ok(Buffer.byteLength(text) <= 3500, 'global-agents-entry.md exceeds 3,500 bytes')
  for (const skill of Object.keys(SKILL_MODULES)) {
    assert.ok(text.includes('`' + skill + '`'), `global entry does not route ${skill}`)
  }
})

test('reviewer runtime spec stays compact and keeps the findings language rule', () => {
  const text = readDoc('review/review-standard.md')
  assert.ok(Buffer.byteLength(text) <= 12000, `review-standard.md is ${Buffer.byteLength(text)} bytes (limit 12000)`)
  assert.match(text, /现象/, 'runtime spec must keep the findings language rule')
  assert.match(text, /建议/, 'runtime spec must keep the findings language rule')
  assert.doesNotMatch(text, /sandbox_permissions/, 'dispatch/tool rules belong in review-dispatch.md')
})
