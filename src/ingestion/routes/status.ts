import type { Router, Request, Response } from 'express'
import { getDb } from '../../memory/db.js'
import { getCurrentHotZones } from '../../temporal/hotzone.js'

export function registerStatusRoute(router: Router): void {
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string
      if (!repo) {
        res.status(400).json({ error: 'repo query param required' })
        return
      }

      const db = getDb()
      const symbolCount = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const fileCount = (db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const hotzones = getCurrentHotZones(repo)
      const tier2Count = (db.prepare(`SELECT COUNT(*) as c FROM tier2_episodes WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const latestDecay = db.prepare(`
        SELECT avg_score as avgScore
        FROM decay_log
        WHERE repo = ?
        ORDER BY run_at DESC
        LIMIT 1
      `).get(repo) as { avgScore: number } | undefined
      const latestEvent = db.prepare(`
        SELECT MAX(ts) as ts
        FROM change_events
        WHERE repo = ?
      `).get(repo) as { ts: number | null }

      res.json({
        repo,
        symbolCount,
        fileCount,
        hotZones: hotzones.length,
        tier2Episodes: tier2Count,
        avgDecay: latestDecay?.avgScore ?? 1,
        lastIndexed: latestEvent?.ts ? new Date(latestEvent.ts).toISOString() : null,
      })
    } catch (err) {
      console.error('[brain] status error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })
}
