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
import { detectModules } from './module-detector.js'
import { commentOnPR } from '../automation/pr-commenter.js'
import { reviewCommit } from '../automation/code-reviewer.js'

export async function processPushEvent(repo: RepoConfig, payload: Record<string, unknown>): Promise<void> {
  const t0 = Date.now()

  const isPR = !!(payload.pull_request)
  const headCommit = payload.head_commit as Record<string, unknown> ?? {}
  const prPayload = payload.pull_request as Record<string, unknown> ?? {}

  const commitSha = isPR
    ? (prPayload.head as Record<string, unknown>)?.sha as string
    : headCommit.id as string
  const timestamp = isPR
    ? new Date((prPayload.updated_at as string) ?? Date.now())
    : new Date(headCommit.timestamp as string)
  const author = isPR
    ? ((prPayload.user as Record<string, unknown>)?.login as string) ?? 'unknown'
    : ((headCommit.author as Record<string, unknown>)?.name as string) ?? 'unknown'
  const commitMessage = isPR ? `PR #${prPayload.number}: ${prPayload.title as string}` : (headCommit.message as string) ?? ''

  if (commitMessage.includes('[skip ci]') || commitMessage.includes('[brain]')) {
    console.info('[brain] skipping auto-generated commit')
    return
  }

  console.info(`[brain] processing commit ${commitSha.slice(0, 7)} for ${repo.name}`)

  const changes = await parseDiff(repo, payload, commitSha)
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

  // Phase 4+: detect modules
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

    const prNumber = (payload.pull_request as { number?: number })?.number
    if (prNumber) {
      commentOnPR(repo, prNumber, commitSha).catch(err =>
        console.error('[brain/automation] PR comment failed:', err)
      )
    }

    if (process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY) {
      const patchContent = changes.map(c => c.patch ?? '').filter(Boolean).join('\n---\n')
      if (patchContent) {
        reviewCommit(repo, commitSha, patchContent).then(result => {
          console.info(`[brain/code-review] ${result.summary}`)
          if (result.risks.length > 0) {
            console.warn('[brain/code-review] risks:', result.risks.join(', '))
          }
        }).catch(err => console.error('[brain/code-review] error:', err))
      }
    }

    console.info(`[brain] AGENTS.md + hotZones done in ${Date.now() - t0}ms`)
  }).catch(err => {
    console.error('[brain/temporal]', err)
  })
}