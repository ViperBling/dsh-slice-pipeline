import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { MODULE_DEFS, MODULE_KEYS, LEGACY_REVIEW_STANDARD_ALIASES, getConfigPath } from './config.js'

export function cleanPathInput(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text.length >= 2 && (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  )) text = text.slice(1, -1)
  return text.trim()
}

export function isContentLike(text) {
  return text.includes('\r') || text.includes('\n') || text.trimStart().startsWith('#') || text.length > 400
}

export function toSlash(p) {
  return p.replaceAll('\\', '/')
}

export async function fileExists(abs) {
  try {
    return (await stat(abs)).isFile()
  } catch {
    return false
  }
}

export async function resolveDocPath(value, {
  defaultPath, aliases = [], pluginRoot, legacyBase, exists = fileExists
}) {
  const text = cleanPathInput(value)
  const fixed = async (abs, source, warning) => {
    const path = toSlash(abs)
    const result = { path, exists: await exists(path), source }
    if (warning !== undefined) result.warning = warning
    return result
  }

  if (!text) return fixed(resolve(pluginRoot, toSlash(defaultPath)), 'default')
  if (isContentLike(text)) {
    return fixed(resolve(pluginRoot, toSlash(defaultPath)), 'default',
      `检测到旧版内容型配置（不是文件路径），已改用默认文件 ${defaultPath}；请把内容保存为文件并填写路径。`)
  }

  const slash = toSlash(text)
  if (aliases.some((alias) => toSlash(alias).toLowerCase() === slash.toLowerCase())) {
    return fixed(resolve(pluginRoot, toSlash(defaultPath)), 'alias')
  }
  if (slash.startsWith('~/')) return fixed(join(homedir(), slash.slice(2)), 'home')
  if (isAbsolute(slash)) return fixed(slash, 'absolute')

  const pluginPath = toSlash(resolve(pluginRoot, slash))
  if (await exists(pluginPath)) return { path: pluginPath, exists: true, source: 'plugin-root' }
  const legacyPath = toSlash(resolve(legacyBase, slash))
  if (await exists(legacyPath)) {
    return {
      path: legacyPath, exists: true, source: 'legacy-dir',
      warning: `相对路径 ${text} 在插件根目录不存在，已改用旧位置 skills/slice-pipeline/${text}。`
    }
  }
  return { path: pluginPath, exists: false, source: 'plugin-root' }
}

export async function resolveModules(config, { pluginRoot, exists = fileExists }) {
  const modules = {}
  for (const key of MODULE_KEYS) {
    const def = MODULE_DEFS[key]
    const state = { enabled: true, role: def.role, status: 'ok', docs: {}, missing: [], warnings: [] }
    modules[key] = state
    try {
      const module = config?.modules?.[key]
      state.enabled = module?.enabled ?? true
      state.role = def.role === null ? null : module?.role ?? def.role
      const legacyBase = join(pluginRoot, 'skills', 'slice-pipeline')
      for (const [docKey, doc] of Object.entries(def.docs)) {
        // A null configPath (pipeline.script) always uses the bundled default.
        const value = doc.configPath === null ? '' : getConfigPath(config, doc.configPath)
        const result = await resolveDocPath(value, {
          defaultPath: doc.defaultPath,
          aliases: key === 'review' ? LEGACY_REVIEW_STANDARD_ALIASES : [],
          pluginRoot, legacyBase, exists
        })
        state.docs[docKey] = result.path
        if (!result.exists) state.missing.push(result.path)
        if (result.warning !== undefined) state.warnings.push(result.warning)
      }
      if (state.missing.length) state.status = 'missingDoc'
    } catch (error) {
      state.status = 'missingDoc'
      state.warnings.push(`路径解析失败：${error?.message ?? String(error)}`)
    }
    if (!state.enabled) state.status = 'disabled'
  }
  return modules
}
