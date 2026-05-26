import OpenAI from 'openai'
import { KUZU_DDL } from '../graph/schema.js'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY ?? '',
      baseURL: 'https://api.groq.com/openai/v1',
    })
  }
  return _client
}

const SCHEMA_CONTEXT = `
Graph Schema:
${KUZU_DDL.join('\n')}

Node types: File, Symbol, Commit, Module
Relationships: Calls, Imports, Exports, Touches, BelongsTo, Contains

Symbol properties: fqn (fully qualified name), kind, name, file, is_exported, decay_score, velocity
File properties: path, repo, language, decay_score, last_touched
`

export async function translateNLToCypher(question: string): Promise<string> {
  const client = getClient()

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 300,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `You are a Cypher query generator for a code knowledge graph.
${SCHEMA_CONTEXT}

Rules:
- Return ONLY valid Cypher query, no explanation
- Use MATCH for queries, never CREATE/MERGE
- Always include LIMIT clause (max 50)
- Use property filters like {repo: $repo} when needed
- For "who owns", look for Module nodes and BelongsTo edges
- For "what calls", use Calls edges
- For "impact of", use Calls edges with path traversal`,
      },
      { role: 'user', content: question },
    ],
  })

  const cypher = response.choices[0]?.message?.content?.trim() ?? ''
  return cypher.replace(/```cypher\n?/g, '').replace(/```\n?/g, '').trim()
}

export async function executeNLQuery(question: string, repo: string): Promise<string> {
  try {
    const cypher = await translateNLToCypher(question)
    return `Generated Cypher:\n${cypher}\n\nExecute this query against your graph database with repo parameter: ${repo}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
  }
}
