import { translateNLToCypher } from '../query/nl-to-cypher.js'
import { initKuzu, getKuzuClient } from '../graph/client.js'
import { computeRippleImpact, formatImpactReport } from '../query/ripple.js'
import path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { getBrainDir } from '../config/paths.js'

export async function queryCommand(cwd: string, question: string, repo?: string): Promise<void> {
  const brainDir = getBrainDir(cwd)
  initKuzu(brainDir)
  const config = await loadConfig(cwd)
  const selectedRepo = repo ?? process.env.BRAIN_REPO ?? config.repos[0]?.name ?? path.basename(cwd)

  if (question.toLowerCase().includes('impact') || question.toLowerCase().includes('ripple')) {
    const fqnMatch = question.match(/['"`]([^'"`]+)['"`]/)
    if (fqnMatch) {
      const report = await formatImpactReport(fqnMatch[1])
      console.log(report)
      return
    }
  }

  try {
    const cypher = await translateNLToCypher(question)
    console.log(`\n[Generated Cypher]\n${cypher}\n`)

    const db = getKuzuClient()
    const result = await db.query(cypher, { repo: selectedRepo })
    
    console.log(`[Results]`)
    console.table(result)
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'GROQ_API_KEY_MISSING') throw err
    console.error('[Error]', err instanceof Error ? err.message : 'Unknown error')
  }
}
