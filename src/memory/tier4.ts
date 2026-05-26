import { getDb } from './db.js'

export interface Tier4Pattern {
  repo: string
  patternKey: string
  description: string
  exampleFqns: string[]
  occurrenceCount: number
  firstSeen: number
  lastSeen: number
}

function hashKey(parts: string[]): string {
  const str = parts.sort().join('|')
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return `pat_${Math.abs(h).toString(36)}`
}

export function promoteToTier4(repo: string): void {
  const db = getDb()
  const now = Date.now()
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000

  const episodes = db.prepare(`
    SELECT date, files_touched, symbols_touched FROM tier2_episodes
    WHERE repo = ? AND expires_at > ? ORDER BY date ASC
  `).all(repo, thirtyDaysAgo) as Array<{
    date: string
    files_touched: string
    symbols_touched: string
  }>

  if (episodes.length < 2) {
    console.info(`[brain] tier4: not enough episodes for ${repo}`)
    return
  }

  const patterns: Map<string, Set<string>> = new Map()

  for (const ep of episodes) {
    const files = JSON.parse(ep.files_touched) as string[]
    const symbols = JSON.parse(ep.symbols_touched) as string[]

    if (files.length >= 2) {
      const sortedFiles = files.slice(0, 5).sort()
      const key = hashKey(['cochange', ...sortedFiles])
      if (!patterns.has(key)) patterns.set(key, new Set())
      patterns.get(key)!.add(ep.date)
    }

    const modules = [...new Set(files.map(f => {
      const parts = f.split('/')
      return parts[1] || parts[0]
    }).filter(m => m && m !== 'src' && m !== 'lib'))]

    if (modules.length >= 2) {
      const key = hashKey(['multi-module', ...modules.sort()])
      if (!patterns.has(key)) patterns.set(key, new Set())
      patterns.get(key)!.add(ep.date)
    }
  }

  const recentEpisodes = episodes.slice(-7)
  const recentFiles = new Set<string>()
  const recentSymbols = new Set<string>()

  for (const ep of recentEpisodes) {
    for (const f of JSON.parse(ep.files_touched) as string[]) recentFiles.add(f)
    for (const s of JSON.parse(ep.symbols_touched) as string[]) recentSymbols.add(s)
  }

  if (recentFiles.size >= 3) {
    const key = hashKey(['active-area', ...Array.from(recentFiles).slice(0, 3)])
    if (!patterns.has(key)) patterns.set(key, new Set())
    patterns.get(key)!.add('recent')
  }

  const insert = db.prepare(`
    INSERT INTO tier4_patterns (repo, pattern_key, description, example_fqns, occurrence_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, pattern_key) DO UPDATE SET
      occurrence_count = occurrence_count + 1,
      last_seen = excluded.last_seen,
      example_fqns = excluded.example_fqns
  `)

  const upsert = db.transaction((pats: Tier4Pattern[]) => {
    for (const p of pats) {
      insert.run(
        p.repo, p.patternKey, p.description,
        JSON.stringify(p.exampleFqns), p.occurrenceCount,
        p.firstSeen, p.lastSeen
      )
    }
  })

  const newPatterns: Tier4Pattern[] = []
  for (const [key, dates] of patterns) {
    if (dates.size >= 2) {
      const exampleFiles = Array.from(recentFiles).slice(0, 5)
      let description = ''

      if (key.startsWith('pat_')) {
        const hash = key.slice(4)
        if (hash.charCodeAt(0) % 3 === 0) {
          description = 'Files frequently modified together'
        } else if (hash.charCodeAt(0) % 3 === 1) {
          description = 'Multi-module change pattern'
        } else {
          description = 'Active development area'
        }
      }

      newPatterns.push({
        repo,
        patternKey: key,
        description,
        exampleFqns: exampleFiles,
        occurrenceCount: dates.size,
        firstSeen: now - 30 * 24 * 60 * 60 * 1000,
        lastSeen: now,
      })
    }
  }

  if (newPatterns.length > 0) {
    upsert(newPatterns)
    console.info(`[brain] tier4: promoted ${newPatterns.length} patterns for ${repo}`)
  } else {
    console.info(`[brain] tier4: no patterns detected for ${repo}`)
  }
}

export function getTier4Patterns(repo: string): Tier4Pattern[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT pattern_key, description, example_fqns, occurrence_count, first_seen, last_seen
    FROM tier4_patterns WHERE repo = ? ORDER BY occurrence_count DESC
  `).all(repo) as Array<{
    pattern_key: string
    description: string
    example_fqns: string
    occurrence_count: number
    first_seen: number
    last_seen: number
  }>

  return rows.map(r => ({
    repo,
    patternKey: r.pattern_key,
    description: r.description,
    exampleFqns: JSON.parse(r.example_fqns),
    occurrenceCount: r.occurrence_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }))
}