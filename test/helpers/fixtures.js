import { MODULE_DEFS, MODULE_KEYS } from '../../lib/config.js'

export const DESKTOP_CONFIG = {
  stages: { plan: ['design'], slice: ['brief', 'implement', 'codeReview', 'fix'] },
  roles: {
    default: 'deepseek-official/deepseek-v4.1-flash',
    designer: 'paper-openai/gpt-6.1-sol',
    task: 'deepseek-official/deepseek-v4.1-flash',
    reviewer: 'paper-anthropic/claude-opus-5-5'
  },
  reviewStandard: 'review-standard.md',
  maxFixRounds: 3
}

export const ROLES = {
  default: { provider: 'pd', model: 'md' },
  designer: { provider: 'pdes', model: 'mdes' },
  task: { provider: 'ptask', model: 'mtask' },
  reviewer: { provider: 'prev', model: 'mrev' }
}

const slash = (path) => path.replaceAll(String.fromCharCode(92), '/')

export function existsFrom(paths) {
  const set = new Set(paths.map(slash))
  return async (path) => set.has(slash(path))
}

export function fakeModules(overrides = {}) {
  return Object.fromEntries(MODULE_KEYS.map((key) => {
    const def = MODULE_DEFS[key]
    const module = {
      enabled: true,
      ...(def.role === null ? {} : { role: def.role }),
      status: 'ok',
      docs: Object.fromEntries(Object.entries(def.docs).map(([docKey, doc]) => [
        docKey, `C:/p/${doc.defaultPath}`
      ]))
    }
    return [key, { ...module, ...overrides[key] }]
  }))
}
