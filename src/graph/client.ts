import { Database, Connection } from 'kuzu'
import path from 'node:path'

let _db: Database | null = null
let _conn: Connection | null = null

export function initKuzu(brainDir: string): void {
  const dbPath = path.join(brainDir, 'graph', 'brain.kuzu')
  _db = new Database(dbPath)
  _conn = new Connection(_db)
}

export function getKuzuClient(): KuzuClient {
  if (!_conn) throw new Error('Kuzu not initialised')
  return new KuzuClient(_conn)
}

export class KuzuClient {
  constructor(private conn: Connection) {}

  async run(cypher: string, params?: Record<string, unknown>): Promise<void> {
    const q = inlineParams(cypher, params)
    const result = await this.conn.query(q)
    const qr = Array.isArray(result) ? result[0] : result
    await qr.getAll()
  }

  async query<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
    const q = inlineParams(cypher, params)
    const result = await this.conn.query(q)
    const qr = Array.isArray(result) ? result[0] : result
    return (await qr.getAll()) as T[]
  }
}

function inlineParams(cypher: string, params?: Record<string, unknown>): string {
  if (!params) return cypher
  let q = cypher
  for (const [k, v] of Object.entries(params)) {
    const escaped = typeof v === 'string'
      ? `'${v.replace(/'/g, "\\'")}'`
      : v instanceof Date
        ? `'${v.toISOString()}'`
        : String(v)
    q = q.replace(new RegExp(`\\$${k}\\b`, 'g'), escaped)
  }
  return q
}

export function closeKuzu(): void {
  _conn = null
  _db = null
}