import type { Router, Request, Response } from 'express'
import { getDb } from '../../memory/db.js'
import { getCurrentHotZones } from '../../temporal/hotzone.js'
import { escapeHtml } from '../helpers.js'
import type { Config } from '../../config/schema.js'
import { getGroqStatus, hasGroqApiKey } from '../../query/groq.js'

export function registerDashboardRoute(router: Router, config: Config): void {
  router.get('/', async (req: Request, res: Response) => {
    try {
      const repo = (req.query.repo as string) ?? config.repos[0]?.name
      if (!repo) {
        res.status(400).send('No repo configured')
        return
      }

      const matchedRepo = config.repos.find(r => r.name === repo)
      const remote = matchedRepo?.remote || ''
      const parts = remote.replace('https://github.com/', '').split('/')
      const owner = parts[0] || 'brain'
      const safeOwner = escapeHtml(owner)

      const db = getDb()
      const symbolCount = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const fileCount = (db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const hotzones = getCurrentHotZones(repo)
      const tier1Count = (db.prepare(`SELECT COUNT(*) as c FROM tier1_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const tier2Count = (db.prepare(`SELECT COUNT(*) as c FROM tier2_episodes WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const tier3Count = (db.prepare(`SELECT COUNT(*) as c FROM tier3_facts WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const tier4Count = (db.prepare(`SELECT COUNT(*) as c FROM tier4_patterns WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const episodes = db.prepare(`SELECT date, summary FROM tier2_episodes WHERE repo = ? ORDER BY date DESC LIMIT 5`).all(repo) as Array<{ date: string; summary: string }>

      const safeRepo = escapeHtml(repo)
      const repoJson = JSON.stringify(repo)
      const groqConfigured = hasGroqApiKey()
      const groqStatus = await getGroqStatus()
      const hotzoneRows = hotzones.map(h => `<tr><td>${escapeHtml(h.symbolFqn)}</td><td>${escapeHtml(h.filePath)}</td><td>${h.zScore.toFixed(2)}</td><td>${h.velocity.toFixed(1)}</td></tr>`).join('\n')
      const episodeRows = episodes.map(e => `<li><strong>${escapeHtml(e.date)}</strong><span>${escapeHtml(e.summary.slice(0, 200))}</span></li>`).join('\n')

      res.setHeader('Content-Type', 'text/html')
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brain Dashboard - ${safeRepo}</title>
<meta name="description" content="Living codebase memory dashboard — knowledge graph, decay heatmap, hot zone detection, and ripple blast radius visualization for ${safeRepo}">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap');
  
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  
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
  
  body {
    min-height: 100dvh;
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    background: var(--paper);
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  
  /* === TOPBAR === */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 100;
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 clamp(18px, 5vw, 72px);
    background: #fffaf0;
    border-bottom: 3px solid var(--line);
  }
  
  .brand {
    font-size: 28px;
    font-weight: 900;
    letter-spacing: -0.5px;
    color: var(--ink);
  }
  .brand span {
    color: var(--pink);
  }
  
  .topbar-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 13px;
    color: var(--ink);
  }
  
  .live-dot {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    background: rgba(52, 211, 153, 0.12);
    border: 2px solid var(--line);
    color: var(--ink);
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .live-dot::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--mint);
    animation: livePulse 2s ease-in-out infinite;
  }
  @keyframes livePulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(100, 233, 163, 0.5); }
    50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(100, 233, 163, 0); }
  }
  
  /* === MAIN LAYOUT === */
  main {
    position: relative;
    z-index: 1;
    width: min(1200px, calc(100% - 32px));
    margin: 0 auto;
    padding: 40px 0 60px;
  }
  
  /* === STATS GRID === */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin-bottom: 28px;
  }
  
  .stat-card {
    border: 3px solid var(--line);
    border-radius: 6px;
    background: #fffaf0;
    padding: 16px;
    box-shadow: 4px 4px 0 var(--shadow);
    transition: all 0.2s ease;
  }
  .stat-card:hover {
    transform: translate(-3px, -3px);
    box-shadow: 7px 7px 0 var(--shadow);
  }
  
  .stat-value {
    font-size: 30px;
    font-weight: 950;
    line-height: 1;
    color: var(--pink);
    font-variant-numeric: tabular-nums;
  }
  .stat-value.emerald {
    color: var(--mint);
  }
  .stat-value.amber {
    color: var(--peach);
  }
  .stat-label {
    margin-top: 8px;
    font-size: 11px;
    font-weight: 850;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
  }
  
  /* === GRAPH SECTION === */
  .graph-section {
    margin-bottom: 28px;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .section-title {
    font-size: 20px;
    font-weight: 950;
    letter-spacing: -0.3px;
  }
  .section-meta {
    font-size: 12px;
    color: var(--muted);
    font-weight: 750;
  }
  
  .graph-container {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 14px;
    align-items: stretch;
  }
  
  #graph-canvas {
    width: 100%;
    height: 560px;
    border-radius: 8px;
    background: #fffaf0;
    border: 3px solid var(--line);
    box-shadow: 4px 4px 0 var(--shadow);
    cursor: default;
    display: block;
    transition: all 0.2s ease;
  }
  #graph-canvas:hover {
    transform: translate(-2px, -2px);
    box-shadow: 6px 6px 0 var(--shadow);
  }
  
  /* === LEGEND === */
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    margin-top: 12px;
    font-size: 12px;
    color: var(--muted);
    font-weight: 800;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend-dot {
    width: 12px;
    height: 12px;
    border: 2px solid var(--line);
    display: inline-block;
  }
  .legend-dot.file { background: var(--pink); }
  .legend-dot.symbol { background: var(--mint); }
  .legend-dot.hot { background: var(--peach); }
  .legend-dot.decayed { background: #ef4444; }
  .legend-line {
    width: 18px;
    height: 3px;
    background: var(--line);
  }
  .legend-line.ripple {
    background: var(--pink);
  }
  
  /* === INSPECTOR === */
  .inspector {
    min-height: 560px;
    border-radius: 8px;
    background: var(--panel);
    border: 4px solid var(--line);
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-shadow: 6px 6px 0 var(--shadow);
    transition: all 0.2s ease;
    overflow: hidden;
  }
  .inspector:hover {
    transform: translate(-2px, -2px);
    box-shadow: 8px 8px 0 var(--shadow);
  }
  
  .inspector-title {
    font-size: 20px;
    font-weight: 900;
    overflow-wrap: anywhere;
    line-height: 1.2;
  }
  .inspector-fqn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--muted);
    overflow-wrap: anywhere;
    margin-top: 4px;
    font-weight: 700;
  }
  
  .pill-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill {
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 850;
    text-transform: uppercase;
    border: 2px solid var(--line);
    background: var(--field);
    color: var(--ink);
  }
  .pill.hot { background: var(--pink); color: #fff; }
  .pill.dead { background: var(--peach); }
  .pill.fresh { background: var(--mint); }
  
  .decay-bar {
    height: 12px;
    border-radius: 6px;
    border: 2px solid var(--line);
    background: #fff;
    overflow: hidden;
    position: relative;
  }
  .decay-bar-fill {
    height: 100%;
    transition: width 0.5s ease;
  }
  .decay-label {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 4px;
    font-weight: 850;
    text-transform: uppercase;
  }
  
  .inspector-summary {
    color: var(--ink);
    font-size: 14px;
    line-height: 1.5;
    flex: 1;
    font-weight: 600;
  }
  
  .neighbor-list {
    display: grid;
    gap: 6px;
    max-height: 200px;
    overflow-y: auto;
  }
  .neighbor-item {
    padding: 6px 0;
    border-top: 1px solid rgba(17, 24, 39, 0.15);
    font-size: 12px;
    color: var(--muted);
    font-weight: 700;
    overflow-wrap: anywhere;
    font-family: 'JetBrains Mono', monospace;
  }
  
  .ripple-btn {
    width: 100%;
    padding: 10px;
    border: 3px solid var(--line);
    border-radius: 4px;
    background: var(--peach);
    color: var(--ink);
    font-size: 12px;
    font-weight: 850;
    cursor: pointer;
    box-shadow: 2px 2px 0 var(--shadow);
    transition: all 0.15s ease;
    font-family: inherit;
  }
  .ripple-btn:hover {
    transform: translate(-1px, -1px);
    box-shadow: 3px 3px 0 var(--shadow);
  }
  .ripple-btn:active {
    transform: translate(1px, 1px);
    box-shadow: 1px 1px 0 var(--shadow);
  }
  .ripple-btn:disabled {
    opacity: 0.4;
    cursor: default;
    transform: none;
    box-shadow: none;
  }
  
  /* === QUERY PANEL === */
  .query-panel {
    border-radius: 8px;
    background: var(--panel);
    border: 4px solid var(--line);
    padding: 22px;
    margin-bottom: 28px;
    box-shadow: 10px 10px 0 var(--shadow);
  }
  .query-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: stretch;
  }
  textarea {
    width: 100%;
    min-height: 74px;
    resize: vertical;
    border: 3px solid var(--line);
    border-radius: 4px;
    background: var(--field);
    color: var(--ink);
    padding: 18px 20px;
    font: 700 16px/1.4 'JetBrains Mono', monospace;
    box-shadow: 4px 4px 0 var(--shadow);
    outline: none;
    transition: all 0.15s ease;
  }
  textarea::placeholder { color: var(--muted); }
  textarea:focus {
    border-color: var(--pink);
    transform: translate(-1px, -1px);
    box-shadow: 5px 5px 0 var(--shadow);
  }
  
  button, .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 48px;
    padding: 0 24px;
    border: 4px solid var(--line);
    border-radius: 6px;
    font-size: 16px;
    font-weight: 850;
    cursor: pointer;
    text-decoration: none;
    color: var(--ink);
    background: var(--peach);
    box-shadow: 4px 4px 0 var(--shadow);
    transition: all 0.15s ease;
    font-family: inherit;
  }
  button:hover, .btn:hover {
    transform: translate(-2px, -2px);
    box-shadow: 6px 6px 0 var(--shadow);
  }
  button:active, .btn:active {
    transform: translate(2px, 2px);
    box-shadow: 2px 2px 0 var(--shadow);
  }
  .btn.secondary {
    background: var(--field);
  }
  
  #chat-output {
    margin-top: 14px;
    padding: 20px;
    border-radius: 6px;
    background: #fffaf0;
    border: 3px solid var(--line);
    color: var(--ink);
    font-size: 14px;
    line-height: 1.5;
    min-height: 60px;
    overflow-x: auto;
    box-shadow: 4px 4px 0 var(--shadow);
  }
  #chat-output pre {
    background: #1a202c;
    color: #f7fafc;
    padding: 14px;
    border-radius: 4px;
    margin: 12px 0;
    overflow-x: auto;
    border: 2px solid var(--line);
  }
  #chat-output code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
  }
  #chat-output p { margin-bottom: 8px; }
  #chat-output ul, #chat-output ol { padding-left: 20px; margin-bottom: 8px; }
  #chat-output li {
    border: none;
    background: transparent;
    padding: 2px 0;
    box-shadow: none;
    list-style: inherit;
  }
  .query-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .query-title { font-size: 18px; font-weight: 900; }
  .query-status { color: var(--muted); font-size: 12px; font-weight: 750; }
  .query-status.ready { color: #176b45; }
  .query-status.missing { color: #a33b4d; }
  .query-help { margin-top: 10px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .query-help code { background: var(--field); border: 1px solid var(--line); padding: 2px 5px; }
  .ask-btn:disabled, textarea:disabled { opacity: 0.58; cursor: not-allowed; transform: none; box-shadow: 2px 2px 0 var(--shadow); }
  
  /* === GRID SECTIONS === */
  .grid-2col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 28px;
  }
  .grid-full { grid-column: 1 / -1; }
  
  .panel {
    border-radius: 8px;
    background: var(--panel);
    border: 4px solid var(--line);
    padding: 22px;
    box-shadow: 6px 6px 0 var(--shadow);
    transition: all 0.2s ease;
  }
  .panel:hover {
    transform: translate(-2px, -2px);
    box-shadow: 8px 8px 0 var(--shadow);
  }
  .panel h2 {
    font-size: 18px;
    font-weight: 900;
    margin-bottom: 12px;
    border-bottom: 2px solid var(--line);
    padding-bottom: 6px;
    color: var(--ink);
  }
  
  .filter-input {
    width: 100%;
    margin-bottom: 12px;
    padding: 8px 12px;
    border: 3px solid var(--line);
    border-radius: 4px;
    background: #fff;
    color: var(--ink);
    font-size: 13px;
    font-weight: 700;
    font-family: inherit;
    outline: none;
  }
  .filter-input:focus { border-color: var(--pink); }
  .filter-input::placeholder { color: var(--muted); }
  
  /* === TABLE === */
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    background: #fffaf0;
    border: 3px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 4px 4px 0 var(--shadow);
  }
  th {
    background: var(--field);
    color: var(--ink);
    text-align: left;
    padding: 10px 12px;
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
    border-bottom: 3px solid var(--line);
  }
  td {
    padding: 10px 12px;
    border-top: 1px solid rgba(17, 24, 39, 0.15);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 700;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  tr:hover td { background: rgba(17, 24, 39, 0.02); }
  
  /* === LISTS === */
  ul { list-style: none; display: grid; gap: 10px; }
  li {
    padding: 12px;
    border-radius: 6px;
    background: #fffaf0;
    border: 3px solid var(--line);
    font-size: 13px;
    color: var(--ink);
    box-shadow: 4px 4px 0 var(--shadow);
    transition: all 0.2s ease;
  }
  li:hover {
    transform: translate(-2px, -2px);
    box-shadow: 6px 6px 0 var(--shadow);
  }
  li strong {
    display: block;
    margin-bottom: 5px;
    font-weight: 900;
    color: var(--pink);
  }
  
  /* === DEAD CODE / IMPACT === */
  .dead-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }
  .dead-item {
    padding: 14px;
    border-radius: 6px;
    background: #fffaf0;
    border: 3px solid var(--line);
    display: grid;
    gap: 6px;
    cursor: pointer;
    box-shadow: 4px 4px 0 var(--shadow);
    transition: all 0.2s ease;
  }
  .dead-item:hover {
    transform: translate(-3px, -3px);
    box-shadow: 7px 7px 0 var(--shadow);
  }
  .dead-item strong { color: var(--ink); font-size: 13px; font-weight: 900; }
  .dead-item code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: anywhere;
    font-weight: 700;
  }
  .dead-item small { color: var(--muted); line-height: 1.4; font-size: 11px; font-weight: 700; }
  
  .empty-state {
    padding: 14px;
    border-radius: 6px;
    background: #fffaf0;
    border: 3px solid var(--line);
    color: var(--muted);
    font-size: 14px;
    box-shadow: 4px 4px 0 var(--shadow);
  }
  
  .foot {
    margin-top: 40px;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
    font-weight: 700;
  }
  
  /* === D3 GRAPH STYLES === */
  .node-circle { cursor: pointer; transition: opacity 0.2s; }
  .node-circle:hover { filter: brightness(1.1); }
  
  .edge-line { pointer-events: none; }
  
  /* === TEMPORAL TIMELINE SIMULATOR === */
  .timeline-control-container {
    margin-top: 18px;
    padding: 16px 20px;
    border-radius: 6px;
    background: var(--panel);
    border: 3px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 4px 4px 0 var(--shadow);
  }
  .timeline-label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .timeline-title {
    font-size: 11px;
    font-weight: 850;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--pink);
  }
  .timeline-days {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--ink);
    font-weight: 800;
  }
  .timeline-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 12px;
    border-radius: 6px;
    background: #fff;
    border: 3px solid var(--line);
    outline: none;
  }
  .timeline-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--peach);
    border: 3px solid var(--line);
    cursor: pointer;
    box-shadow: 2px 2px 0 var(--shadow);
    transition: transform 0.1s;
  }
  .timeline-slider::-webkit-slider-thumb:hover {
    transform: scale(1.15);
  }
  .timeline-slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--peach);
    border: 3px solid var(--line);
    cursor: pointer;
    box-shadow: 2px 2px 0 var(--shadow);
    transition: transform 0.1s;
  }
  .timeline-slider::-moz-range-thumb:hover {
    transform: scale(1.15);
  }
  
  /* === RESPONSIVE === */
  @media (max-width: 900px) {
    .graph-container { grid-template-columns: 1fr; }
    .inspector { min-height: 280px; }
    #graph-canvas { height: 400px; }
    .grid-2col { grid-template-columns: 1fr; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .query-row { grid-template-columns: 1fr; }
    .ask-btn { min-height: 50px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">Br<span>ain</span></div>
  <div class="topbar-meta">
    <a href="/ingest/${safeOwner}/${safeRepo}" class="btn" style="height: 38px; padding: 0 16px; font-size: 13px; border-width: 3px; box-shadow: 2px 2px 0 var(--shadow); background: var(--mint); display: inline-flex; align-items: center; justify-content: center; text-decoration: none; color: var(--ink); font-weight: 850;">Ingest Prompt Dump</a>
    <span class="live-dot">Live</span>
    <span style="font-weight: 700; color: var(--ink);">${safeRepo}</span>
    <span>${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
  </div>
</header>

<main>
  <!-- Stats Row -->
  <div class="stats">
    <div class="stat-card"><div class="stat-value">${fileCount}</div><div class="stat-label">Files Tracked</div></div>
    <div class="stat-card"><div class="stat-value">${symbolCount}</div><div class="stat-label">Symbols</div></div>
    <div class="stat-card"><div class="stat-value amber">${hotzones.length}</div><div class="stat-label">Hot Zones</div></div>
    <div class="stat-card"><div class="stat-value emerald">${tier1Count}</div><div class="stat-label">Tier 1 Events</div></div>
    <div class="stat-card"><div class="stat-value">${tier2Count}</div><div class="stat-label">Tier 2 Episodes</div></div>
    <div class="stat-card"><div class="stat-value">${tier3Count}</div><div class="stat-label">Tier 3 Facts</div></div>
    <div class="stat-card"><div class="stat-value">${tier4Count}</div><div class="stat-label">Tier 4 Patterns</div></div>
    <div class="stat-card"><div class="stat-value emerald">30s</div><div class="stat-label">Refresh Rate</div></div>
  </div>

  <!-- Knowledge Graph (D3 Force-Directed) -->
  <section class="graph-section">
    <div class="section-header">
      <h1 class="section-title">Knowledge Graph</h1>
      <span id="graph-metrics" class="section-meta">Loading graph...</span>
    </div>
    <div class="graph-container">
      <svg id="graph-canvas" role="img" aria-label="Repository knowledge graph — D3 force-directed layout with decay heatmap"></svg>
      <aside class="inspector" id="graph-inspector">
        <div>
          <div class="inspector-title">Select a Node</div>
          <div class="inspector-fqn">Click any file or symbol in the graph to inspect it.</div>
        </div>
        <div class="pill-row">
          <span class="pill">file</span>
          <span class="pill">symbol</span>
          <span class="pill">calls</span>
        </div>
        <p class="inspector-summary">The graph uses a force-directed layout. Nodes are colored by memory decay — green (fresh) → amber (aging) → red (decaying). Pulsing nodes indicate hot zones with high change velocity.</p>
      </aside>
    </div>
    <div class="legend">
      <span class="legend-item"><i class="legend-dot file"></i>File</span>
      <span class="legend-item"><i class="legend-dot symbol"></i>Symbol (fresh)</span>
      <span class="legend-item"><i class="legend-dot hot"></i>Hot Zone</span>
      <span class="legend-item"><i class="legend-dot decayed"></i>Decayed</span>
      <span class="legend-item"><i class="legend-line"></i>Calls / Contains</span>
      <span class="legend-item"><i class="legend-line ripple"></i>Ripple Path</span>
      <span style="margin-left: auto; font-size: 11px;">Drag nodes · Scroll zoom · Double-click reset</span>
    </div>

    <!-- Timeline Scrubber Simulator -->
    <div class="timeline-control-container">
      <div class="timeline-label-row">
        <span class="timeline-title">Temporal Memory Decay Simulator</span>
        <span id="timeline-days-display" class="timeline-days">Current Memory (0 days in future)</span>
      </div>
      <input type="range" id="timeline-slider" min="0" max="90" value="0" step="1" class="timeline-slider" oninput="scrubTimeline(this.value)">
    </div>
  </section>

  <!-- Query Panel -->
  <div class="query-panel">
    <div class="query-header">
      <div class="query-title">Ask your codebase</div>
      <div class="query-status ${groqConfigured ? 'ready' : 'missing'}">${groqConfigured ? `Groq ready · ${escapeHtml(groqStatus.model)}` : 'Local mode · chat disabled'}</div>
    </div>
    <div class="query-row">
      <textarea id="query-input" placeholder="Ask about architecture, risky files, recent changes, decay patterns..." ${groqConfigured ? '' : 'disabled'}></textarea>
      <button class="ask-btn" onclick="askBrain()" ${groqConfigured ? '' : 'disabled'}>Ask Brain</button>
    </div>
    <p class="query-help">${groqConfigured ? `Local guardrails: ${groqStatus.requestsRemainingMinute} requests and ~${groqStatus.tokensRemainingMinute.toLocaleString()} tokens left this minute.` : 'Indexing and graph tools are fully local. To enable chat, add GROQ_API_KEY to .env, then restart brain watch. See .brain/README.md for the setup and free-tier safeguards.'}</p>
    <div id="chat-output">${groqConfigured ? 'Ready. Ask anything about your codebase.' : 'Chat is optional. Your local graph is ready to use.'}</div>
  </div>

  <!-- Two-column grid: Hot Zones + Episodes -->
  <div class="grid-2col">
    <section class="panel">
      <h2>Hot Zones</h2>
      <input type="text" class="filter-input" placeholder="Search hot zones..." oninput="filterTable('hotzones-table', this.value)">
      ${hotzones.length > 0
        ? '<table id="hotzones-table"><thead><tr><th>Symbol</th><th>File</th><th>Z-Score</th><th>Velocity</th></tr></thead><tbody>' + hotzoneRows + '</tbody></table>'
        : '<p class="empty-state">No hot zones detected yet. Symbols with unusually high change velocity will appear here.</p>'}
    </section>

    <section class="panel">
      <h2>Recent Episodes</h2>
      <input type="text" class="filter-input" placeholder="Search episodes..." oninput="filterList('episodes-list', this.value)">
      ${episodes.length > 0 ? '<ul id="episodes-list">' + episodeRows + '</ul>' : '<p class="empty-state">No episodes yet. Run scan or receive webhook events.</p>'}
    </section>

    <section class="panel grid-full">
      <h2>Pending Changes Impact</h2>
      <div id="diff-impact-list" class="dead-list"><p class="empty-state">Loading local diff impact...</p></div>
    </section>

    <section class="panel grid-full">
      <h2>Dead Code Candidates</h2>
      <input type="text" class="filter-input" placeholder="Search dead code candidates..." oninput="filterDeadCode(this.value)">
      <div id="dead-code-list" class="dead-list"><p class="empty-state">Loading candidates...</p></div>
    </section>
  </div>

  <p class="foot">Living Codebase Brain Dashboard</p>
</main>

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
// === GLOBALS ===
if (window.marked) marked.setOptions({ breaks: true, gfm: true });
const REPO = ${repoJson};
const GROQ_CONFIGURED = ${groqConfigured};
let graphData = null;
let selectedNodeId = null;
let simulation = null;
let currentRippleSet = null;

// === DECAY COLOR SCALE (Light Theme Harmonized) ===
function decayColor(score) {
  if (score == null || isNaN(score)) return '#64e9a3'; // default mint
  const s = Math.max(0, Math.min(1, score));
  // green (fresh=1) → amber (0.5) → red (decayed=0)
  if (s > 0.6) {
    const t = (s - 0.6) / 0.4;
    return d3.interpolateRgb('#ffc174', '#64e9a3')(t);
  } else {
    const t = s / 0.6;
    return d3.interpolateRgb('#ff8b8b', '#ffc174')(t);
  }
}

// === ASK BRAIN ===
async function askBrain() {
  const input = document.getElementById('query-input');
  const output = document.getElementById('chat-output');
  const q = input.value.trim();
  if (!q || !GROQ_CONFIGURED) return;
  output.style.opacity = '0.5';
  output.textContent = 'Thinking...';
  try {
    const r = await fetch('/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: REPO, prompt: q, stream: false }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Chat request failed');
    output.style.opacity = '1';
    if (d.answer && window.marked) output.innerHTML = marked.parse(d.answer);
    else output.textContent = d.answer || d.error || 'No answer';
  } catch (e) {
    output.style.opacity = '1';
    output.textContent = 'Error: ' + e.message;
  }
}

// === LOAD GRAPH (enriched endpoint) ===
async function loadGraphData() {
  const metrics = document.getElementById('graph-metrics');
  const deadList = document.getElementById('dead-code-list');
  try {
    const r = await fetch('/api/graph-data?repo=' + encodeURIComponent(REPO) + '&limit=200');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Graph request failed');
    graphData = data;
    metrics.textContent = data.metrics.nodeCount + ' nodes · ' + data.metrics.edgeCount + ' edges · ' + (data.metrics.hotZoneCount || 0) + ' hot zones';
    renderD3Graph(data);
    window.originalDeadCode = data.deadCode || [];
    renderDeadCode(window.originalDeadCode);
  } catch (e) {
    metrics.textContent = 'Graph unavailable: ' + e.message;
    deadList.innerHTML = '<p class="empty-state">' + e.message + '</p>';
  }
}

// === D3 FORCE-DIRECTED GRAPH ===
function renderD3Graph(data) {
  const svg = d3.select('#graph-canvas');
  svg.selectAll('*').remove();

  const svgEl = svg.node();
  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(280, rect.height);
  svg.attr('viewBox', [0, 0, width, height]);

  // Prepare node & edge data with mutable x, y
  const nodes = data.nodes.map(n => ({ ...n }));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges = data.edges.filter(e => nodeById.has(e.source) && nodeById.has(e.target)).map(e => ({ ...e }));

  // Compute degree for node sizing
  const degree = new Map();
  for (const e of edges) {
    degree.set(typeof e.source === 'string' ? e.source : e.source.id, (degree.get(typeof e.source === 'string' ? e.source : e.source.id) || 0) + 1);
    degree.set(typeof e.target === 'string' ? e.target : e.target.id, (degree.get(typeof e.target === 'string' ? e.target : e.target.id) || 0) + 1);
  }

  // Zoom & Pan
  const g = svg.append('g');
  const zoom = d3.zoom()
    .scaleExtent([0.2, 6])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);
  svg.on('dblclick.zoom', () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity));

  // Edge layer
  const edgeLayer = g.append('g').attr('class', 'edges');
  const link = edgeLayer.selectAll('line')
    .data(edges)
    .join('line')
    .attr('class', 'edge-line')
    .attr('stroke', d => d.type === 'calls' ? 'rgba(17, 24, 39, 0.45)' : 'rgba(17, 24, 39, 0.15)')
    .attr('stroke-width', d => d.type === 'calls' ? 1.5 : 0.8);

  // Node layer
  const nodeLayer = g.append('g').attr('class', 'nodes');

  // Pulsing ring for hot zones (rendered behind nodes)
  const hotRingLayer = g.append('g').attr('class', 'hot-rings');
  const hotNodes = nodes.filter(n => n.isHotZone);
  
  const hotRing = hotRingLayer.selectAll('circle')
    .data(hotNodes)
    .join('circle')
    .attr('fill', 'none')
    .attr('stroke', 'var(--pink)')
    .attr('stroke-width', 2);

  // Animate pulsing rings
  function pulseRings() {
    hotRing
      .attr('r', d => nodeRadius(d) + 4)
      .attr('opacity', 0.8)
      .transition()
      .duration(1200)
      .ease(d3.easeSinInOut)
      .attr('r', d => nodeRadius(d) + 14)
      .attr('opacity', 0)
      .on('end', pulseRings);
  }

  function nodeRadius(d) {
    if (d.type === 'file') return 14;
    const deg = degree.get(d.id) || 0;
    return Math.min(10, 5 + deg * 0.6);
  }

  function nodeColor(d) {
    if (d.type === 'file') return 'var(--pink)';
    if (d.isHotZone) return 'var(--peach)';
    return decayColor(d.decayScore);
  }

  const node = nodeLayer.selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node-circle')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded))
    .on('click', (event, d) => {
      event.stopPropagation();
      selectNode(d.id);
    });

  node.append('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => nodeColor(d))
    .attr('stroke', 'var(--line)')
    .attr('stroke-width', d => d.type === 'file' ? 2.5 : 1.5);

  node.append('title')
    .text(d => (d.file || d.label) + (d.kind ? ' · ' + d.kind : '') + (d.decayScore != null ? ' · decay: ' + d.decayScore.toFixed(2) : ''));

  // Labels for file nodes
  node.filter(d => d.type === 'file')
    .append('text')
    .attr('dx', d => nodeRadius(d) + 5)
    .attr('dy', 4)
    .attr('font-size', '10px')
    .attr('font-weight', '700')
    .attr('fill', 'var(--line)')
    .text(d => d.label ? d.label.slice(0, 20) : '');

  // Simulation
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(d => d.type === 'contains' ? 30 : 80).strength(d => d.type === 'contains' ? 0.8 : 0.15))
    .force('charge', d3.forceManyBody().strength(d => d.type === 'file' ? -200 : -60).distanceMax(300))
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 3))
    .force('x', d3.forceX(width / 2).strength(0.02))
    .force('y', d3.forceY(height / 2).strength(0.02))
    .alphaDecay(0.02)
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
      hotRing.attr('cx', d => d.x).attr('cy', d => d.y);
    });

  pulseRings();

  // Drag handlers
  function dragStarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragEnded(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  // Click background to deselect
  svg.on('click', () => {
    selectedNodeId = null;
    currentRippleSet = null;
    resetHighlighting();
    resetInspector();
  });

  // Auto-select first node
  if (nodes.length > 0) selectNode(nodes[0].id, false);
}

