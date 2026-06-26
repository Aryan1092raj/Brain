import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { processPushEvent } from './pipeline.js'
import { getSkeletonCode } from './tree-sitter.js'
import { buildContext, formatRichContext } from '../query/context-builder.js'
import { streamQuery, query as queryLlm } from '../query/engine.js'
import { getGraphOverview } from '../graph/insights.js'
import { computeLocalDiffImpact } from '../query/diff-impact.js'
import type { Config } from '../config/schema.js'

const exec = promisify(execFile)

const SECRET_PATTERNS = [
  /gsk_[a-zA-Z0-9]{48}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /xox[bapr]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{32}/g,
  /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g,
  /AIzaSy[a-zA-Z0-9_-]{33}/g,
  /sk-[a-zA-Z0-9]{48}/g
]

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.brain', 'dist', 'target', 'build', '.next', '.cache', '__pycache__', 'venv', '.env'
])

export const DEFAULT_IGNORE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'eot', 'ttf', 'mp4', 'mp3', 'wav', 'db', 'sqlite', 'kuzu', 'svg',
  'pem', 'key', 'pfx', 'crt', 'der', 'cer'
])

export const DEFAULT_IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock',
  '.env', '.env.local', '.env.development', '.env.test', '.env.production',
  '.env.development.local', '.env.test.local', '.env.production.local',
  '.npmrc', 'secrets.json', 'secrets.yaml', 'secrets.yml'
])

function redactSecrets(content: string): string {
  let redacted = content
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED SECRET]')
  }
  return redacted
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${regexStr}$`, 'i')
}

function shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0) return false
  return ignorePatterns.some(pat => {
    const trimmed = pat.trim()
    if (!trimmed) return false
    try {
      const regex = globToRegex(trimmed)
      if (trimmed.includes('/')) {
        return regex.test(relativePath) || regex.test(relativePath + '/')
      } else {
        const base = path.basename(relativePath)
        return regex.test(base)
      }
    } catch {
      return false
    }
  })
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function downloadAndExtractRepo(owner: string, repo: string, brainDir: string): Promise<string> {
  const tmpDir = path.join(brainDir, 'tmp')
  await fs.mkdir(tmpDir, { recursive: true })

  const zipPath = path.join(tmpDir, `${owner}-${repo}.zip`)
  const extractDir = path.join(tmpDir, `${owner}-${repo}-extracted`)

  await fs.rm(extractDir, { recursive: true, force: true })
  await fs.rm(zipPath, { force: true })

  let downloadUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`
  let response = await fetch(downloadUrl)
  if (!response.ok) {
    downloadUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`
    response = await fetch(downloadUrl)
  }

  if (!response.ok) {
    throw new Error(`Failed to download repository ${owner}/${repo}: ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  await fs.writeFile(zipPath, Buffer.from(arrayBuffer))

  await fs.mkdir(extractDir, { recursive: true })
  await exec('unzip', ['-q', zipPath, '-d', extractDir])
  await fs.rm(zipPath, { force: true })

  const dirs = await fs.readdir(extractDir)
  const rootDir = dirs.find(d => !d.startsWith('.'))
  if (!rootDir) {
    throw new Error('No root folder found in extracted zip')
  }

  return path.join(extractDir, rootDir)
}

function fileLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const mapping: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python'
  }
  return mapping[ext] ?? ''
}

async function generateRepoDigest(
  rootDir: string,
  opts?: { maxSize?: number; compress?: boolean; ignorePatterns?: string[] }
): Promise<{ tree: string; files: Array<{ path: string; content: string; size: number }> }> {
  const maxSize = opts?.maxSize ?? 60000
  const compress = opts?.compress ?? false
  const ignorePatterns = opts?.ignorePatterns ?? []

  const IGNORE_DIRS = DEFAULT_IGNORE_DIRS
  const IGNORE_EXTS = DEFAULT_IGNORE_EXTS
  const IGNORE_FILES = DEFAULT_IGNORE_FILES

  const fileList: Array<{ path: string; content: string; size: number }> = []

  async function walk(dir: string, currentPrefix: string): Promise<string> {
    let treeStr = ''
    const entries = await fs.readdir(dir, { withFileTypes: true })

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const isLast = i === entries.length - 1
      const marker = isLast ? '└── ' : '├── '
      const childPrefix = isLast ? '    ' : '│   '

      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootDir, fullPath)

      if (shouldIgnorePath(relativePath, ignorePatterns)) {
        continue
      }

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        treeStr += `${currentPrefix}${marker}${entry.name}/\n`
        treeStr += await walk(fullPath, `${currentPrefix}${childPrefix}`)
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
        if (IGNORE_FILES.has(entry.name) || IGNORE_EXTS.has(ext)) continue

        try {
          const stat = await fs.stat(fullPath)
          if (stat.size > maxSize) {
            treeStr += `${currentPrefix}${marker}${entry.name} (skipped: too large)\n`
            continue
          }

          treeStr += `${currentPrefix}${marker}${entry.name}\n`

          let content = await fs.readFile(fullPath, 'utf-8')
          content = redactSecrets(content)

          if (compress) {
            const lang = fileLanguage(entry.name)
            if (lang) {
              content = getSkeletonCode(content, lang)
            }
          }

          fileList.push({ path: relativePath, content, size: stat.size })
        } catch {
          // Skip
        }
      }
    }
    return treeStr
  }

  const tree = await walk(rootDir, '')
  return { tree, files: fileList }
}

