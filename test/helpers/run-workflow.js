import { readFile } from 'node:fs/promises'

const SCRIPT_URL = new URL('../../skills/slice-pipeline/slice-pipeline.js', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const PLAN = {
  summary: 's',
  interfaceContract: 'c',
  slices: [{
    id: 'S1',
    title: 'T1',
    scope: 'x',
    acceptance: 'a',
    discussion: {
      sliceId: 'S1',
      understanding: '本片只落地 S1 的接口增量',
      decisions: [{ topic: '写入范围', decision: '只改 lib/x.js', reason: 'S1 边界内' }],
      openQuestions: [],
      userConfirmed: true
    }
  }]
}

export async function runWorkflow(args, { echo, failLabels = [] } = {}) {
  const source = await readFile(SCRIPT_URL, 'utf8')
  const calls = []
  const logs = []
  const actualEcho = echo ?? args.reviewStandardPath ?? args.modules?.review?.docs?.standard ?? 'none'
  const failing = new Set(failLabels)

  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    const label = typeof opts.label === 'string' ? opts.label : ''
    if (failing.has(label)) return null
    if (label.startsWith('brief-review')) {
      return { alignment: 'aligned', findings: [], standardPath: actualEcho }
    }
    if (label.startsWith('brief')) {
      return { sliceId: 'S1', architecture: 'arch', details: 'det' }
    }
    if (label.startsWith('design')) {
      return PLAN
    }
    if (label.startsWith('plan-review') || label.startsWith('code-review')) {
      return { verdict: 'pass', findings: [], standardPath: actualEcho }
    }
    if (label.startsWith('impl') || label.startsWith('fix')) {
      return { sliceId: 'S1', patchPath: 'p.patch', docPath: 'p.md', verifyResult: 'exit 0' }
    }
    return null
  }

  const phase = () => {}
  const log = (message) => { logs.push(String(message)) }
  const pipeline = async () => { throw new Error('pipeline is not supported by runWorkflow') }
  const parallel = async () => { throw new Error('parallel is not supported by runWorkflow') }
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'pipeline', 'parallel', source)

  try {
    const result = await fn(args, agent, phase, log, pipeline, parallel)
    return { result, error: null, calls, logs }
  } catch (error) {
    return { result: null, error, calls, logs }
  }
}