// === NODE SELECTION & HIGHLIGHTING ===
function selectNode(id, fetchExplain = true) {
  selectedNodeId = id;
  currentRippleSet = null;
  highlightSelection(id);

  const node = graphData?.nodes?.find(n => n.id === id);
  if (!node) return;
  const edges = graphData?.edges?.filter(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    return src === id || tgt === id;
  }) || [];

  updateInspector(node, edges, fetchExplain ? 'Loading...' : getDefaultSummary(node));

  if (fetchExplain) {
    fetch('/graph/explain?repo=' + encodeURIComponent(REPO) + '&id=' + encodeURIComponent(id))
      .then(r => r.json())
      .then(data => {
        if (selectedNodeId === id) updateInspector(node, edges, data.summary, data.connected, data.deadCode);
      })
      .catch(e => {
        if (selectedNodeId === id) updateInspector(node, edges, e.message);
      });
  }

  // Fetch co-changes
  fetch('/api/co-change?repo=' + encodeURIComponent(REPO) + '&id=' + encodeURIComponent(id) + '&type=' + node.type)
    .then(r => r.json())
    .then(data => {
      if (selectedNodeId === id && data.predictions) {
        renderCoChangesInInspector(data.predictions);
      }
    })
    .catch(() => {});
}

function getDefaultSummary(node) {
  return node.type === 'file'
    ? 'File node. Click connected symbols to inspect graph edges and decay state.'
    : 'Symbol node with ' + (node.decayScore != null ? 'decay score ' + node.decayScore.toFixed(2) : 'unknown decay') + '.';
}

