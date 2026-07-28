import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant'

// Conservative defaults for the free tier. 429 response headers refine the
// local cooldown so repeated calls do not hammer the organization quota.
const DEFAULT_LIMITS = {
  rpm: 30,
  tpm: 6_000,
  rpd: 14_400,
}

interface UsageEntry {
  at: number
  tokens: number
}

interface UsageState {
  dateUtc: string
  requests: number
  entries: UsageEntry[]
  blockedUntil: number
  limits: typeof DEFAULT_LIMITS
}

export interface GroqStatus {
  configured: boolean
  model: string
  limits: typeof DEFAULT_LIMITS
  requestsToday: number
  requestsRemainingToday: number
  requestsRemainingMinute: number
  tokensRemainingMinute: number
  blockedUntil: string | null
}

export class GroqUnavailableError extends Error {
  code = 'GROQ_API_KEY_MISSING' as const

  constructor() {
    super('Chat is disabled because GROQ_API_KEY is not set. Add a key from https://console.groq.com/keys, then restart Brain.')
    this.name = 'GroqUnavailableError'
  }
}

export class GroqRateLimitError extends Error {
  code = 'GROQ_RATE_LIMITED' as const
  retryAt: number

  constructor(retryAt: number, message = 'Groq free-tier rate limit reached') {
    super(`${message}. Try again ${new Date(retryAt).toISOString()}.`)
    this.name = 'GroqRateLimitError'
    this.retryAt = retryAt
  }
}

export function getGroqApiKey(): string | undefined {
  const key = process.env.GROQ_API_KEY?.trim()
  return key || undefined
}

export function hasGroqApiKey(): boolean {
  return Boolean(getGroqApiKey())
}

export function getGroqModel(): string {
  return process.env.BRAIN_LLM_MODEL?.trim() || DEFAULT_GROQ_MODEL
}

function getUsagePath(): string {
  return process.env.BRAIN_USAGE_PATH?.trim()
    || path.join(os.homedir(), '.config', 'brain', 'llm-usage.json')
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function numericEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function configuredLimits(): typeof DEFAULT_LIMITS {
  return {
    rpm: numericEnv('BRAIN_GROQ_RPM', DEFAULT_LIMITS.rpm),
    tpm: numericEnv('BRAIN_GROQ_TPM', DEFAULT_LIMITS.tpm),
    rpd: numericEnv('BRAIN_GROQ_RPD', DEFAULT_LIMITS.rpd),
  }
}

function emptyState(): UsageState {
  return { dateUtc: utcDate(), requests: 0, entries: [], blockedUntil: 0, limits: configuredLimits() }
}

async function readState(): Promise<UsageState> {
  try {
    const parsed = JSON.parse(await fs.readFile(getUsagePath(), 'utf8')) as Partial<UsageState>
    const state = { ...emptyState(), ...parsed }
    if (state.dateUtc !== utcDate()) {
      state.dateUtc = utcDate()
      state.requests = 0
      state.entries = []
      state.blockedUntil = 0
    }
    state.entries = state.entries.filter(entry => entry.at >= Date.now() - 60_000)
    state.limits = configuredLimits()
    return state
  } catch {
    return emptyState()
  }
}

async function writeState(state: UsageState): Promise<void> {
  await fs.mkdir(path.dirname(getUsagePath()), { recursive: true })
  await fs.writeFile(getUsagePath(), JSON.stringify(state, null, 2), 'utf8')
}

let stateLock: Promise<void> = Promise.resolve()

async function withState<T>(fn: (state: UsageState) => Promise<T>): Promise<T> {
  const previous = stateLock
  let release!: () => void
  stateLock = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    const state = await readState()
    const result = await fn(state)
    await writeState(state)
    return result
  } finally {
    release()
  }
}

function resetAtFromHeader(value: string | null): number | null {
  if (!value) return null
  const match = value.match(/([\d.]+)\s*([a-z]+)/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const multiplier = unit.startsWith('ms') ? 1 : unit.startsWith('s') ? 1_000 : unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 1
  return Date.now() + amount * multiplier
}

export async function reserveGroqRequest(estimatedTokens: number): Promise<void> {
  if (!hasGroqApiKey()) throw new GroqUnavailableError()

  await withState(async state => {
    const now = Date.now()
    if (state.blockedUntil > now) throw new GroqRateLimitError(state.blockedUntil)

    const minuteTokens = state.entries.reduce((sum, entry) => sum + entry.tokens, 0)
    const safeRpm = Math.max(1, state.limits.rpm - 1)
    const safeTpm = Math.max(1, state.limits.tpm - 250)
    const safeRpd = Math.max(1, state.limits.rpd - 1)
    if (state.entries.length >= safeRpm) {
      throw new GroqRateLimitError(state.entries[0].at + 60_000)
    }
    if (minuteTokens + estimatedTokens > safeTpm) {
      throw new GroqRateLimitError(state.entries[0]?.at + 60_000 || now + 60_000, 'Local token budget reached')
    }
    if (state.requests >= safeRpd) {
      const tomorrow = new Date(`${state.dateUtc}T00:00:00.000Z`).getTime() + 86_400_000
      throw new GroqRateLimitError(tomorrow, 'Local daily request budget reached')
    }

    state.requests += 1
    state.entries.push({ at: now, tokens: estimatedTokens })
  })
}

export async function recordGroqRateLimit(error: unknown): Promise<number | null> {
  const candidate = error as { status?: number; headers?: Headers }
  if (candidate?.status !== 429) return null
  const retryAt = resetAtFromHeader(candidate.headers?.get('retry-after') ?? null)
    ?? resetAtFromHeader(candidate.headers?.get('x-ratelimit-reset-tokens') ?? null)
    ?? Date.now() + 60_000
  await withState(async state => {
    state.blockedUntil = Math.max(state.blockedUntil, retryAt)
  })
  return retryAt
}

export async function getGroqStatus(): Promise<GroqStatus> {
  const state = await readState()
  const minuteTokens = state.entries.reduce((sum, entry) => sum + entry.tokens, 0)
  return {
    configured: hasGroqApiKey(),
    model: getGroqModel(),
    limits: state.limits,
    requestsToday: state.requests,
    requestsRemainingToday: Math.max(0, state.limits.rpd - state.requests),
    requestsRemainingMinute: Math.max(0, state.limits.rpm - state.entries.length),
    tokensRemainingMinute: Math.max(0, state.limits.tpm - minuteTokens),
    blockedUntil: state.blockedUntil > Date.now() ? new Date(state.blockedUntil).toISOString() : null,
  }
}

export function estimateTokens(system: string, user: string, maxTokens: number): number {
  return Math.max(1, Math.ceil((system.length + user.length) / 4) + maxTokens)
}
