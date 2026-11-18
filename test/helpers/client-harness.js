const clientUrl = new URL('../../lib/client.js', import.meta.url).href
let loadSeq = 0
let stateWrites = []

function flatten(items) {
  return items.flat(Infinity)
}

function createReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flatten(children) }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useState(initial) {
      return [initial, (value) => { stateWrites.push(value) }]
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {}
  }
}

function render(node) {
  if (Array.isArray(node)) return node.flatMap(render)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props || {}))
  return {
    type: node.type,
    props: node.props || {},
    children: flatten((node.children || []).map(render))
  }
}

function findField(node, id) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findField(child, id)
      if (found) return found
    }
    return null
  }
  if (node.props && node.props['data-field'] === id) return node
  return findField(node.children || [], id)
}

function collectText(node, out) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return
  }
  if (typeof node === 'object') collectText(node.children || [], out)
}

export async function loadClientHarness() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) { captured = definition }
    }
  }
  const url = clientUrl + '?t=' + Date.now() + '&n=' + (loadSeq++)
  await import(url)
  if (!captured) throw new Error('client.js did not register a ModuleLoader definition')
  const react = createReact()
  const exports = captured.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })

  function mount(value, revision = 1) {
    const writes = stateWrites = []
    const mutations = []
    const registration = {}
    const form = {
      getSnapshot: () => ({ status: 'ready', value, revision }),
      subscribe: () => () => {},
      mutate: async (ops) => { mutations.push(ops); return true }
    }
    const ctx = {
      configForms: { get: () => form },
      slots: {
        inject(name, fn) { registration.slot = name; return fn() },
        register(def, Component) { registration.def = def; registration.Component = Component; return () => {} }
      },
      remote: {
        session: { modelCatalog: async () => {} },
        $on: () => () => {}
      },
      on: () => () => {}
    }
    exports.apply(ctx)
    const tree = render({ type: registration.Component, props: {}, children: [] })
    return {
      tree,
      registration,
      mutations,
      stateWrites: writes,
      byField: (id) => findField(tree, id),
      text: () => {
        const out = []
        collectText(tree, out)
        return out.join('')
      }
    }
  }

  return { exports, mount }
}
