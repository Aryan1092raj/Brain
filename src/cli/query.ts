import { translateNLToCypher } from '../query/nl-to-cypher.js'
import { initKuzu, getKuzuClient } from '../graph/client.js'
import { computeRippleImpact, formatImpactReport } from '../query/ripple.js'
import path from 'node:path'

export async function queryCommand(question: string, repo: string): Promise<void> {
  const brainDir = path.join(process.cwd(), '.brain')
  initKuzu(brainDir)

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
    const result = await db.query(cypher, { repo })
    
    console.log(`[Results]`)
    console.table(result)
  } catch (err) {
    console.error('[Error]', err instanceof Error ? err.message : 'Unknown error')
  }
}
