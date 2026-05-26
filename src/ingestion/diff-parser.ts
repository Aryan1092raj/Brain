import { Octokit } from '@octokit/rest'
import type { RepoConfig } from '../config/schema.js'

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  previousPath?: string
  additions: number
  deletions: number
  patch: string | null
  rawUrl: string
}

export async function parseDiff(
  repo: RepoConfig,
  payload: Record<string, unknown>,
): Promise<FileChange[]> {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
  const match = repo.remote.replace('https://github.com/', '').split('/')
  const owner = match[0]
  const repoName = match[1]

  const commitSha = (payload.head_commit as { id: string }).id

  const { data: commit } = await octokit.repos.getCommit({
    owner,
    repo: repoName,
    ref: commitSha,
  })

  const changes: FileChange[] = (commit.files ?? []).map(f => ({
    path: f.filename,
    status: f.status as FileChange['status'],
    previousPath: f.previous_filename,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
    rawUrl: f.raw_url,
  }))

  return changes.filter(f => isSourceFile(f.path, repo.languages))
}

function isSourceFile(path: string, languages: string[]): boolean {
  const extMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    c: 'c', h: 'c',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    cs: 'cs',
  }
  const ext = path.split('.').pop() ?? ''
  return languages.includes(extMap[ext] ?? '')
}