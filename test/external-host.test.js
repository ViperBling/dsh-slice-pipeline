import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPipelineTool } from '../lib/pipeline-tool.js'
import { readConfig } from '../lib/config.js'
import { ROLES, fakeModules } from './helpers/fixtures.js'

const ROOT = join(process.cwd())
const SCRIPT = join(ROOT, 'skills', 'slice-pipeline', 'slice-pipeline.js')

function toolWith(config) {
  const engine = { start: () => { throw new Error('engine must not start') } }
  return createPipelineTool({
    pluginRoot: ROOT,
    getConfig: () => readConfig(config),
    engine,
    resolve: async () => Object.fromEntries(Object.entries(fakeModules()).map(([key, value]) => [key, { ...value, missing: [] }])),
    readScript: async () => readFile(SCRIPT, 'utf8'),
    logger: { warn() {} }
  }).definition
}

const CONTEXT = { repoRoot: 'C:/w', outDir: 'C:/w/AIOut/t', taskName: 't' }
const EXEC = { agent: { id: 'a1' } }
const PLAN = {
  summary: 's', interfaceContract: 'c',
  slices: [{ id: 'S1', title: 'T1', scope: 'x', acceptance: 'a', research: { symbols: [], files: [], forbidden: [], verify: [] } }]
}

test('external designer enabled rejects plain design without render/code two-step', async () => {
  const tool = toolWith({
    externalAgents: { designer: { enabled: true, cli: 'claude', model: '' } }
  })
  await assert.rejects(
    () => tool.execute({ mode: 'design', requirement: 'r', discussionDigest: 'd', ...CONTEXT }, EXEC),
    /renderDesign/
  )
})

test('external agent config rejects batch modes instead of silently using DSH', async () => {
  const tool = toolWith({
    externalAgents: { reviewer: { enabled: true, cli: 'claude', model: '' } }
  })
  await assert.rejects(
    () => tool.execute({ mode: 'plan-only', requirement: 'r', ...CONTEXT }, EXEC),
    /只支持逐阶段/
  )
})

