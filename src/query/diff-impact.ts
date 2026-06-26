import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getKuzuClient } from '../graph/client.js'
import { computeRippleImpact, ImpactedSymbol } from './ripple.js'

const exec = promisify(execFile)

export interface LocalDiff {
  filePath: string
  lines: number[]
}

export interface SymbolImpact {
  symbolFqn: string
  kind: string
  lineStart: number
  lineEnd: number
  ripple: ImpactedSymbol[]
}

export interface FileImpact {
  filePath: string
  symbols: SymbolImpact[]
}

export async function parseLocalDiff(cwd: string): Promise<LocalDiff[]> {
  try {
    const { stdout } = await exec('git', ['diff', '-U0'], { cwd })
    return parseGitDiffOutput(stdout)
  } catch (err) {
    return []
  }
}

export function parseGitDiffOutput(stdout: string): LocalDiff[] {
  const diffs: LocalDiff[] = []
  let currentFile: string | null = null
  let currentLines: number[] = []

  const lines = stdout.split('\n')
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentFile && currentLines.length > 0) {
        diffs.push({ filePath: currentFile, lines: currentLines })
      }
      currentFile = null
      currentLines = []
      const parts = line.split(' ')
      const bPath = parts[parts.length - 1]
      if (bPath && bPath.startsWith('b/')) {
        currentFile = bPath.slice(2)
      }
    } else if (line.startsWith('@@ ')) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/)
      if (match) {
        const start = parseInt(match[1], 10)
        const count = match[2] ? parseInt(match[2], 10) : 1
        const actualCount = count === 0 ? 1 : count
        for (let i = 0; i < actualCount; i++) {
          currentLines.push(start + i)
        }
      }
    }
  }

  if (currentFile && currentLines.length > 0) {
    diffs.push({ filePath: currentFile, lines: currentLines })
  }

  return diffs
}

export async function computeLocalDiffImpact(cwd: string, repo: string): Promise<FileImpact[]> {
  const localDiffs = await parseLocalDiff(cwd)
  const db = getKuzuClient()
  const fileImpacts: FileImpact[] = []

  for (const diff of localDiffs) {
    const query = `
      MATCH (s:Symbol {file: $file, repo: $repo})
      RETURN s.fqn AS fqn, s.kind AS kind, s.line_start AS line_start, s.line_end AS line_end
    `
    let fileSymbols: Array<{ fqn: string; kind: string; line_start: number; line_end: number }> = []
    try {
      fileSymbols = await db.query<{
        fqn: string
        kind: string
        line_start: number
        line_end: number
      }>(query, { file: diff.filePath, repo })
    } catch {
      continue
    }

    const matchedSymbols: SymbolImpact[] = []

    for (const sym of fileSymbols) {
      const isModified = diff.lines.some(l => l >= sym.line_start && l <= sym.line_end)
      if (isModified) {
        const ripple = await computeRippleImpact(sym.fqn)
        matchedSymbols.push({
          symbolFqn: sym.fqn,
          kind: sym.kind,
          lineStart: sym.line_start,
          lineEnd: sym.line_end,
          ripple
        })
      }
    }

    if (matchedSymbols.length > 0) {
      fileImpacts.push({
        filePath: diff.filePath,
        symbols: matchedSymbols
      })
    }
  }

  return fileImpacts
}
