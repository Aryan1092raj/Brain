import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { init } from './init.js'
import { closeKuzu } from '../graph/client.js'
import { closeDb } from '../memory/db.js'
import { getGraphOverview } from '../graph/insights.js'

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-init-'))

try {
  await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export function greet(name: string) { return `hello ${name}` }\n')
  await init(tmpDir)

  const config = JSON.parse(await fs.readFile(path.join(tmpDir, '.brain', 'config.json'), 'utf8')) as { repos: Array<{ name: string; path: string }> }
  assert.equal(config.repos[0]?.path, tmpDir)
  assert.match(await fs.readFile(path.join(tmpDir, '.brain', 'README.md'), 'utf8'), /GROQ_API_KEY/)
  await fs.access(path.join(tmpDir, '.brain', 'brain.db'))
  await fs.access(path.join(tmpDir, '.brain', 'graph', 'brain.kuzu'))
  const graph = await getGraphOverview(config.repos[0]?.name ?? '')
  assert.ok(graph.metrics.nodeCount >= 2)
} finally {
  closeKuzu()
  closeDb()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
