import { streamQuery, query as queryLlm } from '../query/engine.js'
import { buildContext, formatRichContext, buildSystemPrompt } from '../query/context-builder.js'
import { getCurrentHotZones } from '../temporal/hotzone.js'
import { getDb } from '../memory/db.js'
import { computeRippleImpact } from '../query/ripple.js'
import { getGraphOverview } from '../graph/insights.js'
import { hasGroqApiKey } from '../query/groq.js'

export interface MCPTool {
  name: string
  description: string
  inputSchema: object
}

export const tools: MCPTool[] = [
  {
    name: 'brain_ask',
    description: 'Query the knowledge graph with an LLM',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        prompt: { type: 'string', description: 'Question to ask' },
      },
      required: ['repo', 'prompt'],
    },
  },
  {
    name: 'brain_hotzones',
    description: 'Get current hot zones (high change velocity symbols)',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'brain_status',
    description: 'Get brain status for a repo',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'brain_ripple_impact',
    description: 'Trace downstream affected symbols of a given symbol FQN using ripple solver',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        symbolFqn: { type: 'string', description: 'FQN of the symbol (e.g. repo:file:symbolName)' },
        maxDepth: { type: 'number', description: 'Maximum search depth (default: 5)' }
      },
      required: ['repo', 'symbolFqn'],
    },
  },
  {
    name: 'brain_explain',
    description: 'Get short summary and connected edges of a specific graph node (file or symbol)',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        id: { type: 'string', description: 'Node ID (file path or symbol FQN)' }
      },
      required: ['repo', 'id'],
    },
  },
]

export async function handleToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const repo = args.repo as string

  switch (toolName) {
    case 'brain_ask': {
      if (!hasGroqApiKey()) throw new Error('brain_ask requires GROQ_API_KEY. Local MCP tools remain available.')
      const prompt = args.prompt as string
      const ctx = buildContext(repo)
      const contextStr = await formatRichContext(ctx)
      const systemPrompt = buildSystemPrompt()
      const userPrompt = `${contextStr}\n\n## User Question\n${prompt}\n\nProvide a grounded answer.`

      let answer = ''
      for await (const chunk of streamQuery(systemPrompt, userPrompt)) {
        answer += chunk
      }
      return { answer, sources: { hotzones: ctx.hotzones.length, tier2: ctx.tier2.length } }
    }

    case 'brain_hotzones': {
      const hotzones = getCurrentHotZones(repo)
      return hotzones.map(h => ({
        fqn: h.symbolFqn,
        file: h.filePath,
        velocity: h.velocity,
        zScore: h.zScore,
      }))
    }

    case 'brain_status': {
      const db = getDb()
      const symbolCount = (db.prepare(`SELECT COUNT(DISTINCT symbol_fqn) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const fileCount = (db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM change_events WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0
      const hotzones = getCurrentHotZones(repo)
      const tier2Count = (db.prepare(`SELECT COUNT(*) as c FROM tier2_episodes WHERE repo = ?`).get(repo) as { c: number })?.c ?? 0

      return {
        repo,
        symbolCount,
        fileCount,
        hotZones: hotzones.length,
        tier2Episodes: tier2Count,
      }
    }

    case 'brain_ripple_impact': {
      const symbolFqn = args.symbolFqn as string
      const maxDepth = args.maxDepth ? Number(args.maxDepth) : 5
      const impacts = await computeRippleImpact(symbolFqn, maxDepth)
      return impacts.map(rip => ({
        fqn: rip.fqn,
        file: rip.file,
        kind: rip.kind,
        decayScore: rip.decayScore,
        depth: rip.depth,
      }))
    }

    case 'brain_explain': {
      const id = args.id as string
      const graph = await getGraphOverview(repo, 140)
      const node = graph.nodes.find(n => n.id === id)
      if (!node) {
        throw new Error(`Node not found: ${id}`)
      }

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
      if (hasGroqApiKey()) {
        summary = await queryLlm(
          'You explain code graph nodes for an MCP tool. Be concrete. Max 35 words. No markdown.',
          JSON.stringify({ node, connected: neighbors, deadCode: deadCode?.reason ?? null }),
          { temperature: 0.2, maxTokens: 90 },
        ).catch(() => fallback)
      }

      return {
        id,
        label: node.label,
        type: node.type,
        kind: node.kind,
        file: node.file,
        lineStart: node.lineStart,
        summary,
        edgesCount: incident.length,
        connected: neighbors,
        deadCode: deadCode ?? null,
      }
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

export function startMCPServer(): void {
  process.stdin.setEncoding('utf-8')

  let buffer = ''

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 1)

      try {
        const msg = JSON.parse(line)
        handleMessage(msg)
      } catch (e) {
        console.error('[brain/mcp] parse error:', e)
      }
    }
  })

  async function handleMessage(msg: { id?: string; method?: string; params?: Record<string, unknown> }) {
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
    } else if (msg.method === 'tools/call') {
      const toolName = msg.params?.name as string
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
      try {
        const result = await handleToolCall(toolName, args)
        send({ jsonrpc: '2.0', id: msg.id, result })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error'
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message } })
      }
    }
  }

  function send(obj: object) {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }

  console.info('[brain] MCP server started on stdio')
}
