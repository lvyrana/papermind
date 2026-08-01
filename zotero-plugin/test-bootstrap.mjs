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

test('uses only the device header after configuration', () => {
  prefs.set(PaperMind.PREF_BASE, 'https://papermindapp.com')
  prefs.set(PaperMind.PREF_UID, validUid)
  prefs.set(PaperMind.PREF_CONFIG_VERSION, PaperMind.CONFIG_VERSION)

  assert.equal(PaperMind.isConfigured(), true)
  assert.deepEqual(
    { ...PaperMind.requestHeaders() },
    { 'X-User-ID': validUid },
  )
})

test('migrates v0.2 configuration without making the user reconnect', () => {
  prefs.set(PaperMind.PREF_BASE, 'https://papermindapp.com')
  prefs.set(PaperMind.PREF_UID, validUid)
  prefs.set(PaperMind.LEGACY_PREF_USERNAME, 'papermind')
  prefs.set(PaperMind.LEGACY_PREF_PASSWORD, 'old-secret')
  prefs.set(PaperMind.PREF_CONFIG_VERSION, 2)

  assert.equal(PaperMind.migrateLegacyConfig(), true)
  assert.equal(prefs.get(PaperMind.LEGACY_PREF_USERNAME), '')
  assert.equal(prefs.get(PaperMind.LEGACY_PREF_PASSWORD), '')
  assert.equal(prefs.get(PaperMind.PREF_CONFIG_VERSION), 3)
  assert.equal(PaperMind.isConfigured(), true)
})

test('opens Zotero imports explicitly as saved library papers', () => {
  assert.equal(
    PaperMind.buildReadingUrl('https://papermindapp.com', 42, validUid),
    `https://papermindapp.com/paper/42?library=1&uid=${validUid}`,
  )
})
