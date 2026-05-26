import { parseDiff } from './diff-parser.js'
import { extractSymbolDelta } from './tree-sitter.js'
import { applySymbolDelta } from '../graph/writer.js'
import { generateAgentsMd } from '../agents/generator.js'
import { getLanguageForFile } from '../config/loader.js'
import type { RepoConfig } from '../config/schema.js'
import { getConfig } from '../config/loader.js'
import { writeChangeEvents } from '../temporal/tracker.js'
import { recomputeHotZones, getCurrentHotZones } from '../temporal/hotzone.js'
import { dispatchHotZoneAlerts } from '../temporal/alert.js'
import { writeTier1Events, type RawEvent } from '../memory/tier1.js'
import { resolveCallEdges } from './call-resolver.js'
import { detectModules } from './module-detector.js'

export async function processPushEvent(repo: RepoConfig, payload: Record<string, unknown>): Promise<void> {
  const t0 = Date.now()

  const commitMessage = (payload.head_commit as { message?: string })?.message ?? ''
  if (commitMessage.includes('[skip ci]') || commitMessage.includes('[brain]')) {
    console.info('[brain] skipping auto-generated commit')
    return
  }

  const commitSha = (payload.head_commit as { id: string }).id
  const timestamp = new Date((payload.head_commit as { timestamp: string }).timestamp)
  const author = (payload.head_commit as { author?: { name: string } })?.author?.name ?? 'unknown'

  console.info(`[brain] processing commit ${commitSha.slice(0, 7)} for ${repo.name}`)

  const changes = await parseDiff(repo, payload)
  console.info(`[brain] ${changes.length} source files changed`)

  const deltas = await Promise.all(
    changes.map(change => {
      const lang = getLanguageForFile(change.path, repo.languages)
      return extractSymbolDelta(change, lang, repo.path)
    })
  )

   const patchResult = await applySymbolDelta(repo.name, commitSha, deltas, timestamp)
   console.info(`[brain] graph patched in ${patchResult.durationMs}ms — ` +
     `+${patchResult.nodesUpserted} nodes, +${patchResult.edgesUpserted} edges`)

   // Phase 4+: resolve cross-file calls and detect modules
   resolveCallEdges(repo.name)
   detectModules(repo.name)

  // Phase 2: write tier-1 events
  const events: RawEvent[] = []
  for (const delta of deltas) {
    for (const sym of [...delta.added, ...delta.modified]) {
      events.push({
        repo: repo.name,
        commitSha,
        eventType: delta.added.includes(sym) ? 'symbol_added' : 'symbol_modified',
        payload: {
          fqn: `${repo.name}:${delta.file}:${sym.name}`,
          file: delta.file,
          kind: sym.kind,
        },
      })
    }
    for (const sym of delta.removed) {
      events.push({
        repo: repo.name,
        commitSha,
        eventType: 'symbol_removed',
        payload: {
          fqn: `${repo.name}:${delta.file}:${sym.name}`,
          file: delta.file,
          kind: sym.kind,
        },
      })
    }
  }
  if (events.length > 0) writeTier1Events(events)

  // Phase 3: write change events
  writeChangeEvents(repo.name, commitSha, author, deltas,
    changes.map(c => ({ path: c.path, additions: c.additions, deletions: c.deletions })))

  recomputeHotZones(repo.name).then(async hotZones => {
    if (hotZones.length > 0) {
      const config = getConfig()
      await dispatchHotZoneAlerts(config, repo.name, hotZones)
    }
    const currentHotZones = getCurrentHotZones(repo.name)
    await generateAgentsMd(
      repo.name, repo.path, commitSha,
      currentHotZones.map(z => ({ path: z.filePath, velocity: z.velocity })),
    )
    console.info(`[brain] AGENTS.md + hotZones done in ${Date.now() - t0}ms`)
  }).catch(err => {
    console.error('[brain/temporal]', err)
  })
}