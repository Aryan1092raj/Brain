import OpenAI from 'openai'

let _client: OpenAI | null = null

export function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.BRAIN_LLM_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || ''
    const baseURL = process.env.BRAIN_LLM_BASE_URL || (process.env.OPENAI_API_KEY ? undefined : 'https://api.groq.com/openai/v1')
    _client = new OpenAI({
      apiKey,
      baseURL,
    })
  }
  return _client
}

export function getModel(): string {
  return process.env.BRAIN_LLM_MODEL || (process.env.OPENAI_API_KEY ? 'gpt-4o-mini' : 'llama-3.3-70b-versatile')
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
  const client = getClient()
  const stream = await client.chat.completions.create({
    model: getModel(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    stream: true,
  })

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
  const client = getClient()
  const response = await client.chat.completions.create({
    model: getModel(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    stream: false,
  })

  return response.choices[0]?.message?.content ?? ''
}