import { Database, Connection } from 'kuzu'
import path from 'node:path'
import fs from 'node:fs'

let _db: Database | null = null

export function initKuzu(brainDir: string): void {
  const dbPath = path.join(brainDir, 'graph', 'brain.kuzu')
  fs.mkdirSync(path.join(brainDir, 'graph'), { recursive: true })
  _db = new Database(dbPath)
}

export function getKuzuClient(): KuzuClient {
  if (!_db) throw new Error('Kuzu not initialised')
  return new KuzuClient(new Connection(_db))
}

let _queryChain: Promise<any> = Promise.resolve()

async function acquireLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _queryChain.then(fn)
  _queryChain = next.catch(() => {})
  return next
}

export class KuzuClient {
  constructor(private conn: Connection) {}

  async run(cypher: string, params?: Record<string, unknown>): Promise<void> {
    const q = inlineParams(cypher, params)
    await acquireLock(async () => {
      const result = await this.conn.query(q)
      const qr = Array.isArray(result) ? result[0] : result
      await qr.getAll()
    })
  }

  async query<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
    const q = inlineParams(cypher, params)
    return acquireLock(async () => {
      const result = await this.conn.query(q)
      const qr = Array.isArray(result) ? result[0] : result
      return (await qr.getAll()) as T[]
    })
  }
}

function inlineParams(cypher: string, params?: Record<string, unknown>): string {
  if (!params) return cypher
  let q = cypher
  for (const [k, v] of Object.entries(params)) {
    const escaped = typeof v === 'string'
      ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
      : v instanceof Date
        ? `CAST('${v.toISOString()}' AS TIMESTAMP)`
        : typeof v === 'boolean'
          ? String(v)
          : String(v)
    q = q.replace(new RegExp(`\\$${k}\\b`, 'g'), () => escaped)
  }
  return q
}

export function closeKuzu(): void {
  _db = null
}