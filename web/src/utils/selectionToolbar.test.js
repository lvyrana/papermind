import test from 'node:test'
import assert from 'node:assert/strict'
import { getSelectionToolbarPosition } from './selectionToolbar.js'

const toolbar = { width: 460, height: 54 }
const viewport = { width: 1200, height: 800 }

test('places the toolbar above a normal selection', () => {
  const position = getSelectionToolbarPosition({
    bounds: { left: 220, top: 260, right: 760, bottom: 340 },
  }, toolbar, viewport)

  assert.equal(position.top, 196)
  assert.equal(position.left, 260)
})

test('keeps a long Chinese selection unobscured', () => {
  const selectionRects = Array.from({ length: 10 }, (_, index) => ({
    left: 92,
    top: 170 + index * 46,
    right: 900,
    bottom: 204 + index * 46,
  }))
  const position = getSelectionToolbarPosition({
    bounds: { left: 92, top: 170, right: 900, bottom: 618 },
    selectionRects,
  }, { width: 760, height: 64 }, { width: 1070, height: 754 })

  assert.ok(position.top + 64 <= 160)
})

test('uses the right side when there is no room above', () => {
  const position = getSelectionToolbarPosition({
    bounds: { left: 80, top: 20, right: 450, bottom: 620 },
  }, { width: 300, height: 50 }, viewport)

  assert.equal(position.left, 460)
  assert.equal(position.top, 295)
})

test('falls back below when top and sides cannot fit', () => {
  const position = getSelectionToolbarPosition({
    bounds: { left: 30, top: 30, right: 1170, bottom: 300 },
  }, toolbar, viewport)

  assert.equal(position.top, 310)
  assert.equal(position.left, 370)
})

test('clamps oversized toolbars to the viewport', () => {
  const position = getSelectionToolbarPosition({
    bounds: { left: 4, top: 4, right: 1196, bottom: 796 },
  }, { width: 1600, height: 100 }, viewport)

  assert.ok(position.left >= 12)
  assert.ok(position.top >= 12)
  assert.ok(position.left + 1176 <= 1188)
  assert.ok(position.top + 100 <= 788)
})
