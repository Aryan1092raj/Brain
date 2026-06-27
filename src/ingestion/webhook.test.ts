import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyHmac } from './helpers.js'

const body = Buffer.from(JSON.stringify({ ok: true }))
const secret = 'test-secret'
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

assert.equal(verifyHmac(signature, body, secret), true)
assert.equal(verifyHmac('sha256=bad', body, secret), false)
