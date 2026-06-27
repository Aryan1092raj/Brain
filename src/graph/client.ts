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
    await acquireLock(async () => {
      let result
      if (params && Object.keys(params).length > 0) {
        const stmt = await this.conn.prepare(cypher)
        if (!stmt.isSuccess()) {
          throw new Error(`Failed to prepare Cypher statement: ${stmt.getErrorMessage()}\nQuery: ${cypher}`)
        }
        result = await this.conn.execute(stmt, params as any)
      } else {
        result = await this.conn.query(cypher)
      }
      const qr = Array.isArray(result) ? result[0] : result
      await qr.getAll()
    })
  }

  async query<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
    return acquireLock(async () => {
      let result
      if (params && Object.keys(params).length > 0) {
        const stmt = await this.conn.prepare(cypher)
        if (!stmt.isSuccess()) {
          throw new Error(`Failed to prepare Cypher statement: ${stmt.getErrorMessage()}\nQuery: ${cypher}`)
        }
        result = await this.conn.execute(stmt, params as any)
      } else {
        result = await this.conn.query(cypher)
      }
      const qr = Array.isArray(result) ? result[0] : result
      return (await qr.getAll()) as T[]
    })
  }
}

export function closeKuzu(): void {
  _db = null
}