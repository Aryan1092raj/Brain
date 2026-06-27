import { getDb } from './db.js'
import { getTier1EventsSince } from './tier1.js'
import { getClient, getModel } from '../query/engine.js'

const TTL_MS = 30 * 24 * 60 * 60 * 1000

export async function compressTier1ToTier2(repo: string): Promise<void> {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)

  const existing = db.prepare(
    `SELECT id FROM tier2_episodes WHERE repo = ? AND date = ?`
  ).get(repo, today)
  if (existing) return

  const since = Date.now() - 24 * 60 * 60 * 1000
  const events = getTier1EventsSince(repo, since)
  if (events.length === 0) return

  const filesTouched = [...new Set(events.map(e => e.payload.file))]
  const symbolsTouched = [...new Set(events.map(e => e.payload.fqn))]

  const eventsText = events.slice(0, 100).map(e =>
    `${e.eventType}: ${e.payload.fqn} (${e.payload.kind}) in ${e.payload.file}`
  ).join('\n')

  const response = await getClient().chat.completions.create({
    model: getModel(),
    max_tokens: 400,
    messages: [
      {
        role: 'system',
        content: `You are a codebase historian. Summarise the following code changes for a team.
Be factual. Max 3 sentences. Focus on: what changed, which areas, any patterns.
Plain text only.`,
      },
      { role: 'user', content: eventsText },
    ],
  })

  const summary = response.choices[0]?.message?.content ?? 'No summary available'

  const now = Date.now()
  db.prepare(`
    INSERT INTO tier2_episodes
      (repo, date, summary, raw_event_count, files_touched, symbols_touched,
       decay_score, stability, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 1.0, 7.0, ?, ?)
  `).run(
    repo, today, summary, events.length,
    JSON.stringify(filesTouched),
    JSON.stringify(symbolsTouched),
    now, now + TTL_MS
  )
}