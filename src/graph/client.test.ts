
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeKuzu, getKuzuClient, initKuzu } from './client.js'

const tmpDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'brain-kuzu-lifecycle-'),
)

try {
  // Repeatedly open, query, and close the database.
  for (let i = 1; i <= 5; i++) {
    initKuzu(tmpDir)

    const client = getKuzuClient()
    const rows = await client.query<{ value: number }>(
      `RETURN ${i} AS value`,
    )

    assert.equal(Number(rows[0]?.value), i)

    await closeKuzu()
  }

  // Check that queued queries finish before shutdown.
  initKuzu(tmpDir)

  const client = getKuzuClient()

  const firstQuery = client.query<{ value: number }>(
    'RETURN 10 AS value',
  )

  const secondQuery = client.query<{ value: number }>(
    'RETURN 20 AS value',
  )

  const closing = closeKuzu()

  // New queries must be rejected once shutdown begins.
  await assert.rejects(
    client.query('RETURN 30 AS value'),
    /shutting down/,
  )

  const [firstRows, secondRows] = await Promise.all([
    firstQuery,
    secondQuery,
  ])

  assert.equal(Number(firstRows[0]?.value), 10)
  assert.equal(Number(secondRows[0]?.value), 20)

  await closing
} finally {
  await closeKuzu()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
