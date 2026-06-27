import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSqlite, getDb, closeDb } from './db.js'
import { initMemorySchema } from './schema.js'
import { promoteToTier3 } from './tier3.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-promotion-test-'))

try {
  initSqlite(tmpDir)
  initMemorySchema(getDb())

  const db = getDb()
  const now = Date.now()

  // Insert 4 tier2 episodes touching 'src/index.ts'
  const insertStmt = db.prepare(`
    INSERT INTO tier2_episodes
      (repo, date, summary, raw_event_count, files_touched, symbols_touched, decay_score, stability, created_at, expires_at)
    VALUES (?, ?, 'summary', 1, ?, '[]', 1.0, 7.0, ?, ?)
  `)

  for (let i = 0; i < 4; i++) {
    insertStmt.run(
      'test-repo',
      `2026-06-2${i}`,
      JSON.stringify(['src/index.ts']),
      now - i * 1000,
      now + 30 * 24 * 60 * 60 * 1000
    )
  }

  // Run promotion
  promoteToTier3('test-repo')

  // Verify that 'src/index.ts' is promoted to a tier 3 fact
  const fact = db.prepare(`
    SELECT * FROM tier3_facts WHERE repo = ? AND subject = ? AND predicate = ?
  `).get('test-repo', 'src/index.ts', 'frequently_modified') as { object: string; confidence: number } | undefined

  assert.ok(fact)
  assert.equal(fact.object, 'true')
  assert.ok(fact.confidence > 0.9)
} finally {
  closeDb()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
