export function shouldOcrSelection(value) {
  const text = String(value || '').trim()
  if (text.length < 12) return false

  const compact = text.replace(/\s/g, '')
  if (!compact) return false
  const controlCount = (compact.match(/[\u007f-\u009f\ufffd]/g) || []).length
  if (controlCount > 0) return true

  const symbolCount = (compact.match(/[\\[\]^_`{|}~]/g) || []).length
  const length = compact.length

  return symbolCount >= 4 && symbolCount / length > 0.06
}

export function getOcrClipboardText(nativeText, selection) {
  if (selection?.textSource !== 'ocr' || !selection.rawText || !selection.text) return ''
  const compact = value => String(value || '').replace(/\s+/g, '')
  return compact(nativeText) === compact(selection.rawText) ? selection.text : ''
}

export function shouldOcrPage(value, options = {}) {
  const text = String(value || '').trim()
  return text.length < 80 || shouldOcrSelection(text, options)
}

export function buildSelfTestSourceText(pageTexts) {
  return Object.entries(pageTexts || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([page, text]) => [page, String(text || '').trim()])
    .filter(([, text]) => text)
    .map(([page, text]) => `[第 ${page} 页]\n${text}`)
    .join('\n\n')
}
