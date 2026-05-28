import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { initKuzu, getKuzuClient } from '../graph/client.js'
import { initGraphSchema } from '../graph/schema.js'
import { initSqlite, getDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { extractSymbolDelta } from '../ingestion/tree-sitter.js'
import { applySymbolDelta } from '../graph/writer.js'
import { detectModules } from '../ingestion/module-detector.js'
import { writeTier1Events, type RawEvent } from '../memory/tier1.js'
import type { FileChange } from '../ingestion/diff-parser.js'

const IGNORE_DIRS = new Set(['node_modules', '.git', '.brain', 'dist', 'target', 'build', '.next', '.cache', '__pycache__', 'venv', '.env'])

async function walkFiles(dir: string, extMap: Map<string, string>): Promise<string[][]> {
  const files: string[][] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        const sub = await walkFiles(path.join(dir, entry.name), extMap)
        files.push(...sub)
      }
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop() ?? ''
      const language = extMap.get(ext)
      if (language) {
        files.push([path.relative(process.cwd(), path.join(dir, entry.name)), language])
      }
    }
  }
  return files
}

function buildExtMap(repoLanguages: string[]): Map<string, string> {
  const extMapping: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    c: 'c', h: 'c',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    cs: 'cs',
  }
  const map = new Map<string, string>()
  for (const [ext, lang] of Object.entries(extMapping)) {
    if (repoLanguages.includes(lang)) map.set(ext, lang)
  }
  return map
}

export async function scan(cwd: string, _argv: string[]): Promise<void> {
  const config = await loadConfig(cwd)
  const repo = config.repos[0]
  if (!repo) {
    console.error('[brain/scan] no repos configured in brain.config.json')
    process.exit(1)
  }

  const brainDir = path.join(cwd, '.brain')
  initKuzu(brainDir)
  await initGraphSchema()
  initSqlite(brainDir)
  initMemorySchema(getDb())

  const extMap = buildExtMap(repo.languages)
  const fileEntries = await walkFiles(repo.path, extMap)
  console.info(`[brain/scan] scanning ${repo.path} as repo "${repo.name}"`)
  console.info(`[brain/scan] found ${fileEntries.length} source files`)

  const now = new Date()
  const scanSha = `scan-${now.getTime().toString(36)}`

  const deltas = []
  let parsed = 0
  for (const [filePath, language] of fileEntries) {
    const change: FileChange = {
      path: filePath,
      status: 'added',
      additions: 0,
      deletions: 0,
      patch: null,
      rawUrl: '',
    }
    try {
      const delta = await extractSymbolDelta(change, language, repo.path)
      deltas.push(delta)
      if (delta.added.length > 0) parsed++
    } catch {
      deltas.push({ file: filePath, language, added: [], removed: [], modified: [], importsAdded: [], importsRemoved: [] })
    }
  }

  const totalSymbols = deltas.reduce((s, d) => s + d.added.length, 0)
  console.info(`[brain/scan] parsed ${parsed} files, ${totalSymbols} symbols`)
  console.info(`[brain/scan] writing to graph...`)

  const result = await applySymbolDelta(repo.name, scanSha, deltas, now)
  console.info(`[brain/scan] graph ${result.nodesUpserted}/${result.edgesUpserted}`)

  const events: RawEvent[] = []
  for (const delta of deltas) {
    for (const sym of delta.added) {
      events.push({
        repo: repo.name,
        commitSha: scanSha,
        eventType: 'symbol_added',
        payload: {
          fqn: `${repo.name}:${delta.file}:${sym.name}`,
          file: delta.file,
          kind: sym.kind,
        },
      })
    }
  }
  if (events.length > 0) writeTier1Events(events)

  detectModules(repo.name)

  const db = getDb()
  const totalFiles = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo.name) as { c: number })?.c ?? deltas.length

  console.info(`[brain/scan] done`)
  console.info(`  files:   ${deltas.length}`)
  console.info(`  symbols: ${totalSymbols}`)
  console.info(`  tier1:   ${events.length} events`)
  console.info(`\nRun 'brain watch' to start the daemon, or 'brain ask' to query.`)
}
