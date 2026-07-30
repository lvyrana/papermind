import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* ─────────────────────────────────────────────────────────────
   回归护栏：划词工具条的四个操作，绝不能被 OCR 状态阻断。

   为什么需要这道测试（这个坑已经踩回去两次了）：
   OCR 只是「把可能乱码的文字层换成更准的版本」的增强步骤，它会失败、
   会超时、会因为模型不支持图片而返回 400。一旦让操作依赖它，用户就会
   遇到「转圈 → 停 → 四个按钮点了全无反应」，而且没有任何出口——
   因为失败路径不会把 needsOcr 清掉，selection 会永远停在「待识别」。

   正确做法：PDF 文字层的原文始终可用，操作永远可点；
   OCR 成功只是替换文字，失败就用原文，最多给一行提示。

   如果你正在因为这条测试失败而读这段话：请不要通过给按钮加 disabled
   或在 handler 里 early-return 来「修复」乱码问题。要限制不可靠文字，
   请在沉淀结果上做标注，而不是锁死入口。
   ───────────────────────────────────────────────────────────── */

const source = readFileSync(
  fileURLToPath(new URL('./PaperRead.jsx', import.meta.url)),
  'utf8',
)

// 只取划词工具条那一段，避免误伤页面其他地方的 disabled
function selectionToolbarBlock() {
  const start = source.indexOf('aria-label="选中文字操作"')
  assert.notEqual(start, -1, '找不到划词工具条，选择器可能被改名了')
  const end = source.indexOf('mobile-only meta tab', start)
  return source.slice(start, end === -1 ? start + 6000 : end)
}

const SELECTION_ACTIONS = ['askAboutSelection', 'deepReadSelection', 'saveSelectionAsCard', 'sendSelectionToBoard']

test('划词工具条的操作按钮不带 disabled', () => {
  const block = selectionToolbarBlock()
  assert.equal(
    /\bdisabled=/.test(block),
    false,
    'OCR 状态不得禁用划词操作：识别失败时 needsOcr 不会自清，按钮会永久变灰。',
  )
})

test('四个操作 handler 不因 OCR 状态提前返回', () => {
  for (const name of SELECTION_ACTIONS) {
    const at = source.indexOf(`const ${name} = `)
    assert.notEqual(at, -1, `找不到 handler：${name}`)
    const body = source.slice(at, at + 320)
    const guard = body.match(/if \([^)]*\) return/)
    if (!guard) continue
    assert.equal(
      /needsOcr|selectionOcrPending/.test(guard[0]),
      false,
      `${name} 不得因 OCR 状态静默 return —— 用户会看到「点了没反应」且无从得知原因。`,
    )
  }
})

test('OCR 的每条失败路径都会清掉 needsOcr', () => {
  const at = source.indexOf('const handlePdfSelection')
  assert.notEqual(at, -1, '找不到 handlePdfSelection')
  const body = source.slice(at, source.indexOf('}, [])', at))

  // 失败分支（!data.ok）、异常分支（.catch）、拿不到选区图，三条都要有解除标记
  const clears = body.match(/needsOcr:\s*false/g) || []
  assert.ok(
    clears.length >= 3,
    `失败路径必须清 needsOcr，否则操作被永久锁死；当前只找到 ${clears.length} 处（至少 3 处：无选区图 / 识别失败 / 网络异常）。`,
  )
})

// 注释里会解释「曾经用过对象身份比较」，检查前先剥掉注释，只看真实代码
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('OCR 结果按请求号回写，不用对象身份比较', () => {
  const at = source.indexOf('const handlePdfSelection')
  const body = stripComments(source.slice(at, source.indexOf('}, [])', at)))
  assert.ok(
    body.includes('ocrRequestId'),
    '选区要盖 ocrRequestId 印章后按号回写。',
  )
  assert.equal(
    /current === nextSelection/.test(body),
    false,
    '不得用对象身份比较回写 OCR 结果：中途任何一次 setSelection 都会让它失效，结果被静默丢弃、needsOcr 永远留 true。',
  )
})
