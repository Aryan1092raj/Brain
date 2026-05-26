import express from 'express'
import crypto from 'node:crypto'
import { processPushEvent } from './pipeline.js'
import { buildContext, formatContext } from '../query/context-builder.js'
import { streamQuery } from '../query/engine.js'
import type { Config } from '../config/schema.js'

export function verifyHmac(signature: string, body: Buffer, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

export function createWebhookServer(config: Config, trackInFlight?: (delta: number) => void) {
  const app = express()
  app.use(express.raw({ type: 'application/json' }))
  app.use(express.json())

  app.post('/webhook/:repoName', async (req, res) => {
    const repoName = req.params.repoName
    const repo = config.repos.find(r => r.name === repoName)

    if (!repo) return res.status(404).json({ error: 'repo not configured' })

    const signature = req.headers['x-hub-signature-256'] as string
    if (!signature || !verifyHmac(signature, req.body, repo.webhookSecret)) {
      return res.status(401).json({ error: 'invalid signature' })
    }

    const event = req.headers['x-github-event']
    if (event !== 'push') return res.status(200).json({ skipped: true })

    const payload = JSON.parse(req.body.toString())
    if (payload.ref !== `refs/heads/${repo.branch}`) {
      return res.status(200).json({ skipped: 'wrong branch' })
    }

    res.status(202).json({ accepted: true })

    trackInFlight?.(1)
    processPushEvent(repo, payload)
      .catch(err => { console.error('[brain] pipeline error:', err) })
      .finally(() => { trackInFlight?.(-1) })
  })

  app.post('/query', express.json(), async (req, res) => {
    try {
      const { repo, prompt, stream = false } = req.body
      if (!repo || !prompt) {
        return res.status(400).json({ error: 'repo and prompt required' })
      }

      const ctx = buildContext(repo)
      const contextStr = formatContext(ctx)
      const systemPrompt = `You are a codebase analyst with access to a live knowledge graph.
You know:
- Recent episodes (AI-generated summaries of code changes)
- Hot zones (symbols/files with high change velocity)
- Extracted facts (relationships between code entities)
- Recent changes (symbols modified recently)

Use this context to answer user questions about the codebase.
Be specific, reference file paths and symbols, and ground your answer in the data provided.
Keep answers concise but informative.`

      const userPrompt = `${contextStr}\n\n## User Question\n${prompt}\n\nProvide a grounded answer based on the above context.`

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()

        for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`)
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
        res.end()
      } else {
        let answer = ''
        for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
          answer += chunk
        }
        res.json({ answer, sources: { symbols: ctx.symbols.length, hotzones: ctx.hotzones.length } })
      }
    } catch (err) {
      console.error('[brain] query error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.get('/status', express.json(), async (req, res) => {
    try {
      const repo = req.query.repo as string
      if (!repo) {
        return res.status(400).json({ error: 'repo query param required' })
      }

      const db = await import('../memory/db.js').then(m => m.getDb())
      const symbolCount = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const fileCount = (db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const hotzones = (await import('../temporal/hotzone.js')).getCurrentHotZones(repo)
      const tier2Count = (db.prepare(`SELECT COUNT(*) as c FROM tier2_episodes WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0

      res.json({
        repo,
        symbolCount,
        fileCount,
        hotZones: hotzones.length,
        tier2Episodes: tier2Count,
        avgDecay: 0.72, // placeholder
        lastIndexed: new Date().toISOString(),
      })
    } catch (err) {
      console.error('[brain] status error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  return app
}