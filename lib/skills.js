import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SKILL_MODULES } from './config.js'
import { fileExists, resolveModules } from './paths.js'
import { PIPELINE_HEADING, renderPipelineBlock, renderModuleBlock } from './inject.js'
import { pipelineToolStatus } from './pipeline-tool.js'

const name = 'dsh-slice-pipeline'

/** Registry precedence for packaged skill providers: lower than user/project local roots. */
const PACKAGED_SKILL_RANK = 550

/** The source bucket these skills advertise under (prompt-visible metadata). */
const SOURCE = 'custom'

/**
 * Parse the YAML frontmatter block of a SKILL.md into metadata plus body.
 * Handles only the scalar fields DSH skill discovery consumes (name,
 * description, whenToUse); richer metadata passes through verbatim.
 * @param text - the raw skill file contents.
 * @returns parsed metadata object and the markdown body after the block, or
 *   null when the file has no frontmatter block at all.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
  }
  return { metadata, body }
}

/**
 * Read and parse one skill directory's SKILL.md.
 * @param skillFile - absolute path to the SKILL.md file.
 * @param signal - optional cancellation; aborts the read.
 * @returns the parsed skill record, or undefined when the file vanished.
 */
async function parseSkillFile(skillFile, signal) {
  let text
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseFrontmatter(text)
  if (parsed === null) return undefined
  return {
    name: parsed.metadata.name ?? '',
    description: parsed.metadata.description ?? '',
    whenToUse: parsed.metadata.whenToUse,
    metadata: parsed.metadata,
    content: parsed.body
  }
}

/**
 * Discover packaged skill candidates by scanning the package's `skills/`
 * directory: one subdirectory per skill, each carrying a SKILL.md.
 * @param skillsRoot - absolute path to this package's skills directory.
 * @param signal - optional cancellation.
 * @returns the candidate list.
 */
async function discoverCandidates(skillsRoot, signal) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    const parsed = await parseSkillFile(skillFile, signal)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: SOURCE,
      provider: name,
      rank: PACKAGED_SKILL_RANK,
      locator: skillDir,
      path: skillFile,
      ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {})
    })
  }
  return candidates
}

/** Create a provider that reads live plain config on each catalog/load request. */
export function createSkillProvider({ name, pluginRoot, getConfig, exists = fileExists, resolve = resolveModules }) {
  return {
    name,
    async list(options) {
      const candidates = await discoverCandidates(join(pluginRoot, 'skills'), options?.signal)
      const config = getConfig()
      return candidates.filter((candidate) => {
        const key = SKILL_MODULES[basename(candidate.locator)]
        return key === undefined || config.modules[key].enabled === true
      })
    },
    async get(candidate, options) {
      const key = SKILL_MODULES[basename(candidate.locator)]
      const config = getConfig()
      if (key !== undefined && config.modules[key].enabled !== true) return undefined
      const parsed = await parseSkillFile(candidate.path, options?.signal)
      if (parsed === undefined) return undefined
      let block = ''
      if (key !== undefined) {
        try {
          const states = await resolve(config, { pluginRoot, exists })
          block = key === 'pipeline'
            ? renderPipelineBlock(config, states, { pluginRoot, toolStatus: pipelineToolStatus() })
            : renderModuleBlock(key, config, states, { pluginRoot })
        } catch (error) {
          const message = error?.message ?? String(error)
          block = '\n\n' + PIPELINE_HEADING + '\n\n- 警告：配置注入失败：' + message + '\n'
        }
      }
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SOURCE,
        provider: name,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
        content: parsed.content + block
      }
    }
  }
}