function highlightSelection(id) {
  const incidentNodes = new Set([id]);
  for (const e of graphData?.edges || []) {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    if (src === id || tgt === id) {
      incidentNodes.add(src);
      incidentNodes.add(tgt);
    }
  }

  d3.selectAll('.node-circle').attr('opacity', d => incidentNodes.has(d.id) ? 1 : 0.15);
  d3.selectAll('.edge-line').each(function(d) {
    const src = typeof d.source === 'object' ? d.source.id : d.source;
    const tgt = typeof d.target === 'object' ? d.target.id : d.target;
    const isIncident = src === id || tgt === id;
    d3.select(this)
      .attr('stroke', isIncident ? (currentRippleSet ? 'var(--pink)' : 'var(--line)') : 'rgba(17, 24, 39, 0.05)')
      .attr('stroke-width', isIncident ? 2.5 : 0.5)
      .attr('opacity', isIncident ? 0.95 : 0.05);
  });

  // Highlight selected node
  d3.selectAll('.node-circle').select('circle')
    .attr('stroke', d => d.id === id ? 'var(--pink)' : 'var(--line)')
    .attr('stroke-width', d => d.id === id ? 3 : 1.5);
}

function resetHighlighting() {
  d3.selectAll('.node-circle').attr('opacity', 1);
  d3.selectAll('.node-circle').select('circle')
    .attr('stroke', 'var(--line)')
    .attr('stroke-width', d => d.type === 'file' ? 2.5 : 1.5);
  d3.selectAll('.edge-line')
    .attr('stroke', d => d.type === 'calls' ? 'rgba(17, 24, 39, 0.45)' : 'rgba(17, 24, 39, 0.15)')
    .attr('stroke-width', d => d.type === 'calls' ? 1.5 : 0.8)
    .attr('opacity', 1);
}

