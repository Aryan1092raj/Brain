import { getDb } from '../memory/db.js'
import type { SymbolDelta } from '../ingestion/tree-sitter.js'

export interface ChangeEvent {
  repo: string
  symbolFqn: string
  filePath: string
  commitSha: string
  author: string
  additions: number
  deletions: number
  ts: number
}

export function writeChangeEvents(
  repo: string,
  commitSha: string,
  author: string,
  deltas: SymbolDelta[],
  fileChanges: Array<{ path: string; additions: number; deletions: number }>,
): void {
  const db = getDb()
  const ts = Date.now()

  const changeMap = new Map(fileChanges.map(f => [f.path, f]))

  const insert = db.prepare(`
    INSERT INTO change_events (repo, symbol_fqn, file_path, commit_sha, author, additions, deletions, ts)
    VALUES (@repo, @symbolFqn, @filePath, @commitSha, @author, @additions, @deletions, @ts)
  `)

  const insertMany = db.transaction((events: ChangeEvent[]) => {
    for (const e of events) insert.run(e)
  })

  const events: ChangeEvent[] = []
  for (const delta of deltas) {
    const fc = changeMap.get(delta.file)
    for (const sym of [...delta.added, ...delta.modified]) {
      events.push({
        repo,
        symbolFqn: `${repo}:${delta.file}:${sym.name}`,
        filePath: delta.file,
        commitSha,
        author,
        additions: fc?.additions ?? 0,
        deletions: fc?.deletions ?? 0,
        ts,
      })
    }
  }

  insertMany(events)
}