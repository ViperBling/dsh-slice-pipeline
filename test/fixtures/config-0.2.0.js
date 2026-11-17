import z from '@deepseek-ai/schemastery'

const ROLE_KEYS = ['default', 'designer', 'task', 'reviewer']
const DEFAULT_ROUTE = 'deepseek-official/deepseek-flash'
const routeSchema = () => z.string().pattern(/^[^/]+\/.+$/).volatile()

/** 插件自带的默认审查规范文件，相对 skill 资源目录。 */
const DEFAULT_REVIEW_STANDARD_PATH = 'review-standard.md'


/**
 * Plugin config schema.
 *
 * Roles are stored as `provider/model` route strings so every front door can
 * offer one flat, data-driven choice list. The skill-injection step expands
 * them back into `{ provider, model }` objects for the workflow script.
 */
export const ConfigV020 = z.object({
  roles: z.object({
    default: routeSchema().default(DEFAULT_ROUTE),
    designer: routeSchema().default(DEFAULT_ROUTE),
    task: routeSchema().default(DEFAULT_ROUTE),
    reviewer: routeSchema().default(DEFAULT_ROUTE)
  }).default({}),
  stages: z.object({
    plan: z.array(z.string()).default(['design', 'planReview']).volatile(),
    slice: z.array(z.string()).default(['brief', 'implement', 'codeReview', 'fix']).volatile()
  }).default({}),
  maxFixRounds: z.number().step(1).min(0).default(3).volatile(),
  reviewStandard: z.string().default(DEFAULT_REVIEW_STANDARD_PATH).volatile()
})
