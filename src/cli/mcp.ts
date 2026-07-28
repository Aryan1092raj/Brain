import { initSqlite, getDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { startMCPServer } from '../mcp/server.js'
import { initKuzu } from '../graph/client.js'
import { getBrainDir } from '../config/paths.js'

export async function mcp(cwd: string, _argv: string[]): Promise<void> {
  const brainDir = getBrainDir(cwd)
  initSqlite(brainDir)
  initMemorySchema(getDb())
  initKuzu(brainDir)

  startMCPServer()
}
