import OpenAI from 'openai'

const MODEL = 'llama-3.3-70b-versatile'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY ?? '',
      baseURL: 'https://api.groq.com/openai/v1',
    })
  }
  return _client
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
    model: MODEL,
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
    model: MODEL,
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