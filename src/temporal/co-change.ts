import { getDb } from '../memory/db.js'

export interface CoChangePrediction {
  target: string // FQN or File path
  coOccurrences: number
  confidence: number
}

/**
 * Predicts other symbols likely to change when a given symbol is modified,
 * based on historical commit co-occurrences.
 */
export function predictSymbolCoChanges(
  repo: string,
  symbolFqn: string,
  limit = 5
): CoChangePrediction[] {
  const db = getDb()

  // Get total commits touching the source symbol
  const sourceCommitsRow = db.prepare(`
    SELECT COUNT(DISTINCT commit_sha) as total
    FROM change_events
    WHERE repo = ? AND symbol_fqn = ?
  `).get(repo, symbolFqn) as { total: number } | undefined

  const totalSourceCommits = sourceCommitsRow?.total ?? 0
  if (totalSourceCommits === 0) return []

  // Query co-occurring symbols
  const rows = db.prepare(`
    SELECT symbol_fqn as target, COUNT(DISTINCT commit_sha) as co_occurrences
    FROM change_events
    WHERE repo = ?
      AND commit_sha IN (SELECT DISTINCT commit_sha FROM change_events WHERE repo = ? AND symbol_fqn = ?)
      AND symbol_fqn <> ?
    GROUP BY symbol_fqn
    ORDER BY co_occurrences DESC
    LIMIT ?
  `).all(repo, repo, symbolFqn, symbolFqn, limit) as Array<{ target: string; co_occurrences: number }>

  return rows.map(r => ({
    target: r.target,
    coOccurrences: r.co_occurrences,
    confidence: r.co_occurrences / totalSourceCommits,
  }))
}

/**
 * Predicts other files likely to change when a given file is modified,
 * based on historical commit co-occurrences.
 */
export function predictFileCoChanges(
  repo: string,
  filePath: string,
  limit = 5
): CoChangePrediction[] {
  const db = getDb()

  // Get total commits touching the source file
  const sourceCommitsRow = db.prepare(`
    SELECT COUNT(DISTINCT commit_sha) as total
    FROM change_events
    WHERE repo = ? AND file_path = ?
  `).get(repo, filePath) as { total: number } | undefined

  const totalSourceCommits = sourceCommitsRow?.total ?? 0
  if (totalSourceCommits === 0) return []

  // Query co-occurring files
  const rows = db.prepare(`
    SELECT file_path as target, COUNT(DISTINCT commit_sha) as co_occurrences
    FROM change_events
    WHERE repo = ?
      AND commit_sha IN (SELECT DISTINCT commit_sha FROM change_events WHERE repo = ? AND file_path = ?)
      AND file_path <> ?
    GROUP BY file_path
    ORDER BY co_occurrences DESC
    LIMIT ?
  `).all(repo, repo, filePath, filePath, limit) as Array<{ target: string; co_occurrences: number }>

  return rows.map(r => ({
    target: r.target,
    coOccurrences: r.co_occurrences,
    confidence: r.co_occurrences / totalSourceCommits,
  }))
}
