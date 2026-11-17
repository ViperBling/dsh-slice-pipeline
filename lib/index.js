// dsh-slice-pipeline: slice-pipeline skill provider + settings for the DeepSeek Harness.
//
// Host half:
//   - registers one skill provider into the HOST layer of `ctx.skills`;
//   - resolves the six module configs and injects each Skill's absolute doc
//     paths plus the slice-pipeline args JSON (roles / stages / maxFixRounds /
//     modules / reviewStandardPath);
//   - invalidates the skill catalog on loader/volatile-update, and when the
//     dsh-tui `tuiSettingsSections` seam is present, registers a native
//     settings section whose provider/model choices are read from the live
//     DSH llm registry instead of being hardcoded.
//
// The browser half lives in ./client.js and registers a web/desktop settings
// tab that reads the same plugin config and the DSH model catalog.
//
// @module dsh-slice-pipeline
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Config, readConfig } from './config.js'
import { createSkillProvider } from './skills.js'
import { registerPipelineTool, pipelineToolStatus } from './pipeline-tool.js'
import { registerTuiSettings } from './tui.js'

const name = 'dsh-slice-pipeline'
const inject = ['skills', 'llm']

/**
 * Host plugin entry.
 * @param ctx - Cordis context.
 * @param rawConfig - Loader-resolved plugin config.
 */
async function apply(ctx, rawConfig) {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const currentConfig = () => readConfig(rawConfig)
  let invalidate

  ctx.skills.registerProvider((control) => {
    invalidate = control.invalidate
    return createSkillProvider({ name, pluginRoot, getConfig: currentConfig })
  })
  ctx.on('loader/volatile-update', () => invalidate())

  ctx.inject(['tools', 'workflowEngine'], (child) => {
    child.effect(
      () => registerPipelineTool(child, { pluginRoot, getConfig: currentConfig }),
      'dsh-slice-pipeline: pipeline tool'
    )
  })

  const status = pipelineToolStatus()
  if (status.ok) {
    ctx.logger?.info?.('dsh-slice-pipeline: slice_pipeline_run registered')
  } else {
    ctx.logger?.warn?.('dsh-slice-pipeline: slice_pipeline_run NOT registered: ' + status.reason)
  }

  ctx.inject(['tuiSettingsSections'], (child) => {
    child.effect(
      () => registerTuiSettings(ctx, child.tuiSettingsSections, currentConfig),
      'dsh-slice-pipeline: tui settings section'
    )
  })
}

export { Config } from './config.js'
export { apply, inject, name }
export default { Config, apply, inject, name }
