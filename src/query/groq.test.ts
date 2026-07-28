import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getGroqStatus, hasGroqApiKey, reserveGroqRequest, GroqUnavailableError } from './groq.js'

const oldKey = process.env.GROQ_API_KEY
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-groq-'))
const oldUsagePath = process.env.BRAIN_USAGE_PATH

try {
  process.env.BRAIN_USAGE_PATH = path.join(tmpDir, 'llm-usage.json')
  delete process.env.GROQ_API_KEY
  assert.equal(hasGroqApiKey(), false)
  await assert.rejects(reserveGroqRequest(100), GroqUnavailableError)

  process.env.GROQ_API_KEY = 'gsk_test_key'
  await reserveGroqRequest(100)
  const status = await getGroqStatus()
  assert.equal(status.configured, true)
  assert.equal(status.requestsToday, 1)
  assert.equal(status.requestsRemainingMinute, 29)
} finally {
  if (oldKey === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = oldKey
  if (oldUsagePath === undefined) delete process.env.BRAIN_USAGE_PATH
  else process.env.BRAIN_USAGE_PATH = oldUsagePath
  await fs.rm(tmpDir, { recursive: true, force: true })
}
