import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldOcrSelection } from './selectionText.js'

test('flags scrambled custom-font text from a Chinese paper', () => {
  const text = 'W-XYZ[E\\]^_`abcBCEdefg"OhijklmXnopqrEabcBCsAtuEvwBC'
  assert.equal(shouldOcrSelection(text, { preferCjk: true }), true)
})

test('flags invalid control characters regardless of document language', () => {
  assert.equal(shouldOcrSelection('evidence model \u008d training data'), true)
})

test('keeps normal Chinese and English selections', () => {
  assert.equal(
    shouldOcrSelection('采用监督微调和检索增强生成技术，提高模型回答的准确性。', { preferCjk: true }),
    false,
  )
  assert.equal(
    shouldOcrSelection('The model was evaluated in a prospective usability study.'),
    false,
  )
})

test('does not OCR short English terms selected in Chinese papers', () => {
  assert.equal(shouldOcrSelection('RAG model', { preferCjk: true }), false)
})
