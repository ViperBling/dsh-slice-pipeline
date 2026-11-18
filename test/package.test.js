import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('package metadata', () => {
  assert.equal(pkg.version, '0.12.0')
  assert.match(pkg.description, /6 个可配置 Skill/)
  assert.equal(pkg.scripts?.test, 'node --test "test/**/*.test.js"')
  assert.deepEqual(pkg.files, [
    'lib', 'skills', 'docs/INDEX.md', 'docs/global-agents-entry.md',
    'docs/planning', 'docs/patch-delivery', 'docs/workspace-recovery',
    'docs/review', 'docs/diagrams', 'docs/shared',
    'cordis.patch.yml', 'README.md', 'LICENSE'
  ])
  assert.ok(pkg.files.includes('docs/review'))
  assert.ok(!pkg.files.some((file) => file.includes('superpowers')))
})

test('README documents six skills, modules and migration', () => {
  const readme = read('README.md')
  for (const skill of [
    'slice-pipeline', 'slice-planning', 'slice-patch-delivery',
    'slice-workspace-recovery', 'slice-review', 'slice-diagrams'
  ]) {
    assert.ok(readme.includes(skill), `README must mention ${skill}`)
  }
  for (const term of [
    'modules', '迁移到新机器', 'global-agents-entry.md', '~/.dsh/AGENTS.md',
    '回滚', 'plugin-0.2.0', 'reviewStandard', 'reviewDispatch', 'review-standard.md'
  ]) {
    assert.ok(readme.includes(term), `README must mention ${term}`)
  }
  assert.match(readme, /dsh-tui/)
  assert.match(readme, /Desktop|desktop/)
})

test('fallback templates no longer claim to be the source of truth', () => {
  const header = '回退模板：只在 skill 没有注入插件配置时使用；真源是 dsh-slice-pipeline 插件设置（阶段使用的角色由功能模块决定）'
  for (const rel of ['skills/slice-pipeline/pipeline.yml', 'skills/slice-pipeline/model-roles.example.yml']) {
    const text = read(rel)
    assert.ok(text.includes(header), `${rel} must carry the fallback header`)
    assert.equal(text.includes('单一真源'), false, `${rel} must not claim 单一真源`)
    assert.equal(text.includes('~/.dsh/model-roles.yml'), false, `${rel} must not cite ~/.dsh/model-roles.yml`)
  }
})
