// dsh-slice-pipeline: web/desktop settings tab.
//
// Registers one `settings.plugins.tab` page. The page reads the plugin's own
// Host config through `ctx.configForms` and the DSH model catalog through
// `ctx.remote.session.modelCatalog()`, so provider/model choices are the same
// routes the rest of DSH exposes instead of a hardcoded list.
//
// This file is a browser module-loader bundle; it intentionally does not use
// Node APIs.
const PLUGIN_ID = 'dsh-slice-pipeline'
const ROLE_KEYS = ['default', 'designer', 'task', 'reviewer']
const STAGE_KEYS = ['plan', 'slice']

const LEGACY_CONTENT_HINT = '检测到旧版内容型配置，已改用默认文件；请改为文件路径。'
const LEGACY_REVIEW_STANDARD_ALIASES = ['review-standard.md', './review-standard.md']
const REVIEW_STANDARD_ALIAS_NOTE = '旧路径，已自动映射到 docs/review/review-standard.md'
const PATH_HINT = '相对插件根目录，或填写绝对路径；内容请直接编辑文件'

const MODULES = [
  { key: 'pipeline', title: 'Slice Pipeline 流水线', role: null, docs: [] },
  { key: 'planning', title: '规划与切片', role: 'designer', docs: [
    { docKey: 'standard', label: '规范文件', defaultPath: 'docs/planning/standard.md', configPath: ['modules', 'planning', 'standardPath'] }
  ] },
  { key: 'patchDelivery', title: '补丁交付', role: 'task', docs: [
    { docKey: 'standard', label: '规范文件', defaultPath: 'docs/patch-delivery/standard.md', configPath: ['modules', 'patchDelivery', 'standardPath'] },
    { docKey: 'template', label: '薄文档模板', defaultPath: 'docs/patch-delivery/thin-document-template.md', configPath: ['modules', 'patchDelivery', 'templatePath'] }
  ] },
  { key: 'workspaceRecovery', title: '工作区恢复', role: 'default', docs: [
    { docKey: 'standard', label: '规范文件', defaultPath: 'docs/workspace-recovery/standard.md', configPath: ['modules', 'workspaceRecovery', 'standardPath'] }
  ] },
  { key: 'review', title: '审查', role: 'reviewer', docs: [
    { docKey: 'standard', label: '审查运行时规范（reviewer 读取）', defaultPath: 'docs/review/review-standard.md', configPath: ['reviewStandard'] },
    { docKey: 'dispatch', label: '审查派发与闭环规范（Lead 读取）', defaultPath: 'docs/review/review-dispatch.md', configPath: ['reviewDispatch'] }
  ] },
  { key: 'diagrams', title: '制图', role: 'designer', docs: [
    { docKey: 'standard', label: '规范文件', defaultPath: 'docs/diagrams/standard.md', configPath: ['modules', 'diagrams', 'standardPath'] }
  ] }
]

function toSlash(value) {
  return String(value).replaceAll('\\', '/')
}

function cleanPathInput(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text.length >= 2 && (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  )) text = text.slice(1, -1)
  return text.trim()
}

function isContentLike(text) {
  return text.includes('\r') || text.includes('\n') || text.trimStart().startsWith('#') || text.length > 400
}

function pathWriteOps(configPath, text, previousDisplay, stored) {
  const raw = typeof text === 'string' ? text : ''
  const legacyContent = typeof stored === 'string' && isContentLike(stored)
  if (raw === previousDisplay && !(legacyContent && raw === '')) return { ok: true, ops: [] }
  if (raw.includes('\r') || raw.includes('\n')) {
    return { ok: false, error: '路径不能包含换行；规范内容请直接编辑文件。' }
  }
  const cleaned = cleanPathInput(raw)
  if (isContentLike(cleaned)) {
    return { ok: false, error: '路径不能包含换行；规范内容请直接编辑文件。' }
  }
  if (!cleaned) return { ok: true, ops: [{ op: 'unset', path: configPath }] }
  return { ok: true, ops: [{ op: 'set', path: configPath, value: cleaned }] }
}

