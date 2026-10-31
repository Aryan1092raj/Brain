import assert from 'node:assert/strict'
import { getValidatedCommitSha } from './commit-sha.js'
import { processPushEvent } from './pipeline.js'
import type { RepoConfig } from '../config/schema.js'

const validSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

assert.equal(
  getValidatedCommitSha({ head_commit: { id: validSha } }, false),
  validSha,
)

assert.equal(
  getValidatedCommitSha({
    pull_request: { head: { sha: validSha } },
  }, true),
  validSha,
)

assert.equal(getValidatedCommitSha({ head_commit: null }, false), null)
assert.equal(getValidatedCommitSha({}, false), null)
assert.equal(getValidatedCommitSha({ head_commit: { id: 123 } }, false), null)

assert.equal(
  getValidatedCommitSha({
    head_commit: { id: 'not-a-valid-sha' },
  }, false),
  null,
)

assert.equal(
  getValidatedCommitSha({
    pull_request: { head: {} },
  }, true),
  null,
)

assert.equal(
  getValidatedCommitSha({
    head_commit: { id: 'g'.repeat(40) },
  }, false),
  null,
)

// Verify branch deletion is skipped.
const repo = { name: 'test-repo' } as RepoConfig
const originalInfo = console.info
const messages: string[] = []

console.info = (...args: unknown[]) => {
  messages.push(args.join(' '))
}

try {
  await processPushEvent(repo, {
    deleted: true,
    head_commit: null,
    after: '0000000000000000000000000000000000000000',
  })
} finally {
  console.info = originalInfo
}

assert.equal(messages.length, 1)
assert.ok(messages[0].includes('skipping branch deletion event'))

console.log('Commit SHA validation and branch deletion tests passed')
