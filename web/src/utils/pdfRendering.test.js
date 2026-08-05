import test from 'node:test'
import assert from 'node:assert/strict'
import { getPdfRenderWindow, hasRenderablePdfPages } from './pdfRendering.js'

test('keeps only nearby PDF pages in the canvas render window', () => {
  assert.deepEqual(getPdfRenderWindow(1, 166), [1, 2, 3])
  assert.deepEqual(getPdfRenderWindow(80, 166), [78, 79, 80, 81, 82])
  assert.deepEqual(getPdfRenderWindow(166, 166), [164, 165, 166])
})

test('clamps invalid page positions and supports small papers', () => {
  assert.deepEqual(getPdfRenderWindow(99, 3), [1, 2, 3])
  assert.deepEqual(getPdfRenderWindow(0, 3, 0), [1])
  assert.deepEqual(getPdfRenderWindow(1, 0), [])
})

test('rejects zero-page and invalid PDF documents before rendering', () => {
  assert.equal(hasRenderablePdfPages(1), true)
  assert.equal(hasRenderablePdfPages(166), true)
  assert.equal(hasRenderablePdfPages(0), false)
  assert.equal(hasRenderablePdfPages(Number.NaN), false)
})
