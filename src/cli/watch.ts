import { loadConfig } from '../config/loader.js'
import { createWebhookServer } from '../ingestion/webhook.js'
import { startScheduler, stopScheduler } from '../memory/scheduler.js'
import { initKuzu, closeKuzu } from '../graph/client.js'
import { initGraphSchema } from '../graph/schema.js'
import { initSqlite, getDb, closeDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'
import { init } from './init.js'
import fs from 'node:fs/promises'
import { getBrainDir, getProjectConfigPath } from '../config/paths.js'

let server: import('node:http').Server | null = null
let inFlight = 0

export function trackInFlight(delta: number): void {
  inFlight += delta
}

export async function watch(cwd: string): Promise<void> {
  const brainDir = getBrainDir(cwd)

  try {
    await fs.access(getProjectConfigPath(cwd))
  } catch {
    console.info('[brain] project is not initialized — running brain init...')
    await init(cwd)
  }

  const config = await loadConfig(cwd)
  initKuzu(brainDir)
  await initGraphSchema()
  initSqlite(brainDir)
  initMemorySchema(getDb())

  const app = createWebhookServer(config, trackInFlight)

  server = app.listen(config.port, () => {
    console.info(`[brain] listening on :${config.port}`)
    for (const repo of config.repos) {
      console.info(`[brain] dashboard → http://localhost:${config.port}?repo=${repo.name}`)
    }
  })

  startScheduler(config)

  const shutdown = async (signal: string) => {
    console.info(`[brain] received ${signal}, draining ${inFlight} in-flight pipelines...`)
    stopScheduler()
    if (server) server.close()

    const deadline = Date.now() + 10000
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }

    await closeKuzu()
    closeDb()
    console.info('[brain] shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
