import type { Router, Request, Response } from 'express'
import { buildContext, formatRichContext } from '../../query/context-builder.js'
import { streamQuery } from '../../query/engine.js'
import { getGroqStatus, hasGroqApiKey } from '../../query/groq.js'

export function registerQueryRoute(router: Router): void {
  router.get('/api/llm-status', async (_req: Request, res: Response) => {
    res.json(await getGroqStatus())
  })

  router.post('/query', async (req: Request, res: Response) => {
    try {
      const { repo, prompt, stream = false } = req.body
      if (!repo || !prompt) {
        res.status(400).json({ error: 'repo and prompt required' })
        return
      }
      if (!hasGroqApiKey()) {
        res.status(503).json({
          code: 'GROQ_API_KEY_MISSING',
          error: 'Chat is disabled until GROQ_API_KEY is configured.',
          help: 'Add GROQ_API_KEY to the project .env file and restart brain watch.',
        })
        return
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
      const error = err as { code?: string; message?: string; retryAt?: number }
      const status = error.code === 'GROQ_RATE_LIMITED' ? 429 : 500
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: error.message ?? 'Query failed', code: error.code })}\n\n`)
        res.end()
        return
      }
      res.status(status).json({ code: error.code ?? 'QUERY_FAILED', error: error.message ?? 'Query failed', retryAt: error.retryAt })
    }
  })
}
