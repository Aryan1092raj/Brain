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

  // Pass 1: Upsert Files, Commits, Symbols, and local relationships
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
    }

    for (const sym of delta.removed) {
      const fqn = `${repoName}:${delta.file}:${sym.name}`
      await db.run(`MATCH (s:Symbol {fqn: $fqn}) DETACH DELETE s`, { fqn })
      nodesRemoved++
    }
  }

  // Fetch all symbols in Kuzu to construct an in-memory lookup index
  const allSymbols = await db.query<{ fqn: string; file: string; name: string }>(`
    MATCH (s:Symbol {repo: $repo})
    RETURN s.fqn AS fqn, s.file AS file, s.name AS name
  `, { repo: repoName })

  const symbolFqns = new Set(allSymbols.map(s => s.fqn))
  const fileExports = new Map<string, Set<string>>()
  for (const s of allSymbols) {
    if (!fileExports.has(s.file)) {
      fileExports.set(s.file, new Set())
    }
    fileExports.get(s.file)!.add(s.name)
  }

  // Pass 2: Link cross-file Calls and Imports relationships
  for (const delta of deltas) {
    // 1. Establish Calls edges
    for (const sym of [...delta.added, ...delta.modified]) {
      const callerFqn = `${repoName}:${delta.file}:${sym.name}`

      for (const callee of sym.calls) {
        let calleeFqn: string | null = null

        // Check 1: Local call in the same file
        const localFqn = `${repoName}:${delta.file}:${callee}`
        if (symbolFqns.has(localFqn)) {
          calleeFqn = localFqn
        } else {
          // Check 2: Cross-file call from imports
          for (const imp of delta.importsAdded) {
            const resolved = resolveImportPath(delta.file, imp)
            if (resolved) {
              const fileCandidates = [
                resolved,
                resolved.replace(/\.js$/, '.ts'),
                resolved.replace(/\.js$/, '.tsx'),
                resolved + '.ts',
                resolved + '.tsx',
              ]

              for (const candidatePath of fileCandidates) {
                if (fileExports.get(candidatePath)?.has(callee)) {
                  calleeFqn = `${repoName}:${candidatePath}:${callee}`
                  break
                }
              }
              if (calleeFqn) break
            }
          }
        }

        if (calleeFqn) {
          await db.run(`
            MATCH (caller:Symbol {fqn: $callerFqn}), (callee:Symbol {fqn: $calleeFqn})
            MERGE (caller)-[:Calls {call_site_line: $line}]->(callee)
          `, { callerFqn, calleeFqn, line: sym.lineStart }).catch(() => {})
          edgesUpserted++
        }
      }
    }

    // 2. Establish Imports edges
    for (const imp of delta.importsAdded) {
      const resolvedPath = resolveImportPath(delta.file, imp)
      if (resolvedPath) {
        const fileCandidates = [
          resolvedPath,
          resolvedPath.replace(/\.js$/, '.ts'),
          resolvedPath.replace(/\.js$/, '.tsx'),
          resolvedPath + '.ts',
          resolvedPath + '.tsx',
        ]
        
        let finalDest: string | null = null
        for (const candidate of fileCandidates) {
          if (fileExports.has(candidate) || candidate === resolvedPath) {
            finalDest = candidate
            break
          }
        }
        
        if (finalDest) {
          await db.run(`
            MATCH (src:File {path: $src, repo: $repo}), (dst:File {path: $dst, repo: $repo})
            MERGE (src)-[:Imports {import_name: $imp}]->(dst)
          `, { src: delta.file, dst: finalDest, repo: repoName, imp }).catch(() => {})
          edgesUpserted++
        }
      }
    }
  }

  return { nodesUpserted, edgesUpserted, nodesRemoved, durationMs: Date.now() - start }
}

function resolveImportPath(fromFile: string, importPath: string): string | null {
  if (importPath.startsWith('.')) {
    const dir = fromFile.split('/').slice(0, -1).join('/')
    const resolved = `${dir}/${importPath}`.replace(/\/\//g, '/')
    
    // Resolve relative path segments
    const parts = resolved.split('/')
    const stack: string[] = []
    for (const part of parts) {
      if (part === '.' || part === '') continue
      if (part === '..') {
        stack.pop()
      } else {
        stack.push(part)
      }
    }
    return stack.join('/')
  }
  return null
}