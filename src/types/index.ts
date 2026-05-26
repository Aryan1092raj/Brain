export type Language =
  | 'typescript' | 'javascript' | 'python' | 'rust' | 'go'
  | 'java' | 'cpp' | 'c' | 'ruby' | 'php' | 'swift' | 'kotlin' | 'cs'

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'import'

export interface GraphSymbol {
  fqn: string
  name: string
  kind: SymbolKind
  file: string
  lineStart: number
  lineEnd: number
  repo: string
  isExported: boolean
  decayScore: number
  velocity: number
  lastTouched: Date
}

export interface GraphFile {
  path: string
  repo: string
  language: Language
  lineCount: number
  decayScore: number
  lastTouched: Date
}

export interface MemoryEvent {
  tier: 1 | 2 | 3 | 4
  repo: string
  content: string
  createdAt: Date
  expiresAt: Date | null
}

export interface DecayCycleResult {
  repo: string
  nodesRescored: number
  minScore: number
  maxScore: number
  avgScore: number
  durationMs: number
}

export interface PipelineResult {
  repo: string
  commitSha: string
  durationMs: number
  filesProcessed: number
  nodesUpserted: number
  edgesUpserted: number
  hotZonesDetected: number
  alertsSent: number
}