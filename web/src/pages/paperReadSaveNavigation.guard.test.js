import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./PaperRead.jsx', import.meta.url), 'utf8')

test('saving a library copy replaces stale paper route with the new row id', () => {
  assert.match(source, /const navigate = useNavigate\(\)/)
  assert.match(source, /const nextRowId = data\.id/)
  assert.match(source, /if \(String\(nextRowId\) !== String\(id\)\) \{[\s\S]*navigate\(`\/paper\/\$\{nextRowId\}\?library=1`, \{ replace: true, state: \{ paper \} \}\)/)
})

test('saving a new row clears the previous PDF source before reloading the viewer', () => {
  assert.match(source, /if \(String\(nextRowId\) !== String\(id\)\) \{[\s\S]*setPdfUrl\(null\)[\s\S]*setPdfOriginalUrl\(null\)[\s\S]*setPdfUrlLoading\(true\)/)
})
