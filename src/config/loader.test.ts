import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from './loader.js'

const oldPort = process.env.BRAIN_PORT
const oldLogLevel = process.env.BRAIN_LOG_LEVEL
const oldSlack = process.env.SLACK_WEBHOOK_URL
const oldDiscord = process.env.DISCORD_WEBHOOK_URL

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-config-'))

try {
  await fs.writeFile(path.join(dir, 'brain.config.json'), JSON.stringify({
    repos: [{
      name: 'repo',
      path: dir,
      remote: '',
      webhookSecret: 'secret',
      languages: ['typescript'],
      branch: 'main',
    }],
    port: 3747,
    logLevel: 'info',
  }))

  process.env.BRAIN_PORT = '4123'
  process.env.BRAIN_LOG_LEVEL = 'debug'
  process.env.SLACK_WEBHOOK_URL = 'https://example.com/slack'
  process.env.DISCORD_WEBHOOK_URL = 'https://example.com/discord'

  const config = await loadConfig(dir)
  assert.equal(config.port, 4123)
  assert.equal(config.logLevel, 'debug')
  assert.equal(config.slackWebhook, 'https://example.com/slack')
  assert.equal(config.discordWebhook, 'https://example.com/discord')
} finally {
  if (oldPort === undefined) delete process.env.BRAIN_PORT
  else process.env.BRAIN_PORT = oldPort
  if (oldLogLevel === undefined) delete process.env.BRAIN_LOG_LEVEL
  else process.env.BRAIN_LOG_LEVEL = oldLogLevel
  if (oldSlack === undefined) delete process.env.SLACK_WEBHOOK_URL
  else process.env.SLACK_WEBHOOK_URL = oldSlack
  if (oldDiscord === undefined) delete process.env.DISCORD_WEBHOOK_URL
  else process.env.DISCORD_WEBHOOK_URL = oldDiscord
  await fs.rm(dir, { recursive: true, force: true })
}
