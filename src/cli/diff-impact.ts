import path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { initKuzu } from '../graph/client.js'
import { initSqlite } from '../memory/db.js'
import { computeLocalDiffImpact } from '../query/diff-impact.js'

export async function diffImpactCommand(cwd: string, _argv: string[]): Promise<void> {
  const brainDir = path.join(cwd, '.brain')
  initKuzu(brainDir)
  initSqlite(brainDir)

  const config = await loadConfig(cwd)
  const repo = process.env.BRAIN_REPO ?? config.repos[0]?.name ?? path.basename(cwd)

  console.info(`[brain] Analyzing local diff impact for repo: ${repo}`)

  const impacts = await computeLocalDiffImpact(cwd, repo)

  if (impacts.length === 0) {
    console.info('No uncommitted modifications found or no containing symbols affected.')
    return
  }

  for (const fileImpact of impacts) {
    console.log(`\n=========================================`)
    console.log(`File: ${fileImpact.filePath}`)
    console.log(`=========================================`)

    for (const sym of fileImpact.symbols) {
      console.log(`\nModified Symbol: ${sym.kind} ${sym.symbolFqn.split(':').pop()} (lines ${sym.lineStart}-${sym.lineEnd})`)
      if (sym.ripple.length === 0) {
        console.log(`  └─ No downstream impact detected.`)
      } else {
        console.log(`  └─ Downstream Impact:`)
        for (const rip of sym.ripple) {
          const severity = rip.decayScore > 0.7 ? '🔴' : rip.decayScore > 0.4 ? '🟡' : '🟢'
          console.log(`     - ${severity} ${rip.kind} ${rip.fqn.split(':').pop()} (depth: ${rip.depth}, stability: ${rip.decayScore.toFixed(2)})`)
        }
      }
    }
  }
}
