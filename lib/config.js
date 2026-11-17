import z from '@deepseek-ai/schemastery'

export const ROLE_KEYS = ['default', 'designer', 'task', 'reviewer']
export const DEFAULT_ROUTE = 'deepseek-official/deepseek-flash'
export const DEFAULT_REVIEW_STANDARD_PATH = 'docs/review/review-standard.md'
export const DEFAULT_REVIEW_DISPATCH_PATH = 'docs/review/review-dispatch.md'
export const LEGACY_REVIEW_STANDARD_ALIASES = ['review-standard.md', './review-standard.md']
export const INDEX_PATH = 'docs/INDEX.md'
export const DISPATCH_GUIDE_PATH = 'docs/shared/dispatch-guide.md'
export const PLAIN_LANGUAGE_PATH = 'docs/shared/plain-language.md'
export const MODULE_KEYS = ['pipeline', 'planning', 'patchDelivery', 'workspaceRecovery', 'review', 'diagrams']

export const MODULE_DEFS = {
  pipeline: {
    skill: 'slice-pipeline', title: 'Slice Pipeline 流水线', role: null,
    docs: {
      script: { label: 'workflow 脚本', defaultPath: 'skills/slice-pipeline/slice-pipeline.js', configPath: null }
    },
    related: [], dispatchGuide: false
  },
  planning: {
    skill: 'slice-planning', title: '规划与切片', role: 'designer',
    docs: {
      standard: {
        label: '规范文件', defaultPath: 'docs/planning/standard.md',
        configPath: ['modules', 'planning', 'standardPath']
      }
    },
    related: ['review', 'diagrams'], dispatchGuide: true
  },
  patchDelivery: {
    skill: 'slice-patch-delivery', title: '补丁交付', role: 'task',
    docs: {
      standard: {
        label: '规范文件', defaultPath: 'docs/patch-delivery/standard.md',
        configPath: ['modules', 'patchDelivery', 'standardPath']
      },
      template: {
        label: '薄文档模板', defaultPath: 'docs/patch-delivery/thin-document-template.md',
        configPath: ['modules', 'patchDelivery', 'templatePath']
      }
    },
    related: ['workspaceRecovery', 'review'], dispatchGuide: false
  },
  workspaceRecovery: {
    skill: 'slice-workspace-recovery', title: '工作区恢复', role: 'default',
    docs: {
      standard: {
        label: '规范文件', defaultPath: 'docs/workspace-recovery/standard.md',
        configPath: ['modules', 'workspaceRecovery', 'standardPath']
      }
    },
    related: [], dispatchGuide: false
  },
  review: {
    skill: 'slice-review', title: '审查', role: 'reviewer',
    docs: {
      standard: {
        label: '审查运行时规范（reviewer 读取）', defaultPath: DEFAULT_REVIEW_STANDARD_PATH,
        configPath: ['reviewStandard']
      },
      dispatch: {
        label: '审查派发与闭环规范（Lead 读取）', defaultPath: DEFAULT_REVIEW_DISPATCH_PATH,
        configPath: ['reviewDispatch']
      }
    },
    related: [], dispatchGuide: true
  },
  diagrams: {
    skill: 'slice-diagrams', title: '制图', role: 'designer',
    docs: {
      standard: {
        label: '规范文件', defaultPath: 'docs/diagrams/standard.md',
        configPath: ['modules', 'diagrams', 'standardPath']
      }
    },
    related: [], dispatchGuide: false
  }
}

export const SKILL_MODULES = Object.fromEntries(
  MODULE_KEYS.map((key) => [MODULE_DEFS[key].skill, key])
)

const routeSchema = () => z.string().pattern(/^[^/]+[/].+$/).volatile()
const moduleSchemas = Object.fromEntries(MODULE_KEYS.map((key) => {
  const def = MODULE_DEFS[key]
  const fields = { enabled: z.boolean().default(true).volatile() }
  if (def.role !== null) fields.role = z.union(ROLE_KEYS).default(def.role).volatile()
  for (const doc of Object.values(def.docs)) {
    if (doc.configPath?.[0] === 'modules' && doc.configPath[1] === key) {
      fields[doc.configPath[2]] = z.string().default(doc.defaultPath).volatile()
    }
  }
  return [key, z.object(fields).default({})]
}))

