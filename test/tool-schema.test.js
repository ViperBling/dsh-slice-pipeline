import test from 'node:test'
import assert from 'node:assert/strict'
import { toCanonicalDefinition } from '../lib/tool-schema.js'

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

test('canonicalizes the author-facing parameter dialect', () => {
  const execute = async () => {}
  const render = () => []
  const definition = {
    name: 'demo_tool',
    description: 'Demo tool',
    parameters: {
      mode: { type: 'string', required: true, enum: ['plan', 'run'], description: 'Run mode' },
      payload: { type: 'json', required: true },
      optional: { type: 'string', description: 'Not required' }
    },
    output: { schema: { oneOf: [] }, render },
    execute
  }

  const canonical = toCanonicalDefinition(definition)

  assert.equal(canonical.name, 'demo_tool')
  assert.equal(canonical.description, 'Demo tool')
  assert.equal(canonical.execute, execute)
  assert.equal(canonical.output.render, render)
  assert.equal(canonical.parameters.type, 'object')
  assert.equal(canonical.parameters.additionalProperties, false)
  assert.deepEqual(canonical.parameters.required, ['mode', 'payload'])
  assert.deepEqual(canonical.parameters.properties.payload, {})
  assert.deepEqual(canonical.parameters.properties.mode, {
    type: 'string', enum: ['plan', 'run'], description: 'Run mode'
  })
  assertNoRequiredFlags(canonical)
})

test('recurses through properties, items and oneOf and keeps schema keywords', () => {
  const definition = {
    name: 'nested',
    description: 'Nested',
    parameters: {
      config: {
        type: 'object',
        required: true,
        additionalProperties: true,
        properties: {
          name: { type: 'string', required: true, const: 'fixed' },
          nested: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: { flag: { type: 'boolean', required: true } }
          }
        }
      },
      list: {
        type: 'array',
        required: true,
        items: { type: 'object', properties: { id: { type: 'string', required: true } } }
      },
      choice: {
        type: 'object',
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { kind: { type: 'string', required: true, const: 'a' } }
          },
          { type: 'json' }
        ]
      }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string', required: true, const: 'foreground' } }
        }]
      },
      render: () => {}
    },
    execute: async () => {}
  }

  const canonical = toCanonicalDefinition(definition)

  assert.deepEqual(canonical.parameters.required, ['config', 'list'])
  const config = canonical.parameters.properties.config
  assert.equal(config.additionalProperties, true)
  assert.deepEqual(config.required, ['name', 'nested'])
  assert.deepEqual(config.properties.name, { type: 'string', const: 'fixed' })
  assert.equal(config.properties.nested.additionalProperties, false)
  assert.deepEqual(config.properties.nested.required, ['flag'])
  assert.deepEqual(config.properties.nested.properties.flag, { type: 'boolean' })

  const list = canonical.parameters.properties.list
  assert.deepEqual(list.items.required, ['id'])
  assert.deepEqual(list.items.properties.id, { type: 'string' })

  const choice = canonical.parameters.properties.choice
  assert.equal(choice.oneOf[0].additionalProperties, false)
  assert.deepEqual(choice.oneOf[0].required, ['kind'])
  assert.deepEqual(choice.oneOf[1], {})

  assert.equal(canonical.output.schema.oneOf.length, 1)
  assert.deepEqual(canonical.output.schema.oneOf[0].required, ['kind'])
  assertNoRequiredFlags(canonical)
})

test('omits the root required array when no property is required and does not mutate input', () => {
  const definition = {
    name: 'optional',
    description: 'Optional',
    parameters: { value: { type: 'string', required: false } },
    output: { schema: { type: 'json' }, render: () => {} },
    execute: async () => {}
  }
  const before = JSON.parse(JSON.stringify(definition))

  const canonical = toCanonicalDefinition(definition)

  assert.deepEqual(Object.keys(canonical).sort(), ['description', 'execute', 'name', 'output', 'parameters'])
  assert.equal(Object.hasOwn(canonical.parameters, 'required'), false)
  assert.deepEqual(canonical.parameters.properties.value, { type: 'string' })
  assert.deepEqual(canonical.output.schema, {})
  assert.equal(JSON.stringify(definition), JSON.stringify(before))
  assert.equal(definition.output.render, canonical.output.render)
  assert.equal(definition.execute, canonical.execute)
})
