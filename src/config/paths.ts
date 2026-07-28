import path from 'node:path'

/** Brain's databases and settings are always local to the indexed project. */
export function getBrainDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.brain')
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(getBrainDir(cwd), 'config.json')
}

export function getLegacyConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), 'brain.config.json')
}
