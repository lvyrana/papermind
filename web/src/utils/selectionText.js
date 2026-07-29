export function shouldOcrSelection(value, { preferCjk = false } = {}) {
  const text = String(value || '').trim()
  if (text.length < 12) return false

  const compact = text.replace(/\s/g, '')
  if (!compact) return false
  const controlCount = (compact.match(/[\u007f-\u009f\ufffd]/g) || []).length
  if (controlCount > 0) return true

  const cjkCount = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const latinCount = (compact.match(/[A-Za-z]/g) || []).length
  const symbolCount = (compact.match(/[\\[\]^_`{|}~]/g) || []).length
  const length = compact.length

  if (preferCjk && cjkCount / length < 0.02 && latinCount / length > 0.25) {
    return true
  }
  return symbolCount >= 4 && symbolCount / length > 0.06
}