test('review refuses a patch whose added lines leak the slice id/title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-leak-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(docPath, '# 薄文档')
    await writeFile(patchPath, [
      'diff --git a/lib/x.js b/lib/x.js',
      '--- a/lib/x.js',
      '+++ b/lib/x.js',
      '@@ -1 +1,2 @@',
      '+// S1: 这是本片改动',
      '+const value = 1'
    ].join('\n'))
    const tool = toolWith({})
    await assert.rejects(
      () => tool.execute({
        mode: 'review', planFile, sliceId: 'S1', round: 1, userFeedback: '',
        patchPath, docPath, outDir,
        impl: { sliceId: 'S1', patchPath, docPath, verifyResult: 'exit 0' },
        preflight: 'exit 0', renderReview: true, ...CONTEXT, outDir
      }, EXEC),
      /patch 新增行包含切片信息/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('slice-leak gate does not flag a longer identifier sharing the slice prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-prefix-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(docPath, '# 薄文档')
    await writeFile(patchPath, [
      'diff --git a/lib/x.js b/lib/x.js',
      '--- a/lib/x.js',
      '+++ b/lib/x.js',
      '@@ -1 +1,2 @@',
      '+const S10 = 1',
      '+const value = 2'
    ].join('\n'))
    const tool = toolWith({})
    await assert.rejects(
      () => tool.execute({
        mode: 'review', planFile, sliceId: 'S1', round: 1, userFeedback: '',
        patchPath, docPath, outDir,
        impl: { sliceId: 'S1', patchPath, docPath, verifyResult: 'exit 0' },
        preflight: 'exit 0', renderReview: true, ...CONTEXT, outDir
      }, EXEC),
      /engine must not start/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('incremental review still applies the slice-leak gate to the delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-delta-leak-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await mkdir(join(outDir, 'reviews'), { recursive: true })
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(docPath, '# 薄文档')
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n')
    await writeFile(join(outDir, 'reviews', 'S1-review-r1.json'), JSON.stringify({
      round: 1, sliceId: 'S1',
      codeReview: { verdict: 'revise', findings: [{ severity: 'red', file: 'lib/x.js', line: '1', issue: 'i', fix: 'f', evidence: 'e' }], standardPath: 'x' }
    }))
    const deltaPath = join(outDir, 'S1-fix-r1.patch')
    await writeFile(deltaPath, [
      'diff --git a/lib/x.js b/lib/x.js',
      '--- a/lib/x.js',
      '+++ b/lib/x.js',
      '@@ -1 +1,2 @@',
      '+// S1: 本片修复',
      '+const value = 1'
    ].join('\n'))
    const tool = toolWith({})
    await assert.rejects(
      () => tool.execute({
        mode: 'review', planFile, sliceId: 'S1', round: 2, userFeedback: 'u',
        reviewScope: 'incremental',
        patchPath, docPath, outDir,
        impl: {
          sliceId: 'S1', patchPath, docPath, verifyResult: 'exit 0',
          filesChanged: 'lib/x.js', fixDeltaPath: deltaPath
        },
        preflight: 'exit 0', renderReview: true, ...CONTEXT, outDir
      }, EXEC),
      /patch 新增行包含切片信息/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('review accepts a clean patch without slice metadata', async () => {  const dir = await mkdtemp(join(tmpdir(), 'slice-clean-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(docPath, '# 薄文档')
    await writeFile(patchPath, [
      'diff --git a/lib/x.js b/lib/x.js',
      '--- a/lib/x.js',
      '+++ b/lib/x.js',
      '@@ -1 +1,2 @@',
      '+// 缓存未命中时回源',
      '+const value = 1'
    ].join('\n'))
    const tool = toolWith({})
    // 走到 engine 前说明 leak gate 已通过；engine 抛错是可接受的边界。
    await assert.rejects(
      () => tool.execute({
        mode: 'review', planFile, sliceId: 'S1', round: 1, userFeedback: '',
        patchPath, docPath, outDir,
        impl: { sliceId: 'S1', patchPath, docPath, verifyResult: 'exit 0' },
        preflight: 'exit 0', renderReview: true, ...CONTEXT, outDir
      }, EXEC),
      /engine must not start/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('codeDesign reads the external result file before starting the workflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-code-design-'))
  try {
    const outDir = dir
    const externalDir = join(outDir, 'external')
    await mkdir(externalDir, { recursive: true })
    const resultPath = join(externalDir, 'designer-1.json')
    const plan = {
      summary: 's', interfaceContract: 'c',
      slices: [{ id: 'S1', title: 'T1', scope: 'x', acceptance: 'a', research: { symbols: [], files: [], forbidden: [], verify: [] } }]
    }
    await writeFile(resultPath, JSON.stringify(plan))
    const tool = toolWith({})
    await assert.rejects(
      () => tool.execute({
        mode: 'design', requirement: 'r', discussionDigest: 'd',
        codeDesign: { resultPath }, ...CONTEXT, outDir
      }, EXEC),
      /engine must not start/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renderReview marks the task book external and omits payload-write instructions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-external-review-'))
  try {
    const outDir = dir
    const patchPath = join(dir, 'S1.patch')
    const docPath = join(dir, 'S1.md')
    const planFile = join(dir, 'plan.json')
    await writeFile(planFile, JSON.stringify(PLAN))
    await writeFile(docPath, '# 薄文档')
    await writeFile(patchPath, 'diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1,2 @@\n+const value = 1\n')
    const tool = toolWith({ externalAgents: { reviewer: { enabled: true, cli: 'claude', model: '' } } })
    await assert.rejects(
      () => tool.execute({
        mode: 'review', planFile, sliceId: 'S1', round: 1, userFeedback: '',
        patchPath, docPath, outDir,
        impl: { sliceId: 'S1', patchPath, docPath, verifyResult: 'exit 0' },
        preflight: 'exit 0', renderReview: true, ...CONTEXT, outDir
      }, EXEC),
      /engine must not start/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
