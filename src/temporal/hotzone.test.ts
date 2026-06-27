import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initKuzu, getKuzuClient, closeKuzu } from '../graph/client.js'
import { initGraphSchema } from '../graph/schema.js'
import { initSqlite, getDb, closeDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { recomputeHotZones, getCurrentHotZones } from './hotzone.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-hotzone-test-'))

try {
  initKuzu(tmpDir)
  await initGraphSchema()
  initSqlite(tmpDir)
  initMemorySchema(getDb())

  const kuzu = getKuzuClient()
  const db = getDb()
  const now = Date.now()

  // Create Symbol in Kuzu so the update query works
  await kuzu.run(`
    CREATE (:Symbol {
      fqn: 'test-repo:src/hot.ts:hotFunc',
      kind: 'function',
      name: 'hotFunc',
      file: 'src/hot.ts',
      line_start: 1,
      line_end: 10,
      repo: 'test-repo',
      is_exported: true,
      decay_score: 1.0,
      stability: 14.0,
      velocity: 0.0,
      last_touched: $ts,
      created_at: $ts
    })
  `, { ts: new Date(now) })

  // Insert change events into SQLite
  // Symbol A (hotFunc): 15 events
  // Symbols B, C, D: 3 events each
  // All within 30 days window
  const insertStmt = db.prepare(`
    INSERT INTO change_events (repo, symbol_fqn, file_path, commit_sha, author, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  // Symbol A (hotFunc): 30 events
  for (let i = 0; i < 30; i++) {
    insertStmt.run('test-repo', 'test-repo:src/hot.ts:hotFunc', 'src/hot.ts', `sha-a-${i}`, 'author', now - i * 1000)
  }

  // Symbol B: 3 events
  for (let i = 0; i < 3; i++) {
    insertStmt.run('test-repo', 'test-repo:src/cool.ts:coolFunc1', 'src/cool.ts', `sha-b-${i}`, 'author', now - i * 1000)
  }

  // Symbol C: 3 events
  for (let i = 0; i < 3; i++) {
    insertStmt.run('test-repo', 'test-repo:src/cool.ts:coolFunc2', 'src/cool.ts', `sha-c-${i}`, 'author', now - i * 1000)
  }

  // Symbol D: 3 events
  for (let i = 0; i < 3; i++) {
    insertStmt.run('test-repo', 'test-repo:src/cool.ts:coolFunc3', 'src/cool.ts', `sha-d-${i}`, 'author', now - i * 1000)
  }

  // Symbol E: 3 events
  for (let i = 0; i < 3; i++) {
    insertStmt.run('test-repo', 'test-repo:src/cool.ts:coolFunc4', 'src/cool.ts', `sha-e-${i}`, 'author', now - i * 1000)
  }

  // Symbol F: 3 events
  for (let i = 0; i < 3; i++) {
    insertStmt.run('test-repo', 'test-repo:src/cool.ts:coolFunc5', 'src/cool.ts', `sha-f-${i}`, 'author', now - i * 1000)
  }

  // Run hotzone detection
  const flagged = await recomputeHotZones('test-repo')

  // We expect A (hotFunc) to be flagged as a hot zone due to high z-score
  assert.ok(flagged.length > 0)
  const hot = flagged.find(h => h.symbolFqn === 'test-repo:src/hot.ts:hotFunc')
  assert.ok(hot)
  assert.ok(hot.zScore >= 1.5) // should exceed z-score threshold

  // Test getCurrentHotZones returns it too
  const current = getCurrentHotZones('test-repo')
  assert.ok(current.some(c => c.symbolFqn === 'test-repo:src/hot.ts:hotFunc'))
} finally {
  closeKuzu()
  closeDb()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
