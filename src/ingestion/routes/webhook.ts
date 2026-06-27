import express from 'express'
import type { Router, Request, Response } from 'express'
import { verifyHmac } from '../helpers.js'
import { processPushEvent } from '../pipeline.js'
import type { Config } from '../../config/schema.js'

export function registerWebhookRoute(router: Router, config: Config, trackInFlight?: (delta: number) => void): void {
  router.post('/webhook/:repoName', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    try {
      const repoName = req.params.repoName
      const repo = config.repos.find(r => r.name === repoName)

      if (!repo) {
        res.status(404).json({ error: 'repo not configured' })
        return
      }

      const signature = req.headers['x-hub-signature-256'] as string
      // Signature check requires raw body. Express.raw has parsed it into req.body as Buffer.
      const rawBody = req.body as Buffer
      if (!signature || !verifyHmac(signature, rawBody, repo.webhookSecret)) {
        res.status(401).json({ error: 'invalid signature' })
        return
      }

      const event = req.headers['x-github-event']
      if (event !== 'push' && event !== 'pull_request') {
        res.status(200).json({ skipped: true })
        return
      }

      const payload = JSON.parse(rawBody.toString())
      if (payload.ref !== `refs/heads/${repo.branch}`) {
        res.status(200).json({ skipped: 'wrong branch' })
        return
      }

      res.status(202).json({ accepted: true })

      trackInFlight?.(1)
      processPushEvent(repo, payload)
        .catch(err => {
          console.error('[brain] pipeline error:', err)
        })
        .finally(() => {
          trackInFlight?.(-1)
        })
    } catch (err: any) {
      console.error('[brain] webhook route error:', err)
      res.status(500).json({ error: err.message })
    }
  })
}
