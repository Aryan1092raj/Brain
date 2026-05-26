import { basename } from 'node:path'
import path from 'node:path'
import { buildContext, formatContext, buildSystemPrompt } from '../query/context-builder.js'
import { streamQuery } from '../query/engine.js'
import { initSqlite, getDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'

function ensureDb(brainDir: string) {
  initSqlite(brainDir)
  initMemorySchema(getDb())
}

function parseArgs(argv: string[]): { query: string; options: { repo?: string; json?: boolean; watch?: boolean } } {
  const options: { repo?: string; json?: boolean; watch?: boolean } = {}
  const queryParts: string[] = []

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--repo' && i + 1 < argv.length) {
      options.repo = argv[i + 1]
      i += 2
    } else if (arg === '--json') {
      options.json = true
      i += 1
    } else if (arg === '--watch') {
      options.watch = true
      i += 1
    } else if (arg.startsWith('-')) {
      i += 1
    } else {
      queryParts.push(arg)
      i += 1
    }
  }

  return {
    query: queryParts.join(' '),
    options,
  }
}

export async function ask(cwd: string, argv: string[]): Promise<void> {
  const { query: queryText, options } = parseArgs(argv)
  if (!queryText) {
    console.error('Usage: brain ask "<question>" [--repo name] [--json] [--watch]')
    process.exit(1)
  }

  const repo = options.repo ?? basename(cwd)
  const brainDir = path.join(cwd, '.brain')
  ensureDb(brainDir)

  console.info(`[brain] Querying knowledge graph for: "${queryText}"`)

  const ctx = buildContext(repo)
  const contextStr = formatContext(ctx)
  const systemPrompt = buildSystemPrompt()

  const userPrompt = `${contextStr}\n\n## User Question\n${queryText}\n\nProvide a grounded answer based on the above context.`

  let fullResponse = ''
  if (options.json) {
    const response = await (async () => {
      let chunks: string[] = []
      for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
        chunks.push(chunk)
      }
      return chunks.join('')
    })()
    console.log(JSON.stringify({ answer: response, context: { repo, symbols: ctx.symbols.length, hotzones: ctx.hotzones.length } }))
  } else {
    for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
      process.stdout.write(chunk)
      fullResponse += chunk
    }
    process.stdout.write('\n')
  }
}