import { KUZU_DDL } from '../graph/schema.js'
import { query as queryLlm } from './engine.js'

const SCHEMA_CONTEXT = `
Graph Schema:
${KUZU_DDL.join('\n')}

Node types: File, Symbol, Commit, Module
Relationships: Calls, Imports, Exports, Touches, BelongsTo, Contains

Symbol properties: fqn (fully qualified name), kind, name, file, is_exported, decay_score, velocity
File properties: path, repo, language, decay_score, last_touched
`

export async function translateNLToCypher(question: string): Promise<string> {
  const cypher = await queryLlm(`You are a Cypher query generator for a code knowledge graph.
${SCHEMA_CONTEXT}

Rules:
- Return ONLY valid Cypher query, no explanation
- Use MATCH for queries, never CREATE/MERGE
- Always include LIMIT clause (max 50)
- Use property filters like {repo: $repo} when needed
- For "who owns", look for Module nodes and BelongsTo edges
- For "what calls", use Calls edges
- For "impact of", use Calls edges with path traversal`, question, { maxTokens: 300, temperature: 0.1 })

  return cypher.replace(/```cypher\n?/g, '').replace(/```\n?/g, '').trim()
}

export async function executeNLQuery(question: string, repo: string): Promise<string> {
  try {
    const cypher = await translateNLToCypher(question)
    const { getKuzuClient } = await import('../graph/client.js')
    const db = getKuzuClient()
    const results = await db.query(cypher, { repo })
    return JSON.stringify(results, null, 2)
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
  }
}
