import { API_BASE, getUserId } from '../api'

export const SOURCE_LABELS = {
  selection: '划词',
  deep_read: '带读',
  card: '卡片',
  chat: '对话',
  manual: '手动',
  figure: '图表',
}

export function figureUrl(paperRowid, name) {
  return `${API_BASE}/board/${paperRowid}/figures/${name}`
}

// 卡片类型 -> 默认板块映射（可在选单里改投）
export const CARD_SECTION_MAP = {
  method: 'methods',
  finding: 'results',
  critique: 'critique',
  transfer: 'implications',
}

export const EXPORT_FORMATS = [
  { key: 'pptx', label: 'PowerPoint', ext: 'pptx' },
  { key: 'md', label: 'Markdown', ext: 'md' },
]

export async function downloadBoard(paperRowid, title, format = 'pptx') {
  const res = await fetch(`${API_BASE}/board/${paperRowid}/export/${format}`, {
    headers: { 'X-User-ID': getUserId() },
  })
  if (!res.ok) throw new Error('export failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const ext = (EXPORT_FORMATS.find(f => f.key === format) || {}).ext || format
  a.download = `汇报-${(title || 'paper').slice(0, 40)}.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}

// 兼容旧调用
export const downloadBoardMarp = (paperRowid, title) => downloadBoard(paperRowid, title, 'pptx')
