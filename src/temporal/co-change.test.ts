import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSqlite, getDb, closeDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { predictFileCoChanges, predictSymbolCoChanges } from './co-change.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-cochange-test-'))

try {
  initSqlite(tmpDir)
  initMemorySchema(getDb())

  const db = getDb()

  // Insert change events:
  // Commit 1: fileA, fileB
  // Commit 2: fileA, fileB, fileC
  // Commit 3: fileA
  const insertStmt = db.prepare(`
    INSERT INTO change_events (repo, symbol_fqn, file_path, commit_sha, author, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  // Commit 1
  insertStmt.run('test-repo', 'symA', 'src/fileA.ts', 'commit1', 'author', Date.now())
  insertStmt.run('test-repo', 'symB', 'src/fileB.ts', 'commit1', 'author', Date.now())

  // Commit 2
  insertStmt.run('test-repo', 'symA', 'src/fileA.ts', 'commit2', 'author', Date.now())
  insertStmt.run('test-repo', 'symB', 'src/fileB.ts', 'commit2', 'author', Date.now())
  insertStmt.run('test-repo', 'symC', 'src/fileC.ts', 'commit2', 'author', Date.now())

  // Commit 3
  insertStmt.run('test-repo', 'symA', 'src/fileA.ts', 'commit3', 'author', Date.now())

  // We have 3 total commits touching fileA.ts (commit1, commit2, commit3)
  // fileB.ts co-occurred in 2 commits (commit1, commit2). Confidence = 2/3 = 0.666
  // fileC.ts co-occurred in 1 commit (commit2). Confidence = 1/3 = 0.333

  const filePredictions = predictFileCoChanges('test-repo', 'src/fileA.ts')
  assert.equal(filePredictions.length, 2)
  assert.equal(filePredictions[0].target, 'src/fileB.ts')
  assert.equal(filePredictions[0].coOccurrences, 2)
  assert.ok(Math.abs(filePredictions[0].confidence - 0.666) < 0.01)

  assert.equal(filePredictions[1].target, 'src/fileC.ts')
  assert.equal(filePredictions[1].coOccurrences, 1)
  assert.ok(Math.abs(filePredictions[1].confidence - 0.333) < 0.01)

  // Test symbols
  const symPredictions = predictSymbolCoChanges('test-repo', 'symA')
  assert.equal(symPredictions.length, 2)
  assert.equal(symPredictions[0].target, 'symB')
  assert.equal(symPredictions[0].coOccurrences, 2)
  assert.ok(Math.abs(symPredictions[0].confidence - 0.666) < 0.01)
} finally {
  closeDb()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
