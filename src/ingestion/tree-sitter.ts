import Parser from 'tree-sitter'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TS: any
try {
  const mod = await import('tree-sitter-typescript')
  TS = mod.default?.typescript ?? mod.typescript ?? mod.default ?? mod
} catch (err) {
  console.warn('[brain] tree-sitter-typescript unavailable, TS/TSX parsing disabled')
  TS = null
}
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import fs from 'node:fs/promises'
import type { FileChange } from './diff-parser.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Language = any

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'import'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  lineStart: number
  lineEnd: number
  isExported: boolean
  calls: string[]
}

export interface SymbolDelta {
  file: string
  language: string
  added: ExtractedSymbol[]
  removed: ExtractedSymbol[]
  modified: ExtractedSymbol[]
  importsAdded: string[]
  importsRemoved: string[]
}

const PARSERS: Map<string, Parser> = new Map()

const SUPPORTED_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'python'])

function getParser(language: string): Parser | undefined {
  if (PARSERS.has(language)) return PARSERS.get(language)!
  if (!SUPPORTED_LANGUAGES.has(language)) {
    console.warn(`[brain] unsupported language: ${language} — skipping symbol extraction`)
    return undefined
  }
  if ((language === 'typescript' || language === 'tsx') && !TS) {
    console.warn(`[brain] ${language} parser unavailable`)
    return undefined
  }
  const p = new Parser()
  if (language === 'typescript' || language === 'tsx') p.setLanguage(TS as Language)
  else if (language === 'javascript') p.setLanguage(JavaScript as Language)
  else if (language === 'python') p.setLanguage(Python as Language)
  PARSERS.set(language, p)
  return p
}

export async function extractSymbolDelta(
  change: FileChange,
  language: string,
  repoPath: string,
): Promise<SymbolDelta> {
  const filePath = `${repoPath}/${change.path}`

  if (change.status === 'removed') {
    return { file: change.path, language, added: [], removed: [], modified: [], importsAdded: [], importsRemoved: [] }
  }

  const parser = getParser(language)
  if (!parser) {
    return emptyDelta(change.path, language)
  }

  let source: string
  try {
    source = await fs.readFile(filePath, 'utf-8')
  } catch {
    return emptyDelta(change.path, language)
  }

  const tree = parser.parse(source)
  const symbols = walkTree(tree.rootNode, source, language)

  return {
    file: change.path,
    language,
    added: symbols.symbols,
    removed: [],
    modified: [],
    importsAdded: symbols.imports,
    importsRemoved: [],
  }
}

interface WalkResult {
  symbols: ExtractedSymbol[]
  imports: string[]
}

function walkTree(node: Parser.SyntaxNode, source: string, _language: string): WalkResult {
  const symbols: ExtractedSymbol[] = []
  const imports: string[] = []

  function walk(n: Parser.SyntaxNode) {
    switch (n.type) {
      case 'function_declaration':
      case 'function_definition':
      case 'method_definition': {
        const nameNode = n.childForFieldName('name')
        const name = nameNode?.text ?? '<anonymous>'
        symbols.push({ name, kind: 'function', lineStart: n.startPosition.row + 1, lineEnd: n.endPosition.row + 1, isExported: hasExportModifier(n), calls: extractCalls(n) })
        break
      }
      case 'class_declaration':
      case 'class_definition': {
        const nameNode = n.childForFieldName('name')
        const name = nameNode?.text ?? '<anonymous>'
        symbols.push({ name, kind: 'class', lineStart: n.startPosition.row + 1, lineEnd: n.endPosition.row + 1, isExported: hasExportModifier(n), calls: [] })
        break
      }
      case 'interface_declaration': {
        const nameNode = n.childForFieldName('name')
        const name = nameNode?.text ?? '<anonymous>'
        symbols.push({ name, kind: 'interface', lineStart: n.startPosition.row + 1, lineEnd: n.endPosition.row + 1, isExported: hasExportModifier(n), calls: [] })
        break
      }
      case 'import_statement':
      case 'import_from_statement': {
        const src = extractImportSource(n)
        if (src) imports.push(src)
        break
      }
    }
    for (const child of n.children) walk(child)
  }

  walk(node)
  return { symbols, imports }
}

function hasExportModifier(node: Parser.SyntaxNode): boolean {
  if (node.children.some(c => c.type === 'export' || c.text === 'export')) {
    return true
  }
  let p = node.parent
  while (p) {
    if (p.type === 'export_statement') return true
    if (p.type === 'statement_block' || p.type === 'program') break
    p = p.parent
  }
  return false
}

function extractCalls(node: Parser.SyntaxNode): string[] {
  const calls: string[] = []
  function walk(n: Parser.SyntaxNode) {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function')
      if (fn?.text) calls.push(fn.text.split('.').pop() ?? fn.text)
    }
    for (const c of n.children) walk(c)
  }
  walk(node)
  return [...new Set(calls)]
}

function extractImportSource(node: Parser.SyntaxNode): string | null {
  for (const c of node.children) {
    if (c.type === 'string' || c.type === 'string_literal') return c.text.replace(/['"]/g, '')
  }
  return null
}

function emptyDelta(file: string, language: string): SymbolDelta {
  return { file, language, added: [], removed: [], modified: [], importsAdded: [], importsRemoved: [] }
}