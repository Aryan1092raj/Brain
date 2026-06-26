import path from 'node:path'
import { initSqlite, getDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { startMCPServer } from '../mcp/server.js'
import { initKuzu } from '../graph/client.js'

export async function mcp(cwd: string, _argv: string[]): Promise<void> {
  const brainDir = path.join(cwd, '.brain')
  initSqlite(brainDir)
  initMemorySchema(getDb())
  initKuzu(brainDir)

  startMCPServer()
}
