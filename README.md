# Brain

> Local-first codebase intelligence with a graph, memory decay, change impact, and optional Groq chat.

Brain indexes a repository into a project-local `.brain/` directory. The CLI is installed once globally; the data and configuration stay separate for every project where `brain init` runs.

## Quick start

Clone and install Brain once:

```bash
git clone https://github.com/Aryan1092raj/Brain.git
cd brain
npm install
npm run build
npm link
```

Then, in any codebase:

```bash
cd /path/to/your/project
brain init       # creates .brain/ and indexes this project
brain watch      # starts the dashboard at http://localhost:3747
```

`brain init` creates `.brain/config.json`, local graph/memory databases, a Groq setup guide, and performs the first index. Run `brain scan` later to re-index manually. `.brain/` is already ignored by Git, so no project state is shared with another codebase.

## Local-first features

These work without an API key:

- Knowledge graph of supported TypeScript, JavaScript, and Python symbols and relationships.
- Memory decay, hot-zone tracking, co-change predictions, and local diff impact.
- Dashboard, `brain status`, `brain scan`, and local MCP data tools.
- `AGENTS.md` generation from the local graph.

## Optional Groq chat

Chat and AI summaries are disabled unless `GROQ_API_KEY` is detected. Create a key at [console.groq.com/keys](https://console.groq.com/keys), put it in the project’s `.env`, and restart `brain watch`:

```dotenv
GROQ_API_KEY=your_groq_api_key_here
BRAIN_LLM_MODEL=llama-3.1-8b-instant
```

Brain uses `llama-3.1-8b-instant` by default because it is fast and has a high free-tier daily quota, which suits short codebase questions. It stores one user-level usage ledger in `~/.config/brain/llm-usage.json` so multiple project dashboards share the same conservative minute/day budget, reserve estimated tokens before a request, and respect 429 retry windows. Defaults are 30 RPM, 6,000 TPM, and 14,400 RPD; Groq’s exact limits can vary by organization, so check [Groq’s rate-limit documentation](https://console.groq.com/docs/rate-limits).

If your console shows different limits, override the local guardrails:

```dotenv
BRAIN_GROQ_RPM=30
BRAIN_GROQ_TPM=6000
BRAIN_GROQ_RPD=14400
```

Groq limits are organization-wide; creating multiple keys does not create more quota. Full setup instructions are written to `.brain/README.md` during `brain init`.

## Dashboard and ingestion

Start `brain watch`, then open `http://localhost:3747`. The dashboard exposes the graph, decay simulator, hot zones, recent episodes, pending diff impact, dead-code candidates, and optional chat. Remote GitHub prompt ingestion is also available at `/github.com/{owner}/{repo}` or `/{owner}/{repo}`.

### Temporal Memory Decay Simulator

The simulator is a read-only forecast of the graph’s memory scores:

1. Start the daemon with `brain watch` and open the dashboard.
2. In the Knowledge Graph section, move the `Temporal Memory Decay Simulator` slider from `0` to `90` days.
3. The graph recolors nodes as their memory freshness decays. Green is fresh, amber is aging, and red is decaying; hot zones remain marked until their simulated score becomes very low.
4. Select a symbol to see its memory bar update with the forecast. Reset the slider to `0` to return to current memory.

The simulator does not write to Kuzu or SQLite and does not change the scheduled decay job. It is available without `GROQ_API_KEY`. Groq is only needed for the optional `Ask Brain` chat and AI-generated node explanations.

### GitIngest file selection

The `Ingest Prompt Dump` page reads the repository root `.gitignore`. Matching files remain visible in the tree but start unchecked, so the default digest follows the repository’s ignore rules. Check an ignored file or directory manually when it belongs in a prompt. The built-in safety exclusions for dependencies, secrets, binaries, and databases still apply.

If a cloned project shows a blank graph on another laptop, the API key is not the first thing to check: chat is optional. Run `npm install` and `npm run build` in the Brain checkout, then run `brain init` and `brain scan` from the target repository before `brain watch`. Graph data is stored locally in that repository’s `.brain/graph/brain.kuzu`; `brain status` confirms whether files and symbols were indexed. The dashboard graph renderer is local and does not require a CDN or API key.

## CLI reference

| Command | Description |
|---|---|
| `brain init` | Create project-local state and index the current codebase |
| `brain scan` | Re-index the configured repository |
| `brain watch` | Start the dashboard, webhook server, and scheduler |
| `brain status` | Show local file/symbol, memory, and hot-zone counts |
| `brain query "<question>"` | Use Groq to translate a question into a read-only Cypher query |
| `brain ask "<question>"` | Ask Groq with graph-grounded context |
| `brain diff-impact` | Inspect downstream impact of uncommitted changes |
| `brain mcp` | Start the local MCP stdio server |

## Development

```bash
npm run build
npm test
```

## Requirements

- Node.js 22+
- npm
- Git
- Groq API key only for chat/AI summaries

MIT
