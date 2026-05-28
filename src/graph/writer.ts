import { getKuzuClient } from './client.js'
import type { SymbolDelta } from '../ingestion/tree-sitter.js'

export interface PatchResult {
  nodesUpserted: number
  edgesUpserted: number
  nodesRemoved: number
  durationMs: number
}

export async function applySymbolDelta(
  repoName: string,
  commitSha: string,
  deltas: SymbolDelta[],
  timestamp: Date,
): Promise<PatchResult> {
  const db = getKuzuClient()
  const start = Date.now()
  let nodesUpserted = 0, edgesUpserted = 0, nodesRemoved = 0

  for (const delta of deltas) {
    await db.run(`
      MERGE (f:File {path: $path, repo: $repo})
      ON CREATE SET f.language = $lang, f.created_at = $ts, f.last_touched = $ts
      ON MATCH  SET f.last_touched = $ts, f.decay_score = 1.0
    `, { path: delta.file, repo: repoName, lang: delta.language, ts: timestamp })
    nodesUpserted++

    await db.run(`
      MERGE (c:Commit {sha: $sha, repo: $repo})
      ON CREATE SET c.ts = $ts, c.file_count = $fc
    `, { sha: commitSha, repo: repoName, ts: timestamp, fc: deltas.length })

    for (const sym of [...delta.added, ...delta.modified]) {
      const fqn = `${repoName}:${delta.file}:${sym.name}`

      await db.run(`
        MERGE (s:Symbol {fqn: $fqn})
        ON CREATE SET
          s.name = $name, s.kind = $kind, s.file = $file,
          s.line_start = $ls, s.line_end = $le, s.repo = $repo,
          s.is_exported = $exp, s.decay_score = 1.0,
          s.last_touched = $ts, s.created_at = $ts
        ON MATCH SET
          s.line_start = $ls, s.line_end = $le,
          s.is_exported = $exp, s.decay_score = 1.0,
          s.last_touched = $ts
      `, {
        fqn, name: sym.name, kind: sym.kind, file: delta.file,
        ls: sym.lineStart, le: sym.lineEnd, repo: repoName,
        exp: sym.isExported, ts: timestamp,
      })
      nodesUpserted++

      await db.run(`
        MATCH (f:File {path: $file, repo: $repo}), (s:Symbol {fqn: $fqn})
        MERGE (f)-[:Contains]->(s)
      `, { file: delta.file, repo: repoName, fqn })
      edgesUpserted++

      await db.run(`
        MATCH (c:Commit {sha: $sha}), (s:Symbol {fqn: $fqn})
        MERGE (c)-[:Touches]->(s)
      `, { sha: commitSha, fqn })
      edgesUpserted++

      for (const callee of sym.calls) {
        const calleeFqn = `${repoName}:${delta.file}:${callee}`
        await db.run(`
          MATCH (caller:Symbol {fqn: $callerFqn}), (callee:Symbol {fqn: $calleeFqn})
          MERGE (caller)-[:Calls {call_site_line: $line}]->(callee)
        `, { callerFqn: fqn, calleeFqn, line: sym.lineStart }).catch(() => {})
        edgesUpserted++
      }
    }

    for (const sym of delta.removed) {
      const fqn = `${repoName}:${delta.file}:${sym.name}`
      await db.run(`MATCH (s:Symbol {fqn: $fqn}) DETACH DELETE s`, { fqn })
      nodesRemoved++
    }

    for (const imp of delta.importsAdded) {
      const resolvedPath = resolveImportPath(delta.file, imp)
      if (resolvedPath) {
        await db.run(`
          MATCH (src:File {path: $src, repo: $repo}), (dst:File {path: $dst, repo: $repo})
          MERGE (src)-[:Imports {import_name: $imp}]->(dst)
        `, { src: delta.file, dst: resolvedPath, repo: repoName, imp }).catch(() => {})
        edgesUpserted++
      }
    }
  }

  return { nodesUpserted, edgesUpserted, nodesRemoved, durationMs: Date.now() - start }
}

function resolveImportPath(fromFile: string, importPath: string): string | null {
  if (importPath.startsWith('.')) {
    const dir = fromFile.split('/').slice(0, -1).join('/')
    const resolved = `${dir}/${importPath}`.replace(/\/\//g, '/')
    return resolved.startsWith('./') ? resolved.slice(2) : resolved
  }
  return null
}