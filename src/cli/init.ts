import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { getBrainDir, getLegacyConfigPath, getProjectConfigPath } from '../config/paths.js'
import { initKuzu, getKuzuClient } from '../graph/client.js'
import { KUZU_DDL } from '../graph/schema.js'
import { initSqlite, getDb } from '../memory/db.js'
import { SQLITE_DDL } from '../memory/schema.js'
import { scan } from './scan.js'

const GROQ_GUIDE = `# Brain + Groq

Brain works without an API key. Indexing, the graph, status, diff impact, MCP data tools, and the dashboard stay local.

Chat and AI summaries are optional. To enable them:

1. Create a free key at https://console.groq.com/keys
2. Add \`GROQ_API_KEY=...\` to the project \`.env\` file (never commit it)
3. Restart \`brain watch\`

The default model is \`llama-3.1-8b-instant\`, chosen for fast codebase Q&A and the higher free-tier daily quota. Brain keeps one user-level usage ledger at \`~/.config/brain/llm-usage.json\` so multiple project dashboards share the same conservative request/token budget and respect 429 retry windows. Limits are organization-wide, so multiple Groq keys do not create more quota.

Override the model or conservative local limits only when your Groq console shows different limits:

\`\`\`dotenv
BRAIN_LLM_MODEL=llama-3.1-8b-instant
BRAIN_GROQ_RPM=30
BRAIN_GROQ_TPM=6000
BRAIN_GROQ_RPD=14400
\`\`\`
`

export async function init(cwd: string): Promise<void> {
  const brainDir = getBrainDir(cwd)

  await fs.mkdir(path.join(brainDir, 'graph'), { recursive: true })
  await fs.mkdir(path.join(brainDir, 'logs'), { recursive: true })
  await fs.writeFile(path.join(brainDir, 'README.md'), GROQ_GUIDE, 'utf8')

  const configPath = getProjectConfigPath(cwd)
  try {
    await fs.access(configPath)
    console.info('[brain] .brain/config.json already exists — keeping it')
  } catch {
    let config: unknown
    try {
      config = JSON.parse(await fs.readFile(getLegacyConfigPath(cwd), 'utf8'))
      console.info('[brain] migrating legacy brain.config.json into .brain/config.json')
    } catch {
      config = {
        repos: [{
          name: path.basename(path.resolve(cwd)),
          path: path.resolve(cwd),
          remote: '',
          webhookSecret: crypto.randomUUID(),
          languages: ['typescript', 'javascript', 'python'],
          branch: 'main',
        }],
        port: 3747,
        logLevel: 'info',
      }
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    console.info('[brain] created .brain/config.json')
  }

  initKuzu(brainDir)
  const db = getKuzuClient()
  for (const ddl of KUZU_DDL) {
    await db.run(ddl)
  }
  console.info('[brain] Kuzu schema initialised')

  initSqlite(brainDir)
  const sqliteDb = getDb()
  for (const stmt of SQLITE_DDL.split(';').filter(s => s.trim())) {
    sqliteDb.exec(stmt)
  }
  console.info('[brain] SQLite schema initialised')

  console.info('[brain] indexing project...')
  await scan(cwd, ['--quiet'])
  console.info('[brain] init complete — run: brain watch for the dashboard')
}
