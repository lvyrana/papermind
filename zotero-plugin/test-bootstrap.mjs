import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const prefs = new Map()
const sandbox = {
  Components: {},
  Services: { prompt: {} },
  Zotero: {
    Prefs: {
      get(key) {
        return prefs.get(key)
      },
      set(key, value) {
        prefs.set(key, value)
      },
    },
    debug() {},
    getMainWindows() {
      return []
    },
  },
  URL,
  encodeURIComponent,
}

vm.createContext(sandbox)
vm.runInContext(
  fs.readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8'),
  sandbox,
)

const PaperMind = sandbox.PaperMind
const validUid = '123e4567-e89b-42d3-a456-426614174000'
const win = {
  URL,
  TextEncoder,
  btoa(value) {
    return Buffer.from(value, 'binary').toString('base64')
  },
}

test('parses the personal link into origin and UUID v4', () => {
  assert.deepEqual(
    { ...PaperMind.parsePersonalLink(win, `https://papermindapp.com/?uid=${validUid}`) },
    { base: 'https://papermindapp.com', uid: validUid },
  )
})

test('rejects a link without a valid UUID v4', () => {
  assert.throws(
    () => PaperMind.parsePersonalLink(win, 'https://papermindapp.com/?uid=123'),
    /设备 ID/,
  )
})

test('adds Basic Auth and the device header after configuration', () => {
  prefs.set(PaperMind.PREF_BASE, 'https://papermindapp.com')
  prefs.set(PaperMind.PREF_UID, validUid)
  prefs.set(PaperMind.PREF_USERNAME, 'papermind')
  prefs.set(PaperMind.PREF_PASSWORD, 'secret')
  prefs.set(PaperMind.PREF_CONFIG_VERSION, PaperMind.CONFIG_VERSION)

  assert.equal(PaperMind.isConfigured(), true)
  assert.deepEqual(
    { ...PaperMind.requestHeaders(win) },
    {
      Authorization: 'Basic ' + Buffer.from('papermind:secret').toString('base64'),
      'X-User-ID': validUid,
    },
  )
})

test('opens Zotero imports explicitly as saved library papers', () => {
  assert.equal(
    PaperMind.buildReadingUrl('https://papermindapp.com', 42, validUid),
    `https://papermindapp.com/paper/42?library=1&uid=${validUid}`,
  )
})
