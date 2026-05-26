import { getKuzuClient } from '../graph/client.js'

export interface ImpactedSymbol {
  fqn: string
  file: string
  kind: string
  decayScore: number
  depth: number
}

export async function computeRippleImpact(symbolFqn: string, maxDepth = 5): Promise<ImpactedSymbol[]> {
  const db = getKuzuClient()

  const result = await db.query<{
    fqn: string
    file: string
    kind: string
    decay_score: number
    depth: number
  }>(`
    MATCH path = (s:Symbol {fqn: $fqn})-[:Calls*1..${maxDepth}]-(affected:Symbol)
    WHERE s.fqn <> affected.fqn
    RETURN DISTINCT 
      affected.fqn AS fqn,
      affected.file AS file,
      affected.kind AS kind,
      affected.decay_score AS decay_score,
      length(path) AS depth
    ORDER BY decay_score DESC, depth ASC
    LIMIT 100
  `, { fqn: symbolFqn })

  return result.map(r => ({
    fqn: r.fqn,
    file: r.file,
    kind: r.kind,
    decayScore: r.decay_score,
    depth: r.depth,
  }))
}

export async function formatImpactReport(symbolFqn: string): Promise<string> {
  const impacts = await computeRippleImpact(symbolFqn)
  
  if (impacts.length === 0) {
    return `No downstream dependencies found for ${symbolFqn}`
  }

  const lines = [
    `# Impact Analysis: ${symbolFqn}`,
    ``,
    `Found ${impacts.length} affected symbols:`,
    ``,
  ]

  const byFile = impacts.reduce<Record<string, ImpactedSymbol[]>>((acc, sym) => {
    if (!acc[sym.file]) acc[sym.file] = []
    acc[sym.file].push(sym)
    return acc
  }, {})

  for (const [file, syms] of Object.entries(byFile)) {
    lines.push(`## ${file}`)
    for (const sym of syms) {
      const severity = sym.decayScore > 0.7 ? '🔴' : sym.decayScore > 0.4 ? '🟡' : '🟢'
      lines.push(`- ${severity} \`${sym.kind}\` **${sym.fqn.split(':').pop()}** (depth: ${sym.depth}, stability: ${sym.decayScore.toFixed(2)})`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
