import { basename } from 'node:path'
import path from 'node:path'
import * as readline from 'node:readline'
import { buildContext, formatContext, buildSystemPrompt } from '../query/context-builder.js'
import { streamQuery } from '../query/engine.js'
import { initSqlite, getDb } from '../memory/db.js'
import { initMemorySchema } from '../memory/schema.js'

function ensureDb(brainDir: string) {
  initSqlite(brainDir)
  initMemorySchema(getDb())
}

function parseArgs(argv: string[]): { query: string; options: { repo?: string; json?: boolean; interactive?: boolean } } {
  const options: { repo?: string; json?: boolean; interactive?: boolean } = {}
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
    } else if (arg === '--watch' || arg === '--interactive') {
      options.interactive = true
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

async function runQuery(repo: string, question: string, systemPrompt: string): Promise<string> {
  const ctx = buildContext(repo)
  const contextStr = formatContext(ctx)
  const userPrompt = `${contextStr}\n\n## User Question\n${question}\n\nProvide a grounded answer based on the above context.`
  let fullResponse = ''
  for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
    process.stdout.write(chunk)
    fullResponse += chunk
  }
  process.stdout.write('\n')
  return fullResponse
}

export async function ask(cwd: string, argv: string[]): Promise<void> {
  const { query: queryText, options } = parseArgs(argv)
  const repo = options.repo ?? basename(cwd)
  const brainDir = path.join(cwd, '.brain')
  ensureDb(brainDir)

  const systemPrompt = buildSystemPrompt()

  if (options.interactive) {
    console.info('[brain] Interactive mode. Ctrl+C to exit.\n')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const loop = () => {
      rl.question('> ', async (input) => {
        if (!input.trim()) return loop()
        await runQuery(repo, input, systemPrompt)
        loop()
      })
    }
    loop()
    return
  }

  if (!queryText) {
    console.error('Usage: brain ask "<question>" [--repo name] [--json] [--interactive]')
    process.exit(1)
  }

  console.info(`[brain] Querying knowledge graph for: "${queryText}"`)

  if (options.json) {
    const ctx = buildContext(repo)
    const contextStr = formatContext(ctx)
    const userPrompt = `${contextStr}\n\n## User Question\n${queryText}\n\nProvide a grounded answer based on the above context.`
    let chunks: string[] = []
    for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
      chunks.push(chunk)
    }
    console.log(JSON.stringify({ answer: chunks.join(''), context: { repo, symbols: ctx.symbols.length, hotzones: ctx.hotzones.length } }))
  } else {
    await runQuery(repo, queryText, systemPrompt)
  }
}