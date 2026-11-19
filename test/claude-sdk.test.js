import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createClaudeRunner, readClaudeModelOptions, sdkInstallArgs } from '../lib/claude-sdk.js'

function fakeQuery(captured) {
  return (input) => {
    captured.input = input
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'sonnet' }
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '先看调用链' },
            { type: 'text', text: '结论' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }
          ]
        }
      }
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] }
      }
      yield {
        type: 'result', subtype: 'success', result: 'done',
        structured_output: { verdict: 'pass' },
        usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01
      }
    })()
  }
}

test('Claude runner uses strict read-only options and forwards structured output', async () => {
  const captured = {}
  const events = []
  const runner = createClaudeRunner({
    dshHome: 'C:/nope',
    version: '0.3.287',
    prepareSdk: async () => 'C:/sdk/sdk.mjs',
    loadQuery: async () => fakeQuery(captured)
  })
  const result = await runner({
    prompt: 'p', schema: { type: 'object' }, cwd: 'C:/repo', showThinking: true,
    onEvent: (event) => events.push(event)
  })
  assert.deepEqual(result.structuredOutput, { verdict: 'pass' })
  assert.equal(result.model, 'sonnet')
  assert.equal(result.configuredModel, null)
  assert.equal(captured.input.options.settingSources.length, 0)
  assert.equal(captured.input.options.model, undefined)
  assert.equal(captured.input.options.maxTurns, 120)
  assert.ok(captured.input.options.disallowedTools.includes('Write'))
  assert.ok(captured.input.options.disallowedTools.includes('Edit'))
  const allowRead = await captured.input.options.canUseTool('Read', { file_path: 'a.md' })
  assert.equal(allowRead.behavior, 'allow')
  const denyBash = await captured.input.options.canUseTool('Bash', { command: 'rm -rf x' })
  assert.equal(denyBash.behavior, 'deny')
  const allowBash = await captured.input.options.canUseTool('Bash', { command: 'codegraph query Foo' })
  assert.equal(allowBash.behavior, 'allow')
  assert.ok(events.some((event) => event.t === 'thinking' && event.text.includes('调用链')))
  assert.ok(events.some((event) => event.t === 'tool' && event.status === 'start'))
  assert.ok(events.some((event) => event.t === 'tool' && event.status === 'end'))
  assert.ok(events.some((event) => event.t === 'done' && event.status === 'completed'))
  assert.deepEqual(events.find((event) => event.t === 'done').structured, { verdict: 'pass' })
})

test('Claude runner fails when the SDK yields no structured output', async () => {
  const runner = createClaudeRunner({
    dshHome: 'C:/nope',
    prepareSdk: async () => 'C:/sdk/sdk.mjs',
    loadQuery: async () => (input) => (async function* () {
      yield { type: 'result', subtype: 'success', result: 'text only' }
    })()
  })
  await assert.rejects(() => runner({ prompt: 'p', schema: { type: 'object' }, cwd: 'C:/repo' }), /structured_output/)
})
test('readClaudeModelOptions lists native aliases and resolved model ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-settings-'))
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      model: 'sonnet',
      env: {
        ANTHROPIC_MODEL: 'deepseek-v4.1-flash[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4.1-flash[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4.1-flash[1m]',
        ANTHROPIC_AUTH_TOKEN: 'must-not-leak'
      }
    }))
    const catalog = readClaudeModelOptions({ CLAUDE_CONFIG_DIR: dir })
    const values = catalog.options.map((option) => option.value)
    assert.ok(values.includes(''))
    assert.ok(values.includes('sonnet'))
    assert.ok(values.includes('opus'))
    assert.ok(values.includes('claude-opus-5-5'))
    assert.equal(catalog.options.some((option) => option.label.includes('must-not-leak')), false)
    assert.equal(catalog.current.aliases.opus, 'claude-opus-5-5')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Claude runner accepts JSON text when a proxy omits structured_output', async () => {
  const runner = createClaudeRunner({
    dshHome: 'C:/nope',
    prepareSdk: async () => 'C:/sdk/sdk.mjs',
    loadQuery: async () => (input) => (async function* () {
      yield { type: 'result', subtype: 'success', result: '```json\n{"ok":true}\n```' }
    })()
  })
  const result = await runner({ prompt: 'p', schema: { type: 'object' }, cwd: 'C:/repo' })
  assert.deepEqual(result.structuredOutput, { ok: true })
})

test('SDK install keeps a spaced home path as one npm argument', () => {
  const root = 'C:\\Users\\John Doe\\.dsh\\slice-pipeline\\claude-sdk\\0.3.287'
  const args = sdkInstallArgs({ root })
  const prefix = args[args.indexOf('--prefix') + 1]
  if (process.platform === 'win32') assert.ok(prefix.startsWith('"') && prefix.endsWith('"'), prefix)
  else assert.equal(prefix, root)
  assert.ok(args.includes('@anthropic-ai/claude-agent-sdk@0.3.287'))
})
