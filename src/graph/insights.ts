import { getKuzuClient } from './client.js'
import { getDb } from '../memory/db.js'

export interface GraphNode {
  id: string
  label: string
  type: 'symbol' | 'file'
  kind?: string
  file?: string
  lineStart?: number
  exported?: boolean
  velocity?: number
  decayScore?: number
}

export interface GraphEdge {
  source: string
  target: string
  type: 'calls' | 'contains'
}

export interface DeadCodeCandidate {
  fqn: string
  name: string
  kind: string
  file: string
  lineStart: number
  incomingCalls: number
  touchCount: number
  reason: string
}

export interface GraphOverview {
  nodes: GraphNode[]
  edges: GraphEdge[]
  deadCode: DeadCodeCandidate[]
  metrics: {
    nodeCount: number
    edgeCount: number
    deadCodeCount: number
  }
}

interface SymbolRow {
  fqn: string
  name: string
  kind: string
  file: string
  exported: boolean
  lineStart: number
  velocity: number
  decayScore: number
}

interface CallRow {
  source: string
  target: string
}

export async function getGraphOverview(repo: string, limit = 90): Promise<GraphOverview> {
  const kuzu = getKuzuClient()

  const symbols = await kuzu.query<SymbolRow>(`
    MATCH (s:Symbol {repo: $repo})
    RETURN
      s.fqn AS fqn,
      s.name AS name,
      s.kind AS kind,
      s.file AS file,
      s.is_exported AS exported,
      s.line_start AS lineStart,
      s.velocity AS velocity,
      s.decay_score AS decayScore
    ORDER BY s.file, s.line_start
    LIMIT $limit
  `, { repo, limit })

  const calls = await kuzu.query<CallRow>(`
    MATCH (a:Symbol)-[:Calls]->(b:Symbol)
    WHERE a.repo = $repo AND b.repo = $repo
    RETURN a.fqn AS source, b.fqn AS target
    LIMIT 180
  `, { repo })

  const symbolIds = new Set(symbols.map(s => s.fqn))
  const visibleCalls = calls.filter(c => symbolIds.has(c.source) && symbolIds.has(c.target))
  const filePaths = [...new Set(symbols.map(s => s.file))].slice(0, 28)
  const fileIds = new Map(filePaths.map(file => [file, `file:${file}`]))

  const nodes: GraphNode[] = [
    ...filePaths.map(file => ({
      id: `file:${file}`,
      label: file.split('/').pop() ?? file,
      type: 'file' as const,
      file,
    })),
    ...symbols.map(s => ({
      id: s.fqn,
      label: s.name,
      type: 'symbol' as const,
      kind: s.kind,
      file: s.file,
      lineStart: s.lineStart,
      exported: s.exported,
      velocity: s.velocity,
      decayScore: s.decayScore,
    })),
  ]

  const containsEdges: GraphEdge[] = symbols
    .filter(s => fileIds.has(s.file))
    .map(s => ({
      source: fileIds.get(s.file)!,
      target: s.fqn,
      type: 'contains' as const,
    }))

  const edges: GraphEdge[] = [
    ...containsEdges,
    ...visibleCalls.map(c => ({ ...c, type: 'calls' as const })),
  ]

  const deadCode = getDeadCodeCandidates(symbols, calls, repo)

  return {
    nodes,
    edges,
    deadCode,
    metrics: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      deadCodeCount: deadCode.length,
    },
  }
}

function getDeadCodeCandidates(symbols: SymbolRow[], calls: CallRow[], repo: string): DeadCodeCandidate[] {
  const incoming = new Map<string, number>()
  for (const call of calls) {
    incoming.set(call.target, (incoming.get(call.target) ?? 0) + 1)
  }

  const touchCounts = getTouchCounts(repo)
  const entrypointNames = new Set(['main', 'default', 'handler', 'startMCPServer'])

  return symbols
    .filter(s => !s.exported)
    .filter(s => !entrypointNames.has(s.name))
    .filter(s => (incoming.get(s.fqn) ?? 0) === 0)
    .filter(s => ['function', 'class', 'interface', 'type', 'variable'].includes(s.kind))
    .slice(0, 20)
    .map(s => ({
      fqn: s.fqn,
      name: s.name,
      kind: s.kind,
      file: s.file,
      lineStart: s.lineStart,
      incomingCalls: 0,
      touchCount: touchCounts.get(s.fqn) ?? 0,
      reason: 'No incoming Calls edge and not exported. Candidate only; dynamic/runtime use may exist.',
    }))
}

function getTouchCounts(repo: string): Map<string, number> {
  try {
    const db = getDb()
    const rows = db.prepare(`
      SELECT symbol_fqn, COUNT(*) AS count
      FROM change_events
      WHERE repo = ?
      GROUP BY symbol_fqn
    `).all(repo) as Array<{ symbol_fqn: string; count: number }>

    return new Map(rows.map(r => [r.symbol_fqn, r.count]))
  } catch {
    return new Map()
  }
}
