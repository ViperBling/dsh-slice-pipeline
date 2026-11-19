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
      toggle: {
        display: 'flex', alignItems: 'center', gap: '8px',
        width: 'fit-content', minHeight: '22px',
        fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer'
      },
      checkbox: {
        width: '15px', height: '15px', margin: 0, flex: '0 0 auto',
        accentColor: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer'
      },
      label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      select: { minWidth: '0', width: '100%', maxWidth: '100%', height: '32px', flexShrink: 0, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '0 8px' },
      input: { height: '32px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '0 8px' },
      textarea: { minHeight: '180px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '8px', fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', whiteSpace: 'pre-wrap' },
      effort: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', paddingBottom: '8px' },
      sectionTitle: { margin: '8px 0 0', fontSize: '14px', fontWeight: 600 },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      claudeRoot: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px',
        height: '100%', minHeight: 0, boxSizing: 'border-box', overflow: 'hidden',
        color: 'var(--dsw-alias-label-primary)'
      },
      claudeHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexShrink: 0 },
      claudeTitle: { margin: 0, fontSize: '13px', lineHeight: '18px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      claudeMeta: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      statusPill: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0,
        fontSize: '10px', lineHeight: '14px', padding: '2px 8px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)'
      },
      statusDot: { width: '5px', height: '5px', borderRadius: '50%', background: 'var(--dsw-alias-label-tertiary)' },
      statusRunning: { background: 'var(--dsw-alias-state-business-primary)', borderColor: 'transparent', color: 'var(--dsw-alias-label-inverse, #fff)' },
      statusRunningDot: { background: 'currentColor' },
      stepRow: { display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', padding: '2px 0', flexShrink: 0 },
      step: { display: 'flex', alignItems: 'center', flex: '1 0 auto', minWidth: '50px' },
      stepDot: { width: '16px', height: '16px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', border: '1px solid var(--dsw-alias-border-l4)', color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
      stepDotDone: { background: 'var(--dsw-alias-state-success-primary, #2f9e44)', borderColor: 'transparent', color: '#fff' },
      stepDotActive: { borderColor: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-state-business-primary)', boxShadow: '0 0 0 2px var(--dsw-alias-bg-layer-2)' },
      stepDotFailed: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' },
      stepLabel: { fontSize: '10px', marginLeft: '4px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      stepLabelActive: { color: 'var(--dsw-alias-label-primary)' },
      stepLine: { flex: 1, height: '1px', background: 'var(--dsw-alias-border-l3)', margin: '0 3px' },
      progressTrack: { height: '4px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden', flexShrink: 0 },
      progressFill: { height: '100%', borderRadius: '999px', background: 'var(--dsw-alias-state-business-primary)', transition: 'width 240ms ease' },
      progressIndeterminate: { backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.22) 0 6px, transparent 6px 12px)' },
      timeline: {
        display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto',
        flex: '1 1 auto', minHeight: 0, paddingRight: '2px'
      },
      timelineRow: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
      timelineIcon: { width: '16px', flex: '0 0 auto', textAlign: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      timelineBody: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      mono: { fontSize: '11px', fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      jobSelect: { height: '28px', fontSize: '12px', borderColor: 'var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', borderRadius: '6px' },
      toolGroup: { display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 },
      toolGroupHead: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, cursor: 'pointer', userSelect: 'none' },
      toolChevron: { width: '10px', flex: '0 0 auto', textAlign: 'center', fontSize: '9px', color: 'var(--dsw-alias-label-tertiary)' },
      toolGroupTitle: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      toolGroupNames: { flex: '1 1 auto', minWidth: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', opacity: '.8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      toolFail: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap' },
      toolGroupBody: {
        display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0,
        marginLeft: '5px', paddingLeft: '12px', borderLeft: '1px solid var(--dsw-alias-border-l2)'
      },
      toolRow: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
      toolRowFailed: { color: 'var(--dsw-alias-state-error-primary)' },
      toolIcon: { flex: '0 0 auto', width: '10px', textAlign: 'center', fontSize: '9px', color: 'var(--dsw-alias-label-tertiary)', opacity: '.85' },
      toolName: { flex: '0 0 auto', color: 'inherit' },
      toolTarget: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', color: 'inherit', opacity: '.85' },
      toolDuration: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', opacity: '.8' },
      textBlock: { fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      thinking: { borderLeft: '2px solid var(--dsw-alias-border-l3)', paddingLeft: '8px' },
      thinkingSummary: { cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      thinkingText: { fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '4px' },
      usage: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      raw: { marginTop: '2px', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '6px', flexShrink: 0, maxHeight: '260px', overflow: 'auto' },
      rawSummary: { fontSize: '11px', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)' },
      rawTextDetails: { borderLeft: '2px solid var(--dsw-alias-border-l3)', paddingLeft: '8px' },
      rawTextSummary: { cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      rawPre: {
        margin: '6px 0 0', padding: '8px', maxHeight: '220px', overflow: 'auto',
        borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2)',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '11px', lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      },
      done: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #2f9e44)' },
      result: {
        display: 'flex', flexDirection: 'column', gap: '10px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
        padding: '10px', background: 'var(--dsw-alias-bg-layer-1)'
      },
      resultHeading: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      resultTitle: { fontSize: '13px', fontWeight: 600 },
      verdict: {
        fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-2)'
      },
      badge: { fontSize: '10px', padding: '1px 6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)' },
      section: { display: 'flex', flexDirection: 'column', gap: '6px' },
      sectionTitle: { fontSize: '12px', fontWeight: 600 },
      finding: { borderLeft: '2px solid var(--dsw-alias-border-l3)', paddingLeft: '8px', display: 'flex', flexDirection: 'column', gap: '3px' },
      findingHead: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      resultText: { fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' },
      footer: {
        marginTop: 'auto', paddingTop: '8px', paddingBottom: '8px', flexShrink: 0,
        position: 'sticky', bottom: 0, zIndex: 1,
        background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2, transparent))'
      },
      archiveDelete: { alignSelf: 'flex-start', height: '22px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', cursor: 'pointer', flexShrink: 0 },
      stop: { height: '28px', padding: '0 12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' }
    }

    const inject = ['slots', 'remote', 'remote.session', 'configForms']

    const CLAUDE_TAB_ID = 'slice-pipeline:claude'
    const CLAUDE_KIND = 'claude'

    const PHASES = [
      { key: 'starting', label: '启动' },
      { key: 'reading', label: '读取上下文' },
      { key: 'analyzing', label: '分析 / 生成' },
      { key: 'validating', label: '校验' },
      { key: 'done', label: '完成' }
    ]

    function parseResultDetail(value) {
      if (value === undefined || value === null) return undefined
      if (typeof value === 'object') return value
      let text = String(value).trim()
      if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      try { return JSON.parse(text) } catch { return undefined }
    }

    /** Structured-output turns stream their JSON as assistant text; fold that instead of dumping it into the timeline. */
    function isRawTextItem(text) {
      const value = String(text || '').trim()
      const body = value.replace(/^```(?:json)?\s*/i, '')
      if (body.startsWith('{') || body.startsWith('[')) return true
      return value.length > 1200
    }

    function emptyTimeline() {
      return { items: [], tools: new Map(), usage: null, done: null, phase: '', model: '', lastHeartbeat: null, thinkingDisabled: false }
    }

    function reduceTimeline(text) {
      const state = emptyTimeline()
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line.startsWith('{')) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (!event || event.v !== 1) continue
        if (event.t === 'phase') {
          state.phase = event.phase || state.phase
          if (event.model) state.model = event.model
          continue
        }
        if (event.t === 'tool') {
          const id = String(event.id || '')
          if (event.status === 'start') {
            const item = {
              kind: 'tool', id, name: event.name || 'tool', target: event.target || '',
              at: event.at || Date.now(), startAt: event.at || Date.now(), status: 'running'
            }
            state.items.push(item)
            state.tools.set(id, item)
          } else {
            const item = state.tools.get(id) || {
              kind: 'tool', id, name: 'tool', target: '', at: event.at || Date.now(),
              startAt: event.at || Date.now()
            }
            if (!state.tools.has(id)) { state.items.push(item); state.tools.set(id, item) }
            item.status = event.ok === false ? 'failed' : 'ok'
            item.endAt = event.at || Date.now()
            item.ms = event.ms
          }
          continue
        }
        if (event.t === 'thinking') {
          const text = String(event.text || '')
          const last = state.items[state.items.length - 1]
          if (last !== undefined && last.kind === 'thinking') last.text += text
          else state.items.push({ kind: 'thinking', at: event.at || Date.now(), text })
          continue
        }
        if (event.t === 'text') {
          state.items.push({ kind: 'text', at: event.at || Date.now(), text: String(event.text || '') })
          continue
        }
        if (event.t === 'heartbeat') { state.lastHeartbeat = event; continue }
        if (event.t === 'thinking-disabled') { state.thinkingDisabled = true; continue }
        if (event.t === 'stderr') {
          state.items.push({ kind: 'stderr', at: event.at || Date.now(), text: String(event.text || '') })
          continue
        }
        if (event.t === 'usage') { state.usage = event; continue }
        if (event.t === 'done') { state.done = event; if (event.status === 'completed') state.phase = 'done' }
      }
      return state
    }

    function phaseIndex(state, job) {
      if (state.phase === 'done' || state.done?.status === 'completed') return 4
      if (state.usage) return 3
      if (state.items.some((item) => item.kind === 'tool' || item.kind === 'thinking' || item.kind === 'text')) return 2
      if (state.phase === 'starting') return 0
      if (job?.status === 'running') return 0
      return 4
    }

    function formatDuration(ms) {
      const total = Math.max(0, Math.round(Number(ms) || 0))
      const seconds = Math.floor(total / 1000)
      return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
    }

    function useJobsSnapshot(jobs) {
      const subscribe = React.useMemo(
        () => (callback) => (jobs === undefined ? () => {} : jobs.state.subscribe(callback)),
        [jobs]
      )
      const read = React.useCallback(
        () => (jobs === undefined ? { rows: {}, observed: {} } : jobs.state.getSnapshot()),
        [jobs]
      )
      return React.useSyncExternalStore(subscribe, read)
    }

    function ClaudeProgressTab({ ctx, scope, visible }) {
      const jobs = ctx.get('jobs')
      const snapshot = useJobsSnapshot(jobs)
      const sessionId = scope?.sessionId
      const rows = (sessionId !== undefined && snapshot.rows) ? (snapshot.rows[sessionId] || []) : []
      const claudeRows = rows
        .filter((job) => job.kind === CLAUDE_KIND)
        .slice()
        .sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0))
      const [picked, setPicked] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [fileText, setFileText] = React.useState('')
      const [now, setNow] = React.useState(() => Date.now())
      const [stopArmed, setStopArmed] = React.useState(false)
      const [deleteArmed, setDeleteArmed] = React.useState(false)
      const [openGroups, setOpenGroups] = React.useState({})
      const bottomRef = React.useRef(null)

      const matchedArchive = picked === null ? undefined : history.find((entry) => entry.jobId === picked)
      const archived = matchedArchive || (claudeRows.length === 0 ? history[0] : undefined)
      const archivedStart = archived === undefined ? Date.now()
        : (typeof archived.startedAt === 'string' ? Date.parse(archived.startedAt) : archived.startedAt) || Date.now()
      const pickedLive = claudeRows.find((candidate) => String(candidate.id) === picked)
      const selectedId = pickedLive !== undefined
        ? String(pickedLive.id)
        : (archived !== undefined ? String(archived.jobId) : (claudeRows[0] !== undefined ? String(claudeRows[0].id) : undefined))
      const observed = selectedId === undefined || !snapshot.observed ? undefined : snapshot.observed[selectedId]
      const streamText = (observed?.text !== undefined && observed.text !== '') ? observed.text : fileText
      const timeline = React.useMemo(() => reduceTimeline(streamText), [streamText])
      // Archived rows have no live job object: take the clock and the final
      // status from the event stream instead of pretending every historical
      // run took 00:00 and completed.
      let archivedLastAt = 0
      for (const item of timeline.items) if ((item.at || 0) > archivedLastAt) archivedLastAt = item.at || 0
      if ((timeline.done?.at || 0) > archivedLastAt) archivedLastAt = timeline.done.at
      const archivedFresh = archived !== undefined && timeline.done == null
        && archivedLastAt > 0 && (Date.now() - archivedLastAt) < 60_000
      const archivedStatus = archived === undefined ? undefined
        : (timeline.done?.status || archived.status || (archivedFresh ? 'running' : 'unknown'))
      const archivedFinished = Number(archived?.finishedAt) || archivedLastAt || archivedStart
      const job = pickedLive || (archived !== undefined ? {
        id: archived.jobId, label: archived.label, role: archived.role, status: archivedStatus,
        startedAt: archivedStart,
        ...(archivedFresh ? {} : { finishedAt: archivedFinished }),
        progress: '', output: { total: 0 }
      } : claudeRows[0])
      const liveJob = job !== undefined && claudeRows.some((candidate) => String(candidate.id) === String(job.id))

      React.useEffect(() => {
        if (jobs === undefined || sessionId === undefined) return
        return jobs.watchRows(sessionId)
      }, [jobs, sessionId])

      React.useEffect(() => {
        if (typeof fetch !== 'function' || sessionId === undefined) return
        let cancelled = false
        setHistory([])
        const load = async () => {
          try {
            const response = await fetch('/plugins/dsh-slice-pipeline/claude-events-list?sessionId='
              + encodeURIComponent(String(sessionId)), { cache: 'no-store' })
            if (!response.ok) return
            const payload = await response.json()
            if (!cancelled && Array.isArray(payload.jobs)) setHistory(payload.jobs)
          } catch { /* route unavailable */ }
        }
        load()
        const timer = setInterval(load, 5000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [sessionId])

      React.useEffect(() => { setPicked(null) }, [sessionId])

      React.useEffect(() => {
        // Archived jobs belong to the disk, not to this process's jobs
        // registry: following them always fails and would retry forever.
        if (!liveJob) return
        if (jobs === undefined || sessionId === undefined || job === undefined) return
        // Observe whenever mounted. BetterSidebar keeps parked tabs mounted,
        // and an extra observation is cheap; relying on `visible` here made the
        // panel miss its whole stream on hosts that omit/underspecify it.
        let release
        const connect = () => {
          try { release = jobs.observe(sessionId, job.id) } catch { release = undefined }
        }
        connect()
        // Some clients can lose the first observation while the tab is being
        // created. If we still have no text, reattach instead of showing an
        // empty panel forever.
        const retry = setInterval(() => {
          const view = jobs.state.getSnapshot().observed[String(job.id)]
          if (view !== undefined && typeof view.text === 'string' && view.text !== '') {
            clearInterval(retry)
            return
          }
          try { if (typeof release === 'function') release() } catch { /* ignore */ }
          connect()
        }, 2500)
        return () => {
          clearInterval(retry)
          try { if (typeof release === 'function') release() } catch { /* ignore */ }
        }
      }, [jobs, sessionId, job && job.id, liveJob])

      React.useEffect(() => {
        if (job === undefined || sessionId === undefined || typeof fetch !== 'function') return
        let cancelled = false
        setFileText('')
        const load = async () => {
          try {
            const response = await fetch('/plugins/dsh-slice-pipeline/claude-events?jobId='
              + encodeURIComponent(String(job.id))
              + '&sessionId=' + encodeURIComponent(String(sessionId)), { cache: 'no-store' })
            if (!response.ok) return
            const text = await response.text()
            if (!cancelled) setFileText(text)
          } catch { /* route unavailable or job file not created */ }
        }
        load()
        const timer = setInterval(load, 2000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [job && job.id, sessionId])

      React.useEffect(() => {
        if (job === undefined || job.status !== 'running') return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [job && job.status])

      React.useEffect(() => {
        if (bottomRef.current && typeof bottomRef.current.scrollIntoView === 'function') {
          bottomRef.current.scrollIntoView({ block: 'end' })
        }
      }, [streamText])

      if (jobs === undefined) {
        
      return h('div', { style: styles.claudeRoot }, h('p', { style: styles.muted }, '当前 profile 没有 jobs 服务，无法显示 Claude 进度。'))
      }
      if (job === undefined) {
        const rawClaude = rows.find((candidate) => candidate.kind !== CLAUDE_KIND
          && typeof candidate.label === 'string' && /claude/i.test(candidate.label))
        
      return h('div', { style: styles.claudeRoot },
          h('h3', { style: styles.claudeTitle }, '外部 Claude Agent'),
          rawClaude
            ? h('p', { style: styles.error }, '检测到 shell 后台任务「' + rawClaude.label
              + '」，它不是 external_agent_run 创建的 claude job；请停止它，并用 external_agent_run 重跑，侧边栏才会显示阶段条/时间线。')
            : h('p', { style: styles.muted }, '本会话暂无 Claude 历史。Designer/Reviewer 启用外部 agent 后，运行记录会按会话保存在这里，重新打开这个 tab 也能回看。')
        )
      }

      const activeIndex = phaseIndex(timeline, job)
      const elapsed = (job.status === 'running' ? now : (job.finishedAt || now)) - job.startedAt
      const progress = Math.round((Math.min(activeIndex, 4) / 4) * 100)
      const stop = async () => {
        if (!stopArmed) { setStopArmed(true); return }
        setStopArmed(false)
        try { await jobs.kill(sessionId, job.id) } catch { /* controller state converges */ }
      }

      const deleteArchive = async () => {
        if (archived === undefined || sessionId === undefined) return
        if (!deleteArmed) { setDeleteArmed(true); return }
        setDeleteArmed(false)
        try {
          const response = await fetch('/plugins/dsh-slice-pipeline/claude-events?jobId='
            + encodeURIComponent(String(archived.jobId))
            + '&sessionId=' + encodeURIComponent(String(sessionId)), { method: 'DELETE' })
          if (response.ok) {
            setHistory((current) => current.filter((entry) => entry.jobId !== archived.jobId))
            setPicked(null)
          }
        } catch { /* route unavailable */ }
      }
      const stepper = PHASES.map((phase, index) => {
        const done = index < activeIndex || (index === 4 && timeline.done?.status === 'completed')
        const active = index === activeIndex && job.status === 'running'
        return h('div', { key: phase.key, style: styles.step },
          h('span', {
            style: {
              ...styles.stepDot,
              ...(done ? styles.stepDotDone : {}),
              ...(active ? styles.stepDotActive : {}),
              ...(timeline.done?.status === 'failed' && index === 4 ? styles.stepDotFailed : {})
            }
          }, done ? '✓' : String(index + 1)),
          h('span', { style: { ...styles.stepLabel, ...(active ? styles.stepLabelActive : {}) } }, phase.label),
          index < PHASES.length - 1 ? h('span', { style: styles.stepLine }) : null
        )
      })

      // Group consecutive tool calls into one folded line, so long runs do not
      // bury the thinking / result content. Failures stay visible by default.
      const timelineRows = []
      let group = null
      timeline.items.forEach((item, index) => {
        if (item.kind === 'tool') {
          if (group === null) {
            group = { kind: 'tools', key: 'tools-' + index, entries: [] }
            timelineRows.push(group)
          }
          group.entries.push({ item, index })
          return
        }
        group = null
        timelineRows.push({ kind: 'single', key: item.kind + '-' + index, item, index })
      })
      const lastToolGroup = timelineRows.filter((row) => row.kind === 'tools').at(-1)
      const isGroupOpen = (toolRows) => {
        const failures = toolRows.entries.filter(({ item }) => item.status === 'failed').length
        if (openGroups[toolRows.key] !== undefined) return openGroups[toolRows.key]
        return failures > 0 || (job.status === 'running' && toolRows === lastToolGroup)
      }
      const toolLine = ({ item, index }) => {
        const failed = item.status === 'failed'
        const elapsedMs = item.endAt !== undefined ? (item.endAt || 0) - (item.startAt || 0) : undefined
        const duration = elapsedMs !== undefined
          ? (elapsedMs >= 1000 ? formatDuration(elapsedMs) : '')
          : (item.status === 'running' ? '…' : '')
        return h('div', { key: 'tool-' + item.id + '-' + index, style: { ...styles.toolRow, ...(failed ? styles.toolRowFailed : {}) } },
          h('span', { style: styles.toolIcon }, failed ? '!' : (item.status === 'ok' ? '✓' : '·')),
          h('span', { style: styles.toolName }, item.name),
          item.target ? h('span', { title: item.target, style: styles.toolTarget }, item.target) : null,
          h('span', { style: styles.toolDuration }, duration)
        )
      }
      const renderToolGroup = (toolRows) => {
        const failures = toolRows.entries.filter(({ item }) => item.status === 'failed').length
        const counts = new Map()
        for (const { item } of toolRows.entries) counts.set(item.name, (counts.get(item.name) || 0) + 1)
        const names = [...counts.entries()]
          .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
        const summary = names.slice(0, 4).map(([toolName, count]) => toolName + ' ×' + count).join(' · ')
          + (names.length > 4 ? ' 等 ' + names.length + ' 种' : '')
        const open = isGroupOpen(toolRows)
        const toggle = () => setOpenGroups((current) => ({ ...current, [toolRows.key]: !open }))
        return h('div', { key: toolRows.key, style: styles.toolGroup },
          h('div', {
            style: styles.toolGroupHead,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? 'true' : 'false',
            title: open ? '收起工具调用' : '展开工具调用',
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              toggle()
            }
          },
            h('span', { style: styles.toolChevron }, open ? '▾' : '▸'),
            h('span', { style: styles.toolGroupTitle }, toolRows.entries.length + ' 次工具调用'),
            names.length > 0 ? h('span', { style: styles.toolGroupNames }, summary) : null,
            failures > 0 ? h('span', { style: styles.toolFail }, failures + ' 失败') : null
          ),
          open ? h('div', { style: styles.toolGroupBody }, ...toolRows.entries.map(toolLine)) : null
        )
      }

      const rendered = timelineRows.map((row) => {
        if (row.kind === 'tools') return renderToolGroup(row)
        const item = row.item
        const index = row.index
        if (item.kind === 'thinking') {
          return h('details', { key: 'think-' + index, style: styles.thinking },
            h('summary', { style: styles.thinkingSummary }, '💭 思考'),
            h('div', { style: styles.thinkingText }, item.text)
          )
        }
        if (item.kind === 'stderr') {
          return h('div', { key: 'stderr-' + index, style: styles.timelineRow },
            h('span', { style: styles.timelineIcon }, '!'),
            h('div', { style: styles.error }, item.text))
        }
        const text = String(item.text || '')
        if (isRawTextItem(text)) {
          return h('details', { key: 'text-' + index, style: styles.rawTextDetails },
            h('summary', { style: styles.rawTextSummary },
              '原始输出（' + text.length + ' 字符，点击展开/收起）'),
            h('pre', { style: styles.rawPre }, text)
          )
        }
        return h('div', { key: 'text-' + index, style: styles.timelineRow },
          h('span', { style: styles.timelineIcon }, '✎'),
          h('div', { style: styles.timelineBody }, h('div', { style: styles.textBlock }, text))
        )
      })

      const rawBlock = streamText !== ''
        ? h('details', { style: styles.raw },
            h('summary', { style: styles.rawSummary },
              '原始事件流 / 输出（' + streamText.length + ' 字符）'),
            h('pre', { style: styles.rawPre }, streamText.slice(-120000))
          )
        : null
      const structured = timeline.done?.structured
      const parsedResult = structured !== undefined && structured !== null
        ? (typeof structured === 'string' ? parseResultDetail(structured) : structured)
        : parseResultDetail(timeline.done?.detail)
      const firstText = (...values) => {
        for (const value of values) {
          if (value === undefined || value === null) continue
          const text = String(value).trim()
          if (text !== '') return text
        }
        return ''
      }
      const renderFinding = (finding, index) => {
        const source = firstText(finding.source)
        const category = firstText(finding.category, finding.area, finding.layer)
        const locator = firstText(
          finding.locator,
          finding.designRef,
          (() => {
            const file = firstText(finding.file, finding.path)
            if (file === '') return ''
            const line = firstText(finding.line, finding.lineNumber)
            return line === '' || file.endsWith(':' + line) ? file : file + ':' + line
          })()
        )
        const message = firstText(finding.message, finding.issue, finding.summary, finding.description, finding.detail, finding.title, finding.text)
        const fix = firstText(finding.fix, finding.suggestion, finding.suggestedFix, finding.recommendation, finding.action)
        return h('div', { key: 'finding-' + index, style: styles.finding },
          h('div', { style: styles.findingHead },
            h('span', { style: styles.badge }, firstText(finding.severity, finding.level, 'finding')),
            category !== '' ? h('span', { style: styles.badge }, category) : null,
            source !== '' ? h('span', { style: styles.muted }, source) : null,
            locator !== '' ? h('span', { style: styles.mono }, locator) : null
          ),
          message !== '' ? h('div', { style: styles.resultText }, message) : null,
          fix !== '' ? h('div', { style: styles.muted }, '建议：' + fix) : null,
          finding.evidence ? h('details', { style: styles.raw },
            h('summary', { style: styles.rawSummary }, '证据'),
            h('pre', { style: styles.rawPre }, String(finding.evidence))) : null
        )
      }
      const renderResult = (result) => {
        if (result && typeof result === 'object' && result.verdict !== undefined) {
          const findings = Array.isArray(result.findings) ? result.findings : []
          const blind = Array.isArray(result.blindFindings) ? result.blindFindings : []
          const unverified = Array.isArray(result.unverified)
            ? result.unverified
            : (typeof result.unverifiable === 'string' && result.unverifiable.trim() !== '' ? [result.unverifiable] : [])
          return h('div', { style: styles.result },
            h('div', { style: styles.resultHeading },
              h('span', { style: styles.resultTitle }, 'Review result'),
              h('span', { style: styles.verdict }, String(result.verdict)),
              h('span', { style: styles.muted }, findings.length + ' findings')
            ),
            result.summary ? h('div', { style: styles.resultText }, String(result.summary)) : null,
            findings.length > 0 ? h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, 'Findings'),
              ...findings.map(renderFinding)) : null,
            blind.length > 0 ? h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, 'Blind findings'),
              ...blind.map(renderFinding)) : null,
            unverified.length > 0 ? h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, 'Unverified'),
              ...unverified.map((item, index) => h('div', { key: 'unverified-' + index, style: styles.resultText }, String(item)))) : null
          )
        }
        if (result && typeof result === 'object' && Array.isArray(result.slices)) {
          const decisions = Array.isArray(result.decisions) ? result.decisions : []
          const questions = Array.isArray(result.openQuestions) ? result.openQuestions : []
          return h('div', { style: styles.result },
            h('div', { style: styles.resultHeading },
              h('span', { style: styles.resultTitle }, 'Design result'),
              h('span', { style: styles.muted }, result.slices.length + ' slices')
            ),
            result.summary ? h('div', { style: styles.resultText }, String(result.summary)) : null,
            result.interfaceContract ? h('details', { style: styles.raw },
              h('summary', { style: styles.rawSummary }, 'Interface contract'),
              h('pre', { style: styles.rawPre }, String(result.interfaceContract))) : null,
            result.slices.length > 0 ? h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, 'Slices'),
              ...result.slices.map((slice, index) => h('div', { key: 'slice-' + index, style: styles.finding },
                h('div', { style: styles.findingHead },
                  h('span', { style: styles.badge }, String(slice.id || '#' + (index + 1))),
                  h('span', { style: styles.resultTitle }, String(slice.title || ''))
                ),
                slice.scope ? h('div', { style: styles.resultText }, String(slice.scope)) : null,
                slice.acceptance ? h('div', { style: styles.muted }, 'Acceptance: ' + String(slice.acceptance)) : null
              ))) : null,
            decisions.length > 0 ? h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, 'Decisions'),
              ...decisions.map((decision, index) => h('div', { key: 'decision-' + index, style: styles.resultText },
                String(decision.topic || '') + '：' + String(decision.decision || '')))) : null,
            questions.length > 0 ? h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, 'Open questions'),
              ...questions.map((question, index) => h('div', { key: 'question-' + index, style: styles.resultText }, String(question)))) : null
          )
        }
        // 外部调用方可能传自己的 output schema（例如直接调 external_agent_run，
        // 或项目有自己的设计文档格式）。这类结果不是插件的 Review/Design schema，
        // 但也不该把整段 JSON 原样糊在面板上：按通用字段渲染成可读卡片。
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const summary = firstText(result.summary, result.overview, result.description, result.abstract)
          const body = firstText(result.designMarkdown, result.markdown, result.plan, result.details, result.content)
          const decisions = Array.isArray(result.decisions) ? result.decisions : []
          const openQuestions = Array.isArray(result.openQuestions) ? result.openQuestions : []
          const risks = Array.isArray(result.risks) ? result.risks : []
          const consumed = new Set([
            'summary', 'overview', 'description', 'abstract',
            'designMarkdown', 'markdown', 'plan', 'details', 'content',
            'decisions', 'openQuestions', 'risks'
          ])
          const extras = Object.entries(result)
            .filter(([key, value]) => !consumed.has(key) && value !== undefined && value !== null && value !== '')
          if (summary !== '' || body !== '' || decisions.length > 0 || openQuestions.length > 0 || risks.length > 0) {
            const isDesign = body !== '' || job.role === 'designer'
            const genericTitle = (isDesign ? 'Design result' : (job.role === 'reviewer' ? 'Review result' : 'Result'))
              + '（通用格式）'
            const describeItem = (item) => {
              if (typeof item === 'string') return item
              if (!item || typeof item !== 'object') return String(item)
              const primary = firstText(item.topic, item.question, item.risk, item.title, item.issue, item.summary)
              const secondary = firstText(item.decision, item.answer, item.detail, item.description, item.mitigation)
              if (primary !== '' && secondary !== '') return primary + '：' + secondary
              if (primary !== '') return primary
              return JSON.stringify(item)
            }
            const listSection = (titleText, items) => h('div', { style: styles.section },
              h('div', { style: styles.sectionTitle }, titleText),
              ...items.map((item, index) => h('div', { key: titleText + '-' + index, style: styles.resultText },
                describeItem(item))))
            return h('div', { style: styles.result },
              h('div', { style: styles.resultHeading },
                h('span', { style: styles.resultTitle }, genericTitle),
                h('span', { style: styles.muted }, '非插件 schema，按通用格式展示')
              ),
              summary !== '' ? h('div', { style: styles.resultText }, summary) : null,
              body !== '' ? h('details', { style: styles.raw },
                h('summary', { style: styles.rawSummary }, '正文（' + body.length + ' 字符）'),
                h('pre', { style: styles.rawPre }, body)) : null,
              decisions.length > 0 ? listSection('Decisions', decisions) : null,
              openQuestions.length > 0 ? listSection('Open questions', openQuestions) : null,
              risks.length > 0 ? listSection('Risks', risks) : null,
              extras.length > 0 ? h('div', { style: styles.section },
                h('div', { style: styles.sectionTitle }, '其他字段'),
                ...extras.map(([key, value]) => h('div', { key: 'extra-' + key, style: styles.resultText },
                  key + '：' + (typeof value === 'string' ? value : JSON.stringify(value))))) : null
            )
          }
        }
        return h('div', { style: styles.result },
          h('div', { style: styles.resultTitle }, 'Result'),
          h('pre', { style: styles.rawPre }, JSON.stringify(result, null, 2))
        )
      }
      const resultBlock = parsedResult !== undefined
        ? renderResult(parsedResult)
        : (timeline.done?.detail
          ? h('div', { style: styles.result },
              h('div', { style: styles.resultTitle }, 'Result'),
              h('div', { style: styles.resultText }, '结果不是可解析的 JSON；原始内容已折叠。'),
              h('details', { style: styles.raw },
                h('summary', { style: styles.rawSummary }, '原始结果'),
                h('pre', { style: styles.rawPre }, String(timeline.done.detail))
              )
            )
          : null)
      const usage = timeline.usage
      const historyChoices = history.filter((entry) => !claudeRows.some((row) => String(row.id) === entry.jobId))
      const thinkingTokens = usage?.output_tokens_details?.thinking_tokens
      const usageLine = usage
        ? [usage.turns != null ? usage.turns + ' turns' : null,
           usage.inputTokens != null ? usage.inputTokens + ' in' : null,
           usage.outputTokens != null ? usage.outputTokens + ' out' : null,
           thinkingTokens != null ? thinkingTokens + ' thinking' : null,
           usage.costUsd != null ? '$' + Number(usage.costUsd).toFixed(3) : null]
          .filter(Boolean).join(' · ')
        : ''

      
      return h('div', { style: styles.claudeRoot },
        h('div', { style: styles.claudeHeader },
          h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
            h('div', { style: styles.claudeTitle }, job.label || 'Claude'),
            h('div', { style: styles.claudeMeta }, (timeline.model || job.progress || '') + ' · ' + formatDuration(elapsed))
          ),
          h('span', { style: { ...styles.statusPill, ...(job.status === 'running' ? styles.statusRunning : {}) } },
            h('span', { style: { ...styles.statusDot, ...(job.status === 'running' ? styles.statusRunningDot : {}) } }),
            job.status === 'unknown' ? '未记录' : job.status)
        ),
        claudeRows.length + historyChoices.length > 1 ? h('select', {
          style: { ...styles.select, ...styles.jobSelect },
          value: picked || String(job.id),
          onChange: (event) => setPicked(event.target.value)
        }, [
          ...claudeRows.map((candidate) => h('option', { key: String(candidate.id), value: String(candidate.id) },
            String(candidate.label || candidate.id) + ' · ' + candidate.status)),
          ...historyChoices.map((candidate) => h('option', { key: 'history-' + candidate.jobId, value: candidate.jobId },
            String(candidate.label || candidate.jobId) + ' · archived'))
        ])
          : null,
        archived !== undefined && !liveJob
          ? h('button', { style: styles.archiveDelete, onClick: deleteArchive }, deleteArmed ? '确认删除历史' : '删除历史')
          : null,
        h('div', { style: styles.stepRow }, ...stepper),
        h('div', { style: styles.progressTrack },
          h('div', { style: { ...styles.progressFill, width: progress + '%', ...(job.status === 'running' && activeIndex === 2 ? styles.progressIndeterminate : {}) } })
        ),
        h('div', { style: styles.timeline }, rendered.length > 0 ? rendered : h('p', {
          style: job.status === 'failed' ? styles.error : styles.muted
        }, job.status === 'failed'
          ? '任务失败：' + String(job.detail || job.progress || 'unknown error')
          : (timeline.lastHeartbeat
            ? '等待模型响应… 已 ' + Math.round((timeline.lastHeartbeat.elapsedMs || 0) / 1000) + 's'
            : ((streamText === '') && job.output && job.output.total > 0
              ? '已产生 ' + job.output.total + ' 字节输出，但观察流尚未连接；请关闭并重新打开此 tab。'
              : '启动 Claude…'))), resultBlock, rawBlock),
        h('div', { ref: bottomRef }),
        usageLine ? h('div', { style: styles.usage }, usageLine) : null,
        timeline.items.length > 0 && job.status === 'running' && !timeline.items.some((item) => item.kind === 'thinking')
          ? h('div', { style: styles.muted }, timeline.thinkingDisabled
            ? '当前 native 配置 MAX_THINKING_TOKENS=0，thinking 已被关闭；这是 workaround 的预期行为。'
            : (thinkingTokens != null && thinkingTokens > 0
              ? '模型返回了 ' + thinkingTokens + ' 个 thinking tokens，但上游没有提供可展示的思考文本（通常只有签名）。'
              : '尚未收到 thinking 事件：当前 CLI 路由/模型可能未返回思考块。'))
          : null,
        h('div', { style: styles.footer },
          job.status === 'running'
            ? h('button', { style: styles.stop, onClick: stop }, stopArmed ? '确认停止' : 'Stop')
            : null
        )
      )
    }

    function registerClaudePanel(ctx, form) {
      ctx.inject(['betterSidebar', 'jobs'], (child) => {
        const sidebar = child.betterSidebar
        const jobs = child.jobs
        child.effect(() => sidebar.registerTab({
          id: CLAUDE_TAB_ID,
          title: () => 'Claude',
          description: '外部 Designer / Reviewer 的 Claude 执行进度',
          icon: () => h('span', { style: { fontWeight: 700 } }, 'C'),
          single: true,
          component: ClaudeProgressTab
        }), 'dsh-slice-pipeline: claude tab')

        child.effect(() => {
          const opened = new Set()
          let watchedSession
          let releaseRows
          const releaseWatchers = () => { if (releaseRows) releaseRows(); releaseRows = undefined }
          const tick = () => {
            const sessionId = sidebar.getSnapshot().sessionId
            if (sessionId === undefined) { releaseWatchers(); watchedSession = undefined; return }
            if (sessionId !== watchedSession) {
              releaseWatchers()
              watchedSession = sessionId
              releaseRows = jobs.watchRows(sessionId)
            }
            const config = form.getSnapshot().value || {}
            if (config.externalAgents?.autoOpen === false) return
            const rows = jobs.state.getSnapshot().rows[sessionId] || []
            const running = rows.find((job) => job.kind === CLAUDE_KIND && job.status === 'running'
              && !opened.has(String(job.id)))
            if (running === undefined) return
            opened.add(String(running.id))
            try { sidebar.openTab({ type: CLAUDE_TAB_ID }, { sessionId }) } catch { /* tab surface may be closing */ }
          }
          const unsubscribeJobs = jobs.state.subscribe(tick)
          const unsubscribeSidebar = sidebar.subscribeState(tick)
          const unsubscribeForm = typeof form.subscribe === 'function' ? form.subscribe(tick) : () => {}
          tick()
          return () => {
            unsubscribeJobs()
            unsubscribeSidebar()
            unsubscribeForm()
            releaseWatchers()
          }
        }, 'dsh-slice-pipeline: claude auto-open')
      })
    }

    function apply(ctx) {
      const form = ctx.configForms.get(PLUGIN_ID)
      if (typeof ctx.inject === 'function') registerClaudePanel(ctx, form)

      function SlicePipelineSettings() {
        const snapshot = React.useSyncExternalStore(
          React.useCallback((listener) => form.subscribe(listener), []),
          React.useCallback(() => form.getSnapshot(), [])
        )
        const [catalog, setCatalog] = React.useState(null)
        const [catalogLoading, setCatalogLoading] = React.useState(true)
        const [catalogError, setCatalogError] = React.useState(null)
        const [claudeModels, setClaudeModels] = React.useState(null)
        const [draftStages, setDraftStages] = React.useState({ plan: '', slice: '' })
        const [draftMaxFixRounds, setDraftMaxFixRounds] = React.useState('3')
        const [draftMaxTurns, setDraftMaxTurns] = React.useState('120')
        const [draftTimeoutMinutes, setDraftTimeoutMinutes] = React.useState('30')
        const [draftFirstTimeoutMinutes, setDraftFirstTimeoutMinutes] = React.useState('10')
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
          let alive = true
          if (typeof fetch !== 'function') return undefined
          fetch('/plugins/' + PLUGIN_ID + '/claude-models', { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)))
            .then((payload) => { if (alive) setClaudeModels(payload) })
            .catch(() => { if (alive) setClaudeModels({ options: [], failed: true }) })
          return () => { alive = false }
        }, [])

        React.useEffect(() => {
          setDraftStages({
            plan: Array.isArray(stages.plan) ? stages.plan.join(', ') : '',
            slice: Array.isArray(stages.slice) ? stages.slice.join(', ') : ''
          })
          setDraftMaxFixRounds(String(maxFixRounds))
          setDraftMaxTurns(String(value.externalAgents?.maxTurns ?? 120))
          setDraftTimeoutMinutes(String(value.externalAgents?.timeoutMinutes ?? 30))
          setDraftFirstTimeoutMinutes(String(value.externalAgents?.firstResponseTimeoutMinutes ?? 10))
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

        const externalAgents = value.externalAgents || {}
        const writeExternal = (path, valueToWrite) => write([{ op: 'set', path: ['externalAgents', ...path], value: valueToWrite }])
        const externalRows = ['designer', 'reviewer'].map((role) => {
          const external = externalAgents[role] || {}
          const savedModel = typeof external.model === 'string' ? external.model : ''
          const modelOptions = (claudeModels?.options || []).map((option) => ({ ...option }))
          if (savedModel !== '' && !modelOptions.some((option) => option.value === savedModel)) {
            modelOptions.push({ value: savedModel, label: savedModel + '（当前保存值）' })
          }
          if (modelOptions.length === 0) {
            modelOptions.push({ value: '', label: claudeModels === null ? 'Claude CLI 默认（读取中…）' : 'Claude CLI 默认' })
          }
          const modelControl = claudeModels?.failed === true
            ? h('input', {
              style: styles.input,
              value: savedModel,
              placeholder: '例如 opus / sonnet / claude-opus-5-5',
              onBlur: (event) => writeExternal([role, 'model'], event.target.value.trim())
            })
            : h('select', {
              style: styles.select,
              value: savedModel,
              onChange: (event) => writeExternal([role, 'model'], event.target.value)
            }, modelOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
          return h('div', { key: 'external-' + role, style: styles.card, 'data-external-role': role },
            h('div', { style: styles.cardTitle }, role + ' · 外部 Claude'),
            h('label', { style: styles.toggle },
              h('input', {
                style: styles.checkbox,
                type: 'checkbox',
                checked: external.enabled === true,
                onChange: (event) => writeExternal([role, 'enabled'], event.target.checked)
              }),
              h('span', null, 'UseOutSideAgent')
            ),
            h('label', { style: styles.label }, 'CLI',
              h('select', {
                style: styles.select,
                value: external.cli || 'claude',
                onChange: (event) => writeExternal([role, 'cli'], event.target.value)
              }, h('option', { value: 'claude' }, 'Claude Code'))
            ),
            h('label', { style: styles.label }, 'Model',
              modelControl,
              claudeModels?.current
                ? h('div', { style: styles.muted },
                  '本机 CLI：' + (claudeModels.current.model || '未设置 model')
                  + (claudeModels.current.envModel ? '；ANTHROPIC_MODEL=' + claudeModels.current.envModel : '')
                  + (claudeModels.current.aliases?.opus ? '；opus → ' + claudeModels.current.aliases.opus : ''))
                : h('div', { style: styles.muted }, '留空 = 完全使用 Claude CLI 配置（settings.json / ANTHROPIC_MODEL / alias）')
            )
          )
        })

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
            h('label', { key: 'enabled', style: styles.toggle },
              h('input', {
                style: styles.checkbox,
                type: 'checkbox',
                checked: enabled,
                'data-field': 'modules.' + def.key + '.enabled',
                onChange: (event) => writeModuleEnabled(def.key, event.target.checked)
              }),
              h('span', null, '启用')
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
          h('h3', { style: styles.sectionTitle }, '外部 Agent（Designer / Reviewer）'),
          h('label', { style: styles.toggle },
            h('input', {
              style: styles.checkbox,
              type: 'checkbox',
              checked: externalAgents.autoOpen !== false,
              onChange: (event) => writeExternal(['autoOpen'], event.target.checked)
            }),
            h('span', null, '自动打开进度面板')
          ),
          h('label', { style: styles.toggle },
            h('input', {
              style: styles.checkbox,
              type: 'checkbox',
              checked: externalAgents.showThinking !== false,
              onChange: (event) => writeExternal(['showThinking'], event.target.checked)
            }),
            h('span', null, '显示 thinking')
          ),
          h('label', { style: styles.field }, '最大回合数（设计复杂任务建议 120+）',
            h('input', {
              style: styles.input,
              type: 'number',
              min: 1,
              value: draftMaxTurns,
              onChange: (event) => setDraftMaxTurns(event.target.value),
              onBlur: (event) => {
                const number = Number(event.target.value)
                if (Number.isInteger(number) && number > 0) {
                  writeExternal(['maxTurns'], number)
                } else {
                  setDraftMaxTurns(String(externalAgents.maxTurns ?? 120))
                }
              }
            })
          ),
          h('label', { style: styles.field }, '外部会话整体超时（分钟，默认 30）',
            h('input', {
              style: styles.input,
              type: 'number',
              min: 1,
              max: 1440,
              'data-field': 'externalAgents.timeoutMinutes',
              value: draftTimeoutMinutes,
              onChange: (event) => setDraftTimeoutMinutes(event.target.value),
              onBlur: (event) => {
                const minutes = Number(event.target.value)
                if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) {
                  writeExternal(['timeoutMinutes'], minutes)
                  setDraftTimeoutMinutes(String(minutes))
                } else {
                  setDraftTimeoutMinutes(String(externalAgents.timeoutMinutes ?? 30))
                }
              }
            })
          ),
          h('label', { style: styles.field }, '首个响应超时（分钟，默认 10）',
            h('input', {
              style: styles.input,
              type: 'number',
              min: 1,
              max: 240,
              'data-field': 'externalAgents.firstResponseTimeoutMinutes',
              value: draftFirstTimeoutMinutes,
              onChange: (event) => setDraftFirstTimeoutMinutes(event.target.value),
              onBlur: (event) => {
                const minutes = Number(event.target.value)
                if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 240) {
                  writeExternal(['firstResponseTimeoutMinutes'], minutes)
                  setDraftFirstTimeoutMinutes(String(minutes))
                } else {
                  setDraftFirstTimeoutMinutes(String(externalAgents.firstResponseTimeoutMinutes ?? 10))
                }
              }
            })
          ),
          h('label', { style: styles.field }, '外部 CLI effort',
            h('select', {
              style: styles.select,
              value: externalAgents.effortLevel || '',
              onChange: (event) => writeExternal(['effortLevel'], event.target.value)
            },
              h('option', { value: '' }, 'native 默认'),
              ...['low', 'medium', 'high', 'xhigh', 'max'].map((level) => h('option', { key: level, value: level }, level))
            )
          ),
          h('label', { style: styles.toggle },
            h('input', {
              style: styles.checkbox,
              type: 'checkbox',
              checked: externalAgents.showThinkingSummaries !== false,
              onChange: (event) => writeExternal(['showThinkingSummaries'], event.target.checked)
            }),
            h('span', null, '显示 thinking summaries')
          ),
          ...externalRows,
          h('p', { style: styles.effort },
            'MAX_THINKING_TOKENS / CLAUDE_CODE_EFFORT_LEVEL 属于 ~/.claude/settings.json 的 native env，不在本插件设置里；插件只控制 externalAgents 的启用、model、maxTurns、超时和开关。'),
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
