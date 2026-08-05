import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const indexSource = readFileSync(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8',
)
const mainSource = readFileSync(
  fileURLToPath(new URL('./main.jsx', import.meta.url)),
  'utf8',
)
const fallbackSource = readFileSync(
  fileURLToPath(new URL('./components/AppErrorFallback.jsx', import.meta.url)),
  'utf8',
)

test('应用根节点阻止浏览器自动翻译改写 React DOM', () => {
  assert.match(indexSource, /<html[^>]+translate="no"[^>]+class="notranslate"/)
  assert.match(indexSource, /<div id="root"[^>]+translate="no"[^>]+class="notranslate"/)
})

test('Sentry Replay 默认遮罩论文、引用和笔记内容', () => {
  assert.match(mainSource, /maskAllText:\s*true/)
  assert.match(mainSource, /blockAllMedia:\s*true/)
})

test('顶层异常提供可恢复页面而不是留下空白', () => {
  assert.match(mainSource, /<Sentry\.ErrorBoundary fallback=\{<AppErrorFallback\s*\/>\}>/)
  assert.match(fallbackSource, />\s*重新加载\s*</)
  assert.match(fallbackSource, />\s*返回首页\s*</)
})
