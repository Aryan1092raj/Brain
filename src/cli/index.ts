#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

// Load .env file
async function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')
  try {
    const content = await fs.readFile(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match && match[1] && match[2]) {
        process.env[match[1].trim()] = match[2].trim()
      }
    }
    console.info('[brain] loaded .env')
  } catch {
    // .env is optional
  }
}

await loadEnv()

import { init } from './init.js'
import { watch } from './watch.js'
import { ask } from './ask.js'
import { mcp } from './mcp.js'
import { status } from './status.js'
import { queryCommand } from './query.js'

const cmd = process.argv[2]
const cwd = process.cwd()

if (cmd === 'init') {
  init(cwd).catch(err => {
    console.error('[brain] init failed:', err)
    process.exit(1)
  })
} else if (cmd === 'watch') {
  watch(cwd).catch(err => {
    console.error('[brain] watch failed:', err)
    process.exit(1)
  })
} else if (cmd === 'query') {
  const question = process.argv.slice(3).join(' ')
  const repo = process.env.BRAIN_REPO || 'default'
  queryCommand(question, repo).catch(err => {
    console.error('[brain] query failed:', err)
    process.exit(1)
  })
} else if (cmd === 'ask') {
  ask(cwd, process.argv.slice(3)).catch(err => {
    console.error('[brain] ask failed:', err)
    process.exit(1)
  })
} else if (cmd === 'mcp') {
  mcp(cwd, process.argv.slice(3)).catch(err => {
    console.error('[brain] mcp failed:', err)
    process.exit(1)
  })
} else if (cmd === 'status') {
  status(cwd, process.argv.slice(3)).catch(err => {
    console.error('[brain] status failed:', err)
    process.exit(1)
  })
} else {
  console.info('Usage: brain [init|watch|status|query|ask|mcp]')
  process.exit(1)
}//test
//test
//test
//test
