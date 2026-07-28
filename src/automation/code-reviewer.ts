import { buildContext, formatContext } from '../query/context-builder.js'
import type { RepoConfig } from '../config/schema.js'
import { query } from '../query/engine.js'

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
  const ctx = buildContext(repo.name)
  const contextStr = formatContext(ctx)
  const raw = await query(`You are an expert code reviewer with full codebase context.
You have access to: hot zones, recent episodes, symbol relationships.
Return ONLY valid JSON: { summary, risks[], suggestions[], impactedSymbols[] }`,
    `${contextStr}\n\n## Diff for ${commitSha.slice(0, 7)}\n\`\`\`\n${patchContent.slice(0, 4000)}\n\`\`\`\n\nReview this commit.`,
    { maxTokens: 700, temperature: 0.2 })

  return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim()) as ReviewResult
}