interface TreeNode {
  name: string
  type: 'file' | 'directory'
  path?: string
  size?: number
  children?: TreeNode[]
}

async function buildDirectoryTree(rootDir: string, dir = rootDir, ignorePatterns: string[] = []): Promise<TreeNode[]> {
  const IGNORE_DIRS = DEFAULT_IGNORE_DIRS
  const IGNORE_EXTS = DEFAULT_IGNORE_EXTS
  const IGNORE_FILES = DEFAULT_IGNORE_FILES

  const result: TreeNode[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(rootDir, fullPath)

    if (shouldIgnorePath(relativePath, ignorePatterns)) {
      continue
    }

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const children = await buildDirectoryTree(rootDir, fullPath, ignorePatterns)
      if (children.length > 0) {
        result.push({ name: entry.name, type: 'directory', children })
      }
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
      if (IGNORE_FILES.has(entry.name) || IGNORE_EXTS.has(ext)) continue
      try {
        const stat = await fs.stat(fullPath)
        result.push({ name: entry.name, type: 'file', path: relativePath, size: stat.size })
      } catch {
        // Skip
      }
    }
  }
  return result
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

  app.get('/graph/diff-impact', async (req, res) => {
    try {
      const repo = req.query.repo as string
      if (!repo) {
        return res.status(400).json({ error: 'repo query param required' })
      }

      const matchedRepo = config.repos.find(r => r.name === repo)
      if (!matchedRepo) {
        return res.status(404).json({ error: 'repo not configured' })
      }

      const impacts = await computeLocalDiffImpact(matchedRepo.path, repo)
      res.json(impacts)
    } catch (err) {
      console.error('[brain] diff-impact error:', err)
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

  // Support both /ingest/:owner/:repo and /ingest/github.com/:owner/:repo
  const handleIngest = async (req: express.Request, res: express.Response) => {
    try {
      const owner = req.params.owner as string
      const repo = req.params.repo as string
      if (!owner || !repo) {
        return res.status(400).send('Owner and repo parameters are required')
      }

      // Query params
      const format = (req.query.format as string) === 'xml' ? 'xml' : 'text'
      const maxSize = req.query.maxSize ? Number(req.query.maxSize) : 60000
      const compress = req.query.compress === 'true'
      const ignoreParam = req.query.ignore as string | undefined
      const ignorePatterns = ignoreParam ? ignoreParam.split(',').map(s => s.trim()).filter(Boolean) : []

      // Check if it is a local repo
      const matchedRepo = config.repos.find(r => {
        const parts = r.remote.replace('https://github.com/', '').split('/')
        return parts[0]?.toLowerCase() === owner.toLowerCase() && parts[1]?.toLowerCase() === repo.toLowerCase()
      }) || config.repos.find(r => r.name.toLowerCase() === repo.toLowerCase())

      let rootPath = ''
      let isLocal = false
      if (matchedRepo) {
        rootPath = matchedRepo.path
        isLocal = true
      } else {
        const brainDir = path.join(process.cwd(), '.brain')
        rootPath = await downloadAndExtractRepo(owner, repo, brainDir)
      }

      const { tree, files } = await generateRepoDigest(rootPath, { maxSize, compress, ignorePatterns })
      const nestedTree = await buildDirectoryTree(rootPath, rootPath, ignorePatterns)

      // Calculate characteristics
      const fileCount = files.length
      const charCount = files.reduce((acc, f) => acc + f.content.length, 0)
      const estimatedTokens = Math.round(charCount / 4)

      // Escape JSON to prevent breaking script tag (XSS or syntax issues)
      const filesJson = JSON.stringify(files).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
      const treeJson = JSON.stringify(nestedTree).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

      // Clean up remote repo tmp dir
      if (!isLocal) {
        setTimeout(async () => {
          try {
            await fs.rm(path.dirname(rootPath), { recursive: true, force: true })
          } catch (e) {
            console.error('[brain/ingest] temp cleanup failed:', e)
          }
        }, 5000)
      }

      res.setHeader('Content-Type', 'text/html')
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brain Ingest - ${escapeHtml(owner)}/${escapeHtml(repo)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');
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
  body { min-height: 100dvh; font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; background: var(--paper); color: var(--ink); }
  .topbar { height: 72px; border-bottom: 3px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 clamp(18px, 5vw, 72px); background: #fffaf0; }
  .brand { font-size: 28px; font-weight: 900; letter-spacing: -0.5px; }
  .brand span { color: var(--pink); }
  .meta { display: flex; align-items: center; gap: 12px; color: var(--line); font-size: 15px; }
  .badge { display: inline-flex; align-items: center; height: 25px; padding: 0 8px; border: 2px solid var(--line); background: var(--pink); color: #fff; font-weight: 900; font-size: 12px; transform: rotate(-6deg); box-shadow: 2px 2px 0 var(--line); }
  
  main { width: min(1200px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 60px; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 30px; }
  h1 { font-size: clamp(28px, 5vw, 42px); font-weight: 950; letter-spacing: -0.5px; }
  
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 30px; }
  .card { border: 3px solid var(--line); border-radius: 6px; background: #fffaf0; padding: 20px; transition: all 0.2s ease; box-shadow: 4px 4px 0 var(--shadow); }
  .card:hover { transform: translate(-3px, -3px); box-shadow: 8px 8px 0 var(--shadow); }
  .card .value { font-size: 32px; font-weight: 950; color: var(--pink); font-variant-numeric: tabular-nums; }
  .card .label { margin-top: 8px; color: var(--muted); font-size: 13px; font-weight: 850; text-transform: uppercase; }
  
  .layout-grid { display: grid; grid-template-columns: 340px 1fr; gap: 24px; align-items: start; }
  .sidebar-panel { background: var(--panel); border: 4px solid var(--line); border-radius: 8px; box-shadow: 6px 6px 0 var(--shadow); padding: 20px; }
  .sidebar-panel h2 { font-size: 18px; font-weight: 900; margin-bottom: 12px; border-bottom: 2px solid var(--line); padding-bottom: 6px; }
  
  .settings-group { display: grid; gap: 12px; margin-bottom: 20px; }
  .setting-item { display: grid; gap: 6px; }
  .setting-item label { font-size: 12px; font-weight: 850; text-transform: uppercase; color: var(--muted); }
  select, input[type="text"] { width: 100%; height: 38px; border: 3px solid var(--line); border-radius: 4px; background: #fff; padding: 0 10px; font-size: 13px; font-weight: 700; outline: none; }
  .checkbox-item { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 800; user-select: none; }
  .checkbox-item input { width: 18px; height: 18px; cursor: pointer; }
  
  .tree-container { background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 12px; max-height: 450px; overflow-y: auto; }
  .tree-list { list-style: none; margin-left: 0; }
  .tree-node { margin-left: 14px; list-style: none; font-size: 13px; font-weight: 700; line-height: 1.4; }
  .tree-node.directory { margin-bottom: 4px; }
  .tree-node.file { margin-bottom: 2px; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
  .tree-node label { display: inline-flex; align-items: center; cursor: pointer; user-select: none; }
  .tree-node input { margin-right: 6px; cursor: pointer; width: 14px; height: 14px; }
  summary { font-weight: 800; cursor: pointer; list-style: none; display: flex; align-items: center; gap: 4px; outline: none; }
  summary::-webkit-details-marker { display: none; }
  
  .container { background: var(--panel); border: 4px solid var(--line); border-radius: 8px; box-shadow: 10px 10px 0 var(--shadow); padding: clamp(18px, 4vw, 30px); }
  .actions { display: flex; gap: 16px; margin-bottom: 20px; align-items: center; }
  
  button, .btn { display: inline-flex; align-items: center; justify-content: center; height: 50px; padding: 0 24px; border: 4px solid var(--line); border-radius: 6px; font-size: 16px; font-weight: 850; cursor: pointer; text-decoration: none; color: var(--ink); background: var(--peach); box-shadow: 4px 4px 0 var(--shadow); transition: all 0.15s ease; }
  button:hover, .btn:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--shadow); }
  button:active, .btn:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--shadow); }
  .btn.secondary { background: var(--field); }
  
  textarea { width: 100%; height: 600px; border: 4px solid var(--line); border-radius: 6px; background: var(--field); padding: 20px; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; line-height: 1.5; box-shadow: 4px 4px 0 var(--shadow); resize: none; outline: none; }
  
  @media (max-width: 850px) {
    .layout-grid { grid-template-columns: 1fr; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">Br<span>ain</span></div>
  <div class="meta"><span class="badge" style="transform: none; background: var(--mint); color: #000;">INGEST</span></div>
</header>
<main>
  <div class="header">
    <h1>${escapeHtml(owner)}/${escapeHtml(repo)}</h1>
    <a href="/?repo=${encodeURIComponent(repo)}" class="btn secondary">View Dashboard</a>
  </div>

  <div class="stats">
    <div class="card"><div class="value" id="files-count-val">${fileCount}</div><div class="label">Files Included</div></div>
    <div class="card"><div class="value" id="chars-count-val">${charCount.toLocaleString()}</div><div class="label">Total Characters</div></div>
    <div class="card"><div class="value" id="tokens-count-val">${estimatedTokens.toLocaleString()}</div><div class="label">Est. GPT Tokens</div></div>
    <div class="card"><div class="value" style="color: var(--mint);">${isLocal ? 'Local' : 'Remote'}</div><div class="label">Repo Location</div></div>
  </div>

  <div class="layout-grid">
    <aside class="sidebar-panel">
      <h2>Options</h2>
      <div class="settings-group">
        <div class="setting-item">
          <label for="format-select">Format</label>
          <select id="format-select" onchange="toggleFile()">
            <option value="text" ${format === 'text' ? 'selected' : ''}>Plain Text (GitIngest)</option>
            <option value="xml" ${format === 'xml' ? 'selected' : ''}>XML Tags (Claude-friendly)</option>
          </select>
        </div>
        
        <div class="setting-item">
          <label for="size-limit-select">Max File Size</label>
          <select id="size-limit-select" onchange="reloadSettings()">
            <option value="20000" ${maxSize === 20000 ? 'selected' : ''}>20 KB</option>
            <option value="60000" ${maxSize === 60000 ? 'selected' : ''}>60 KB (Default)</option>
            <option value="150000" ${maxSize === 150000 ? 'selected' : ''}>150 KB</option>
            <option value="500000" ${maxSize === 500000 ? 'selected' : ''}>500 KB</option>
          </select>
        </div>
        
        <div style="margin-top: 8px;">
          <label class="checkbox-item">
            <input type="checkbox" id="compress-toggle" ${compress ? 'checked' : ''} onchange="reloadSettings()">
            <span>Skeleton Mode (Compress)</span>
          </label>
        </div>
        
        <div class="setting-item" style="margin-top: 8px;">
          <label for="ignore-input">Exclude Patterns</label>
          <input type="text" id="ignore-input" value="${escapeHtml(ignoreParam ?? '')}" placeholder="e.g. *.log,src/config/*" onchange="reloadSettings()">
        </div>
      </div>
      
      <h2>File Tree</h2>
      <div class="tree-container" id="tree-root"></div>
    </aside>

    <div class="container">
      <div class="actions">
        <button onclick="copyDigest()">Copy LLM Prompt Digest</button>
        <span style="font-size: 13px; font-weight: 800; color: var(--muted); margin-left: auto;">
          Selected: <span id="selected-files-val" style="color: var(--pink);">${fileCount}</span> files · 
          <span id="selected-tokens-val" style="color: var(--mint);">${estimatedTokens.toLocaleString()}</span> tokens
        </span>
      </div>
      <textarea id="digest-text" readonly></textarea>
    </div>
  </div>
</main>

<script>
// Load injected repository data
const allFiles = ${filesJson};
const treeData = ${treeJson};
const treeStr = ${JSON.stringify(tree)};
const owner = ${JSON.stringify(owner)};
const repo = ${JSON.stringify(repo)};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function renderTree(container, nodes) {
  function buildHtml(items) {
    let html = '<ul class="tree-list">';
    for (const item of items) {
      if (item.type === 'directory') {
        html += '<li class="tree-node directory">';
        html += '<details open>';
        html += '<summary>';
        html += '<input type="checkbox" checked class="dir-checkbox" onchange="toggleDir(this)">';
        html += '📂 ' + item.name;
        html += '</summary>';
        html += buildHtml(item.children);
        html += '</details>';
        html += '</li>';
      } else {
        html += '<li class="tree-node file">';
        html += '<label>';
        html += '<input type="checkbox" checked data-path="' + item.path + '" onchange="toggleFile()">';
        html += '📄 ' + item.name;
        html += '<span style="color: var(--muted); font-size: 10px; font-weight: 700; margin-left: 4px;">(' + formatSize(item.size) + ')</span>';
        html += '</label>';
        html += '</li>';
      }
    }
    html += '</ul>';
    return html;
  }
  container.innerHTML = buildHtml(nodes);
}

function toggleDir(dirCheckbox) {
  const parentLi = dirCheckbox.closest('li.directory');
  const childCheckboxes = parentLi.querySelectorAll('input[type="checkbox"]');
  for (const cb of childCheckboxes) {
    cb.checked = dirCheckbox.checked;
  }
  toggleFile();
}

function toggleFile() {
  const checkedPaths = new Set();
  const cbs = document.querySelectorAll('input[data-path]');
  let selectedFiles = 0;
  let selectedChars = 0;
  
  for (const cb of cbs) {
    if (cb.checked) {
      checkedPaths.add(cb.dataset.path);
      selectedFiles++;
    }
  }

  const format = document.getElementById('format-select').value;
  let text = '';

  if (format === 'xml') {
    text += '<repository path="' + owner + '/' + repo + '">\\n';
    text += '<directory_structure>\\n' + treeStr + '</directory_structure>\\n\\n';
    text += '<file_contents>\\n';
    for (const file of allFiles) {
      if (checkedPaths.has(file.path)) {
        text += '<file path="' + file.path + '">\\n' + file.content + '\\n</file>\\n\\n';
        selectedChars += file.content.length;
      }
    }
    text += '</file_contents>\\n';
    text += '</repository>\\n';
  } else {
    text += '================================================================\\n';
    text += 'Directory Structure\\n';
    text += '================================================================\\n';
    text += treeStr + '\\n';
    text += '================================================================\\n';
    text += 'File Contents\\n';
    text += '================================================================\\n';
    for (const file of allFiles) {
      if (checkedPaths.has(file.path)) {
        text += '=========================================\\n';
        text += 'File: ' + file.path + '\\n';
        text += '=========================================\\n';
        text += file.content + '\\n\\n';
        selectedChars += file.content.length;
      }
    }
  }

  document.getElementById('digest-text').value = text;
  
  // Update stats counters
  const tokens = Math.round(selectedChars / 4);
  document.getElementById('selected-files-val').textContent = selectedFiles;
  document.getElementById('selected-tokens-val').textContent = tokens.toLocaleString();
  
  document.getElementById('files-count-val').textContent = selectedFiles;
  document.getElementById('chars-count-val').textContent = selectedChars.toLocaleString();
  document.getElementById('tokens-count-val').textContent = tokens.toLocaleString();
}

function reloadSettings() {
  const compress = document.getElementById('compress-toggle').checked;
  const maxSize = document.getElementById('size-limit-select').value;
  const format = document.getElementById('format-select').value;
  const ignore = document.getElementById('ignore-input').value;

  const url = new URL(window.location.href);
  url.searchParams.set('compress', compress ? 'true' : 'false');
  url.searchParams.set('maxSize', maxSize);
  url.searchParams.set('format', format);
  url.searchParams.set('ignore', ignore);
  window.location.href = url.toString();
}

function copyDigest() {
  const ta = document.getElementById('digest-text');
  navigator.clipboard.writeText(ta.value);
  const btn = document.querySelector('button');
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  btn.style.background = 'var(--mint)';
  setTimeout(() => {
    btn.textContent = original;
    btn.style.background = '';
  }, 2000);
}

// Initialise tree and content
renderTree(document.getElementById('tree-root'), treeData);
toggleFile();
</script>
</body>
</html>`)
    } catch (err: any) {
      console.error('[brain/ingest] error:', err)
      res.setHeader('Content-Type', 'text/html')
      res.status(500).send(`<!DOCTYPE html>
<html lang="en">
<head><title>Ingest Error</title><style>body { background: #fffdf8; color: #111827; font-family: sans-serif; padding: 40px; } .card { border: 4px solid #111827; background: #fff3d6; padding: 30px; border-radius: 8px; box-shadow: 8px 8px 0 #152033; max-width: 600px; margin: 0 auto; }</style></head>
<body>
  <div class="card">
    <h1 style="color: #ff4167;">Ingestion Failed</h1>
    <p style="margin-top: 15px; line-height: 1.6;">Could not download or process repository. Make sure the repository exists, is public, and is not empty.</p>
    <code style="display: block; margin-top: 15px; padding: 10px; background: #e9f1ff; border: 2px solid #111827; border-radius: 4px; overflow-wrap: anywhere;">${escapeHtml(err.message)}</code>
    <a href="/" style="display: inline-block; margin-top: 20px; font-weight: bold; color: #111827; text-decoration: underline;">Back to Dashboard</a>
  </div>
</body>
</html>`)
    }
  }

  app.get('/ingest/:owner/:repo', handleIngest)
  app.get('/ingest/github.com/:owner/:repo', handleIngest)

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
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');
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
  body { min-height: 100dvh; font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; background: var(--paper); color: var(--ink); }
  .topbar { height: 72px; border-bottom: 3px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 clamp(18px, 5vw, 72px); background: #fffaf0; }
  .brand { font-size: 28px; font-weight: 900; letter-spacing: -0.5px; }
  .brand span { color: var(--pink); }
  .meta { display: flex; align-items: center; gap: 12px; color: var(--line); font-size: 15px; }
  .badge { display: inline-flex; align-items: center; height: 25px; padding: 0 8px; border: 2px solid var(--line); background: var(--pink); color: #fff; font-weight: 900; font-size: 12px; transform: rotate(-6deg); box-shadow: 2px 2px 0 var(--line); animation: pulse 2.5s infinite ease-in-out; }
  
  @keyframes pulse {
    0% { transform: scale(1) rotate(-6deg); }
    50% { transform: scale(1.05) rotate(-6deg); }
    100% { transform: scale(1) rotate(-6deg); }
  }

  main { width: min(1200px, calc(100% - 32px)); margin: 0 auto; padding: clamp(34px, 7vw, 60px) 0 46px; }
  .hero { text-align: center; position: relative; margin-bottom: 40px; }
  h1 { max-width: 800px; margin: 0 auto; font-size: clamp(44px, 7vw, 76px); line-height: .98; font-weight: 950; text-wrap: balance; letter-spacing: -1px; }
  .subtitle { margin: 20px auto 0; max-width: 660px; color: #3d4656; font-size: clamp(16px, 2vw, 20px); line-height: 1.45; text-wrap: pretty; }
  .spark { position: absolute; display: grid; place-items: center; color: var(--line); font-size: clamp(42px, 6vw, 74px); font-weight: 900; line-height: 1; }
  .spark::before { content: ""; width: .62em; height: .62em; border: 4px solid var(--line); background: var(--pink); transform: rotate(45deg); box-shadow: 0 0 0 8px var(--paper); }
  .spark.mint::before { background: var(--mint); }
  .spark.left { left: 5%; top: 10%; }
  .spark.right { right: 4%; top: 40%; }
  
  .dashboard { margin: 20px auto 0; background: var(--panel); border: 4px solid var(--line); border-radius: 8px; box-shadow: 10px 10px 0 var(--shadow); padding: clamp(18px, 4vw, 30px); text-align: left; }
  .query-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: stretch; margin-bottom: 20px; }
  textarea { width: 100%; min-height: 74px; resize: vertical; border: 4px solid var(--line); border-radius: 5px; background: var(--field); color: var(--line); padding: 18px 20px; font: 700 18px/1.4 'JetBrains Mono', monospace; box-shadow: 5px 5px 0 var(--shadow); transition: all 0.15s ease; }
  textarea::placeholder { color: #6c7890; }
  textarea:focus { outline: none; border-color: var(--pink); transform: translate(-2px, -2px); box-shadow: 7px 7px 0 var(--shadow); }
  
  button { min-width: 132px; border: 4px solid var(--line); border-radius: 5px; background: var(--peach); color: var(--ink); font-size: 20px; font-weight: 850; cursor: pointer; box-shadow: 5px 5px 0 var(--shadow); transition: all 0.15s ease; }
  button:hover { transform: translate(-2px, -2px); box-shadow: 7px 7px 0 var(--shadow); background: #ffb154; }
  button:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--shadow); }
  
  #chat-output { background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 20px; color: var(--line); font-size: 15px; min-height: 94px; line-height: 1.5; box-shadow: 4px 4px 0 var(--shadow); overflow-x: auto; }
  #chat-output pre { background: #1a202c; color: #f7fafc; padding: 14px; border-radius: 4px; margin: 12px 0; overflow-x: auto; border: 2px solid var(--line); }
  #chat-output code { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; }
  #chat-output p { margin-bottom: 8px; }
  #chat-output ul, #chat-output ol { padding-left: 20px; margin-bottom: 8px; }
  #chat-output li { border: none; background: transparent; padding: 2px 0; box-shadow: none; list-style: inherit; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin: 26px 0; }
  .card { min-height: 92px; border: 3px solid var(--line); border-radius: 6px; background: #fffaf0; padding: 14px; box-shadow: 4px 4px 0 var(--shadow); transition: all 0.2s ease; }
  .card:hover { transform: translate(-3px, -3px); box-shadow: 7px 7px 0 var(--shadow); }
  .card .value { font-size: 30px; line-height: 1; font-weight: 950; color: var(--pink); font-variant-numeric: tabular-nums; }
  .card .label { margin-top: 8px; color: var(--muted); font-size: 12px; font-weight: 850; text-transform: uppercase; }
  
  .grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: 20px; margin-top: 28px; align-items: start; }
  .graph-panel { margin-top: 28px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  .microcopy { color: var(--muted); font-size: 13px; font-weight: 750; }
  
  .graph-shell { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: stretch; }
  #graph-map { width: 100%; height: 520px; display: block; background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; box-shadow: 4px 4px 0 var(--shadow); cursor: default; }
  
  .graph-node { cursor: pointer; transition: opacity 0.2s ease; }
  .graph-node circle { transition: stroke-width 0.15s ease, r 0.15s ease; }
  .graph-node:hover circle { stroke-width: 5; }
  .graph-node.selected circle { fill: var(--mint); stroke-width: 5; }
  .graph-node.dim { opacity: .25; }
  .graph-edge { transition: opacity 0.2s ease, stroke-width 0.2s ease; }
  .graph-edge.dim { opacity: .08; }
  .graph-edge.selected { stroke: var(--pink); opacity: .92; stroke-width: 3.5; }
  
  .inspector { min-height: 520px; background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 20px; display: grid; grid-template-rows: auto auto 1fr; gap: 14px; box-shadow: 4px 4px 0 var(--shadow); transition: all 0.2s ease; }
  .inspector:hover { transform: translate(-3px, -3px); box-shadow: 7px 7px 0 var(--shadow); }
  .inspector h3 { font-size: 20px; line-height: 1.1; overflow-wrap: anywhere; font-weight: 900; }
  .inspector code { display: block; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; font-family: 'JetBrains Mono', monospace; font-weight: 700; margin-top: 4px; }
  .inspector p { color: #273244; line-height: 1.5; font-size: 14px; text-wrap: pretty; }
  
  .pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { border: 2px solid var(--line); border-radius: 999px; padding: 4px 10px; background: var(--field); font-size: 11px; font-weight: 850; text-transform: uppercase; }
  .pill.hot { background: var(--pink); color: #fff; }
  
  .neighbor-list { display: grid; gap: 8px; align-content: start; max-height: 250px; overflow-y: auto; }
  .neighbor-list div { border-top: 1px solid rgba(17,24,39,.18); padding-top: 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; font-weight: 700; }
  
  .legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 10px; color: var(--muted); font-size: 12px; font-weight: 800; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 12px; height: 12px; border: 2px solid var(--line); display: inline-block; }
  .dot.file { background: var(--pink); }
  .dot.symbol { background: var(--mint); }
  .dot.call { width: 18px; height: 3px; background: var(--line); border: 0; }
  
  .dead-section { grid-column: 1 / -1; }
  .dead-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .dead-item { display: grid; gap: 6px; box-shadow: 4px 4px 0 var(--shadow); transition: all 0.2s ease; }
  .dead-item:hover { transform: translate(-3px, -3px); box-shadow: 7px 7px 0 var(--shadow); background: #fffaec; }
  .dead-item code { color: var(--line); font-size: 12px; overflow-wrap: anywhere; font-family: 'JetBrains Mono', monospace; font-weight: 700; }
  .dead-item small { color: var(--muted); line-height: 1.4; font-size: 11px; font-weight: 700; }
  
  section { min-width: 0; }
  h2 { margin: 0 0 12px; color: var(--line); font-size: 20px; font-weight: 950; letter-spacing: -0.5px; }
  
  table { width: 100%; border-collapse: collapse; background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; overflow: hidden; table-layout: fixed; box-shadow: 4px 4px 0 var(--shadow); }
  th { background: var(--field); color: var(--line); text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; border-bottom: 3px solid var(--line); font-weight: 900; }
  td { padding: 10px 12px; border-top: 1px solid rgba(17,24,39,.18); font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: rgba(17,24,39,0.02); }
  
  ul { list-style: none; display: grid; gap: 10px; }
  li { background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 12px; font-size: 13px; box-shadow: 4px 4px 0 var(--shadow); transition: all 0.2s ease; }
  li:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--shadow); }
  li strong { color: var(--pink); display: block; margin-bottom: 5px; font-weight: 900; }
  
  .empty { background: #fffaf0; border: 3px solid var(--line); border-radius: 6px; padding: 14px; color: var(--muted); font-size: 14px; box-shadow: 4px 4px 0 var(--shadow); }
  .foot { margin-top: 40px; color: var(--muted); text-align: center; font-size: 14px; font-weight: 700; }
  
  /* Quick Filters styling */
  .filter-input { width: 100%; margin-bottom: 12px; padding: 8px 12px; border: 3px solid var(--line); border-radius: 5px; background: #fff; font-weight: 700; font-size: 13px; box-shadow: 3px 3px 0 var(--shadow); outline: none; }
  .filter-input:focus { border-color: var(--pink); }

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
  <div class="meta">
    <span class="badge">LIVE</span>
    <span>${safeRepo}</span>
    <span style="font-weight: 700;">${new Date().toLocaleDateString()}</span>
  </div>
</header>
<main>
  <div class="hero">
    <span class="spark left"></span>
    <span class="spark right mint"></span>
    <h1>Prompt-friendly code memory</h1>
    <p class="subtitle">Track repository stability, anomalous hot zones, memory decay, and generate instant prompt digests.</p>
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
      <div class="card"><div class="value" style="color: var(--mint);">30s</div><div class="label">Refresh</div></div>
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
        <span style="margin-left: auto;" class="microcopy">💡 Double-click background to reset zoom/pan · Drag to pan · Scroll to zoom</span>
      </div>
    </section>

    <div class="grid">
      <section>
        <h2>Hot Zones</h2>
        <input type="text" class="filter-input" placeholder="Search hot zones..." oninput="filterTable('hotzones-table', this.value)">
        ${hotzones.length > 0
          ? `<table id="hotzones-table"><thead><tr><th>Symbol</th><th>File</th><th>Z-Score</th><th>Velocity</th></tr></thead><tbody>${hotzoneRows}</tbody></table>`
          : '<p class="empty">No hot zones detected yet.</p>'}
      </section>

      <section>
        <h2>Recent Episodes</h2>
        <input type="text" class="filter-input" placeholder="Search episodes..." oninput="filterList('episodes-list', this.value)">
        ${episodes.length > 0 ? `<ul id="episodes-list">${episodeRows}</ul>` : '<p class="empty">No episodes yet. Run scan or receive webhook events.</p>'}
      </section>

      <section class="dead-section">
        <h2>Pending Changes Impact</h2>
        <div id="diff-impact-list" class="dead-list"><p class="empty">Loading local diff impact...</p></div>
      </section>

      <section class="dead-section">
        <h2>Dead Code Candidates</h2>
        <input type="text" class="filter-input" placeholder="Search dead code candidates..." oninput="filterDeadCode(this.value)">
        <div id="dead-code-list" class="dead-list"><p class="empty">Loading candidates...</p></div>
      </section>
    </div>
  </div>
  <p class="foot">Living Codebase Brain Dashboard · <a href="/ingest/brain/brain" style="color: var(--pink); font-weight: 800; text-decoration: underline;">Ingest Prompt Dump</a></p>
</main>

<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
// Configure marked options
marked.setOptions({
  breaks: true,
  gfm: true
});

async function askBrain() {
  const input = document.getElementById('query-input')
  const output = document.getElementById('chat-output')
  const q = input.value.trim()
  if (!q) return
  
  output.style.opacity = '0.7'
  output.textContent = 'Thinking...'
  
  try {
    const r = await fetch('/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: ${repoJson}, prompt: q, stream: false }) })
    const d = await r.json()
    output.style.opacity = '1'
    if (d.answer) {
      output.innerHTML = marked.parse(d.answer)
    } else {
      output.textContent = d.error || 'No answer'
    }
  } catch (e) { 
    output.style.opacity = '1'
    output.textContent = 'Error: ' + e.message 
  }
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
    
    // Save original dead code items for filtering
    window.originalDeadCode = data.deadCode || []
    renderDeadCode(window.originalDeadCode)
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
    p.textContent = 'No candidates found.'
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

// Client side filtering helpers
function filterTable(tableId, query) {
  const table = document.getElementById(tableId)
  if (!table) return
  const rows = table.getElementsByTagName('tr')
  const q = query.toLowerCase()
  for (let i = 1; i < rows.length; i++) {
    const text = rows[i].textContent.toLowerCase()
    rows[i].style.display = text.includes(q) ? '' : 'none'
  }
}

function filterList(listId, query) {
  const list = document.getElementById(listId)
  if (!list) return
  const items = list.getElementsByTagName('li')
  const q = query.toLowerCase()
  for (let i = 0; i < items.length; i++) {
    const text = items[i].textContent.toLowerCase()
    items[i].style.display = text.includes(q) ? '' : 'none'
  }
}

function filterDeadCode(query) {
  if (!window.originalDeadCode) return
  const q = query.toLowerCase()
  const filtered = window.originalDeadCode.filter(item => 
    item.name.toLowerCase().includes(q) || 
    item.file.toLowerCase().includes(q) ||
    item.kind.toLowerCase().includes(q)
  )
  renderDeadCode(filtered)
}

async function loadDiffImpact() {
  const list = document.getElementById('diff-impact-list')
  if (!list) return
  try {
    const r = await fetch('/graph/diff-impact?repo=' + encodeURIComponent(${repoJson}))
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Diff impact failed')
    
    list.innerHTML = ''
    if (!data.length) {
      list.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">No uncommitted changes detected or no containing symbols affected.</p>'
      return
    }
    
    for (const fileImpact of data) {
      for (const sym of fileImpact.symbols) {
        const box = document.createElement('div')
        box.className = 'empty dead-item'
        box.style.borderLeft = '4px solid var(--pink)'
        
        const title = document.createElement('strong')
        title.textContent = sym.symbolFqn.split(':').pop() + ' (' + sym.kind + ')'
        
        const loc = document.createElement('code')
        loc.textContent = fileImpact.filePath + ':' + sym.lineStart + '-' + sym.lineEnd
        
        const impactText = document.createElement('small')
        if (sym.ripple.length === 0) {
          impactText.textContent = 'No downstream impact.'
        } else {
          impactText.textContent = 'Affects ' + sym.ripple.length + ' symbols downstream: ' + 
            sym.ripple.map(rip => rip.fqn.split(':').pop()).join(', ')
        }
        
        box.append(title, loc, impactText)
        list.appendChild(box)
      }
    }
  } catch (e) {
    list.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">Error loading diff impact: ' + e.message + '</p>'
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

  // Create viewport group for Zoom & Pan support
  const viewportGroup = svgEl('g')
  viewportGroup.setAttribute('id', 'graph-viewport')
  svg.appendChild(viewportGroup)

  const nodes = layoutClusterGraph(data.nodes || [], width, height)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const degree = new Map()
  for (const edge of data.edges || []) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  }

  const edgeGroup = svgEl('g')
  const nodeGroup = svgEl('g')
  viewportGroup.append(edgeGroup, nodeGroup)

  // Zoom & Pan state
  let zoom = 1
  let panX = 0
  let panY = 0
  let isDragging = false
  let startX = 0
  let startY = 0

  function updateTransform() {
    viewportGroup.setAttribute('transform', 'translate(' + panX + ', ' + panY + ') scale(' + zoom + ')')
  }

  svg.addEventListener('dblclick', () => {
    zoom = 1
    panX = 0
    panY = 0
    updateTransform()
  })

  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    const zoomFactor = 1.08
    const oldZoom = zoom
    if (e.deltaY < 0) {
      zoom = Math.min(zoom * zoomFactor, 6)
    } else {
      zoom = Math.max(zoom / zoomFactor, 0.25)
    }
    const rect = svg.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    panX = mouseX - (mouseX - panX) * (zoom / oldZoom)
    panY = mouseY - (mouseY - panY) * (zoom / oldZoom)
    updateTransform()
  }, { passive: false })

  svg.addEventListener('mousedown', (e) => {
    if (e.target.closest('.graph-node')) return
    isDragging = true
    startX = e.clientX - panX
    startY = e.clientY - panY
    svg.style.cursor = 'grabbing'
  })

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return
    panX = e.clientX - startX
    panY = e.clientY - startY
    updateTransform()
  })

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false
      svg.style.cursor = 'default'
    }
  })

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
  body.style.marginTop = '10px'
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
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
loadGraph()
setInterval(loadGraph, 30000)
loadDiffImpact()
setInterval(loadDiffImpact, 15000)
</script>
</body>
</html>`)
  })

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  return app
}
