import type { Router, Request, Response } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  downloadAndExtractRepo,
  generateRepoDigest,
  buildDirectoryTree,
  escapeHtml
} from '../helpers.js'
import type { Config } from '../../config/schema.js'

export function registerIngestRoute(router: Router, config: Config): void {
  const handleIngest = async (req: Request, res: Response) => {
    try {
      const owner = req.params.owner as string
      const repo = req.params.repo as string
      if (!owner || !repo) {
        res.status(400).send('Owner and repo parameters are required')
        return
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

  router.get('/ingest/:owner/:repo', handleIngest)
  router.get('/ingest/github.com/:owner/:repo', handleIngest)
}
