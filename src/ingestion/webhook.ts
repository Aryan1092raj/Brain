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

  app.post('/webhook/:repoName', express.raw({ type: 'application/json' }), async (req, res) => {
    const repoName = req.params.repoName
    const repo = config.repos.find(r => r.name === repoName)

    if (!repo) return res.status(404).json({ error: 'repo not configured' })

    const signature = req.headers['x-hub-signature-256'] as string
    if (!signature || !verifyHmac(signature, req.body, repo.webhookSecret)) {
      return res.status(401).json({ error: 'invalid signature' })
    }

    const event = req.headers['x-github-event']
    if (event !== 'push' && event !== 'pull_request') return res.status(200).json({ skipped: true })

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

  app.get('/status', async (req, res) => {
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

  app.get('/', async (req, res) => {
    const repo = (req.query.repo as string) ?? config.repos[0]?.name
    if (!repo) return res.status(400).send('No repo configured')

    const db = await import('../memory/db.js').then(m => m.getDb())
    const symbolCount = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
    const fileCount = (db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
    const hotzones = (await import('../temporal/hotzone.js')).getCurrentHotZones(repo)
    const tier1Count = (db.prepare(`SELECT COUNT(*) as c FROM tier1_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
    const tier2Count = (db.prepare(`SELECT COUNT(*) as c FROM tier2_episodes WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
    const tier3Count = (db.prepare(`SELECT COUNT(*) as c FROM tier3_facts WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
    const tier4Count = (db.prepare(`SELECT COUNT(*) as c FROM tier4_patterns WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
    const episodes = db.prepare(`SELECT date, summary FROM tier2_episodes WHERE repo = ? ORDER BY date DESC LIMIT 5`).all(repo) as Array<{ date: string; summary: string }>

    const hotzoneRows = hotzones.map(h => `<tr><td>${h.symbolFqn}</td><td>${h.filePath}</td><td>${h.zScore.toFixed(2)}</td><td>${h.velocity.toFixed(1)}</td></tr>`).join('\n')
    const episodeRows = episodes.map(e => `<li><strong>${e.date}</strong>: ${e.summary.slice(0, 200)}</li>`).join('\n')

    res.setHeader('Content-Type', 'text/html')
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brain Dashboard — ${repo}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { color: #58a6ff; margin-bottom: 8px; }
  h2 { color: #f0f6fc; margin: 24px 0 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
  .card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
  th { background: #21262d; color: #8b949e; text-align: left; padding: 8px 12px; font-size: 12px; text-transform: uppercase; }
  td { padding: 8px 12px; border-top: 1px solid #30363d; font-family: monospace; font-size: 13px; }
  tr:hover td { background: #1c2331; }
  ul { list-style: none; }
  li { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 8px; font-size: 13px; }
  li strong { color: #58a6ff; }
  .chat { margin-top: 24px; }
  .chat textarea { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; padding: 12px; font-family: monospace; font-size: 13px; resize: vertical; min-height: 60px; }
  .chat button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 20px; font-size: 14px; cursor: pointer; margin-top: 8px; }
  .chat button:hover { background: #2ea043; }
  #chat-output { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-top: 8px; white-space: pre-wrap; font-family: monospace; font-size: 13px; min-height: 80px; }
  .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .status-ok { background: #3fb950; }
</style>
</head>
<body>
<h1><span class="status-dot status-ok"></span>Brain Dashboard</h1>
<p style="color: #8b949e; margin-bottom: 16px;">${repo} · <span id="last-refresh">${new Date().toISOString()}</span></p>

<div class="stats">
  <div class="card"><div class="value">${fileCount}</div><div class="label">Files</div></div>
  <div class="card"><div class="value">${symbolCount}</div><div class="label">Symbols</div></div>
  <div class="card"><div class="value">${hotzones.length}</div><div class="label">Hot Zones</div></div>
  <div class="card"><div class="value">${tier1Count}</div><div class="label">Tier 1 Events</div></div>
  <div class="card"><div class="value">${tier2Count}</div><div class="label">Tier 2 Episodes</div></div>
  <div class="card"><div class="value">${tier3Count}</div><div class="label">Tier 3 Facts</div></div>
  <div class="card"><div class="value">${tier4Count}</div><div class="label">Tier 4 Patterns</div></div>
</div>

<h2>Hot Zones</h2>
${hotzones.length > 0
  ? `<table><thead><tr><th>Symbol</th><th>File</th><th>Z-Score</th><th>Velocity</th></tr></thead><tbody>${hotzoneRows}</tbody></table>`
  : '<p style="color: #8b949e;">No hot zones detected yet.</p>'}

<h2>Recent Episodes</h2>
${episodes.length > 0 ? `<ul>${episodeRows}</ul>` : '<p style="color: #8b949e;">No episodes yet.</p>'}

<h2>Ask Brain</h2>
<div class="chat">
  <textarea id="query-input" placeholder="Ask a question about the codebase..."></textarea>
  <button onclick="askBrain()">Ask</button>
  <div id="chat-output"></div>
</div>

<script>
async function askBrain() {
  const input = document.getElementById('query-input')
  const output = document.getElementById('chat-output')
  const q = input.value.trim()
  if (!q) return
  output.textContent = 'Thinking...'
  try {
    const r = await fetch('/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: '${repo}', prompt: q, stream: false }) })
    const d = await r.json()
    output.textContent = d.answer || 'No answer'
  } catch (e) { output.textContent = 'Error: ' + e.message }
}
setInterval(() => { window.location.reload() }, 30000)
</script>
</body>
</html>`)
  })

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  return app
}