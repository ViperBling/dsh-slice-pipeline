/** Deep-clone plain JSON values so canonicalization never aliases the input. */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]))
  }
  return value
}

function convertProperties(properties) {
  const required = []
  const converted = {}
  for (const [key, spec] of Object.entries(properties ?? {})) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      converted[key] = canonicalizeSchema(spec)
      continue
    }
    const rest = { ...spec }
    if (rest.required === true) {
      required.push(key)
      delete rest.required
    } else if (rest.required === false) {
      delete rest.required
    }
    converted[key] = canonicalizeSchema(rest)
  }
  return { properties: converted, required }
}

/** Convert the author-facing schema dialect into canonical JSON Schema. */
function canonicalizeSchema(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(canonicalizeSchema)
  if (node.type === 'json' && Object.keys(node).length === 1) return {}

  const converted = {}
  let declaredRequired
  let flaggedRequired = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && value === 'json') continue
    if (key === 'required') {
      if (typeof value === 'boolean') continue
      if (Array.isArray(value)) declaredRequired = [...value]
      else converted.required = cloneValue(value)
      continue
    }
    if (key === 'properties') {
      const nested = convertProperties(value)
      converted.properties = nested.properties
      flaggedRequired = nested.required
      continue
    }
    if (key === 'items' || key === 'oneOf') {
      converted[key] = Array.isArray(value)
        ? value.map(canonicalizeSchema)
        : canonicalizeSchema(value)
      continue
    }
    converted[key] = cloneValue(value)
  }

  const required = declaredRequired ?? []
  for (const key of flaggedRequired) {
    if (!required.includes(key)) required.push(key)
  }
  if (required.length > 0) converted.required = required
  return converted
}

export function toCanonicalDefinition(definition) {
  const parameters = convertProperties(definition.parameters)
  return {
    name: definition.name,
    description: definition.description,
    parameters: {
      type: 'object',
      properties: parameters.properties,
      ...(parameters.required.length > 0 ? { required: parameters.required } : {}),
      additionalProperties: false
    },
    output: {
      schema: canonicalizeSchema(definition.output?.schema),
      render: definition.output?.render
    },
    execute: definition.execute
  }
}
