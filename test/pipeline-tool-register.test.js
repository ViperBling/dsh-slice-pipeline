import test from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from '../lib/config.js'
import { registerPipelineTool, pipelineToolStatus } from '../lib/pipeline-tool.js'

const fakeEngine = () => ({ start: () => { throw new Error('engine must not start during registration') } })

function fakeContext(engine) {
  const registered = []
  const ctx = {
    registered,
    disposed: 0,
    logger: { warn() {} },
    get(name) {
      if (name === 'workflowEngine') return engine
      return undefined
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => { ctx.disposed += 1 }
      }
    }
  }
  return ctx
}

function assertNoRequiredFlags(node, path = '$') {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((value, index) => assertNoRequiredFlags(value, `${path}[${index}]`))
    return
  }
  assert.notEqual(typeof node.required, 'boolean', `${path}.required must not be a boolean`)
  for (const [key, value] of Object.entries(node)) {
    assertNoRequiredFlags(value, `${path}.${key}`)
  }
}

test('registers one canonical tool when tools and workflowEngine are present', () => {
  const ctx = fakeContext(fakeEngine())
  const dispose = registerPipelineTool(ctx, {
    pluginRoot: '/p', getConfig: () => readConfig({})
  })

  assert.equal(ctx.registered.length, 1)
  const definition = ctx.registered[0]
  assert.equal(definition.name, 'slice_pipeline_run')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(Array.isArray(definition.parameters.required), true)
  assert.ok(definition.parameters.required.includes('mode'))
  assert.equal(definition.parameters.additionalProperties, false)
  assert.equal(definition.output.schema.oneOf.length, 3)
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output.render, 'function')
  assertNoRequiredFlags(definition)

  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(ctx.disposed, 1)
})

test('skips registration and returns a no-op disposer without a workflow engine', () => {
  const ctx = fakeContext(undefined)
  const dispose = registerPipelineTool(ctx, {
    pluginRoot: '/p', getConfig: () => readConfig({})
  })

  assert.equal(ctx.registered.length, 0)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
  assert.equal(ctx.disposed, 0)
})

test('apply wires the pipeline registration behind tools and workflowEngine', async () => {
  const { apply } = await import('../lib/index.js')
  const registered = []
  let servicesSeen
  let effectLabel
  const ctx = {
    skills: {
      registerProvider(create) {
        create({ invalidate() {} })
        return () => {}
      }
    },
    on() { return () => {} },
    inject(services, callback) {
      if (services[0] !== 'tools') return
      servicesSeen = services
      callback({
        get: (name) => (name === 'workflowEngine' ? fakeEngine() : undefined),
        logger: { warn() {} },
        tools: {
          register(definition) {
            registered.push(definition)
            return () => {}
          }
        },
        effect(create, label) {
          effectLabel = label
          create()
        }
      })
    },
    logger: { warn() {} }
  }

  await apply(ctx, {})

  assert.deepEqual(servicesSeen, ['tools', 'workflowEngine'])
  assert.equal(effectLabel, 'dsh-slice-pipeline: pipeline tool')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'slice_pipeline_run')
})

test('successful registration records an ok tool status', () => {
  const ctx = fakeContext(fakeEngine())
  registerPipelineTool(ctx, { pluginRoot: '/p', getConfig: () => readConfig({}) })

  const status = pipelineToolStatus()
  assert.equal(status.ok, true)
  assert.equal(status.reason, 'registered')
})

test('a throwing tool registry yields a no-op disposer and records the failure reason', () => {
  const ctx = fakeContext(fakeEngine())
  ctx.tools.register = () => { throw new Error('registry boom') }

  const dispose = registerPipelineTool(ctx, { pluginRoot: '/p', getConfig: () => readConfig({}) })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
  const status = pipelineToolStatus()
  assert.equal(status.ok, false)
  assert.match(status.reason, /registry boom/)
})
