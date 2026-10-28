import assert from 'node:assert/strict'
import { getValidatedCommitSha } from './commit-sha.js'

const validSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

assert.equal(
  getValidatedCommitSha({ head_commit: { id: validSha } }),
  validSha,
)

assert.equal(
  getValidatedCommitSha({
    pull_request: { head: { sha: validSha } },
  }),
  validSha,
)

assert.equal(getValidatedCommitSha({ head_commit: null }), null)
assert.equal(getValidatedCommitSha({}), null)
assert.equal(getValidatedCommitSha({ head_commit: { id: 123 } }), null)

assert.equal(
  getValidatedCommitSha({
    head_commit: { id: 'not-a-valid-sha' },
  }),
  null,
)

assert.equal(
  getValidatedCommitSha({
    pull_request: { head: {} },
  }),
  null,
)

assert.equal(
  getValidatedCommitSha({
    head_commit: { id: 'g'.repeat(40) },
  }),
  null,
)

console.log('Commit SHA validation tests passed')
