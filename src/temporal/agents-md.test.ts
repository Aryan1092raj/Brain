import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initKuzu, getKuzuClient, closeKuzu } from '../graph/client.js'
import { initGraphSchema } from '../graph/schema.js'
import { initSqlite, getDb, closeDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { generateAgentsMd } from './agents-md.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-agentsmd-test-'))

try {
  initKuzu(tmpDir)
  await initGraphSchema()
  initSqlite(tmpDir)
  initMemorySchema(getDb())

  const kuzu = getKuzuClient()
  const db = getDb()
  const now = Date.now()

  // 1. Create a File node in Kuzu
  await kuzu.run(`
    CREATE (:File {
      path: 'src/decayed.ts',
      repo: 'test-repo',
      language: 'typescript',
      line_count: 100,
      decay_score: 0.15,
      stability: 30.0,
      last_touched: $ts,
      created_at: $ts
    })
  `, { ts: new Date(now - 45 * 24 * 60 * 60 * 1000) }) // 45 days ago

  // 2. Insert some change events to make a hot zone
  const insertStmt = db.prepare(`
    INSERT INTO change_events (repo, symbol_fqn, file_path, commit_sha, author, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  // Hot zone symbol: 15 events
  for (let i = 0; i < 15; i++) {
    insertStmt.run('test-repo', 'test-repo:src/hot.ts:hotFunc', 'src/hot.ts', `sha-${i}`, 'author', now - i * 1000)
  }
  // Normal symbol: 3 events
  for (let i = 0; i < 3; i++) {
    insertStmt.run('test-repo', 'test-repo:src/cool.ts:coolFunc', 'src/cool.ts', `sha-norm-${i}`, 'author', now - i * 1000)
  }

  // Populate hot_zones table
  db.prepare(`
    INSERT INTO hot_zones (repo, symbol_fqn, file_path, velocity, z_score, first_flagged, last_flagged)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('test-repo', 'test-repo:src/hot.ts:hotFunc', 'src/hot.ts', 0.5, 2.8, now, now)

  // 3. Create a tier2 episode
  db.prepare(`
    INSERT INTO tier2_episodes
      (repo, date, summary, raw_event_count, files_touched, symbols_touched, decay_score, stability, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'test-repo',
    '2026-06-27',
    'Implemented major login refactoring and secure session handling.',
    10,
    JSON.stringify(['src/login.ts']),
    JSON.stringify(['loginFunc']),
    1.0,
    7.0,
    now,
    now + 30 * 24 * 60 * 60 * 1000
  )

  // 4. Generate AGENTS.md
  await generateAgentsMd('test-repo', tmpDir)

  // 5. Read and assert AGENTS.md
  const agentsMdContent = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
  console.log("=== AGENTS.MD CONTENT ===");
  console.log(agentsMdContent);
  console.log("=========================");
  console.log("Includes '# Repository Intelligence Summary'?", agentsMdContent.includes('# Repository Intelligence Summary'));
  console.log("Includes 'Files Tracked: 2'?", agentsMdContent.includes('Files Tracked: 2'));
  console.log("Includes 'Files Tracked'?", agentsMdContent.includes('Files Tracked'));
  console.log("Includes '2'?", agentsMdContent.includes('2'));
  
  assert.ok(agentsMdContent.includes('# Repository Intelligence Summary'))
  assert.ok(agentsMdContent.includes('Files Tracked'))
  assert.ok(agentsMdContent.includes('Active Hot Zones: 1'))
  assert.ok(agentsMdContent.includes('src/decayed.ts'))
  assert.ok(agentsMdContent.includes('15%')) // decay freshness score
  assert.ok(agentsMdContent.includes('Implemented major login refactoring'))
  assert.ok(agentsMdContent.includes('hotFunc'))
} finally {
  closeKuzu()
  closeDb()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
