import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { getSkeletonCode } from './tree-sitter.js'

const exec = promisify(execFile)

const SECRET_PATTERNS = [
  /gsk_[a-zA-Z0-9]{48}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /xox[bapr]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{32}/g,
  /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g,
  /AIzaSy[a-zA-Z0-9_-]{33}/g,
  /sk-[a-zA-Z0-9]{48}/g
]

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.brain', 'dist', 'target', 'build', '.next', '.cache', '__pycache__', 'venv', '.env'
])

export const DEFAULT_IGNORE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'eot', 'ttf', 'mp4', 'mp3', 'wav', 'db', 'sqlite', 'kuzu', 'svg',
  'pem', 'key', 'pfx', 'crt', 'der', 'cer'
])

export const DEFAULT_IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock',
  '.env', '.env.local', '.env.development', '.env.test', '.env.production',
  '.env.development.local', '.env.test.local', '.env.production.local',
  '.npmrc', 'secrets.json', 'secrets.yaml', 'secrets.yml'
])

export function redactSecrets(content: string): string {
  let redacted = content
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED SECRET]')
  }
  return redacted
}

export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${regexStr}$`, 'i')
}

export function shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0) return false
  return ignorePatterns.some(pat => {
    const trimmed = pat.trim()
    if (!trimmed) return false
    try {
      const regex = globToRegex(trimmed)
      if (trimmed.includes('/')) {
        return regex.test(relativePath) || regex.test(relativePath + '/')
      } else {
        const base = path.basename(relativePath)
        return regex.test(base)
      }
    } catch {
      return false
    }
  })
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function downloadAndExtractRepo(owner: string, repo: string, brainDir: string): Promise<string> {
  const tmpDir = path.join(brainDir, 'tmp')
  await fs.mkdir(tmpDir, { recursive: true })

  const zipPath = path.join(tmpDir, `${owner}-${repo}.zip`)
  const extractDir = path.join(tmpDir, `${owner}-${repo}-extracted`)

  await fs.rm(extractDir, { recursive: true, force: true })
  await fs.rm(zipPath, { force: true })

  let downloadUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`
  let response = await fetch(downloadUrl)
  if (!response.ok) {
    downloadUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`
    response = await fetch(downloadUrl)
  }

  if (!response.ok) {
    throw new Error(`Failed to download repository ${owner}/${repo}: ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  await fs.writeFile(zipPath, Buffer.from(arrayBuffer))

  await fs.mkdir(extractDir, { recursive: true })
  await exec('unzip', ['-q', zipPath, '-d', extractDir])
  await fs.rm(zipPath, { force: true })

  const dirs = await fs.readdir(extractDir)
  const rootDir = dirs.find(d => !d.startsWith('.'))
  if (!rootDir) {
    throw new Error('No root folder found in extracted zip')
  }

  return path.join(extractDir, rootDir)
}

export function fileLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const mapping: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python'
  }
  return mapping[ext] ?? ''
}

export async function generateRepoDigest(
  rootDir: string,
  opts?: { maxSize?: number; compress?: boolean; ignorePatterns?: string[] }
): Promise<{ tree: string; files: Array<{ path: string; content: string; size: number }> }> {
  const maxSize = opts?.maxSize ?? 60000
  const compress = opts?.compress ?? false
  const ignorePatterns = opts?.ignorePatterns ?? []

  const IGNORE_DIRS = DEFAULT_IGNORE_DIRS
  const IGNORE_EXTS = DEFAULT_IGNORE_EXTS
  const IGNORE_FILES = DEFAULT_IGNORE_FILES

  const fileList: Array<{ path: string; content: string; size: number }> = []

  async function walk(dir: string, currentPrefix: string): Promise<string> {
    let treeStr = ''
    const entries = await fs.readdir(dir, { withFileTypes: true })

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const isLast = i === entries.length - 1
      const marker = isLast ? '└── ' : '├── '
      const childPrefix = isLast ? '    ' : '│   '

      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootDir, fullPath)

      if (shouldIgnorePath(relativePath, ignorePatterns)) {
        continue
      }

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        treeStr += `${currentPrefix}${marker}${entry.name}/\n`
        treeStr += await walk(fullPath, `${currentPrefix}${childPrefix}`)
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
        if (IGNORE_FILES.has(entry.name) || IGNORE_EXTS.has(ext)) continue

        try {
          const stat = await fs.stat(fullPath)
          if (stat.size > maxSize) {
            treeStr += `${currentPrefix}${marker}${entry.name} (skipped: too large)\n`
            continue
          }

          treeStr += `${currentPrefix}${marker}${entry.name}\n`

          let content = await fs.readFile(fullPath, 'utf-8')
          content = redactSecrets(content)

          if (compress) {
            const lang = fileLanguage(entry.name)
            if (lang) {
              content = getSkeletonCode(content, lang)
            }
          }

          fileList.push({ path: relativePath, content, size: stat.size })
        } catch {
          // Skip
        }
      }
    }
    return treeStr
  }

  const tree = await walk(rootDir, '')
  return { tree, files: fileList }
}

export interface TreeNode {
  name: string
  type: 'file' | 'directory'
  path?: string
  size?: number
  children?: TreeNode[]
}

export async function buildDirectoryTree(rootDir: string, dir = rootDir, ignorePatterns: string[] = []): Promise<TreeNode[]> {
  const IGNORE_DIRS = DEFAULT_IGNORE_DIRS
  const IGNORE_EXTS = DEFAULT_IGNORE_EXTS
  const IGNORE_FILES = DEFAULT_IGNORE_FILES

  const result: TreeNode[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(rootDir, fullPath)

    if (shouldIgnorePath(relativePath, ignorePatterns)) {
      continue
    }

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const children = await buildDirectoryTree(rootDir, fullPath, ignorePatterns)
      if (children.length > 0) {
        result.push({ name: entry.name, type: 'directory', children })
      }
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
      if (IGNORE_FILES.has(entry.name) || IGNORE_EXTS.has(ext)) continue
      try {
        const stat = await fs.stat(fullPath)
        result.push({ name: entry.name, type: 'file', path: relativePath, size: stat.size })
      } catch {
        // Skip
      }
    }
  }
  return result
}

export function verifyHmac(signature: string, body: Buffer, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}
