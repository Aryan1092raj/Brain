import { getDb } from './db.js'

const TTL_MS = 24 * 60 * 60 * 1000

export interface RawEvent {
  repo: string
  commitSha: string
  eventType: 'symbol_added' | 'symbol_modified' | 'symbol_removed'
  payload: {
    fqn: string
    file: string
    kind: string
    additions?: number
    deletions?: number
  }
}

export function writeTier1Events(events: RawEvent[]): void {
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO tier1_events (repo, commit_sha, event_type, payload, created_at, expires_at)
    VALUES (@repo, @commitSha, @eventType, @payload, @createdAt, @expiresAt)
  `)

  const now = Date.now()
  const insertMany = db.transaction((evts: RawEvent[]) => {
    for (const e of evts) {
      insert.run({
        repo: e.repo,
        commitSha: e.commitSha,
        eventType: e.eventType,
        payload: JSON.stringify(e.payload),
        createdAt: now,
        expiresAt: now + TTL_MS,
      })
    }
  })

  insertMany(events)
}

export function evictExpiredTier1(): number {
  const db = getDb()
  const result = db.prepare(
    `DELETE FROM tier1_events WHERE expires_at < ?`
  ).run(Date.now())
  return result.changes
}

export function getTier1EventsSince(repo: string, sinceMs: number): RawEvent[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM tier1_events WHERE repo = ? AND created_at >= ? ORDER BY created_at ASC`
  ).all(repo, sinceMs) as Array<{
    id: number
    repo: string
    commit_sha: string
    event_type: string
    payload: string
    created_at: number
    expires_at: number
  }>

  return rows.map(r => ({
    repo: r.repo,
    commitSha: r.commit_sha,
    eventType: r.event_type as RawEvent['eventType'],
    payload: JSON.parse(r.payload),
  }))
}