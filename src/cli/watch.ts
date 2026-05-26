import { loadConfig } from '../config/loader.js'
import { createWebhookServer } from '../ingestion/webhook.js'
import { startScheduler } from '../memory/scheduler.js'
import { initKuzu, closeKuzu } from '../graph/client.js'
import { initSqlite, closeDb } from '../memory/db.js'

let server: import('node:http').Server | null = null
let inFlight = 0

export function trackInFlight(delta: number): void {
  inFlight += delta
}

export async function watch(cwd: string): Promise<void> {
  const config = await loadConfig(cwd)

  const brainDir = cwd
  initKuzu(brainDir)
  initSqlite(brainDir)

  const app = createWebhookServer(config, trackInFlight)

  server = app.listen(config.port, () => {
    console.info(`[brain] listening on :${config.port}`)
  })

  startScheduler(config)

  const shutdown = async (signal: string) => {
    console.info(`[brain] received ${signal}, draining ${inFlight} in-flight pipelines...`)
    if (server) server.close()

    const deadline = Date.now() + 10000
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }

    closeKuzu()
    closeDb()
    console.info('[brain] shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}