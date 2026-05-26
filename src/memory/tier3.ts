import { getDb } from './db.js'

interface EpisodeRow {
  id: number
  files_touched: string
  symbols_touched: string
  summary: string
}

export function promoteToTier3(repo: string): void {
  const db = getDb()

  const episodes = db.prepare<[string], EpisodeRow>(`
    SELECT id, files_touched, symbols_touched, summary
    FROM tier2_episodes
    WHERE repo = ?
    ORDER BY created_at DESC LIMIT 14
  `).all(repo)

  const fileCounts = new Map<string, number>()
  for (const ep of episodes) {
    const files: string[] = JSON.parse(ep.files_touched)
    for (const f of files) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  }

  const now = Date.now()
  const upsert = db.prepare(`
    INSERT INTO tier3_facts (repo, category, subject, predicate, object, confidence, source_episode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, subject, predicate) DO UPDATE SET
      object = excluded.object,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `)

  for (const [file, count] of fileCounts.entries()) {
    if (count >= episodes.length * 0.5) {
      upsert.run(repo, 'activity', file, 'frequently_modified', 'true',
        count / episodes.length, null, now, now)
    }
  }
}

export function extractFactsFromEpisode(episodeId: number): void {
  const db = getDb()
  
  const episode = db.prepare(`
    SELECT repo, summary, files_touched 
    FROM tier2_episodes WHERE id = ?
  `).get(episodeId) as { repo: string; summary: string; files_touched: string } | undefined

  if (!episode) return

  const files = JSON.parse(episode.files_touched) as string[]
  const now = Date.now()

  for (const file of files) {
    db.prepare(`
      INSERT INTO tier3_facts (repo, category, subject, predicate, object, confidence, source_episode, created_at, updated_at)
      VALUES (?, 'file', ?, 'modified_in_episode', ?, 1.0, ?, ?, ?)
      ON CONFLICT(repo, subject, predicate) DO UPDATE SET updated_at = excluded.updated_at
    `).run(episode.repo, file, episodeId.toString(), episodeId, now, now)
  }
}