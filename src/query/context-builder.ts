import { getDb } from '../memory/db.js'
import { getGraphOverview, type GraphOverview } from '../graph/insights.js'

interface ContextData {
  repo: string
  symbols: string[]
  hotzones: Array<{ fqn: string; file: string; velocity: number; zScore: number }>
  tier2: Array<{ date: string; summary: string; decayScore: number }>
  tier3: Array<{ subject: string; predicate: string; object: string }>
  recentChanges: Array<{ fqn: string; file: string; ts: number; commit: string }>
}

export function buildContext(repo: string): ContextData {
  const db = getDb()

  const symbols = db.prepare(`
    SELECT DISTINCT symbol_fqn FROM change_events WHERE repo = ?
    ORDER BY ts DESC LIMIT 50
  `).all(repo).map((r: any) => r.symbol_fqn)

  const hotzones = db.prepare(`
    SELECT symbol_fqn, file_path, velocity, z_score FROM hot_zones
    WHERE repo = ? ORDER BY z_score DESC LIMIT 10
  `).all(repo).map((r: any) => ({
    fqn: r.symbol_fqn,
    file: r.file_path,
    velocity: r.velocity,
    zScore: r.z_score,
  }))

  const tier2 = db.prepare(`
    SELECT date, summary, decay_score FROM tier2_episodes
    WHERE repo = ? AND expires_at > ? ORDER BY date DESC LIMIT 5
  `).all(repo, Date.now()).map((r: any) => ({
    date: r.date,
    summary: r.summary,
    decayScore: r.decay_score,
  }))

  const tier3 = db.prepare(`
    SELECT subject, predicate, object FROM tier3_facts
    WHERE repo = ? ORDER BY confidence DESC LIMIT 20
  `).all(repo).map((r: any) => ({
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
  }))

  const recentChanges = db.prepare(`
    SELECT symbol_fqn, file_path, ts, commit_sha FROM change_events
    WHERE repo = ? ORDER BY ts DESC LIMIT 20
  `).all(repo).map((r: any) => ({
    fqn: r.symbol_fqn,
    file: r.file_path,
    ts: r.ts,
    commit: r.commit_sha,
  }))

  return { repo, symbols, hotzones, tier2, tier3, recentChanges }
}

export function formatContext(ctx: ContextData): string {
  const parts: string[] = []

  parts.push(`## Repository: ${ctx.repo}\n`)

  if (ctx.tier2.length > 0) {
    parts.push('## Recent Episodes (Tier 2)')
    for (const ep of ctx.tier2) {
      parts.push(`- [${ep.date}] (score: ${ep.decayScore.toFixed(2)}) ${ep.summary}`)
    }
    parts.push('')
  }

  if (ctx.hotzones.length > 0) {
    parts.push('## Hot Zones (high change velocity)')
    for (const h of ctx.hotzones) {
      parts.push(`- \`${h.fqn}\` in ${h.file} (z-score: ${h.zScore.toFixed(2)}, velocity: ${h.velocity.toFixed(1)})`)
    }
    parts.push('')
  }

  if (ctx.tier3.length > 0) {
    parts.push('## Facts (Tier 3)')
    for (const f of ctx.tier3.slice(0, 10)) {
      parts.push(`- ${f.subject} ${f.predicate} ${f.object}`)
    }
    parts.push('')
  }

  if (ctx.recentChanges.length > 0) {
    parts.push('## Recent Changes')
    for (const c of ctx.recentChanges.slice(0, 10)) {
      const date = new Date(c.ts).toISOString().slice(0, 10)
      parts.push(`- ${date} ${c.fqn} in ${c.file}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}

export async function formatRichContext(ctx: ContextData): Promise<string> {
  const parts = [formatContext(ctx)]

  try {
    const overview = await loadGraphOverview(ctx.repo)
    const symbols = overview.nodes.filter(n => n.type === 'symbol')
    const files = overview.nodes.filter(n => n.type === 'file')
    const calls = overview.edges.filter(e => e.type === 'calls')
    const contains = overview.edges.filter(e => e.type === 'contains')

    parts.push('## Live Kuzu Graph')
    parts.push(`- Files in graph sample: ${files.length}`)
    parts.push(`- Symbols in graph sample: ${symbols.length}`)
    parts.push(`- Contains edges: ${contains.length}`)
    parts.push(`- Calls edges: ${calls.length}`)
    parts.push(`- Dead-code candidates: ${overview.deadCode.length}`)
    parts.push('')

    const modules = new Map<string, number>()
    for (const node of symbols) {
      const dir = node.file?.split('/').slice(0, 2).join('/') ?? 'unknown'
      modules.set(dir, (modules.get(dir) ?? 0) + 1)
    }

    if (modules.size > 0) {
      parts.push('## Module Map')
      for (const [module, count] of [...modules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        parts.push(`- ${module}: ${count} symbols`)
      }
      parts.push('')
    }

    if (calls.length > 0) {
      const labels = new Map(overview.nodes.map(n => [n.id, `${n.label}${n.file ? ` (${n.file})` : ''}`]))
      parts.push('## Call Edges')
      for (const edge of calls.slice(0, 25)) {
        parts.push(`- ${labels.get(edge.source) ?? edge.source} -> ${labels.get(edge.target) ?? edge.target}`)
      }
      parts.push('')
    }

    if (overview.deadCode.length > 0) {
      parts.push('## Dead-Code Candidates')
      for (const item of overview.deadCode.slice(0, 12)) {
        parts.push(`- ${item.name} (${item.kind}) in ${item.file}:${item.lineStart}: ${item.reason}`)
      }
      parts.push('')
    }
  } catch (err) {
    parts.push('## Live Kuzu Graph')
    parts.push(`- unavailable: ${err instanceof Error ? err.message : 'unknown error'}`)
    parts.push('')
  }

  return parts.join('\n')
}

async function loadGraphOverview(repo: string): Promise<GraphOverview> {
  try {
    return await getGraphOverview(repo, 120)
  } catch (directErr) {
    const port = process.env.BRAIN_PORT ?? '3747'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1000)
    try {
      const res = await fetch(`http://localhost:${port}/graph?repo=${encodeURIComponent(repo)}`, {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`daemon returned ${res.status}`)
      return await res.json() as GraphOverview
    } catch {
      throw directErr
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function buildSystemPrompt(): string {
  return `You are a codebase analyst with access to a live knowledge graph.
You know:
- Recent episodes (AI-generated summaries of code changes)
- Hot zones (symbols/files with high change velocity)
- Extracted facts (relationships between code entities)
- Recent changes (symbols modified recently)
- Live Kuzu graph samples: files, symbols, Contains edges, Calls edges, and dead-code candidates

Use this context to answer user questions about the codebase.
When context is sparse, say what is known from graph structure and what needs more commits or summaries.
Be specific, reference file paths and symbols, and ground your answer in the data provided.
Keep answers concise but informative.`
}
