import express from 'express'
import crypto from 'node:crypto'
import { processPushEvent } from './pipeline.js'
import { buildContext, formatRichContext } from '../query/context-builder.js'
import { streamQuery, query as queryLlm } from '../query/engine.js'
import { getGraphOverview } from '../graph/insights.js'
import type { Config } from '../config/schema.js'

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

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
      const contextStr = await formatRichContext(ctx)
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

  app.get('/graph', async (req, res) => {
    try {
      const repo = req.query.repo as string
      if (!repo) {
        return res.status(400).json({ error: 'repo query param required' })
      }

      res.json(await getGraphOverview(repo))
    } catch (err) {
      console.error('[brain] graph error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  app.get('/graph/explain', async (req, res) => {
    try {
      const repo = req.query.repo as string
      const id = req.query.id as string
      if (!repo || !id) {
        return res.status(400).json({ error: 'repo and id query params required' })
      }

      const graph = await getGraphOverview(repo, 140)
      const node = graph.nodes.find(n => n.id === id)
      if (!node) return res.status(404).json({ error: 'node not found' })

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

    const safeRepo = escapeHtml(repo)
    const repoJson = JSON.stringify(repo)
    const hotzoneRows = hotzones.map(h => `<tr><td>${escapeHtml(h.symbolFqn)}</td><td>${escapeHtml(h.filePath)}</td><td>${h.zScore.toFixed(2)}</td><td>${h.velocity.toFixed(1)}</td></tr>`).join('\n')
    const episodeRows = episodes.map(e => `<li><strong>${escapeHtml(e.date)}</strong><span>${escapeHtml(e.summary.slice(0, 200))}</span></li>`).join('\n')

    res.setHeader('Content-Type', 'text/html')
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brain Dashboard - ${safeRepo}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --paper: #fffdf8;
    --ink: #08090b;
    --line: #111827;
    --muted: #596171;
    --pink: #ff4167;
    --mint: #64e9a3;
    --panel: #fff3d6;
    --field: #e9f1ff;
    --peach: #ffc174;
    --shadow: #152033;
  }
  body { min-height: 100dvh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--paper); color: var(--ink); }
  .topbar { height: 72px; border-bottom: 3px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 clamp(18px, 5vw, 72px); }
  .brand { font-size: 28px; font-weight: 900; letter-spacing: 0; }
  .brand span { color: var(--pink); }
  .meta { display: flex; align-items: center; gap: 12px; color: var(--line); font-size: 15px; }
  .badge { display: inline-flex; align-items: center; height: 25px; padding: 0 8px; border: 2px solid var(--line); background: var(--pink); color: #fff; font-weight: 900; font-size: 12px; transform: rotate(-6deg); box-shadow: 2px 2px 0 var(--line); }
  main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: clamp(34px, 7vw, 72px) 0 46px; }
  .hero { text-align: center; position: relative; }
  h1 { max-width: 760px; margin: 0 auto; font-size: clamp(52px, 8vw, 88px); line-height: .98; font-weight: 950; text-wrap: balance; letter-spacing: 0; }
  .subtitle { margin: 24px auto 0; max-width: 660px; color: #3d4656; font-size: clamp(18px, 2vw, 22px); line-height: 1.45; text-wrap: pretty; }
  .spark { position: absolute; display: grid; place-items: center; color: var(--line); font-size: clamp(42px, 6vw, 74px); font-weight: 900; line-height: 1; }
  .spark::before { content: ""; width: .62em; height: .62em; border: 4px solid var(--line); background: var(--pink); transform: rotate(45deg); box-shadow: 0 0 0 8px var(--paper); }
  .spark.mint::before { background: var(--mint); }
  .spark.left { left: 7%; top: 10%; }
  .spark.right { right: 6%; top: 42%; }
  .dashboard { margin: 46px auto 0; background: var(--panel); border: 4px solid var(--line); border-radius: 8px; box-shadow: 10px 10px 0 var(--shadow); padding: clamp(18px, 4vw, 30px); text-align: left; }
  .query-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: stretch; }
  textarea { width: 100%; min-height: 74px; resize: vertical; border: 4px solid var(--line); border-radius: 5px; background: var(--field); color: var(--line); padding: 18px 20px; font: 700 18px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; box-shadow: 5px 5px 0 var(--shadow); }
  textarea::placeholder { color: #6c7890; }
  button { min-width: 132px; border: 4px solid var(--line); border-radius: 5px; background: var(--peach); color: var(--ink); font-size: 20px; font-weight: 850; cursor: pointer; box-shadow: 5px 5px 0 var(--shadow); }
  button:focus-visible, textarea:focus-visible { outline: 3px solid var(--pink); outline-offset: 3px; }
  button:active { transform: translate(3px, 3px); box-shadow: 2px 2px 0 var(--shadow); }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 26px 0 4px; }
  .card { min-height: 92px; border: 3px solid var(--line); border-radius: 6px; background: #fffaf0; padding: 14px; }
  .card .value { font-size: 30px; line-height: 1; font-weight: 950; color: var(--pink); font-variant-numeric: tabular-nums; }
  .card .label { margin-top: 8px; color: var(--muted); font-size: 12px; font-weight: 850; text-transform: uppercase; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: 20px; margin-top: 28px; align-items: start; }
  .graph-panel { margin-top: 28px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  .microcopy { color: var(--muted); font-size: 13px; font-weight: 750; }
  .graph-shell { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: stretch; }
  #graph-map { width: 100%; height: 520px; display: block; background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; }
  .graph-node { cursor: pointer; }
  .graph-node:hover circle { stroke-width: 5; }
  .graph-node.selected circle { fill: var(--mint); stroke-width: 5; }
  .graph-node.dim { opacity: .25; }
  .graph-edge.dim { opacity: .08; }
  .graph-edge.selected { stroke: var(--pink); opacity: .92; stroke-width: 3; }
  .inspector { min-height: 520px; background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 16px; display: grid; grid-template-rows: auto auto 1fr; gap: 12px; }
  .inspector h3 { font-size: 20px; line-height: 1.1; overflow-wrap: anywhere; }
  .inspector code { display: block; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
  .inspector p { color: #273244; line-height: 1.45; font-size: 14px; text-wrap: pretty; }
  .pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { border: 2px solid var(--line); border-radius: 999px; padding: 4px 8px; background: var(--field); font-size: 12px; font-weight: 850; }
  .pill.hot { background: var(--pink); color: #fff; }
  .neighbor-list { display: grid; gap: 8px; align-content: start; }
  .neighbor-list div { border-top: 1px solid rgba(17,24,39,.18); padding-top: 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 10px; color: var(--muted); font-size: 12px; font-weight: 800; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 12px; height: 12px; border: 2px solid var(--line); display: inline-block; }
  .dot.file { background: var(--pink); }
  .dot.symbol { background: var(--mint); }
  .dot.call { width: 18px; height: 3px; background: var(--line); border: 0; }
  .dead-section { grid-column: 1 / -1; }
  .dead-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
  .dead-item { display: grid; gap: 4px; }
  .dead-item code { color: var(--line); font-size: 12px; overflow-wrap: anywhere; }
  .dead-item small { color: var(--muted); line-height: 1.4; }
  section { min-width: 0; }
  h2 { margin: 0 0 12px; color: var(--line); font-size: 18px; font-weight: 950; }
  table { width: 100%; border-collapse: collapse; background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; overflow: hidden; table-layout: fixed; }
  th { background: var(--field); color: var(--line); text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; border-bottom: 3px solid var(--line); }
  td { padding: 10px 12px; border-top: 1px solid rgba(17,24,39,.18); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul { list-style: none; display: grid; gap: 10px; }
  li { background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 12px; font-size: 13px; }
  li strong { color: var(--pink); display: block; margin-bottom: 5px; }
  .empty, #chat-output { background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 14px; color: var(--muted); font-size: 14px; }
  #chat-output { margin-top: 16px; min-height: 94px; white-space: pre-wrap; color: var(--line); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
  .foot { margin-top: 24px; color: var(--muted); text-align: center; font-size: 14px; }
  @media (max-width: 800px) {
    .topbar { height: auto; padding: 16px; align-items: flex-start; flex-direction: column; }
    .spark { display: none; }
    .query-row, .grid { grid-template-columns: 1fr; }
    .graph-shell { grid-template-columns: 1fr; }
    #graph-map { height: 420px; }
    .inspector { min-height: 260px; }
    button { height: 62px; width: 100%; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .dashboard { box-shadow: 6px 6px 0 var(--shadow); }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">Br<span>ain</span></div>
  <div class="meta"><span class="badge">LIVE</span><span>${safeRepo}</span><span>${new Date().toLocaleString()}</span></div>
</header>
<main>
  <div class="hero">
    <span class="spark left"></span>
    <span class="spark right mint"></span>
    <h1>Prompt-friendly code memory</h1>
    <p class="subtitle">Track repository changes, hot zones, summaries, and ask grounded questions from one local dashboard.</p>
  </div>

  <div class="dashboard">
    <div class="query-row">
      <textarea id="query-input" placeholder="Ask about architecture, risky files, recent changes..."></textarea>
      <button onclick="askBrain()">Ask</button>
    </div>
    <div id="chat-output">Ready.</div>

    <div class="stats">
      <div class="card"><div class="value">${fileCount}</div><div class="label">Files</div></div>
      <div class="card"><div class="value">${symbolCount}</div><div class="label">Symbols</div></div>
      <div class="card"><div class="value">${hotzones.length}</div><div class="label">Hot Zones</div></div>
      <div class="card"><div class="value">${tier1Count}</div><div class="label">Tier 1 Events</div></div>
      <div class="card"><div class="value">${tier2Count}</div><div class="label">Tier 2 Episodes</div></div>
      <div class="card"><div class="value">${tier3Count}</div><div class="label">Tier 3 Facts</div></div>
      <div class="card"><div class="value">${tier4Count}</div><div class="label">Tier 4 Patterns</div></div>
      <div class="card"><div class="value">30s</div><div class="label">Refresh</div></div>
    </div>

    <section class="graph-panel">
      <div class="section-head">
        <h2>Knowledge Graph</h2>
        <div id="graph-metrics" class="microcopy">Loading graph...</div>
      </div>
      <div class="graph-shell">
        <svg id="graph-map" role="img" aria-label="Repository knowledge graph"></svg>
        <aside class="inspector" id="graph-inspector">
          <div>
            <h3>Select a node</h3>
            <code>Click any file or symbol in the graph.</code>
          </div>
          <div class="pill-row">
            <span class="pill">file</span>
            <span class="pill">symbol</span>
            <span class="pill">calls</span>
          </div>
          <p>Inspector will show file name, graph degree, and short Groq explanation.</p>
        </aside>
      </div>
      <div class="legend">
        <span><i class="dot file"></i>File</span>
        <span><i class="dot symbol"></i>Symbol</span>
        <span><i class="dot call"></i>Calls / Contains</span>
      </div>
    </section>

    <div class="grid">
      <section>
        <h2>Hot Zones</h2>
        ${hotzones.length > 0
          ? `<table><thead><tr><th>Symbol</th><th>File</th><th>Z-Score</th><th>Velocity</th></tr></thead><tbody>${hotzoneRows}</tbody></table>`
          : '<p class="empty">No hot zones detected yet.</p>'}
      </section>

      <section>
        <h2>Recent Episodes</h2>
        ${episodes.length > 0 ? `<ul>${episodeRows}</ul>` : '<p class="empty">No episodes yet. Run scan or receive webhook events.</p>'}
      </section>

      <section class="dead-section">
        <h2>Dead Code Candidates</h2>
        <div id="dead-code-list" class="dead-list"><p class="empty">Loading candidates...</p></div>
      </section>
    </div>
  </div>
  <p class="foot">Local-first knowledge graph dashboard.</p>
</main>

<script>
async function askBrain() {
  const input = document.getElementById('query-input')
  const output = document.getElementById('chat-output')
  const q = input.value.trim()
  if (!q) return
  output.textContent = 'Thinking...'
  try {
    const r = await fetch('/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: ${repoJson}, prompt: q, stream: false }) })
    const d = await r.json()
    output.textContent = d.answer || d.error || 'No answer'
  } catch (e) { output.textContent = 'Error: ' + e.message }
}
async function loadGraph() {
  const metrics = document.getElementById('graph-metrics')
  const deadList = document.getElementById('dead-code-list')
  try {
    const r = await fetch('/graph?repo=' + encodeURIComponent(${repoJson}))
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Graph request failed')
    metrics.textContent = data.metrics.nodeCount + ' nodes · ' + data.metrics.edgeCount + ' edges · ' + data.metrics.deadCodeCount + ' dead-code candidates'
    renderGraph(data)
    renderDeadCode(data.deadCode || [])
  } catch (e) {
    metrics.textContent = 'Graph unavailable'
    deadList.innerHTML = ''
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = e.message
    deadList.appendChild(p)
  }
}
let graphState = null
let selectedGraphNodeId = null

function renderDeadCode(items) {
  const list = document.getElementById('dead-code-list')
  list.innerHTML = ''
  if (!items.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = 'No candidates found in visible graph.'
    list.appendChild(p)
    return
  }
  for (const item of items.slice(0, 10)) {
    const box = document.createElement('div')
    box.className = 'empty dead-item'
    const title = document.createElement('strong')
    title.textContent = item.name + ' · ' + item.kind
    const loc = document.createElement('code')
    loc.textContent = item.file + ':' + item.lineStart
    const meta = document.createElement('small')
    meta.textContent = item.reason
    box.append(title, loc, meta)
    box.style.cursor = 'pointer'
    box.addEventListener('click', () => selectGraphNode(item.fqn))
    list.appendChild(box)
  }
}
function renderGraph(data) {
  graphState = data
  const svg = document.getElementById('graph-map')
  const bounds = svg.getBoundingClientRect()
  const width = Math.max(320, Math.floor(bounds.width))
  const height = Math.max(280, Math.floor(bounds.height))
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
  svg.innerHTML = ''

  const nodes = layoutClusterGraph(data.nodes || [], width, height)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const degree = new Map()
  for (const edge of data.edges || []) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  }

  const edgeGroup = svgEl('g')
  const nodeGroup = svgEl('g')
  svg.append(edgeGroup, nodeGroup)

  for (const edge of data.edges || []) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) continue
    const line = svgEl('line')
    line.classList.add('graph-edge')
    line.dataset.source = edge.source
    line.dataset.target = edge.target
    line.setAttribute('x1', source.x)
    line.setAttribute('y1', source.y)
    line.setAttribute('x2', target.x)
    line.setAttribute('y2', target.y)
    line.setAttribute('stroke', edge.type === 'calls' ? '#111827' : '#596171')
    line.setAttribute('stroke-width', edge.type === 'calls' ? '1.6' : '1')
    line.setAttribute('opacity', edge.type === 'calls' ? '.26' : '.12')
    edgeGroup.appendChild(line)
  }

  let renderedLabels = 0
  for (const node of nodes) {
    const group = svgEl('g')
    group.classList.add('graph-node')
    group.dataset.id = node.id
    group.addEventListener('click', () => selectGraphNode(node.id))
    const circle = svgEl('circle')
    const r = node.type === 'file' ? 13 : Math.min(8, 4.5 + (degree.get(node.id) || 0) * 0.5)
    circle.setAttribute('cx', node.x)
    circle.setAttribute('cy', node.y)
    circle.setAttribute('r', String(r))
    circle.setAttribute('fill', node.type === 'file' ? '#ff4167' : colorForKind(node.kind))
    circle.setAttribute('stroke', '#111827')
    circle.setAttribute('stroke-width', node.type === 'file' ? '3' : '2')
    const title = svgEl('title')
    title.textContent = (node.file || node.label) + (node.kind ? ' · ' + node.kind : '')
    group.append(circle, title)

    if (node.type === 'file' && renderedLabels < 14) {
      const text = svgEl('text')
      text.setAttribute('x', String(node.x + r + 5))
      text.setAttribute('y', String(node.y + 4))
      text.setAttribute('font-size', '11')
      text.setAttribute('font-weight', '800')
      text.setAttribute('fill', '#111827')
      text.textContent = node.label.slice(0, 18)
      group.appendChild(text)
      renderedLabels++
    }
    nodeGroup.appendChild(group)
  }

  if (nodes.length > 0 && !selectedGraphNodeId) selectGraphNode(nodes[0].id, false)
  else if (selectedGraphNodeId) highlightGraphSelection()
}

function layoutClusterGraph(nodes, width, height) {
  const files = nodes.filter(n => n.type === 'file')
  const symbols = nodes.filter(n => n.type === 'symbol')
  const symbolsByFile = new Map()
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.file) || []
    list.push(symbol)
    symbolsByFile.set(symbol.file, list)
  }

  const cols = Math.max(2, Math.ceil(Math.sqrt(files.length * 1.45)))
  const rows = Math.max(1, Math.ceil(files.length / cols))
  const padX = 52
  const padY = 46
  const cellW = (width - padX * 2) / cols
  const cellH = (height - padY * 2) / rows
  const laidOut = []
  const filePositions = new Map()

  files.forEach((file, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const x = padX + col * cellW + cellW / 2
    const y = padY + row * cellH + cellH / 2
    const placed = { ...file, x, y }
    laidOut.push(placed)
    filePositions.set(file.file, placed)
  })

  for (const [file, list] of symbolsByFile.entries()) {
    const parent = filePositions.get(file)
    if (!parent) continue
    const radius = Math.min(cellW, cellH) * 0.33
    list.forEach((symbol, index) => {
      const ring = Math.floor(index / 10)
      const slot = index % 10
      const count = Math.min(10, list.length - ring * 10)
      const angle = -Math.PI / 2 + (slot / Math.max(1, count)) * Math.PI * 2
      const r = radius + ring * 13
      laidOut.push({
        ...symbol,
        x: clamp(parent.x + Math.cos(angle) * r, 20, width - 24),
        y: clamp(parent.y + Math.sin(angle) * r, 24, height - 24),
      })
    })
  }

  return laidOut
}
async function selectGraphNode(id, fetchExplain = true) {
  selectedGraphNodeId = id
  highlightGraphSelection()
  const node = graphState?.nodes?.find(n => n.id === id)
  if (!node) return
  const edges = graphState?.edges?.filter(e => e.source === id || e.target === id) || []
  updateInspector(node, edges, 'Loading Groq summary...')

  if (!fetchExplain) {
    updateInspector(node, edges, node.type === 'file'
      ? 'File node. Click connected symbols to inspect parser output and graph edges.'
      : 'Symbol node. Calls and Contains edges show how this code connects.')
    return
  }

  try {
    const r = await fetch('/graph/explain?repo=' + encodeURIComponent(${repoJson}) + '&id=' + encodeURIComponent(id))
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Explain failed')
    if (selectedGraphNodeId === id) updateInspector(node, edges, data.summary, data.connected, data.deadCode)
  } catch (e) {
    if (selectedGraphNodeId === id) updateInspector(node, edges, e.message)
  }
}
function highlightGraphSelection() {
  const id = selectedGraphNodeId
  const incident = new Set()
  for (const edge of graphState?.edges || []) {
    if (edge.source === id || edge.target === id) {
      incident.add(edge.source)
      incident.add(edge.target)
    }
  }
  document.querySelectorAll('.graph-node').forEach(el => {
    const isSelected = el.dataset.id === id
    const isIncident = incident.has(el.dataset.id)
    el.classList.toggle('selected', isSelected)
    el.classList.toggle('dim', !!id && !isSelected && !isIncident)
  })
  document.querySelectorAll('.graph-edge').forEach(el => {
    const isSelected = el.dataset.source === id || el.dataset.target === id
    el.classList.toggle('selected', isSelected)
    el.classList.toggle('dim', !!id && !isSelected)
  })
}
function updateInspector(node, edges, summary, connected = null, deadCode = null) {
  const inspector = document.getElementById('graph-inspector')
  inspector.innerHTML = ''
  const head = document.createElement('div')
  const title = document.createElement('h3')
  title.textContent = node.label
  const loc = document.createElement('code')
  loc.textContent = node.type === 'file' ? node.file : node.file + (node.lineStart ? ':' + node.lineStart : '')
  head.append(title, loc)

  const pills = document.createElement('div')
  pills.className = 'pill-row'
  for (const label of [node.type, node.kind, node.exported ? 'exported' : null, edges.length + ' edges'].filter(Boolean)) {
    const pill = document.createElement('span')
    pill.className = 'pill' + (deadCode ? ' hot' : '')
    pill.textContent = label
    pills.appendChild(pill)
  }

  const body = document.createElement('p')
  body.textContent = summary

  const neighbors = document.createElement('div')
  neighbors.className = 'neighbor-list'
  for (const line of (connected || edges.slice(0, 8).map(e => {
    const otherId = e.source === node.id ? e.target : e.source
    const other = graphState.nodes.find(n => n.id === otherId)
    return e.type + ': ' + (other?.label || otherId)
  }))) {
    const item = document.createElement('div')
    item.textContent = line
    neighbors.appendChild(item)
  }

  inspector.append(head, pills, body, neighbors)
}
function svgEl(name) {
  return document.createElementNS('http://www.w3.org/2000/svg', name)
}
function colorForKind(kind) {
  if (kind === 'class' || kind === 'interface') return '#64e9a3'
  if (kind === 'function') return '#ffc174'
  return '#e9f1ff'
}
function hash(value) {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  return Math.abs(h)
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
loadGraph()
setInterval(loadGraph, 30000)
</script>
</body>
</html>`)
  })

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  return app
}
