import test from 'node:test'
import assert from 'node:assert/strict'
import { retryAsync } from './retryAsync.js'

test('retries a transient failure and returns the successful result', async () => {
  let calls = 0
  const result = await retryAsync(async () => {
    calls += 1
    if (calls < 3) throw new Error('connection closed')
    return 'ok'
  }, { attempts: 3 })

  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('stops after the configured number of failed attempts', async () => {
  let calls = 0
  await assert.rejects(
    retryAsync(async () => {
      calls += 1
      throw new Error('offline')
    }, { attempts: 2 }),
    /offline/,
  )
  assert.equal(calls, 2)
})