function describeStoredPath(doc, stored) {
  if (typeof stored !== 'string' || stored === '') return { display: '', note: null }
  if (isContentLike(stored)) return { display: '', note: LEGACY_CONTENT_HINT }
  if (doc?.configPath?.join('.') === 'reviewStandard') {
    const normalized = toSlash(cleanPathInput(stored)).toLowerCase()
    if (LEGACY_REVIEW_STANDARD_ALIASES.some((alias) => toSlash(alias).toLowerCase() === normalized)) {
      return { display: stored, note: REVIEW_STANDARD_ALIAS_NOTE }
    }
  }
  return { display: stored, note: null }
}

function readConfigPath(config, path) {
  return path.reduce((value, key) => value?.[key], config)
}

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    function splitRoute(route) {
      const text = typeof route === 'string' ? route : ''
      const index = text.indexOf('/')
      if (index <= 0) return { provider: text, model: '' }
      return { provider: text.slice(0, index), model: text.slice(index + 1) }
    }

    function joinRoute(provider, model) {
      return provider + (model ? '/' + model : '')
    }

    function providerOptions(groups, current) {
      const options = groups.map((group) => h('option', { key: group.id, value: group.id }, group.name || group.id))
      if (current && !groups.some((group) => group.id === current)) {
        options.unshift(h('option', { key: '__current_provider', value: current }, current))
      }
      if (options.length === 0) options.push(h('option', { key: '__empty_provider', value: '' }, '（未检测到 provider）'))
      return options
    }

    function modelOptions(models, current) {
      const options = models.map((model) => h('option', { key: model.id, value: model.id }, model.name || model.id))
      if (current && !models.some((model) => model.id === current)) {
        options.unshift(h('option', { key: '__current_model', value: current }, current))
      }
      if (options.length === 0) options.push(h('option', { key: '__empty_model', value: '' }, '（该 provider 没有可用模型）'))
      return options
    }

    const styles = {
      box: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '820px', color: 'var(--dsw-alias-label-primary)' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      intro: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      muted: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      card: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      cardTitle: { fontWeight: 600, fontSize: '13px' },
      row: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' },
      label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      select: { minWidth: '240px', height: '32px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '0 8px' },
      input: { height: '32px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '0 8px' },
      textarea: { minHeight: '180px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '8px', fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', whiteSpace: 'pre-wrap' },
      effort: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', paddingBottom: '8px' },
      sectionTitle: { margin: '8px 0 0', fontSize: '14px', fontWeight: 600 },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
    }

    const inject = ['slots', 'remote', 'remote.session', 'configForms']

    function apply(ctx) {
      const form = ctx.configForms.get(PLUGIN_ID)

      function SlicePipelineSettings() {
        const snapshot = React.useSyncExternalStore(
          React.useCallback((listener) => form.subscribe(listener), []),
          React.useCallback(() => form.getSnapshot(), [])
        )
        const [catalog, setCatalog] = React.useState(null)
        const [catalogLoading, setCatalogLoading] = React.useState(true)
        const [catalogError, setCatalogError] = React.useState(null)
        const [draftStages, setDraftStages] = React.useState({ plan: '', slice: '' })
        const [draftMaxFixRounds, setDraftMaxFixRounds] = React.useState('3')
        const [saveError, setSaveError] = React.useState(null)

        const loadCatalog = React.useCallback(async () => {
          setCatalogLoading(true)
          setCatalogError(null)
          try {
            const result = await ctx.remote.session.modelCatalog()
            if (!result || result.ok !== true) {
              throw new Error(result?.error?.message || 'modelCatalog failed')
            }
            setCatalog(result.value)
          } catch (error) {
            setCatalogError(error instanceof Error ? error.message : String(error))
          } finally {
            setCatalogLoading(false)
          }
        }, [])

        React.useEffect(() => {
          loadCatalog()
          const offAdapters = ctx.remote.$on('llm/adapters-updated', loadCatalog)
          const offReset = ctx.on('connection/reset', loadCatalog)
          return () => {
            offAdapters()
            offReset()
          }
        }, [loadCatalog])

        const value = snapshot.value || {}
        const roles = value.roles || {}
        const stages = value.stages || {}
        const maxFixRounds = value.maxFixRounds ?? 3

        React.useEffect(() => {
          setDraftStages({
            plan: Array.isArray(stages.plan) ? stages.plan.join(', ') : '',
            slice: Array.isArray(stages.slice) ? stages.slice.join(', ') : ''
          })
          setDraftMaxFixRounds(String(maxFixRounds))
        }, [snapshot.revision])

        const write = React.useCallback(async (ops) => {
          try {
            const accepted = await form.mutate(ops)
            setSaveError(accepted ? null : '保存被拒绝；请检查配置或权限。')
          } catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error))
          }
        }, [])

        const writeRole = (role, route) => write([{ op: 'set', path: ['roles', role], value: route }])
        const writeEffort = (role, effort) => write([{ op: 'set', path: ['reasoningEfforts', role], value: effort }])
        const writeStage = (stage, text) => {
          const list = String(text).split(',').map((item) => item.trim()).filter(Boolean)
          write([{ op: 'set', path: ['stages', stage], value: list }])
        }
        const writeMaxFixRounds = (text) => {
          const number = Number(text)
          if (!Number.isInteger(number) || number < 0) {
            setSaveError('maxFixRounds 必须是非负整数。')
            return
          }
          write([{ op: 'set', path: ['maxFixRounds'], value: number }])
        }
        const writeModuleEnabled = (key, enabled) => write([{ op: 'set', path: ['modules', key, 'enabled'], value: enabled }])
        const writeModuleRole = (key, role) => write([{ op: 'set', path: ['modules', key, 'role'], value: role }])

        if (snapshot.status === 'unavailable') return h('div', { style: styles.box }, '当前客户端不可写 Slice Pipeline 配置。')
        if (snapshot.status === 'loading' || snapshot.value === undefined) return h('div', { style: styles.box }, '正在读取 Slice Pipeline 配置…')

        const groups = (catalog?.groups || []).filter((group) => Array.isArray(group.models) && group.models.length > 0)
        const roleRows = ROLE_KEYS.map((role) => {
          const route = roles[role] || ''
          let selected = splitRoute(route)
          let group = groups.find((candidate) => candidate.id === selected.provider)
          let models = group?.models || []
          if (!group && groups.length > 0 && !selected.provider) {
            group = groups[0]
            models = group.models || []
            selected = { provider: group.id, model: models[0]?.id || '' }
          }
          if (group && !selected.model) selected.model = group.models?.[0]?.id || ''
          const modelInfo = models.find((model) => model.id === selected.model)
          const defaultEffort = modelInfo?.reasoning?.defaultEffort || '—'
          const effortIds = Array.isArray(modelInfo?.reasoning?.efforts)
            ? modelInfo.reasoning.efforts.map((item) => item && item.id).filter(Boolean)
            : []
          const effortValue = (value.reasoningEfforts || {})[role] || ''
          return h('div', { key: role, style: styles.card },
            h('div', { style: styles.cardTitle }, role),
            h('div', { style: styles.row },
              h('label', { style: styles.label }, 'Provider',
                h('select', {
                  style: styles.select,
                  value: selected.provider,
                  onChange: (event) => {
                    const nextProvider = event.target.value
                    const nextGroup = groups.find((candidate) => candidate.id === nextProvider)
                    const nextModel = nextGroup?.models?.[0]?.id || ''
                    writeRole(role, joinRoute(nextProvider, nextModel))
                  }
                }, providerOptions(groups, selected.provider))
              ),
              h('label', { style: styles.label }, 'Model',
                h('select', {
                  style: styles.select,
                  value: selected.model,
                  onChange: (event) => writeRole(role, joinRoute(selected.provider, event.target.value))
                }, modelOptions(models, selected.model))
              ),
              h('label', { style: styles.label }, 'Reasoning',
                h('select', {
                  style: styles.select,
                  value: effortValue,
                  'data-field': 'reasoningEfforts.' + role,
                  onChange: (event) => writeEffort(role, event.target.value)
                }, [
                  h('option', { key: 'default', value: '' }, '模型默认（' + defaultEffort + '）'),
                  ...effortIds.map((id) => h('option', { key: id, value: id }, id))
                ])
              )
            )
          )
        })

        const moduleRows = MODULES.map((def) => {
          const state = value.modules?.[def.key] || {}
          const enabled = state.enabled ?? true
          const role = def.role === null ? null : state.role ?? def.role
          const children = [
            h('div', { key: 'title', style: styles.cardTitle }, def.title),
            h('label', { key: 'enabled', style: styles.field },
              h('input', {
                type: 'checkbox',
                checked: enabled,
                'data-field': 'modules.' + def.key + '.enabled',
                onChange: (event) => writeModuleEnabled(def.key, event.target.checked)
              }),
              '启用'
            )
          ]
          if (def.role !== null) {
            children.push(h('label', { key: 'role', style: styles.field }, '派发角色',
              h('select', {
                style: styles.select,
                value: role,
                'data-field': 'modules.' + def.key + '.role',
                onChange: (event) => writeModuleRole(def.key, event.target.value)
              }, ROLE_KEYS.map((roleKey) => h('option', { key: roleKey, value: roleKey }, roleKey + '（' + (roles[roleKey] || '') + '）')))
            ))
          }
          for (const doc of def.docs) {
            const fieldId = doc.configPath.join('.')
            const stored = readConfigPath(value, doc.configPath)
            const { display, note } = describeStoredPath(doc, stored)
            children.push(h('label', { key: fieldId, style: styles.field }, doc.label,
              h('input', {
                style: styles.input,
                defaultValue: display,
                key: fieldId + ':' + snapshot.revision,
                placeholder: doc.defaultPath,
                'data-field': fieldId,
                onBlur: (event) => {
                  const result = pathWriteOps(doc.configPath, event.target.value, display, stored)
                  if (!result.ok) setSaveError(result.error)
                  else if (result.ops.length > 0) write(result.ops)
                }
              }),
              h('div', { style: styles.muted }, PATH_HINT),
              note ? h('div', { style: styles.muted }, note) : null
            ))
          }
          return h('div', { key: def.key, 'data-module': def.key, style: styles.card }, ...children)
        })

        return h('div', { style: styles.box },
          h('h2', { style: styles.title }, 'Slice Pipeline 配置'),
          h('p', { style: styles.intro }, '为 default / designer / task / reviewer 选择 DSH 已配置的 provider 与 model。effort 由所选 provider 路由的 reasoning 默认值决定；workflow agent() 当前不支持 per-role effort。'),
          catalogLoading ? h('p', { style: styles.muted }, '正在读取 DSH 模型目录…') : null,
          catalogError ? h('p', { style: styles.error }, catalogError) : null,
          ...roleRows,
          h('h3', { style: styles.sectionTitle }, '工作流阶段'),
          h('label', { style: styles.field }, 'plan 阶段（逗号分隔）',
            h('input', {
              style: styles.input,
              placeholder: 'design（planReview 已归档，不可启用）',
              value: draftStages.plan,
              onChange: (event) => setDraftStages((current) => ({ ...current, plan: event.target.value })),
              onBlur: () => writeStage('plan', draftStages.plan)
            })
          ),
          h('label', { style: styles.field }, 'slice 阶段（逗号分隔）',
            h('input', {
              style: styles.input,
              placeholder: 'brief, implement, codeReview, fix（briefReview 已归档）',
              value: draftStages.slice,
              onChange: (event) => setDraftStages((current) => ({ ...current, slice: event.target.value })),
              onBlur: () => writeStage('slice', draftStages.slice)
            })
          ),
          h('label', { style: styles.field }, '最大修订轮数（0 = 禁用 fix）',
            h('input', {
              style: styles.input,
              type: 'number',
              min: 0,
              value: draftMaxFixRounds,
              onChange: (event) => setDraftMaxFixRounds(event.target.value),
              onBlur: () => writeMaxFixRounds(draftMaxFixRounds)
            })
          ),
          h('h3', { style: styles.sectionTitle }, '功能模块'),
          ...moduleRows,
          saveError ? h('p', { style: styles.error }, saveError) : null
        )
      }

      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: PLUGIN_ID,
        order: 60,
        label: () => 'Slice Pipeline'
      }, SlicePipelineSettings))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.helpers = { MODULES, cleanPathInput, isContentLike, pathWriteOps, describeStoredPath }
    return module.exports
  }
})
