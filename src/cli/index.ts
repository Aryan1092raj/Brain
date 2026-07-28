#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { getBrainDir } from '../config/paths.js'

// Load .env file
async function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')
  try {
    const content = await fs.readFile(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match && match[1] && match[2] && !process.env[match[1].trim()]) {
        process.env[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '')
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
import { scan } from './scan.js'
import { diffImpactCommand } from './diff-impact.js'

const cmd = process.argv[2]
const cwd = process.cwd()
process.env.BRAIN_DIR = getBrainDir(cwd)

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
  queryCommand(cwd, question, process.env.BRAIN_REPO).catch(err => {
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
} else if (cmd === 'scan') {
  scan(cwd, process.argv.slice(3)).catch(err => {
    console.error('[brain] scan failed:', err)
    process.exit(1)
  })
} else if (cmd === 'diff-impact') {
  diffImpactCommand(cwd, process.argv.slice(3)).catch(err => {
    console.error('[brain] diff-impact failed:', err)
    process.exit(1)
  })
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.info('Usage: brain [init|watch|scan|status|query|ask|mcp|diff-impact]')
  console.info('Run "brain init" once in each project. It creates .brain/ and indexes the codebase.')
} else {
  console.info('Usage: brain [init|watch|scan|status|query|ask|mcp|diff-impact]')
  console.info('Run "brain init" once in each project. It creates .brain/ and indexes the codebase.')
  process.exit(1)
}