function resetInspector() {
  const inspector = document.getElementById('graph-inspector');
  inspector.innerHTML = '<div><div class="inspector-title">Select a Node</div><div class="inspector-fqn">Click any file or symbol in the graph to inspect it.</div></div>' +
    '<div class="pill-row"><span class="pill">file</span><span class="pill">symbol</span><span class="pill">calls</span></div>' +
    '<p class="inspector-summary">The graph uses a force-directed layout. Nodes are colored by memory decay — green (fresh) → amber (aging) → red (decaying). Pulsing nodes indicate hot zones.</p>';
}

// === UPDATE INSPECTOR ===
function updateInspector(node, edges, summary, connected, deadCode) {
  const inspector = document.getElementById('graph-inspector');
  inspector.innerHTML = '';

  // Header
  const head = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'inspector-title';
  title.textContent = node.label;
  const fqn = document.createElement('div');
  fqn.className = 'inspector-fqn';
  fqn.textContent = node.type === 'file' ? node.file : (node.file + (node.lineStart ? ':' + node.lineStart : ''));
  head.append(title, fqn);
  inspector.appendChild(head);

  // Pills
  const pillRow = document.createElement('div');
  pillRow.className = 'pill-row';
  const labels = [node.type, node.kind, node.exported ? 'exported' : null, edges.length + ' edges'];
  if (node.isHotZone) labels.push('hot zone');
  for (const label of labels.filter(Boolean)) {
    const pill = document.createElement('span');
    pill.className = 'pill' + (label.includes('hot') ? ' hot' : '') + (deadCode ? ' dead' : '');
    pill.textContent = label;
    pillRow.appendChild(pill);
  }
  inspector.appendChild(pillRow);

  // Decay bar
  if (node.decayScore != null && node.type === 'symbol') {
    const decayWrap = document.createElement('div');
    const labelRow = document.createElement('div');
    labelRow.className = 'decay-label';
    const freshness = node.decayScore > 0.7 ? 'Fresh' : node.decayScore > 0.4 ? 'Aging' : 'Decaying';
    labelRow.innerHTML = '<span>Memory Decay</span><span>' + freshness + ' (' + (node.decayScore * 100).toFixed(0) + '%)</span>';
    const bar = document.createElement('div');
    bar.className = 'decay-bar';
    const fill = document.createElement('div');
    fill.className = 'decay-bar-fill';
    fill.style.width = (node.decayScore * 100) + '%';
    fill.style.background = 'linear-gradient(90deg, #ff8b8b, #ffc174, #64e9a3)';
    bar.appendChild(fill);
    decayWrap.append(labelRow, bar);
    inspector.appendChild(decayWrap);
  }

  // Summary
  const body = document.createElement('p');
  body.className = 'inspector-summary';
  body.textContent = summary || '';
  inspector.appendChild(body);

  // Ripple button (only for symbols)
  if (node.type === 'symbol') {
    const btn = document.createElement('button');
    btn.className = 'ripple-btn';
    btn.textContent = 'Compute Blast Radius';
    btn.onclick = () => computeRipple(node.id, btn);
    inspector.appendChild(btn);
  }

  // Neighbors
  const neighbors = document.createElement('div');
  neighbors.className = 'neighbor-list';
  const items = connected || edges.slice(0, 8).map(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    const otherId = src === node.id ? tgt : src;
    const other = graphData?.nodes?.find(n => n.id === otherId);
    return e.type + ': ' + (other?.label || otherId);
  });
  for (const line of items) {
    const item = document.createElement('div');
    item.className = 'neighbor-item';
    item.textContent = line;
    neighbors.appendChild(item);
  }
  inspector.appendChild(neighbors);

  // Co-changes container
  const coChangesDiv = document.createElement('div');
  coChangesDiv.id = 'inspector-co-changes';
  coChangesDiv.className = 'neighbor-list';
  coChangesDiv.style.marginTop = '10px';
  inspector.appendChild(coChangesDiv);
}

