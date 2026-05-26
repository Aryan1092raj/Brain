import { getDb } from '../memory/db.js'
import { getKuzuClient } from '../graph/client.js'

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const HOT_ZONE_Z_THRESHOLD = 2.0
const MIN_EVENTS_FOR_SCORING = 3

export interface HotZone {
  symbolFqn: string
  filePath: string
  velocity: number
  zScore: number
  isNew: boolean
}

export async function recomputeHotZones(repo: string): Promise<HotZone[]> {
  const db = getDb()
  const kuzu = getKuzuClient()
  const windowStart = Date.now() - WINDOW_MS
  const windowDays = WINDOW_MS / 86400000

  const velocities = db.prepare<[string, number, number], {
    symbol_fqn: string
    file_path: string
    event_count: number
  }>(`
    SELECT symbol_fqn, file_path, COUNT(*) as event_count
    FROM change_events
    WHERE repo = ? AND ts >= ?
    GROUP BY symbol_fqn, file_path
    HAVING COUNT(*) >= ?
  `).all(repo, windowStart, MIN_EVENTS_FOR_SCORING)

  if (velocities.length === 0) return []

  const values = velocities.map(v => v.event_count / windowDays)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  const stdDev = Math.sqrt(variance)

  const newHotZones: HotZone[] = []
  const now = Date.now()

  for (let i = 0; i < velocities.length; i++) {
    const v = velocities[i]
    const velocity = values[i]
    const zScore = stdDev > 0 ? (velocity - mean) / stdDev : 0

    if (zScore >= HOT_ZONE_Z_THRESHOLD) {
      const existing = db.prepare(
        `SELECT id, alert_sent FROM hot_zones WHERE repo = ? AND symbol_fqn = ?`
      ).get(repo, v.symbol_fqn) as { id: number; alert_sent: number } | undefined

      db.prepare(`
        INSERT INTO hot_zones (repo, symbol_fqn, file_path, velocity, z_score, first_flagged, last_flagged)
        VALUES (@repo, @fqn, @file, @velocity, @zScore, @now, @now)
        ON CONFLICT(repo, symbol_fqn) DO UPDATE SET
          velocity = excluded.velocity,
          z_score = excluded.z_score,
          last_flagged = excluded.last_flagged
      `).run({ repo, fqn: v.symbol_fqn, file: v.file_path, velocity, zScore, now })

      newHotZones.push({
        symbolFqn: v.symbol_fqn,
        filePath: v.file_path,
        velocity,
        zScore,
        isNew: !existing || existing.alert_sent === 0,
      })

      await kuzu.run(
        `MATCH (s:Symbol {fqn: $fqn}) SET s.velocity = $v`,
        { fqn: v.symbol_fqn, v: velocity }
      ).catch(() => {})
    }
  }

  return newHotZones
}

export function getCurrentHotZones(repo: string): Array<{
  symbolFqn: string
  filePath: string
  velocity: number
  zScore: number
}> {
  const db = getDb()
  const windowStart = Date.now() - WINDOW_MS
  return db.prepare(`
    SELECT symbol_fqn AS symbolFqn, file_path AS filePath, velocity, z_score AS zScore
    FROM hot_zones
    WHERE repo = ? AND last_flagged >= ?
    ORDER BY z_score DESC
  `).all(repo, windowStart) as Array<{ symbolFqn: string; filePath: string; velocity: number; zScore: number }>
}