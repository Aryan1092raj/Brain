import { getKuzuClient } from '../graph/client.js'
import { getDb } from './db.js'

const STABILITY_MAP: Record<string, number> = {
  interface:   90,
  class:       30,
  function:    14,
  type:        14,
  variable:    7,
  import:      3,
}

export async function runDecayCycle(repo: string): Promise<void> {
  const db = getKuzuClient()
  const sqliteDb = getDb()
  const now = Date.now()
  const nowDays = now / 86400000

  const symbols = await db.query<{
    fqn: string
    kind: string
    last_touched: string
  }>(`
    MATCH (s:Symbol {repo: $r})
    RETURN s.fqn AS fqn, s.kind AS kind, s.last_touched AS last_touched
  `, { r: repo })

  let totalRescored = 0
  let minScore = 1.0
  let maxScore = 1.0
  let sumScore = 0

  for (const sym of symbols) {
    const stability = STABILITY_MAP[sym.kind] ?? 14
    const lastTouchedDays = new Date(sym.last_touched).getTime() / 86400000
    const t = nowDays - lastTouchedDays
    const R = Math.exp(-t / stability)

    await db.run(
      `MATCH (s:Symbol {fqn: $fqn}) SET s.decay_score = $r, s.stability = $s`,
      { fqn: sym.fqn, r: Math.max(0.001, R), s: stability }
    )

    minScore = Math.min(minScore, R)
    maxScore = Math.max(maxScore, R)
    sumScore += R
    totalRescored++
  }

  const files = await db.query<{ path: string; last_touched: string }>(
    `MATCH (f:File {repo: $r}) RETURN f.path AS path, f.last_touched AS last_touched`,
    { r: repo }
  )

  for (const file of files) {
    const t = nowDays - new Date(file.last_touched).getTime() / 86400000
    const R = Math.exp(-t / 14)
    await db.run(
      `MATCH (f:File {path: $p, repo: $r}) SET f.decay_score = $score`,
      { p: file.path, r: repo, score: Math.max(0.001, R) }
    )
  }

  sqliteDb.prepare(`
    INSERT INTO decay_log (repo, run_at, nodes_rescored, min_score, max_score, avg_score)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    repo, now, totalRescored,
    minScore, maxScore,
    totalRescored > 0 ? sumScore / totalRescored : 0
  )
}