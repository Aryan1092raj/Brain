# Brain

> Local-first always-on daemon for codebase intelligence with memory decay, temporal tracking, and knowledge graph capabilities.

Brain is a persistent code intelligence system that watches your repository, builds a knowledge graph of symbols and their relationships, tracks code stability through memory decay, detects hot zones, and answers natural language questions about your codebase.

## Features

- **🧠 Knowledge Graph** — Kuzu-powered graph of files, symbols, commits, and modules
- **⏳ Memory Decay** — Ebbinghaus-inspired decay scoring for code stability tracking
- **🔥 Hot Zone Detection** — Statistical anomaly detection for rapidly changing code
- **🌊 Ripple Analysis** — BFS traversal to compute impact of changes across the codebase
- **💬 Natural Language Queries** — Ask questions in plain English, get Cypher queries
- **📊 4-Tier Memory System** — From raw events to long-term patterns
- **🤖 AGENTS.md Generation** — Auto-generated context for AI coding assistants
- **🔗 Cross-File Call Resolution** — Tracks function calls across file boundaries
- **📦 Module Detection** — Automatic grouping of symbols into logical modules
- **🔌 MCP Server** — Model Context Protocol support for AI editor integration

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub Webhook                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Ingestion Pipeline                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Diff   │─▶│tree-sitter│─▶│  Graph   │─▶│ AGENTS.md│   │
│  │  Parser  │  │  Parser   │  │  Writer  │  │Generator │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└────────────────────┬────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌──────────────┐          ┌──────────────┐
│  Kuzu Graph  │          │   SQLite     │
│              │          │  (4 Tiers)   │
│ • Files      │          │              │
│ • Symbols    │          │ • Tier 1: Raw│
│ • Commits    │          │ • Tier 2: Sum│
│ • Modules    │          │ • Tier 3: Fact│
│              │          │ • Tier 4: Pat│
│ Edges:       │          └──────────────┘
│ • Calls      │
│ • Imports    │
│ • Touches    │
│ • BelongsTo  │
└──────────────┘
```

## Requirements

- **Node.js** >= 22 (tested on 24)
- **npm**
- **Git** (for repository tracking)
- **LLM API key** (Groq recommended — free tier available at https://console.groq.com)

---

## Quick Start (copy-paste for any LLM)

Give the following prompt to any LLM (Claude, ChatGPT, etc.) to set up Brain on a fresh machine:

<details>
<summary><strong>📋 Click to copy — LLM Setup Prompt</strong></summary>

```
You are helping me set up a project called "Brain" — a local-first codebase intelligence daemon.

## Project Location
The project is at ~/project/brain

## Step-by-step instructions:

### 1. Install Node.js dependencies
```bash
cd ~/project/brain
npm install
```

### 2. Build the TypeScript project
```bash
npm run build
```

### 3. Set up environment variables
Copy and fill in your API key:
```bash
cp .env.example .env
```
Edit `.env` and set at minimum:
- `GROQ_API_KEY` — get a free key from https://console.groq.com
- Optionally set `GITHUB_TOKEN` if you want GitHub integration

### 4. Initialize Brain for a repository
```bash
cd ~/project/brain
node dist/cli/index.js init
```
This creates `.brain/` (databases) and `brain.config.json` (configuration) in the current directory.

### 5. Fix native module if needed
If you get a Node.js version mismatch error with better-sqlite3:
```bash
npm rebuild better-sqlite3
```

### 6. Start the daemon
```bash
node dist/cli/index.js watch
```
You should see:
```
[brain] loaded .env
[brain/scheduler] started — 6h decay cycle, 24h tier promotion
[brain] listening on :3747
```

### 7. Query the knowledge graph (in another terminal)
```bash
cd ~/project/brain
node dist/cli/index.js query "what does package.json do"
```

### 8. Check status
```bash
node dist/cli/index.js status
```

### 9. Ask an LLM-powered question
```bash
node dist/cli/index.js ask "explain the project architecture"
```

