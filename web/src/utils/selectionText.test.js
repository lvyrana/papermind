import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSelfTestSourceText,
  getOcrClipboardText,
  shouldOcrPage,
  shouldOcrSelection,
} from './selectionText.js'

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

test('replaces native clipboard gibberish with OCR text for the active selection', () => {
  const selection = {
    textSource: 'ocr',
    rawText: 'W-XYZ [E\\]^_` abc',
    text: '现有问答系统仍存在不足。',
  }
  assert.equal(
    getOcrClipboardText('W-XYZ[E\\]^_`abc', selection),
    '现有问答系统仍存在不足。',
  )
  assert.equal(getOcrClipboardText('another selection', selection), '')
})

test('treats missing or suspiciously short page text as needing OCR', () => {
  assert.equal(shouldOcrPage('', { preferCjk: true }), true)
  assert.equal(shouldOcrPage('护理证据模型', { preferCjk: true }), true)
  assert.equal(
    shouldOcrPage('采用监督微调和检索增强生成技术，提高模型回答的准确性与可溯源性。'.repeat(3), {
      preferCjk: true,
    }),
    false,
  )
})

test('builds full self-test context in page order with traceable markers', () => {
  assert.equal(
    buildSelfTestSourceText({ 2: '第二页正文', 1: '第一页正文', 3: '' }),
    '[第 1 页]\n第一页正文\n\n[第 2 页]\n第二页正文',
  )
})
