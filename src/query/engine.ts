import OpenAI from 'openai'
import { estimateTokens, getGroqApiKey, getGroqModel, hasGroqApiKey, recordGroqRateLimit, reserveGroqRequest, GroqRateLimitError, GroqUnavailableError } from './groq.js'

let _client: OpenAI | null = null

export function getClient(): OpenAI {
  const apiKey = getGroqApiKey()
  if (!apiKey) throw new GroqUnavailableError()
  if (!_client) {
    _client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
      maxRetries: 0,
    })
  }
  return _client
}

export function getModel(): string {
  return getGroqModel()
}

export function hasLlmAccess(): boolean {
  return hasGroqApiKey()
}

export interface QueryOptions {
  stream?: boolean
  temperature?: number
  maxTokens?: number
}

export async function* streamQuery(
  system: string,
  user: string,
  opts: QueryOptions = {}
): AsyncGenerator<string> {
  const maxTokens = opts.maxTokens ?? 700
  await reserveGroqRequest(estimateTokens(system, user, maxTokens))
  let stream
  try {
    stream = await getClient().chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: opts.temperature ?? 0.7,
      max_tokens: maxTokens,
      stream: true,
    })
  } catch (error) {
    const retryAt = await recordGroqRateLimit(error)
    if (retryAt) throw new GroqRateLimitError(retryAt)
    throw error
  }

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content
    if (content) yield content
  }
}

export async function query(
  system: string,
  user: string,
  opts: QueryOptions = {}
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 700
  await reserveGroqRequest(estimateTokens(system, user, maxTokens))
  let response
  try {
    response = await getClient().chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: opts.temperature ?? 0.7,
      max_tokens: maxTokens,
      stream: false,
    })
  } catch (error) {
    const retryAt = await recordGroqRateLimit(error)
    if (retryAt) throw new GroqRateLimitError(retryAt)
    throw error
  }

  return response.choices[0]?.message?.content ?? ''
}
