import express from 'express'
import type { Config } from '../config/schema.js'

import { registerWebhookRoute } from './routes/webhook.js'
import { registerQueryRoute } from './routes/query.js'
import { registerGraphRoutes } from './routes/graph.js'
import { registerStatusRoute } from './routes/status.js'
import { registerIngestRoute } from './routes/ingest.js'
import { registerDashboardRoute } from './routes/dashboard.js'

// Export verifyHmac for compatibility/testing if needed
export { verifyHmac } from './helpers.js'

export function createWebhookServer(config: Config, trackInFlight?: (delta: number) => void) {
  const app = express()

  // Webhook route needs to handle raw body for signature verification before parsing JSON globally.
  // We register webhook route first with express.raw middleware inside registerWebhookRoute.
  registerWebhookRoute(app, config, trackInFlight)

  // Global middlewares for subsequent JSON routes
  app.use(express.json())

  registerQueryRoute(app)
  registerGraphRoutes(app, config)
  registerStatusRoute(app)
  registerIngestRoute(app, config)
  registerDashboardRoute(app, config)

  return app
}
