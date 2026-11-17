import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_MODULES, readConfig } from '../lib/config.js'
import { MODULE_HEADING, PIPELINE_HEADING } from '../lib/inject.js'
import { createSkillProvider } from '../lib/skills.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SKILLS_DIR = join(ROOT, 'skills')
const PIPELINE_DIR = join(SKILLS_DIR, 'slice-pipeline')
const SKILLS = Object.keys(SKILL_MODULES).sort()
const PIPELINE_FILES = [
  'SKILL.md', 'model-roles.example.yml', 'pipeline.yml', 'review-standard.md', 'slice-pipeline.js'
]
const STALE_DRAFTS = /development-guide\.md|(?<!shared\/)dispatch-guide\.md|diagram-guide\.md|~\/\.dsh\/model-roles\.yml/

const readSkill = (name) => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')

/** The injected block is appended last; a body may also quote the heading by name. */
const injectedBlock = (content, heading) => content.slice(content.lastIndexOf(heading))

/** Count content lines, ignoring one trailing newline. */
function lineCount(text) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length
}

function parseFrontmatter(text) {
  assert.ok(text.startsWith('---\n'), 'SKILL.md must open with a frontmatter block')
  const end = text.indexOf('\n---', 3)
  assert.notEqual(end, -1, 'frontmatter block must be closed')
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const keys = []
  const metadata = {}
  for (const line of block.split('\n')) {
    if (!line.trim()) continue
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    assert.ok(match, `unparseable frontmatter line: ${line}`)
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    keys.push(match[1])
    metadata[match[1]] = value
  }
  return { keys, metadata, body }
}

test('skills dir holds exactly the six module skills', () => {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(dirs, SKILLS)
})

test('frontmatter names match dirs; only the three scalar keys; values single-line', () => {
  for (const name of SKILLS) {
    const { keys, metadata } = parseFrontmatter(readSkill(name))
    assert.deepEqual(keys.slice().sort(), ['description', 'name', 'whenToUse'], `${name} frontmatter keys`)
    assert.equal(metadata.name, name)
    for (const key of ['name', 'description', 'whenToUse']) {
      assert.ok(metadata[key].length > 0, `${name}: empty ${key}`)
    }
  }
})

test('line budgets', () => {
  for (const name of SKILLS) {
    const limit = name === 'slice-pipeline' ? 100 : 80
    const lines = lineCount(readSkill(name))
    assert.ok(lines <= limit, `${name}/SKILL.md has ${lines} lines (limit ${limit})`)
  }
})

test('description + whenToUse budgets', () => {
  let total = 0
  for (const name of SKILLS) {
    const { metadata } = parseFrontmatter(readSkill(name))
    const bytes = Buffer.byteLength(metadata.description) + Buffer.byteLength(metadata.whenToUse)
    assert.ok(bytes <= 400, `${name}: description + whenToUse = ${bytes} bytes (limit 400)`)
    total += bytes
  }
  assert.ok(total <= 2400, `six skills total ${total} bytes (limit 2400)`)
})

test('no SKILL cites removed drafts or the old role file', () => {
  for (const name of SKILLS) {
    const { body } = parseFrontmatter(readSkill(name))
    assert.doesNotMatch(body, STALE_DRAFTS, `${name} cites a removed draft or role file`)
  }
})

test('slice-pipeline dir keeps runtime files and a short redirect', () => {
  assert.deepEqual(readdirSync(PIPELINE_DIR).sort(), PIPELINE_FILES)
  const redirect = readFileSync(join(PIPELINE_DIR, 'review-standard.md'), 'utf8')
  assert.ok(lineCount(redirect) <= 10, `review-standard.md redirect has ${lineCount(redirect)} lines`)
  assert.ok(redirect.includes('docs/review/review-standard.md'), 'redirect points at docs/review/review-standard.md')
})

test('real plugin: six skills, all modules ok, blocks within budget', async () => {
  const provider = createSkillProvider({
    name: 'dsh-slice-pipeline', pluginRoot: ROOT, getConfig: () => readConfig({})
  })
  const list = await provider.list({})
  assert.equal(list.length, 6)
  assert.deepEqual(list.map((candidate) => candidate.name).sort(), SKILLS)
  for (const candidate of list) {
    const skill = await provider.get(candidate, {})
    if (candidate.name === 'slice-pipeline') {
      const json = skill.content.split(PIPELINE_HEADING).at(-1).match(/```json\n([\s\S]*?)\n```/)
      assert.ok(json, 'pipeline block must embed a json args block')
      for (const [key, module] of Object.entries(JSON.parse(json[1]).modules)) {
        assert.equal(module.status, 'ok', `pipeline module ${key}`)
      }
      const block = injectedBlock(skill.content, PIPELINE_HEADING)
      assert.ok(Buffer.byteLength(block) <= 3500, `pipeline block is ${Buffer.byteLength(block)} bytes`)
    } else {
      assert.ok(skill.content.includes('状态：ok'), `${candidate.name} must report 状态：ok`)
      assert.equal(skill.content.includes('状态：missingDoc'), false, `${candidate.name} reports missingDoc`)
      const block = injectedBlock(skill.content, MODULE_HEADING)
      assert.ok(lineCount(block) <= 15, `${candidate.name} block has ${lineCount(block)} lines`)
      assert.ok(Buffer.byteLength(block) <= 1500, `${candidate.name} block is ${Buffer.byteLength(block)} bytes`)
    }
  }
})

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('pipeline SKILL documents the tool-first path and keeps the fallback constraints', () => {
  const body = read('skills/slice-pipeline/SKILL.md')
  for (const needle of [
    'slice_pipeline_run', '不要读脚本', '不要读注入的 args JSON 来拼工具参数',
    '禁止改写、简化或重排脚本', 'run_in_background', 'skill_resources', '禁止 find /'
  ]) {
    assert.ok(body.includes(needle), needle)
  }
  const toolFirst = body.indexOf('## 运行方式（首选）')
  const fallback = body.indexOf('## 手工内联回退')
  assert.ok(toolFirst !== -1 && fallback !== -1 && toolFirst < fallback, '运行方式（首选） must precede 手工内联回退')
  assert.ok(body.split('\n').length <= 101, 'SKILL.md 超过 100 行')
})

test('README and INDEX mention the tool entry', () => {
  const readme = read('README.md')
  assert.match(readme, /slice_pipeline_run/)
  assert.match(readme, /pipeline-tool\.js/)
  assert.match(readme, /tool-schema\.js/)
  assert.match(read('docs/INDEX.md'), /slice_pipeline_run/)
})
