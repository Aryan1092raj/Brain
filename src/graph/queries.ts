import { getKuzuClient } from './client.js'

export async function getExportedSymbols(repo: string) {
  const db = getKuzuClient()
  return db.query<{ fqn: string; kind: string; file: string }>(
    `MATCH (s:Symbol {repo: $r, is_exported: true})
     RETURN s.fqn AS fqn, s.kind AS kind, s.file AS file
     ORDER BY s.file LIMIT 200`,
    { r: repo }
  )
}

export async function getSymbolCount(repo: string): Promise<number> {
  const db = getKuzuClient()
  const result = await db.query<{ count: number }>(
    `MATCH (s:Symbol {repo: $r}) RETURN count(s) AS count`,
    { r: repo }
  )
  return result[0]?.count ?? 0
}

export async function getFileCount(repo: string): Promise<number> {
  const db = getKuzuClient()
  const result = await db.query<{ count: number }>(
    `MATCH (f:File {repo: $r}) RETURN count(f) AS count`,
    { r: repo }
  )
  return result[0]?.count ?? 0
}

export async function getPrimaryLanguage(repo: string): Promise<string> {
  const db = getKuzuClient()
  const result = await db.query<{ language: string; count: number }>(
    `MATCH (f:File {repo: $r})
     RETURN f.language AS language, count(f) AS count
     ORDER BY count DESC LIMIT 1`,
    { r: repo }
  )
  return result[0]?.language ?? 'unknown'
}