export const Config = z.object({
  roles: z.object({
    default: routeSchema().default(DEFAULT_ROUTE),
    designer: routeSchema().default(DEFAULT_ROUTE),
    task: routeSchema().default(DEFAULT_ROUTE),
    reviewer: routeSchema().default(DEFAULT_ROUTE)
  }).default({}),
  stages: z.object({
    plan: z.array(z.string()).default(['design']).volatile(),
    slice: z.array(z.string()).default(['brief', 'implement', 'codeReview', 'fix']).volatile()
  }).default({}),
  maxFixRounds: z.number().step(1).min(0).default(3).volatile(),
  reviewStandard: z.string().default(DEFAULT_REVIEW_STANDARD_PATH).volatile(),
  reviewDispatch: z.string().default(DEFAULT_REVIEW_DISPATCH_PATH).volatile(),
  // 子智能体派发的 reasoning effort（空 = 用模型默认）。当前 Lead 侧 subagent 会读取。
  reasoningEfforts: z.object({
    default: z.string().default('').volatile(),
    designer: z.string().default('').volatile(),
    task: z.string().default('').volatile(),
    reviewer: z.string().default('').volatile()
  }).default({}),
  designProvenance: z.union(['enforce', 'warn', 'off']).default('enforce').volatile(),
  modules: z.object(moduleSchemas).default({})
})

/** Read a volatile leaf or return an already-plain value. */
export function readValue(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/** Project live or plain config into the shared config model without resolving paths. */
export function readConfig(raw) {
  const config = raw ?? {}
  const modules = Object.fromEntries(MODULE_KEYS.map((key) => {
    const def = MODULE_DEFS[key]
    const module = config.modules?.[key]
    const fields = { enabled: readValue(module?.enabled) ?? true }
    if (def.role !== null) fields.role = readValue(module?.role) ?? def.role
    for (const doc of Object.values(def.docs)) {
      if (doc.configPath?.[0] === 'modules' && doc.configPath[1] === key) {
        const field = doc.configPath[2]
        fields[field] = readValue(module?.[field]) ?? doc.defaultPath
      }
    }
    return [key, fields]
  }))
  return {
    roles: Object.fromEntries(ROLE_KEYS.map((role) => [
      role, readValue(config.roles?.[role]) ?? DEFAULT_ROUTE
    ])),
    stages: {
      plan: readValue(config.stages?.plan) ?? ['design'],
      slice: readValue(config.stages?.slice) ?? ['brief', 'implement', 'codeReview', 'fix']
    },
    maxFixRounds: readValue(config.maxFixRounds) ?? 3,
    reviewStandard: readValue(config.reviewStandard) ?? DEFAULT_REVIEW_STANDARD_PATH,
    reviewDispatch: readValue(config.reviewDispatch) ?? DEFAULT_REVIEW_DISPATCH_PATH,
    reasoningEfforts: Object.fromEntries(['default', 'designer', 'task', 'reviewer'].map((role) => [
      role, readValue(config.reasoningEfforts?.[role]) ?? ''
    ])),
    designProvenance: readValue(config.designProvenance) ?? 'enforce',
    modules
  }
}

/** Split at the first slash; keep legacy behavior for missing provider/model parts. */
export function splitRoute(route) {
  const text = typeof route === 'string' ? route : ''
  const index = text.indexOf('/')
  if (index <= 0) return { provider: text, model: '' }
  return { provider: text.slice(0, index), model: text.slice(index + 1) }
}

/** Walk the plain config; missing intermediate keys yield undefined. */
export function getConfigPath(config, path) {
  return path.reduce((value, key) => value?.[key], config)
}
