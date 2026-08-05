import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../components/PdfViewer.jsx', import.meta.url), 'utf8')

test('uses the pdf.js legacy build so older trial browsers get required polyfills', () => {
  assert.match(source, /from 'pdfjs-dist\/legacy\/build\/pdf\.mjs'/)
  assert.match(source, /from 'pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'/)
  assert.match(source, /import 'pdfjs-dist\/legacy\/web\/pdf_viewer\.css'/)
  assert.doesNotMatch(source, /from 'pdfjs-dist\/build\/pdf\.mjs'/)
  assert.doesNotMatch(source, /from 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url'/)
})