## Troubleshooting
- **"Kuzu not initialised"** — Run `node dist/cli/index.js init` first
- **"better_sqlite3.node" errors** — Run `npm rebuild better-sqlite3`
- **Port already in use** — Set `BRAIN_PORT=3748` in `.env`
- **No results from query** — The daemon needs time to ingest code. Check `node dist/cli/index.js status`
```
</details>

---

## Manual Setup

### 1. Install Dependencies

```bash
cd ~/project/brain
npm install
npm run build
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your API keys:

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes | LLM API key (Groq free tier: https://console.groq.com) |
| `GITHUB_TOKEN` | No | GitHub PAT with `repo:read` scope for webhook integration |
| `BRAIN_PORT` | No | HTTP server port (default: 3747) |
| `BRAIN_LOG_LEVEL` | No | Log verbosity: `info`, `debug`, `error` (default: `info`) |

### 3. Initialize

```bash
node dist/cli/index.js init
```

This creates:
- `.brain/` directory with Kuzu graph and SQLite databases
- `brain.config.json` with default settings

### 4. Start the Daemon

```bash
node dist/cli/index.js watch
```

The daemon will:
- Watch your repo for file changes and update the knowledge graph
- Run decay scheduler every 6 hours
- Compress tier 1 → tier 2 every 24 hours
- Promote to tier 3/4 every 7 days
- Listen on port 3747 for HTTP requests (configurable via `BRAIN_PORT` or `port` in config)

---

## Commands

| Command | Description |
|---------|-------------|
| `node dist/cli/index.js init` | Initialize Brain in the current directory |
| `node dist/cli/index.js watch` | Start the daemon (ingestion, decay, API server) |
| `node dist/cli/index.js query "<question>"` | Natural language query against the knowledge graph |
| `node dist/cli/index.js ask "<question>"` | LLM-powered question answering |
| `node dist/cli/index.js status` | Show daemon health, stats, hot zones |
| `node dist/cli/index.js mcp` | Start MCP server on stdio (for AI editor integration) |

## Query Examples

```bash
# Find what a file exports
node dist/cli/index.js query "what does auth.ts export"

# Find files that depend on something
node dist/cli/index.js query "what files import config"

# Find unstable/hot code
node dist/cli/index.js query "which files are changing the most"

# Ripple impact analysis
node dist/cli/index.js query "impact of changing validateToken"

# Architecture questions
node dist/cli/index.js query "explain the module structure"
```

## Status Output

```bash
node dist/cli/index.js status
```

Shows:
- Total files and symbols tracked
- Hot zones (high-velocity code)
- Recent patterns detected
- Memory tier statistics

## LLM-powered Questions

```bash
node dist/cli/index.js ask "explain the authentication flow"
node dist/cli/index.js ask "what design patterns are used"
node dist/cli/index.js ask "how does error handling work"
```

---

## Configuration

Edit `brain.config.json`:

```json
{
  "repos": [
    {
      "name": "my-app",
      "path": "/path/to/repo",
      "remote": "https://github.com/username/repo",
      "webhookSecret": "auto-generated-uuid",
      "languages": ["typescript", "javascript", "python"],
      "branch": "main"
    }
  ],
  "port": 3747,
  "logLevel": "info"
}
```

### Adding Multiple Repos

```json
{
  "repos": [
    { "name": "frontend", "path": "/path/to/frontend", "languages": ["typescript"] },
    { "name": "backend", "path": "/path/to/backend", "languages": ["python"] }
  ]
}
```

---

## Memory Tiers

### Tier 1: Raw Events (24h TTL)
- Every symbol add/modify/remove
- Stored in SQLite
- Compressed to Tier 2 daily

### Tier 2: Daily Summaries (30d TTL)
- LLM-generated summaries of daily activity
- Files and symbols touched
- Decay score tracking

### Tier 3: Facts (90d TTL)
- Extracted triples: `(subject, predicate, object)`
- Example: `(auth.ts, frequently_modified, true)`
- Confidence scores

### Tier 4: Patterns (Permanent)
- Co-change patterns (files modified together)
- Multi-module patterns
- Active development areas
- Occurrence counts

---

## Graph Schema

### Nodes

```cypher
File(path, repo, language, decay_score, last_touched)
Symbol(fqn, kind, name, file, is_exported, decay_score, velocity)
Commit(sha, repo, author, ts)
Module(name, repo, owner)
```

### Relationships

```cypher
(Symbol)-[:Calls]->(Symbol)
(File)-[:Imports]->(File)
(File)-[:Contains]->(Symbol)
(Commit)-[:Touches]->(Symbol)
(Symbol)-[:BelongsTo]->(Module)
```

## Example Queries

### Find all callers of a function

```cypher
MATCH (caller:Symbol)-[:Calls]->(target:Symbol {fqn: 'repo:file:functionName'})
RETURN caller.fqn, caller.file
```

### Find hot zones

```cypher
MATCH (s:Symbol {repo: 'my-app'})
WHERE s.velocity > 2.0
RETURN s.fqn, s.file, s.velocity
ORDER BY s.velocity DESC
```

### Ripple impact analysis

```cypher
MATCH path = (s:Symbol {fqn: 'repo:auth.ts:validateToken'})-[:Calls*1..5]-(affected:Symbol)
RETURN DISTINCT affected.fqn, affected.decay_score, length(path) AS depth
ORDER BY affected.decay_score DESC
```

---

## API

### Programmatic Usage

```typescript
import { getKuzuClient } from 'brain/graph/client'
import { computeRippleImpact } from 'brain/query/ripple'

const db = getKuzuClient()
const result = await db.query(`
  MATCH (s:Symbol {repo: $repo})
  RETURN s.fqn, s.decay_score
  ORDER BY s.decay_score DESC
  LIMIT 10
`, { repo: 'my-app' })

const impact = await computeRippleImpact('my-app:auth.ts:validateToken')
```

### HTTP Endpoints

With the daemon running:

```
GET  /status              — Daemon health and stats
GET  /query?q=<question>  — Query the knowledge graph
POST /webhook             — GitHub webhook receiver
```

---

## Decay Formula

Brain uses an Ebbinghaus-inspired decay formula:

```
decay_score = e^(-λ * days_since_touch)
```

Where:
- `λ` (lambda) = decay rate (default: 0.1)
- `days_since_touch` = days since last commit touching the symbol
- Stability factor adjusts λ per symbol type:
  - Architecture files: high stability (λ = 0.03)
  - Business logic: medium stability (λ = 0.1)
  - TODO comments: low stability (λ = 0.3)

## Hot Zone Detection

Hot zones are detected using z-score analysis:

```
z_score = (velocity - mean_velocity) / std_dev
```

A symbol is flagged as a hot zone if:
- `z_score >= 2.0` (configurable)
- At least 3 change events in the 30-day window

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in dev mode (no build step)
npm run dev watch

# Run tests
npm test
```

## Tech Stack

- **Runtime**: Node.js 22+ / TypeScript (ESM)
- **Graph DB**: Kuzu (embedded, C++)
- **Memory DB**: SQLite (better-sqlite3)
- **Parser**: tree-sitter (JS/TS/Python)
- **LLM**: Groq (Llama 3.3 70B)
- **Web**: Express
- **AI Protocol**: MCP (Model Context Protocol)

---

## Roadmap

- [x] Phase 1: Walking skeleton (webhook → graph → AGENTS.md)
- [x] Phase 2: Memory engine (4 tiers + decay)
- [x] Phase 3: Temporal engine (hot zones + alerts)
- [x] Phase 4: Ripple solver (BFS impact analysis)
- [x] Phase 5: Query interface (NL → Cypher)
- [x] Phase 6: MCP server integration
- [ ] Phase 7: Multi-repo cross-pattern detection
- [ ] Phase 8: Cloudflare Tunnel setup
- [ ] Phase 9: systemd/launchd service files

---

## Why Brain?

**Problem**: Codebases are living organisms. Files decay, hot zones emerge, and dependencies ripple. Traditional static analysis tools don't capture this temporal dimension.

**Solution**: Brain treats your codebase as a knowledge graph with memory. It remembers what changed, when, and how often. It detects patterns, predicts impact, and answers questions.

**Use Cases**:
- "What breaks if I change this function?" → Ripple analysis
- "Which files are changing too fast?" → Hot zone detection
- "What owns the auth module?" → Module queries
- "Show me stable vs unstable code" → Decay score ranking

## License

MIT

## Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Credits

Inspired by:
- [Ebbinghaus forgetting curve](https://en.wikipedia.org/wiki/Forgetting_curve)
- [Kuzu graph database](https://kuzudb.com/)
- [tree-sitter](https://tree-sitter.github.io/)
- OpenClaw architecture patterns
