import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildDirectoryTree, generateRepoDigest, isGitignored } from './helpers.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-gitignore-test-'))

try {
  await fs.mkdir(path.join(root, 'graphify-out'), { recursive: true })
  await fs.mkdir(path.join(root, 'src', 'config'), { recursive: true })
  await fs.writeFile(path.join(root, '.gitignore'), [
    'graphify-out/',
    '*.log',
    '!keep.log',
    'src/config/*',
    '!src/config/example.ts',
  ].join('\n'))
  await fs.writeFile(path.join(root, 'main.ts'), 'export const main = true\n')
  await fs.writeFile(path.join(root, 'graphify-out', 'bundle.ts'), 'generated\n')
  await fs.writeFile(path.join(root, 'debug.log'), 'debug\n')
  await fs.writeFile(path.join(root, 'keep.log'), 'keep\n')
  await fs.writeFile(path.join(root, 'src', 'config', 'secret.ts'), 'secret\n')
  await fs.writeFile(path.join(root, 'src', 'config', 'example.ts'), 'example\n')

  assert.equal(isGitignored('graphify-out/bundle.ts', await fs.readFile(path.join(root, '.gitignore'), 'utf8')), true)
  assert.equal(isGitignored('keep.log', await fs.readFile(path.join(root, '.gitignore'), 'utf8')), false)

  const digest = await generateRepoDigest(root)
  const files = new Map(digest.files.map(file => [file.path, file]))
  assert.equal(files.get('main.ts')?.ignoredByGitignore, false)
  assert.equal(files.get('graphify-out/bundle.ts')?.ignoredByGitignore, true)
  assert.equal(files.get('debug.log')?.ignoredByGitignore, true)
  assert.equal(files.get('keep.log')?.ignoredByGitignore, false)
  assert.equal(files.get('src/config/secret.ts')?.ignoredByGitignore, true)
  assert.equal(files.get('src/config/example.ts')?.ignoredByGitignore, false)

  const tree = await buildDirectoryTree(root)
  const generated = tree.find(node => node.name === 'graphify-out')?.children?.[0]
  assert.equal(generated?.ignoredByGitignore, true)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
