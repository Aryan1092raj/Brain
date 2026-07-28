import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initKuzu, getKuzuClient, closeKuzu } from '../graph/client.js'
import { initGraphSchema } from '../graph/schema.js'
import { initSqlite, getDb, closeDb } from './db.js'
import { initMemorySchema } from './schema.js'
import { runDecayCycle } from './decay.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-decay-test-'))

try {
  initKuzu(tmpDir)
  await initGraphSchema()
  initSqlite(tmpDir)
  initMemorySchema(getDb())

  const kuzu = getKuzuClient()
  const now = new Date()
  // 7 days ago
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // Create test file and symbol in Kuzu
  await kuzu.run(`
    CREATE (f:File {
      path: 'src/main.ts',
      repo: 'test-repo',
      language: 'typescript',
      line_count: 100,
      decay_score: 1.0,
      stability: 14.0,
      last_touched: $ts,
      created_at: $ts
    })
  `, { ts: sevenDaysAgo })

  await kuzu.run(`
    CREATE (s:Symbol {
      fqn: 'test-repo:src/main.ts:myVar',
      kind: 'variable',
      name: 'myVar',
      file: 'src/main.ts',
      line_start: 1,
      line_end: 10,
      repo: 'test-repo',
      is_exported: true,
      decay_score: 1.0,
      stability: 7.0,
      velocity: 0.0,
      last_touched: $ts,
      created_at: $ts
    })
  `, { ts: sevenDaysAgo })

  // Run decay cycle
  await runDecayCycle('test-repo')

  // Retrieve decay score
  const res = await kuzu.query<{ decay: number }>(`
    MATCH (s:Symbol {fqn: 'test-repo:src/main.ts:myVar'})
    RETURN s.decay_score AS decay
  `)

  assert.ok(res.length > 0)
  const score = res[0].decay
  assert.ok(score > 0.30 && score < 0.40)
} finally {
  closeKuzu()
  closeDb()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
