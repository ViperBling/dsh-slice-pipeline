// dsh-tui settings section for the slice-pipeline plugin.
//
// The section is kept out of lib/index.js so the host entry stays a thin
// plugin entry point; tests can exercise the field builders directly.
import { MODULE_DEFS, MODULE_KEYS, ROLE_KEYS, getConfigPath } from './config.js'
import { cleanPathInput, isContentLike } from './paths.js'

export const PATH_HINT = '相对插件根目录或绝对路径；内容请直接编辑文件。'
export const LEGACY_CONTENT_HINT = '检测到旧版内容型配置，已改用默认文件；请改为文件路径。'

/**
 * Collect every live DSH provider/model pair, with its route-level reasoning
 * effort when the adapter exposes one.
 * @param ctx - plugin context.
 * @returns flat select options labelled `Provider / Model · effort`.
 */
export async function collectRouteOptions(ctx) {
  const llm = ctx.get('llm')
  if (!llm) return []
  const options = []
  let providers = []
  try {
    providers = llm.listProviders()
  } catch {
    return []
  }
  for (const provider of providers) {
    let models = []
    try {
      models = await llm.listModels(provider.id)
    } catch {
      models = []
    }
    for (const model of models) {
      let effort = ''
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        const reasoning = info?.reasoning
        if (reasoning?.defaultEffort) effort = ' · ' + reasoning.defaultEffort
        else if (Array.isArray(reasoning?.efforts) && reasoning.efforts.length > 0) effort = ' · ' + reasoning.efforts[0].id
      } catch {
        // Effort is display-only here; a failed lookup must not hide the route.
      }
      options.push({
        value: provider.id + '/' + model.id,
        label: (provider.name || provider.id) + ' / ' + (model.name || model.id) + effort
      })
    }
  }
  return options
}

function roleFields(routeOptions, config) {
  return ROLE_KEYS.map((role) => {
    const options = routeOptions.slice()
    const current = config.roles?.[role]
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: current + '（当前配置，未检测到）' })
    }
    if (options.length === 0) options.push({ value: '', label: '（未检测到可用 provider/model）' })
    return {
      path: ['roles', role],
      label: role === 'default' ? '默认角色模型' : role + ' 模型',
      hint: '选择 DSH 已配置的 provider/model；effort 由该 provider 路由的 reasoning 默认值决定。',
      kind: 'select',
      options
    }
  })
}

function stageFields() {
  const fields = []
  for (const stage of ['plan', 'slice']) {
    fields.push({
      path: ['stages', stage],
      label: stage + ' 阶段（逗号分隔）',
      kind: 'text',
      placeholder: stage === 'plan'
        ? 'design（planReview 已归档，不可启用）'
        : 'brief, implement, codeReview, fix（briefReview 已归档）',
      format(value) {
        return Array.isArray(value) ? value.join(', ') : ''
      },
      parse(text) {
        return {
          kind: 'set',
          value: String(text).split(',').map((item) => item.trim()).filter(Boolean)
        }
      }
    })
  }
  fields.push({
    path: ['maxFixRounds'],
    label: '最大修订轮数',
    hint: '0 表示禁用 fix 阶段。',
    kind: 'number'
  })
  return fields
}

function pathField(group, doc, config) {
  const value = getConfigPath(config, doc.configPath)
  const legacy = typeof value === 'string' && isContentLike(value)
  return {
    path: doc.configPath,
    label: doc.label,
    kind: 'text',
    group,
    placeholder: doc.defaultPath,
    hint: legacy ? LEGACY_CONTENT_HINT : PATH_HINT,
    format(text) {
      return typeof text === 'string' && isContentLike(text) ? '' : text
    },
    parse(text) {
      const raw = typeof text === 'string' ? text : ''
      if (raw.includes('\r') || raw.includes('\n')) return undefined
      const cleaned = cleanPathInput(raw)
      if (!cleaned) return { kind: 'clear' }
      return { kind: 'set', value: cleaned }
    }
  }
}

function moduleFields(config) {
  const fields = []
  for (const key of MODULE_KEYS) {
    const def = MODULE_DEFS[key]
    fields.push({ path: ['modules', key, 'enabled'], label: '启用', kind: 'boolean', group: key })
    if (def.role !== null) {
      fields.push({
        path: ['modules', key, 'role'],
        label: '派发角色',
        kind: 'select',
        group: key,
        options: ROLE_KEYS.map((role) => ({
          value: role,
          label: role + '（' + config.roles[role] + '）'
        }))
      })
    }
    for (const doc of Object.values(def.docs)) {
      if (doc.configPath !== null) fields.push(pathField(key, doc, config))
    }
  }
  return fields
}

export function buildTuiSection(routeOptions, config) {
  return {
    ns: 'dsh-slice-pipeline',
    title: 'Slice Pipeline',
    groups: MODULE_KEYS.map((key) => ({ id: key, title: MODULE_DEFS[key].title, mode: 'page' })),
    fields: [...roleFields(routeOptions, config), ...stageFields(), ...moduleFields(config)]
  }
}

/**
 * Register (and keep fresh) the dsh-tui settings section.
 * Returns a disposer; callers normally wrap it in `ctx.effect`.
 * @param ctx - plugin context.
 * @param tuiSettings - `ctx.tuiSettingsSections` service.
 * @param getConfig - returns the current resolved plugin config.
 * @returns disposer that unregisters the section and its listeners.
 */
export function registerTuiSettings(ctx, tuiSettings, getConfig) {
  let dispose
  let generation = 0
  const refresh = async () => {
    const current = ++generation
    const routeOptions = await collectRouteOptions(ctx)
    if (current !== generation) return
    dispose?.()
    dispose = tuiSettings.register(buildTuiSection(routeOptions, getConfig()))
  }
  const report = (error) => {
    ctx.logger?.warn?.('dsh-slice-pipeline: failed to refresh TUI settings: ' + String(error))
  }
  refresh().catch(report)
  const offLlm = ctx.on('llm/adapters-updated', () => {
    refresh().catch(report)
  })
  const offVolatile = ctx.on('loader/volatile-update', () => {
    refresh().catch(report)
  })
  return () => {
    generation++
    offLlm?.()
    offVolatile?.()
    dispose?.()
  }
}
