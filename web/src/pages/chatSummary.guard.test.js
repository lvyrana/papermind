import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PaperRead.jsx', import.meta.url), 'utf8')

test('对话总结使用后端返回的 note 正文送入汇报板', () => {
  assert.match(
    source,
    /setChatSummaryText\(String\(data\.note\s*\|\|/,
    'POST /api/chat/summarize 返回字段是 note；前端必须读取 data.note，否则按钮可见但点击无内容。',
  )
})

test('对话变化或清空后丢弃旧总结正文', () => {
  const resets = source.match(/setChatSummaryText\(''\)/g) || []
  assert.ok(
    resets.length >= 2,
    '清空对话和发送新消息后都应清掉旧总结，避免把过期内容送入汇报板。',
  )
})
