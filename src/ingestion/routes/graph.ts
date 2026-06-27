import type { Router, Request, Response } from 'express'
import { getGraphOverview } from '../../graph/insights.js'
import { computeLocalDiffImpact } from '../../query/diff-impact.js'
import { computeRippleImpact } from '../../query/ripple.js'
import { getCurrentHotZones } from '../../temporal/hotzone.js'
import { predictSymbolCoChanges, predictFileCoChanges } from '../../temporal/co-change.js'
import { query as queryLlm } from '../../query/engine.js'
import type { Config } from '../../config/schema.js'

export function registerGraphRoutes(router: Router, config: Config): void {
  router.get('/graph', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string
      if (!repo) {
        res.status(400).json({ error: 'repo query param required' })
        return
      }

      res.json(await getGraphOverview(repo))
    } catch (err) {
      console.error('[brain] graph error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.get('/graph/diff-impact', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string
      if (!repo) {
        res.status(400).json({ error: 'repo query param required' })
        return
      }

      const matchedRepo = config.repos.find(r => r.name === repo)
      if (!matchedRepo) {
        res.status(404).json({ error: 'repo not configured' })
        return
      }

      const impacts = await computeLocalDiffImpact(matchedRepo.path, repo)
      res.json(impacts)
    } catch (err) {
      console.error('[brain] diff-impact error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.get('/graph/explain', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string
      const id = req.query.id as string
      if (!repo || !id) {
        res.status(400).json({ error: 'repo and id query params required' })
        return
      }

      const graph = await getGraphOverview(repo, 140)
      const node = graph.nodes.find(n => n.id === id)
      if (!node) {
        res.status(404).json({ error: 'node not found' })
        return
      }

      const incident = graph.edges.filter(e => e.source === id || e.target === id)
      const neighbors = incident.slice(0, 10).map(e => {
        const otherId = e.source === id ? e.target : e.source
        const other = graph.nodes.find(n => n.id === otherId)
        return `${e.type}: ${other?.label ?? otherId}`
      })
      const deadCode = graph.deadCode.find(d => d.fqn === id)
      const fallback = [
        node.type === 'file' ? `File ${node.file ?? node.label}.` : `${node.kind ?? 'Symbol'} ${node.label} in ${node.file}${node.lineStart ? `:${node.lineStart}` : ''}.`,
        `Connected edges: ${incident.length}.`,
        deadCode ? `Dead-code candidate: ${deadCode.reason}` : '',
      ].filter(Boolean).join(' ')

      let summary = fallback
      if (process.env.GROQ_API_KEY) {
        summary = await queryLlm(
          'You explain code graph nodes for a debugging dashboard. Be concrete. Max 35 words. No markdown.',
          JSON.stringify({ node, connected: neighbors, deadCode: deadCode?.reason ?? null }),
          { temperature: 0.2, maxTokens: 90 },
        ).catch(() => fallback)
      }

      res.json({ node, edges: incident, connected: neighbors, deadCode, summary })
    } catch (err) {
      console.error('[brain] graph explain error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Enriched graph data: merges graph overview with hot zone flags for D3 dashboard
  router.get('/api/graph-data', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string
      const limit = Math.min(Number(req.query.limit) || 200, 500)
      if (!repo) {
        res.status(400).json({ error: 'repo query param required' })
        return
      }

      const [overview, hotZones] = await Promise.all([
        getGraphOverview(repo, limit),
        Promise.resolve(getCurrentHotZones(repo)),
      ])

      const hotSet = new Set(hotZones.map(h => h.symbolFqn))
      const hotMap = new Map(hotZones.map(h => [h.symbolFqn, { velocity: h.velocity, zScore: h.zScore }]))

      const enrichedNodes = overview.nodes.map(node => ({
        ...node,
        isHotZone: hotSet.has(node.id),
        hotVelocity: hotMap.get(node.id)?.velocity ?? null,
        hotZScore: hotMap.get(node.id)?.zScore ?? null,
      }))

      res.json({
        nodes: enrichedNodes,
        edges: overview.edges,
        deadCode: overview.deadCode,
        hotZones,
        metrics: {
          ...overview.metrics,
          hotZoneCount: hotZones.length,
        },
      })
    } catch (err) {
      console.error('[brain] api/graph-data error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Ripple impact API: returns blast radius for a given symbol
  router.get('/api/ripple', async (req: Request, res: Response) => {
    try {
      const fqn = req.query.fqn as string
      const depth = Math.min(Number(req.query.depth) || 5, 8)
      if (!fqn) {
        res.status(400).json({ error: 'fqn query param required' })
        return
      }

      const impacts = await computeRippleImpact(fqn, depth)
      res.json({ source: fqn, impacts })
    } catch (err) {
      console.error('[brain] api/ripple error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Co-change Prediction API: predicts historical co-occurring files or symbols
  router.get('/api/co-change', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string
      const id = req.query.id as string
      const type = req.query.type as string // 'file' or 'symbol'
      const limit = Math.min(Number(req.query.limit) || 5, 15)

      if (!repo || !id || !type) {
        res.status(400).json({ error: 'repo, id, and type query params required' })
        return
      }

      if (type === 'file') {
        const predictions = predictFileCoChanges(repo, id, limit)
        res.json({ id, type, predictions })
      } else {
        const predictions = predictSymbolCoChanges(repo, id, limit)
        res.json({ id, type, predictions })
      }
    } catch (err) {
      console.error('[brain] api/co-change error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })
}
