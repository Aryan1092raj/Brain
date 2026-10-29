
import { Database, Connection } from 'kuzu'
import path from 'node:path'
import fs from 'node:fs'

let _db: Database | null = null
let _dbPath: string | null = null
let _conn: Connection | null = null

let _queryChain: Promise<unknown> = Promise.resolve()
let _isClosing = false
let _closePromise: Promise<void> | null = null
let _generation = 0

export function initKuzu(brainDir: string): void {
  if (_isClosing || _closePromise) {
    throw new Error('Cannot initialise Kuzu while it is closing')
  }

  const dbPath = path.join(brainDir, 'graph', 'brain.kuzu')
  fs.mkdirSync(path.join(brainDir, 'graph'), { recursive: true })

  // Avoid opening the same database twice.
  if (_db) {
    if (_dbPath === dbPath) return

    throw new Error(
      'Kuzu is already initialised at a different path. ' +
      'Call and await closeKuzu() before opening another database.',
    )
  }

  _db = new Database(dbPath)
  _dbPath = dbPath
  _conn = null
}

export function getKuzuClient(): KuzuClient {
  if (!_db) {
    throw new Error('Kuzu not initialised')
  }

  if (_isClosing || _closePromise) {
    throw new Error('Kuzu is shutting down')
  }

  // Reuse one connection instead of creating an untracked connection
  // every time getKuzuClient() is called.
  if (!_conn) {
    _conn = new Connection(_db)
  }

  return new KuzuClient(_conn, _generation)
}

async function acquireLock<T>(
  conn: Connection,
  generation: number,
  fn: () => Promise<T>,
): Promise<T> {
  // Reject new operations once shutdown starts.
  if (_isClosing || _closePromise) {
    throw new Error('Cannot execute a query while Kuzu is shutting down')
  }

  if (!_db || _conn !== conn || generation !== _generation) {
    throw new Error('Kuzu client is no longer active')
  }

  const next = _queryChain.then(fn)

  // A failed query must not prevent subsequent queued queries from running.
  _queryChain = next.catch(() => undefined)

  return next
}

export class KuzuClient {
  constructor(
    private conn: Connection,
    private generation: number,
  ) {}

  async run(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    await acquireLock(this.conn, this.generation, async () => {
      let result

      if (params && Object.keys(params).length > 0) {
        const stmt = await this.conn.prepare(cypher)

        if (!stmt.isSuccess()) {
          throw new Error(
            `Failed to prepare Cypher statement: ${stmt.getErrorMessage()}\n` +
            `Query: ${cypher}`,
          )
        }

        result = await this.conn.execute(stmt, params as any)
      } else {
        result = await this.conn.query(cypher)
      }

      const results = Array.isArray(result) ? result : [result]

      try {
        const first = results[0]

        if (!first) {
          throw new Error('Kuzu returned no query result')
        }

        await first.getAll()
      } finally {
        for (const qr of results) {
          qr.close()
        }
      }
    })
  }

  async query<T>(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    return acquireLock(this.conn, this.generation, async () => {
      let result

      if (params && Object.keys(params).length > 0) {
        const stmt = await this.conn.prepare(cypher)

        if (!stmt.isSuccess()) {
          throw new Error(
            `Failed to prepare Cypher statement: ${stmt.getErrorMessage()}\n` +
            `Query: ${cypher}`,
          )
        }

        result = await this.conn.execute(stmt, params as any)
      } else {
        result = await this.conn.query(cypher)
      }

      const results = Array.isArray(result) ? result : [result]

      try {
        const first = results[0]

        if (!first) {
          throw new Error('Kuzu returned no query result')
        }

        return (await first.getAll()) as T[]
      } finally {
        for (const qr of results) {
          qr.close()
        }
      }
    })
  }
}

export function closeKuzu(): Promise<void> {
  // Reuse an ongoing shutdown operation if another caller arrives.
  if (_closePromise) {
    return _closePromise
  }

  if (!_db) {
    return Promise.resolve()
  }

  _isClosing = true

  const db = _db
  const conn = _conn

  const closing = (async () => {
    try {
      // Finish every query that was queued before shutdown began.
      await _queryChain

      // Close the connection before closing its database.
      if (conn) {
        await conn.close()

        if (_conn === conn) {
          _conn = null
        }
      }

      await db.close()

      // Clear state only after successful database closure.
      if (_db === db) {
        _db = null
        _dbPath = null
        _generation += 1
      }
    } finally {
      _isClosing = false
    }
  })()

  _closePromise = closing

  // Clear the stored promise on both success and failure.
  void closing.then(
    () => {
      if (_closePromise === closing) {
        _closePromise = null
      }
    },
    () => {
      if (_closePromise === closing) {
        _closePromise = null
      }
    },
  )

  return closing
}
