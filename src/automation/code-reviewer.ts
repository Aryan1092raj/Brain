import { buildContext, formatContext } from '../query/context-builder.js'
import type { RepoConfig } from '../config/schema.js'

export interface ReviewResult {
  summary: string
  risks: string[]
  suggestions: string[]
  impactedSymbols: string[]
}

export async function reviewCommit(
  repo: RepoConfig,
  commitSha: string,
  patchContent: string,
): Promise<ReviewResult> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || '',
  })

  const ctx = buildContext(repo.name)
  const contextStr = formatContext(ctx)

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are an expert code reviewer with full codebase context.
You have access to: hot zones, recent episodes, symbol relationships.
Return ONLY valid JSON: { summary, risks[], suggestions[], impactedSymbols[] }`,
      },
      {
        role: 'user',
        content: `${contextStr}\n\n## Diff for ${commitSha.slice(0, 7)}\n\`\`\`\n${patchContent.slice(0, 4000)}\n\`\`\`\n\nReview this commit.`,
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
  })

  const raw = response.choices[0]?.message?.content ?? '{}'
  return JSON.parse(raw) as ReviewResult
}
