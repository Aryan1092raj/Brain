
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadEnv } from './env.js'

const originalCwd = process.cwd()
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-env-test-'))
const keys = [
  'BRAIN_TEST_NORMAL',
  'BRAIN_TEST_HASH',
  'BRAIN_TEST_QUOTED',
]

const originalValues = new Map(
  keys.map(key => [key, process.env[key]]),
)

try {
  await fs.writeFile(
    path.join(tempDir, '.env'),
    [
      '',
      '# full-line comment',
      'BRAIN_TEST_NORMAL=hello',
      'BRAIN_TEST_HASH=abc#123',
      'BRAIN_TEST_QUOTED="hello world" # trailing comment',
      '',
    ].join('\n'),
  )

  for (const key of keys) delete process.env[key]

  process.chdir(tempDir)
  await loadEnv()

  assert.equal(process.env.BRAIN_TEST_NORMAL, 'hello')
  assert.equal(process.env.BRAIN_TEST_HASH, 'abc#123')
  assert.equal(process.env.BRAIN_TEST_QUOTED, 'hello world')
} finally {
  process.chdir(originalCwd)

  for (const key of keys) {
    const value = originalValues.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  await fs.rm(tempDir, { recursive: true, force: true })
}