function renderCoChangesInInspector(predictions) {
  const container = document.getElementById('inspector-co-changes');
  if (!container) return;
  container.innerHTML = '';
  if (!predictions || predictions.length === 0) return;

  const header = document.createElement('div');
  header.style.fontWeight = '800';
  header.style.color = 'var(--pink)';
  header.style.fontSize = '11px';
  header.style.textTransform = 'uppercase';
  header.style.letterSpacing = '0.5px';
  header.style.marginBottom = '6px';
  header.textContent = 'Predicted Co-Changes';
  container.appendChild(header);

  for (const pred of predictions) {
    const item = document.createElement('div');
    item.className = 'neighbor-item';
    item.style.color = 'var(--muted)';
    
    const targetLabel = pred.target.split('/').pop().split(':').pop();
    item.innerHTML = '→ <span style="color: var(--ink); font-weight: 700;">' + targetLabel + '</span> ' +
      '<span style="color: var(--muted);">(' + pred.coOccurrences + ' commits, ' + (pred.confidence * 100).toFixed(0) + '% confidence)</span>';
    item.title = pred.target;
    item.style.cursor = 'pointer';
    item.onclick = () => selectNode(pred.target);
    container.appendChild(item);
  }
}

// === RIPPLE BLAST RADIUS ===
async function computeRipple(fqn, btn) {
  btn.disabled = true;
  btn.textContent = 'Computing...';
  try {
    const r = await fetch('/api/ripple?fqn=' + encodeURIComponent(fqn));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ripple failed');

    const impactedFqns = new Set(data.impacts.map(i => i.fqn));
    impactedFqns.add(fqn);
    currentRippleSet = impactedFqns;

    // Highlight impacted nodes
    d3.selectAll('.node-circle').attr('opacity', d => impactedFqns.has(d.id) ? 1 : 0.08);
    d3.selectAll('.node-circle').select('circle')
      .attr('stroke', d => impactedFqns.has(d.id) ? 'var(--pink)' : 'var(--line)')
      .attr('stroke-width', d => impactedFqns.has(d.id) ? 3 : 1.5);

    // Highlight ripple edges
    d3.selectAll('.edge-line').each(function(d) {
      const src = typeof d.source === 'object' ? d.source.id : d.source;
      const tgt = typeof d.target === 'object' ? d.target.id : d.target;
      const isRipple = impactedFqns.has(src) && impactedFqns.has(tgt);
      d3.select(this)
        .attr('stroke', isRipple ? 'var(--pink)' : 'rgba(17, 24, 39, 0.05)')
        .attr('stroke-width', isRipple ? 2.5 : 0.8)
        .attr('opacity', isRipple ? 0.95 : 0.05);
    });

    btn.textContent = data.impacts.length + ' symbols in blast radius';
  } catch (e) {
    btn.textContent = 'Error: ' + e.message;
  }
}

