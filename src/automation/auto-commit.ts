import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)

export async function commitAgentsMd(repoPath: string, commitSha: string): Promise<void> {
  const agentsPath = path.join(repoPath, 'AGENTS.md')

  try {
    await exec('git', ['-C', repoPath, 'add', 'AGENTS.md'])

    const { stdout } = await exec('git', ['-C', repoPath, 'status', '--porcelain', 'AGENTS.md'])
    if (!stdout.trim()) {
      console.info('[brain/auto-commit] AGENTS.md unchanged, skip')
      return
    }

    await exec('git', ['-C', repoPath, 'commit', '-m',
      `[brain] update AGENTS.md for ${commitSha.slice(0, 7)} [skip ci]`])

    await exec('git', ['-C', repoPath, 'push'])
    console.info('[brain/auto-commit] pushed AGENTS.md')
  } catch (err) {
    console.warn('[brain/auto-commit] git push failed (check token + remote):', err)
  }
}
