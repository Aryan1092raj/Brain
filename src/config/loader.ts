import fs from 'node:fs/promises'
import path from 'node:path'
import { ConfigSchema, type Config, type RepoConfig } from './schema.js'

let _config: Config | null = null

export async function loadConfig(cwd: string): Promise<Config> {
  const configPath = path.join(cwd, 'brain.config.json')
  const content = await fs.readFile(configPath, 'utf-8')
  const parsed = JSON.parse(content)
  _config = ConfigSchema.parse(parsed)
  return _config
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded — call loadConfig first')
  return _config
}

export function getRepoConfig(name: string): RepoConfig {
  const config = getConfig()
  const repo = config.repos.find(r => r.name === name)
  if (!repo) throw new Error(`Repo ${name} not found in config`)
  return repo
}

export function getLanguageForFile(filePath: string, languages: string[]): string {
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
  const ext = filePath.split('.').pop() ?? ''
  return extMap[ext] ?? ''
}