// === DEAD CODE ===
function renderDeadCode(items) {
  const list = document.getElementById('dead-code-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<p class="empty-state">No candidates found.</p>';
    return;
  }
  for (const item of items.slice(0, 12)) {
    const box = document.createElement('div');
    box.className = 'dead-item';
    const title = document.createElement('strong');
    title.textContent = item.name + ' · ' + item.kind;
    const loc = document.createElement('code');
    loc.textContent = item.file + ':' + item.lineStart;
    const meta = document.createElement('small');
    meta.textContent = item.reason;
    box.append(title, loc, meta);
    box.addEventListener('click', () => selectNode(item.fqn));
    list.appendChild(box);
  }
}

// === DIFF IMPACT ===
async function loadDiffImpact() {
  const list = document.getElementById('diff-impact-list');
  if (!list) return;
  try {
    const r = await fetch('/graph/diff-impact?repo=' + encodeURIComponent(REPO));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Diff impact failed');
    list.innerHTML = '';
    if (!data.length) {
      list.innerHTML = '<p class="empty-state">No uncommitted changes detected or no containing symbols affected.</p>';
      return;
    }
    for (const fileImpact of data) {
      for (const sym of fileImpact.symbols) {
        const box = document.createElement('div');
        box.className = 'dead-item';
        box.style.borderLeft = '4px solid var(--pink)';
        const title = document.createElement('strong');
        title.textContent = sym.symbolFqn.split(':').pop() + ' (' + sym.kind + ')';
        const loc = document.createElement('code');
        loc.textContent = fileImpact.filePath + ':' + sym.lineStart + '-' + sym.lineEnd;
        const impactText = document.createElement('small');
        impactText.textContent = sym.ripple.length === 0
          ? 'No downstream impact.'
          : 'Affects ' + sym.ripple.length + ' symbols: ' + sym.ripple.map(r => r.fqn.split(':').pop()).join(', ');
        box.append(title, loc, impactText);
        list.appendChild(box);
      }
    }
  } catch (e) {
    list.innerHTML = '<p class="empty-state">Error: ' + e.message + '</p>';
  }
}

