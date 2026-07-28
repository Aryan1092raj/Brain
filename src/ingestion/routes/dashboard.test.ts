import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createWebhookServer } from '../webhook.js'
import { initKuzu, getKuzuClient, closeKuzu } from '../../graph/client.js'
import { initGraphSchema } from '../../graph/schema.js'
import { initSqlite, getDb, closeDb } from '../../memory/db.js'
import { initMemorySchema } from '../../memory/schema.js'
import type { Config } from '../../config/schema.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-dashboard-test-'))
let server: import('node:http').Server | undefined
const originalGroqKey = process.env.GROQ_API_KEY

try {
  delete process.env.GROQ_API_KEY
  initKuzu(root)
  await initGraphSchema()
  initSqlite(root)
  initMemorySchema(getDb())
  const kuzu = getKuzuClient()
  await kuzu.run(`CREATE (f:File { path: 'src/main.py', repo: 'fixture', language: 'python' })`)
  await kuzu.run(`CREATE (s:Symbol {
    fqn: 'fixture:src/main.py:main', kind: 'function', name: 'main', file: 'src/main.py',
    line_start: 1, line_end: 2, repo: 'fixture', is_exported: true, decay_score: 1.0,
    stability: 14.0, velocity: 0.0
  })`)
  await kuzu.run(`MATCH (f:File {path: 'src/main.py'}), (s:Symbol {fqn: 'fixture:src/main.py:main'}) CREATE (f)-[:Contains]->(s)`)

  const config: Config = {
    repos: [{
      name: 'fixture',
      path: root,
      remote: 'https://github.com/example/fixture',
      webhookSecret: 'test-secret',
      languages: ['typescript'],
      branch: 'main',
    }],
    port: 0,
    logLevel: 'info',
  }

  const app = createWebhookServer(config)
  server = app.listen(0)
  await new Promise<void>(resolve => server!.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const html = await fetch(`http://127.0.0.1:${port}/?repo=fixture`).then(response => response.text())
  const graph = await fetch(`http://127.0.0.1:${port}/api/graph-data?repo=fixture`).then(response => response.json()) as { nodes: unknown[] }

  assert.match(html, /Local mode · chat disabled/)
  assert.ok(graph.nodes.length >= 2, 'local graph should work without a Groq API key')
  const match = html.match(/function interpolateColor[\s\S]*?\n}\n\n\/\/ === ASK BRAIN ===/)
  assert.ok(match, 'dashboard should emit the color interpolation helper')
  const helperSource = match[0].replace(/\n\n\/\/ === ASK BRAIN ===$/, '')
  const interpolateColor = new Function(`${helperSource}; return interpolateColor;`)() as (from: unknown, to: unknown, t: number) => string

  assert.equal(interpolateColor('#ffc174', '#64e9a3', 0.5), '#b2d58c')
  assert.equal(interpolateColor('var(--pink)', null, 0.5), '#b2d58c')
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  closeKuzu()
  closeDb()
  if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = originalGroqKey
  await fs.rm(root, { recursive: true, force: true })
}
