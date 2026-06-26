import path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { initSqlite, getDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { getCurrentHotZones } from '../temporal/hotzone.js'

export async function status(cwd: string, _argv: string[]): Promise<void> {
  const brainDir = path.join(cwd, '.brain')
  initSqlite(brainDir)
  initMemorySchema(getDb())

  const config = await loadConfig(cwd)
  const repo = process.env.BRAIN_REPO ?? config.repos[0]?.name ?? path.basename(cwd)
  const db = getDb()

  const symbolCount = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
  const fileCount = (db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0

  const hotzones = getCurrentHotZones(repo)

  const tier1Count = (db.prepare(`SELECT COUNT(*) as c FROM tier1_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
  const tier2Count = (db.prepare(`SELECT COUNT(*) as c FROM tier2_episodes WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
  const tier3Count = (db.prepare(`SELECT COUNT(*) as c FROM tier3_facts WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
  const tier4Count = (db.prepare(`SELECT COUNT(*) as c FROM tier4_patterns WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0

  console.info(`[brain] repo: ${repo}`)
  console.info(`  files:    ${fileCount}  symbols: ${symbolCount}`)
  console.info(`  hotzones: ${hotzones.length}${hotzones.length > 0 ? ` (${hotzones[0].filePath} highest: z=${hotzones[0].zScore.toFixed(1)})` : ''}`)
  console.info(`  memory:   tier1 ${tier1Count}ev | tier2 ${tier2Count}ep | tier3 ${tier3Count}facts | tier4 ${tier4Count}patterns`)
  console.info(`  health:   ✓ sqlite ok`)
}