// === FILTERS ===
function filterTable(tableId, query) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = table.getElementsByTagName('tr');
  const q = query.toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    rows[i].style.display = rows[i].textContent.toLowerCase().includes(q) ? '' : 'none';
  }
}

function filterList(listId, query) {
  const list = document.getElementById(listId);
  if (!list) return;
  const items = list.getElementsByTagName('li');
  const q = query.toLowerCase();
  for (let i = 0; i < items.length; i++) {
    items[i].style.display = items[i].textContent.toLowerCase().includes(q) ? '' : 'none';
  }
}

function filterDeadCode(query) {
  if (!window.originalDeadCode) return;
  const q = query.toLowerCase();
  renderDeadCode(window.originalDeadCode.filter(item =>
    item.name.toLowerCase().includes(q) ||
    item.file.toLowerCase().includes(q) ||
    item.kind.toLowerCase().includes(q)
  ));
}

// === TEMPORAL TIMELINE SIMULATOR ===
function scrubTimeline(days) {
  const sliderDays = parseFloat(days);
  const display = document.getElementById('timeline-days-display');
  if (sliderDays === 0) {
    display.textContent = 'Current Memory (0 days in future)';
  } else {
    display.textContent = 'Simulated: +' + sliderDays + ' days in future';
  }

  // Update colors of all symbol/file nodes in D3 based on future decay
  d3.selectAll('.node-circle').select('circle')
    .attr('fill', d => {
      if (d.type === 'file') {
        const fileStability = d.stability || 30.0;
        const baseScore = d.decayScore != null ? d.decayScore : 1.0;
        const futureScore = baseScore * Math.exp(-sliderDays / fileStability);
        return decayColor(futureScore);
      } else {
        const stability = d.stability || 14.0;
        const baseScore = d.decayScore != null ? d.decayScore : 1.0;
        const futureScore = baseScore * Math.exp(-sliderDays / stability);
        if (d.isHotZone) {
          return futureScore < 0.2 ? '#ef4444' : 'var(--peach)';
        }
        return decayColor(futureScore);
      }
    });

  // If a node is selected, update its inspector decay bar as well!
  if (selectedNodeId) {
    const node = graphData?.nodes?.find(n => n.id === selectedNodeId);
    if (node) {
      const stability = node.stability || (node.type === 'file' ? 30.0 : 14.0);
      const baseScore = node.decayScore != null ? node.decayScore : 1.0;
      const futureScore = baseScore * Math.exp(-sliderDays / stability);
      
      const fillEl = document.querySelector('.decay-bar-fill');
      const textEl = document.querySelector('.decay-label span:last-child');
      if (fillEl && textEl) {
        fillEl.style.width = (futureScore * 100) + '%';
        const freshness = futureScore > 0.7 ? 'Fresh' : futureScore > 0.4 ? 'Aging' : 'Decaying';
        textEl.textContent = freshness + ' (' + (futureScore * 100).toFixed(0) + '%)';
      }
    }
  }
}

// === INIT ===
loadGraphData();
setInterval(loadGraphData, 30000);
loadDiffImpact();
setInterval(loadDiffImpact, 15000);
</script>
</body>
</html>`)
    } catch (err) {
      console.error('[brain] dashboard error:', err)
      res.status(500).send('Internal server error')
    }
  })
}
