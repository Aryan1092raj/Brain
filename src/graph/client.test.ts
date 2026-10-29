
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeKuzu, getKuzuClient, initKuzu } from './client.js'

const tmpDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'brain-kuzu-lifecycle-'),
)

try {
  // Open the database and run a query.
  initKuzu(tmpDir)

  const firstRows = await getKuzuClient().query<{ value: number }>(
    'RETURN 1 AS value',
  )

  assert.equal(Number(firstRows[0]?.value), 1)

  // Close the database completely.
  await closeKuzu()

  // Reopen the same database path and run another query.
  initKuzu(tmpDir)

  const secondRows = await getKuzuClient().query<{ value: number }>(
    'RETURN 2 AS value',
  )

  assert.equal(Number(secondRows[0]?.value), 2)
} finally {
  await closeKuzu()
  await fs.rm(tmpDir, { recursive: true, force: true })
}
