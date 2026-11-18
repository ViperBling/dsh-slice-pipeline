import { resolve } from 'node:path'
import { ROLE_KEYS, MODULE_KEYS, MODULE_DEFS, INDEX_PATH, DISPATCH_GUIDE_PATH, PLAIN_LANGUAGE_PATH, splitRoute } from './config.js'
import { toSlash } from './paths.js'

export const PIPELINE_HEADING = '## 当前插件配置（由 dsh-slice-pipeline 注入）'
export const MODULE_HEADING = '## 当前模块配置（由 dsh-slice-pipeline 注入）'

/** Project resolved modules into the workflow payload; keep warnings in prose only. */
export function buildPipelineArgs(config, states, pluginRoot) {
  return {
    roles: Object.fromEntries(ROLE_KEYS.map((role) => [role, splitRoute(config.roles[role])])),
    stages: config.stages,
    maxFixRounds: config.maxFixRounds,
    reviewStandardPath: states.review.docs.standard ?? null,
    // 子智能体派发的 reasoning effort：只注入非空项，避免空配置撑大注入块。
    reasoningEfforts: Object.fromEntries(Object.entries(config.reasoningEfforts || {})
      .filter(([, value]) => typeof value === 'string' && value !== '')),
    ...(config.externalAgents?.designer?.enabled === true || config.externalAgents?.reviewer?.enabled === true
      ? { externalAgents: config.externalAgents }
      : {}),
    // 产出文档语言规范：宿主给出绝对路径，workflow prompt 直接引用（规则只有一份）。
    plainLanguagePath: pluginRoot ? toSlash(resolve(pluginRoot, PLAIN_LANGUAGE_PATH)) : PLAIN_LANGUAGE_PATH,
    modules: Object.fromEntries(MODULE_KEYS.map((key) => {
      const state = states[key]
      // reviewer 的运行时规范已经由 reviewStandardPath 顶层注入；dispatch 只给模块块显示，
      // 不进 workflow args，避免重复撑大 3,500 字节的注入块。
      const docs = (key === 'review')
        ? Object.fromEntries(Object.entries(state.docs).filter(([docKey]) => docKey !== 'dispatch'))
        : state.docs
      return [key, {
        enabled: state.enabled,
        ...(key === 'pipeline' ? {} : { role: state.role }),
        status: state.status,
        docs,
        ...(state.missing.length ? { missing: state.missing } : {})
      }]
    }))
  }
}

/** Single-line values, except the modules object with one module per line. */
export function renderArgsJson(args) {
  const entries = Object.entries(args)
  const lines = ['{']
  entries.forEach(([key, value], index) => {
    const comma = index < entries.length - 1 ? ',' : ''
    if (key === 'modules') {
      lines.push('  "modules": {')
      const modules = Object.entries(value)
      modules.forEach(([moduleKey, module], moduleIndex) => {
        const suffix = moduleIndex < modules.length - 1 ? ',' : ''
        lines.push(`    ${JSON.stringify(moduleKey)}: ${JSON.stringify(module)}${suffix}`)
      })
      lines.push(`  }${comma}`)
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`)
    }
  })
  lines.push('}')
  return lines.join('\n')
}

function renderDocPath(state, docKey) {
  const path = state.docs[docKey]
  if (path == null) return '（未解析）'
  return '`' + path + '`' + (state.missing.includes(path) ? '（缺失）' : '')
}

export function renderPipelineBlock(
  config,
  states,
  { pluginRoot, toolStatus = { ok: false, reason: 'not attempted' } }
) {
  const warnings = MODULE_KEYS.flatMap((key) => states[key].warnings.map(
    (warning) => `${MODULE_DEFS[key].title}：${warning}`
  ))
  const toolLine = toolStatus?.ok === true
    ? '- 工具 slice_pipeline_run：已注册（首选路径；下面的 workflow 脚本与 args JSON 仅手工内联回退时使用）'
    : `- 工具 slice_pipeline_run：未注册（原因：${toolStatus?.reason ?? 'not attempted'}）。若刚升级插件请完整重启 Desktop / dsh-tui；重启后仍未注册就把这条原因告诉用户。`
  const lines = [
    PIPELINE_HEADING, '',
    `- workflow 脚本（仅手工内联回退时使用）：${renderDocPath(states.pipeline, 'script')}（read 后原样作为 workflow 工具的 script 传入；首选路径用 slice_pipeline_run 工具，不要读脚本）`,
    `- 文档索引：\`${toSlash(resolve(pluginRoot, INDEX_PATH))}\``,
    toolLine,
    '- 下面的 JSON：首选路径下不要用它拼工具参数（工具会自行注入配置）；仅手工内联回退时作为 workflow args 传入；读取其中的路径（如 modules.planning.docs.standard）是允许的。',
    '- 规范文件由子代理按 JSON 中的绝对路径自行读取；不要读取规范内容再传 reviewStandard。',
    '- 读不到文件时报告该路径；禁止 find / 或扫描盘符。'
  ]
  if (warnings.length) lines.push(`- 警告：${warnings.join('；')}`)
  lines.push('', '```json', renderArgsJson(buildPipelineArgs(config, states, pluginRoot)), '```')
  return '\n\n' + lines.join('\n')
}

export function renderModuleBlock(moduleKey, config, states, { pluginRoot }) {
  const def = MODULE_DEFS[moduleKey]
  const state = states[moduleKey]
  const lines = [MODULE_HEADING, '', `- 模块：${def.title}（${moduleKey}）· 状态：${state.status}`]
  if (state.role !== null) {
    const route = splitRoute(config.roles[state.role])
    lines.push(`- 派发角色：${state.role} → ${route.provider}/${route.model}（仅派发子代理时使用，不切换当前会话模型）`)
  }
  for (const [docKey, doc] of Object.entries(def.docs)) {
    lines.push(`- ${doc.label}：${renderDocPath(state, docKey)}`)
  }
  for (const relatedKey of def.related) {
    const related = states[relatedKey]
    lines.push(`- 相关模块 ${MODULE_DEFS[relatedKey].title}（${related.status}）：${renderDocPath(related, 'standard')}`)
  }
  if (def.dispatchGuide) {
    lines.push(`- 人工派发约定：\`${toSlash(resolve(pluginRoot, DISPATCH_GUIDE_PATH))}\``)
  }
  lines.push(
    `- 文档索引：\`${toSlash(resolve(pluginRoot, INDEX_PATH))}\``,
    '- 只按上述绝对路径读取；读不到时报告该路径，禁止 find / 或扫描盘符。'
  )
  if (state.warnings.length) lines.push(`- 警告：${state.warnings.join('；')}`)
  return '\n\n' + lines.join('\n')
}

