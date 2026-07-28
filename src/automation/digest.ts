import { getDb } from '../memory/db.js'
import { hasLlmAccess, query } from '../query/engine.js'
import type { Config } from '../config/schema.js'

export async function sendDailyDigest(config: Config, repo: string): Promise<void> {
  const db = getDb()
  const since = Date.now() - 24 * 60 * 60 * 1000

  const changes = db.prepare(`
    SELECT symbol_fqn, file_path, COUNT(*) as changes
    FROM change_events
    WHERE repo = ? AND ts >= ?
    GROUP BY symbol_fqn ORDER BY changes DESC LIMIT 20
  `).all(repo, since) as Array<{ symbol_fqn: string; file_path: string; changes: number }>

  const hotzones = db.prepare(`
    SELECT symbol_fqn, z_score FROM hot_zones
    WHERE repo = ? AND last_flagged >= ?
    ORDER BY z_score DESC LIMIT 5
  `).all(repo, since) as Array<{ symbol_fqn: string; z_score: number }>

  if (changes.length === 0 || !hasLlmAccess()) return

  const summary = changes.map(c => `${c.symbol_fqn} (${c.changes}x)`).join(', ')
  const hotList = hotzones.map(h => `${h.symbol_fqn} z=${h.z_score.toFixed(1)}`).join(', ')

  const digest = await query(
    'You are a codebase historian. Write a 3-sentence daily digest for a dev team.',
    `Changed today: ${summary}\nHot zones: ${hotList || 'none'}`
  )

  const message = `Daily Codebase Digest — ${repo}\n${digest}`

  if (config.slackWebhook) {
    await fetch(config.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    })
  }

  console.info(`[brain/digest] sent daily digest for ${repo}`)
}
