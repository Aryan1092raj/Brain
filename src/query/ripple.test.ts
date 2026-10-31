import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initKuzu, getKuzuClient, closeKuzu } from '../graph/client.js'
import { initGraphSchema } from '../graph/schema.js'
import { computeRippleImpact, formatImpactReport } from './ripple.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-ripple-test-'))

try {
  initKuzu(tmpDir)
  await initGraphSchema()

  const kuzu = getKuzuClient()
  const now = new Date()

  // Create symbol A, B, C
  await kuzu.run(`
    CREATE (:Symbol {
      fqn: 'test-repo:src/main.ts:symA',
      kind: 'function',
      name: 'symA',
      file: 'src/main.ts',
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
  `, { ts: now })

  await kuzu.run(`
    CREATE (:Symbol {
      fqn: 'test-repo:src/main.ts:symB',
      kind: 'function',
      name: 'symB',
      file: 'src/main.ts',
      line_start: 12,
      line_end: 20,
      repo: 'test-repo',
      is_exported: true,
      decay_score: 0.8,
      stability: 14.0,
      velocity: 0.0,
      last_touched: $ts,
      created_at: $ts
    })
  `, { ts: now })

  await kuzu.run(`
    CREATE (:Symbol {
      fqn: 'test-repo:src/other.ts:symC',
      kind: 'function',
      name: 'symC',
      file: 'src/other.ts',
      line_start: 5,
      line_end: 15,
      repo: 'test-repo',
      is_exported: true,
      decay_score: 0.5,
      stability: 14.0,
      velocity: 0.0,
      last_touched: $ts,
      created_at: $ts
    })
  `, { ts: now })

  // Create Calls relations: A -> B -> C
  await kuzu.run(`
    MATCH (a:Symbol {fqn: 'test-repo:src/main.ts:symA'}), (b:Symbol {fqn: 'test-repo:src/main.ts:symB'})
    CREATE (a)-[:Calls {call_site_line: 5, is_async: false}]->(b)
  `)

  await kuzu.run(`
    MATCH (b:Symbol {fqn: 'test-repo:src/main.ts:symB'}), (c:Symbol {fqn: 'test-repo:src/other.ts:symC'})
    CREATE (b)-[:Calls {call_site_line: 15, is_async: false}]->(c)
  `)

  // Run ripple solver from symA
  const impacts = await computeRippleImpact('test-repo:src/main.ts:symA')

  // We expect B and C to be in the impacted list
  assert.ok(impacts.length >= 2)
  assert.ok(impacts.some(i => i.fqn === 'test-repo:src/main.ts:symB'))
  assert.ok(impacts.some(i => i.fqn === 'test-repo:src/other.ts:symC'))

  // Verify formatImpactReport doesn't crash and returns formatted details
  const report = await formatImpactReport('test-repo:src/main.ts:symA')
  assert.ok(report.includes('Impact Analysis'))
  assert.ok(report.includes('symB'))
  assert.ok(report.includes('symC'))
} finally {
  await closeKuzu()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
