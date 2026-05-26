import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { initKuzu, getKuzuClient } from '../graph/client.js'
import { KUZU_DDL } from '../graph/schema.js'
import { initSqlite, getDb } from '../memory/db.js'
import { SQLITE_DDL } from '../memory/schema.js'

export async function init(cwd: string): Promise<void> {
  const brainDir = path.join(cwd, '.brain')

  await fs.mkdir(path.join(brainDir, 'graph'), { recursive: true })
  await fs.mkdir(path.join(brainDir, 'logs'), { recursive: true })

  const configPath = path.join(cwd, 'brain.config.json')
  try {
    await fs.access(configPath)
    console.info('[brain] brain.config.json already exists — skipping')
  } catch {
    await fs.writeFile(configPath, JSON.stringify({
      repos: [{
        name: path.basename(cwd),
        path: cwd,
        remote: '',
        webhookSecret: crypto.randomUUID(),
        languages: ['typescript', 'javascript'],
        branch: 'main',
      }],
      port: 3747,
      logLevel: 'info',
    }, null, 2))
    console.info('[brain] created brain.config.json — fill in remote and webhookSecret')
  }

  initKuzu(brainDir)
  const db = getKuzuClient()
  for (const ddl of KUZU_DDL) {
    await db.run(ddl)
  }
  console.info('[brain] Kuzu schema initialised')

  initSqlite(brainDir)
  const sqliteDb = getDb()
  for (const stmt of SQLITE_DDL.split(';').filter(s => s.trim())) {
    sqliteDb.exec(stmt)
  }
  console.info('[brain] SQLite schema initialised')

  console.info('[brain] init complete — run: brain watch')
}