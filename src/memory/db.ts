import Database from 'better-sqlite3'
import path from 'node:path'

let _db: Database.Database | null = null

export function initSqlite(brainDir: string): void {
  const dbPath = path.join(brainDir, 'brain.db')
  _db = new Database(dbPath)
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('SQLite not initialised — call initSqlite first')
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}