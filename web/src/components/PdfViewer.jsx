import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut, AlertCircle, Download, Crop } from 'lucide-react'
import * as Sentry from '@sentry/react'
import { getUserId } from '../api'

/* ─────────────────────────────────────────────────────────────
   PdfViewer · 基于 pdfjs-dist 的轻量 PDF 渲染器

   设计原则：
   1. 单文件、纯 React，不依赖 react-pdf
   2. 渲染 canvas + 透明 text layer，保证可选中（quote 流程的前提）
   3. 提供 onSelection({ text, page, rect }) 回调给父组件做浮窗
   4. 自带 toolbar（上/下页 + 缩放 + 当前节 hint）
   5. 暴露 imperative API：goToPage(n), highlightQuote(n)（用于从右栏 quote 卡片回跳）
   6. CORS 友好：父组件传 url，加载失败时显示 iframe 兜底

   依赖：
     - pdfjs-dist@^4.0.0 或 ^5.0.0
     - 父组件 mount 前必须先 import 本文件，本文件会一次性配置 GlobalWorkerOptions
   ───────────────────────────────────────────────────────────── */

import * as pdfjsLib from 'pdfjs-dist'
import { shouldOcrSelection } from '../utils/selectionText'
import { getPdfRenderWindow, hasRenderablePdfPages } from '../utils/pdfRendering'
// Vite 专属语法：?url 导入资源得到最终构建后的 URL，绕过 import 解析
// 如果项目用 webpack/parcel，看 README 末尾的替代方案
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  // Query version also invalidates any browser-cached response that predates
  // the production .mjs MIME rule.
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${workerSrc}?v=5.7.284-1`
}

// 引入 pdfjs 自带的 text layer 样式（让 textDivs 透明覆盖在 canvas 上）
// 5.x 路径是 pdfjs-dist/web/pdf_viewer.css；4.x 路径相同
import 'pdfjs-dist/web/pdf_viewer.css'

const DEFAULT_SCALE = 1.4
const MIN_SCALE = 0.6
const MAX_SCALE = 3.0
const MAX_CANVAS_DPR = 2
const MAX_CANVAS_PIXELS = 6_000_000

function normalizeSelectedText(value) {
  return String(value || '')
    .replace(/\u00ad/g, '')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s*([，。！？；：、（）【】《》“”‘’「」『』])\s*/g, '$1')
    .replace(
      /([\u3400-\u9fff\uf900-\ufaff，。！？；：、）】》”’」』])\s+(?=[\u3400-\u9fff\uf900-\ufaff（【《“‘「『])/g,
      '$1',
    )
    .replace(/([a-z0-9])-\s+(?=[a-z0-9])/gi, '$1-')
    .replace(/\s+/g, ' ')
    .trim()
}

function captureSelectionImage(pageInfo, rects) {
  const canvas = pageInfo?.canvas
  const outputScale = pageInfo?.outputScale || 1
  if (!canvas || !rects?.length) return ''

  const left = Math.max(0, Math.min(...rects.map(rect => rect.x)))
  const top = Math.max(0, Math.min(...rects.map(rect => rect.y)))
  const right = Math.min(canvas.clientWidth, Math.max(...rects.map(rect => rect.x + rect.width)))
  const bottom = Math.min(canvas.clientHeight, Math.max(...rects.map(rect => rect.y + rect.height)))
  if (right <= left || bottom <= top) return ''

  const padding = 8
  const crop = document.createElement('canvas')
  crop.width = Math.ceil((right - left + padding * 2) * outputScale)
  crop.height = Math.ceil((bottom - top + padding * 2) * outputScale)
  const context = crop.getContext('2d')
  if (!context) return ''
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, crop.width, crop.height)

  // Only copy the selected line rectangles. This keeps text before the first
  // selected character and after the last selected character out of OCR.
  for (const rect of rects) {
    context.drawImage(
      canvas,
      rect.x * outputScale,
      rect.y * outputScale,
      rect.width * outputScale,
      rect.height * outputScale,
      (rect.x - left + padding) * outputScale,
      (rect.y - top + padding) * outputScale,
      rect.width * outputScale,
      rect.height * outputScale,
    )
  }
  return crop.toDataURL('image/jpeg', 0.92)
}

function getCanvasOutputScale(viewport) {
  const deviceScale = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR)
  const cssPixels = viewport.width * viewport.height
  if (cssPixels <= 0) return 1
  const pixelLimitedScale = Math.sqrt(MAX_CANVAS_PIXELS / cssPixels)
  return Math.max(1, Math.min(deviceScale, pixelLimitedScale))
}

const PdfViewer = forwardRef(function PdfViewer(
  {
    url, originalUrl, onSelection, onPageChange, onTextReady, sectionHint,
    headerLeft, headerRight, onUploadLocalPdf, uploadingLocalPdf, highlights = [],
    onSnip, preferChineseText = false,
  },
  ref,
) {
  const containerRef = useRef(null)
  const pagesContainerRef = useRef(null)
  const pdfRef = useRef(null)
  const pageRefs = useRef({})  // pageNum -> { canvasEl, textLayerEl, viewport, scale }
  const renderWindowRef = useRef(new Set([1, 2, 3]))
  const pinnedPagesRef = useRef(new Set())
  const layoutGenerationRef = useRef(0)
  const reportedErrorsRef = useRef(new Set())
  const highlightsRef = useRef([])
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const currentPageRef = useRef(1)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [snipping, setSnipping] = useState(false)   // 图表截取模式
  const [snipBox, setSnipBox] = useState(null)      // 拖拽中的选框（视口坐标）
  const snipStartRef = useRef(null)

  const reportPdfError = useCallback((stage, error, pageNumber = null) => {
    const normalized = error instanceof Error ? error : new Error(String(error || 'Unknown PDF error'))
    const key = `${stage}:${pageNumber || 0}:${normalized.name}:${normalized.message}`
    if (reportedErrorsRef.current.has(key)) return
    reportedErrorsRef.current.add(key)
    Sentry.withScope(scope => {
      scope.setTag('component', 'PdfViewer')
      scope.setTag('pdf_stage', stage)
      if (pageNumber) scope.setTag('pdf_page', String(pageNumber))
      scope.setExtra('pdf_page_count', pdfRef.current?.numPages || 0)
      scope.setExtra('pdf_same_origin', (() => {
        try { return new URL(url, window.location.href).origin === window.location.origin }
        catch { return false }
      })())
      Sentry.captureException(normalized)
    })
  }, [url])

  // ── 图表截取：接管鼠标，框选 → 从页 canvas 裁剪出 PNG ──
  useEffect(() => {
    const container = containerRef.current
    if (!snipping || !container) return
    container.style.cursor = 'crosshair'
    const layers = container.querySelectorAll('.textLayer')
    layers.forEach(l => { l.style.pointerEvents = 'none' })

    const onDown = (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      snipStartRef.current = { x: e.clientX, y: e.clientY }
      setSnipBox({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY })
    }
    const onMove = (e) => {
      if (!snipStartRef.current) return
      setSnipBox({ x1: snipStartRef.current.x, y1: snipStartRef.current.y, x2: e.clientX, y2: e.clientY })
    }
    const onUp = (e) => {
      if (!snipStartRef.current) return
      const s = snipStartRef.current
      snipStartRef.current = null
      setSnipBox(null)
      const rect = {
        left: Math.min(s.x, e.clientX), top: Math.min(s.y, e.clientY),
        right: Math.max(s.x, e.clientX), bottom: Math.max(s.y, e.clientY),
      }
      if (rect.right - rect.left < 15 || rect.bottom - rect.top < 15) return
      // 选框中心落在哪一页的 canvas 上，就在那页裁剪（canvas 背景存储 = CSS 像素，1:1）
      const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2
      for (const [pageNum, info] of Object.entries(pageRefs.current)) {
        const cRect = info?.canvas?.getBoundingClientRect()
        if (!cRect || cx < cRect.left || cx > cRect.right || cy < cRect.top || cy > cRect.bottom) continue
        const sx = Math.max(rect.left, cRect.left) - cRect.left
        const sy = Math.max(rect.top, cRect.top) - cRect.top
        const sw = Math.min(rect.right, cRect.right) - cRect.left - sx
        const sh = Math.min(rect.bottom, cRect.bottom) - cRect.top - sy
        if (sw < 10 || sh < 10) break
        // canvas 背景存储 = CSS 像素 × outputScale（Retina 下为 2）：
        // 源坐标必须同乘，否则裁到错位区域；输出按背景分辨率导出更清晰
        const os = info.outputScale || 1
        const out = document.createElement('canvas')
        out.width = Math.round(sw * os); out.height = Math.round(sh * os)
        out.getContext('2d').drawImage(info.canvas, sx * os, sy * os, sw * os, sh * os, 0, 0, sw * os, sh * os)
        out.toBlob(blob => {
          if (blob) onSnip?.({ blob, page: Number(pageNum), url: URL.createObjectURL(blob) })
        }, 'image/png')
        break
      }
      setSnipping(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setSnipping(false) }
    container.addEventListener('mousedown', onDown)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKey)
    return () => {
      container.style.cursor = ''
      layers.forEach(l => { l.style.pointerEvents = '' })
      container.removeEventListener('mousedown', onDown)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
      snipStartRef.current = null
      setSnipBox(null)
    }
  }, [snipping, onSnip])

  const getHighlightAnchor = useCallback((highlight) => {
    if (!highlight) return {}
    if (highlight.anchor && typeof highlight.anchor === 'object') return highlight.anchor
    if (typeof highlight.anchor === 'string') {
      try { return JSON.parse(highlight.anchor) } catch { return {} }
    }
    return {}
  }, [])

  // Zotero 式高亮修正：浏览器 getClientRects 会给出大量重叠/重复矩形
  // （span 框 + 文本节点框、跨行整行框），直接绘制会叠色成深浅不一的色块。
  // 先丢弃被更大矩形包含的重复项，再按行合并成每行一条干净的带状矩形。
  const mergeLineRects = useCallback((rects) => {
    const rs = (rects || []).filter(r => Number(r.width) >= 2 && Number(r.height) >= 2)
    if (!rs.length) return []
    const kept = rs.filter((a, i) => !rs.some((b, j) => j !== i
      && b.x <= a.x + 1 && b.y <= a.y + 1
      && b.x + b.width >= a.x + a.width - 1
      && b.y + b.height >= a.y + a.height - 1
      && b.width * b.height > a.width * a.height))
    const lines = []
    for (const r of kept.sort((p, q) => (p.y + p.height / 2) - (q.y + q.height / 2))) {
      const cy = r.y + r.height / 2
      const line = lines.find((L) => {
        const overlap = Math.min(L.y2, r.y + r.height) - Math.max(L.y1, r.y)
        const overlapRatio = overlap / Math.max(1, Math.min(L.h, r.height))
        const centerDistance = Math.abs(L.cy - cy)
        return overlapRatio >= 0.45
          || centerDistance < Math.max(L.h, r.height) * 0.65
      })
      if (line) {
        line.x1 = Math.min(line.x1, r.x); line.x2 = Math.max(line.x2, r.x + r.width)
        line.y1 = Math.min(line.y1, r.y); line.y2 = Math.max(line.y2, r.y + r.height)
        line.cy = (line.y1 + line.y2) / 2; line.h = line.y2 - line.y1
      } else {
        lines.push({ x1: r.x, x2: r.x + r.width, y1: r.y, y2: r.y + r.height, cy, h: r.height })
      }
    }
    const merged = lines.map(L => ({
      x: L.x1, y: L.y1,
      width: L.x2 - L.x1, height: L.y2 - L.y1,
    }))
    // 中文 PDF 的文字框高度有时略大于真实行距，相邻两行会重叠约 1px。
    // 在两行中点处分界，避免半透明色块再次叠出深色横线。
    for (let i = 0; i < merged.length - 1; i++) {
      const current = merged[i]
      const next = merged[i + 1]
      const overlap = current.y + current.height - next.y
      if (overlap <= 0) continue
      const boundary = (current.y + current.height + next.y) / 2
      current.height = Math.max(2, boundary - current.y)
      next.height = Math.max(2, next.y + next.height - boundary)
      next.y = boundary
    }
    return merged.map(r => ({
      x: +r.x.toFixed(2), y: +r.y.toFixed(2),
      width: +r.width.toFixed(2), height: +r.height.toFixed(2),
    }))
  }, [])

  const clearActiveSelection = useCallback(() => {
    Object.values(pageRefs.current).forEach((pageInfo) => {
      if (pageInfo?.activeSelectionLayer) pageInfo.activeSelectionLayer.innerHTML = ''
      pageInfo?.textLayer?.classList.remove('selecting')
    })
  }, [])

  const paintActiveSelection = useCallback((selection) => {
    clearActiveSelection()
    const container = containerRef.current
    if (!container || !selection?.rangeCount
      || !container.contains(selection.anchorNode)
      || !container.contains(selection.focusNode)) return

    const range = selection.getRangeAt(0)
    const clientRects = Array.from(range.getClientRects())
      .filter(rect => rect.width >= 1 && rect.height >= 1)
    if (!clientRects.length) return

    Object.values(pageRefs.current).forEach((pageInfo) => {
      const wrapRect = pageInfo?.wrapEl?.getBoundingClientRect()
      const layer = pageInfo?.activeSelectionLayer
      if (!wrapRect || !layer) return

      const localRects = clientRects.flatMap((rect) => {
        const left = Math.max(rect.left, wrapRect.left)
        const top = Math.max(rect.top, wrapRect.top)
        const right = Math.min(rect.right, wrapRect.right)
        const bottom = Math.min(rect.bottom, wrapRect.bottom)
        if (right - left < 1 || bottom - top < 1) return []
        return [{
          x: left - wrapRect.left,
          y: top - wrapRect.top,
          width: right - left,
          height: bottom - top,
        }]
      })

      const lineRects = mergeLineRects(localRects)
      if (!lineRects.length) return
      pageInfo.textLayer?.classList.add('selecting')
      for (const rect of lineRects) {
        const marker = document.createElement('div')
        marker.className = 'pdf-active-selection'
        marker.style.cssText = `
          position:absolute;
          left:${rect.x}px; top:${rect.y}px;
          width:${rect.width}px; height:${rect.height}px;
          border-radius:2px;
          background:rgba(92, 145, 220, .26);
        `
        layer.appendChild(marker)
      }
    })
  }, [clearActiveSelection, mergeLineRects])

  // 第一性原理：高亮锚定的是文本而不是像素。绘制时优先在当前文字层里
  // 重新定位 quote 原文，从真实 span 几何推导矩形——任何缩放下都精确贴字
  // （Zotero 的做法）；文字层不可用或文本找不到时，退回存储的矩形快照。
  const locateTextRects = useCallback((pageInfo, text) => {
    const layer = pageInfo?.textLayer
    const wrap = pageInfo?.wrapEl
    if (!layer || !wrap || !text) return []
    const needle = String(text).replace(/\s+/g, ' ').trim().toLowerCase()
    if (needle.length < 4) return []
    // 收集文字层全部文本节点与累计偏移
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    const nodes = []
    let full = ''
    while (walker.nextNode()) {
      const node = walker.currentNode
      const raw = node.textContent || ''
      if (!raw) continue
      nodes.push({ node, start: full.length, raw })
      full += raw
    }
    if (!nodes.length) return []
    // 规范化（折叠空白/小写）后匹配，并保留规范化索引 → 原始索引映射
    const map = []
    let normStr = ''
    let prevSpace = true
    for (let i = 0; i < full.length; i++) {
      const ch = full[i]
      if (/\s/.test(ch)) {
        if (!prevSpace) { normStr += ' '; map.push(i) }
        prevSpace = true
      } else {
        normStr += ch.toLowerCase(); map.push(i)
        prevSpace = false
      }
    }
    const idx = normStr.indexOf(needle)
    if (idx < 0) return []
    const rawStart = map[idx]
    const rawEnd = map[idx + needle.length - 1] + 1
    const findPos = (rawIdx) => {
      for (const n of nodes) {
        if (rawIdx <= n.start + n.raw.length) {
          return { node: n.node, offset: Math.max(0, rawIdx - n.start) }
        }
      }
      const last = nodes[nodes.length - 1]
      return { node: last.node, offset: last.raw.length }
    }
    try {
      const s = findPos(rawStart)
      const e = findPos(rawEnd)
      const range = document.createRange()
      range.setStart(s.node, s.offset)
      range.setEnd(e.node, e.offset)
      const wrapRect = wrap.getBoundingClientRect()
      return Array.from(range.getClientRects()).map(r => ({
        x: r.left - wrapRect.left, y: r.top - wrapRect.top, width: r.width, height: r.height,
      }))
    } catch { return [] }
  }, [])

  // Zotero 同款：直接用 PDF 内部字形坐标计算高亮矩形。
  // DOM 文字层是"浏览器字体 + 横向拉伸"对 PDF 字形的近似，两端对齐排版下
  // 行内误差可达几十像素（行末过冲、词位漂移）；textContent.items 携带每段
  // 文字的 PDF 空间 transform/width/height，据此换算的矩形与打印字形严格一致。
  const locatePdfRects = useCallback((pageInfo, text) => {
    const items = pageInfo?.textItems
    const viewport = pageInfo?.viewport
    if (!items?.length || !viewport || !text) return []
    const needle = String(text).replace(/\s+/g, ' ').trim().toLowerCase()
    if (needle.length < 4) return []
    // 与 DOM 文字层同序拼接 item 文本，规范化后匹配，保留索引映射
    let full = ''
    const spans = []
    for (const it of items) {
      if (!it.str) continue
      spans.push({ it, start: full.length, len: it.str.length })
      full += it.str
    }
    const map = []
    let normStr = ''
    let prevSpace = true
    for (let i = 0; i < full.length; i++) {
      const ch = full[i]
      if (/\s/.test(ch)) {
        if (!prevSpace) { normStr += ' '; map.push(i) }
        prevSpace = true
      } else {
        normStr += ch.toLowerCase(); map.push(i)
        prevSpace = false
      }
    }
    const idx = normStr.indexOf(needle)
    if (idx < 0) return []
    const rawStart = map[idx]
    const rawEnd = map[idx + needle.length - 1] + 1
    const rects = []
    for (const s of spans) {
      const iStart = Math.max(rawStart, s.start)
      const iEnd = Math.min(rawEnd, s.start + s.len)
      if (iStart >= iEnd) continue
      const t = s.it.transform // [sx, skewY, skewX, sy, tx, ty]，水平文本 skew≈0
      const fontH = s.it.height || Math.abs(t[3]) || 10
      // item 内按字符占比插值起止 x（首尾 item 局部选中时）
      const f0 = (iStart - s.start) / s.len
      const f1 = (iEnd - s.start) / s.len
      const x0 = t[4] + s.it.width * f0
      const x1 = t[4] + s.it.width * f1
      // PDF y 轴向上，ty 是基线：上沿 = 基线 + ascent(~0.8em)，下沿 = 基线 - descent(~0.2em)
      const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle([
        x0, t[5] - fontH * 0.22, x1, t[5] + fontH * 0.8,
      ])
      const left = Math.min(vx0, vx1), top = Math.min(vy0, vy1)
      rects.push({ x: left, y: top, width: Math.abs(vx1 - vx0), height: Math.abs(vy1 - vy0) })
    }
    return rects
  }, [])

  const paintPageHighlights = useCallback((pageNum) => {
    const pageInfo = pageRefs.current[pageNum]
    if (!pageInfo?.highlightLayer) return
    pageInfo.highlightLayer.innerHTML = ''
    const pageHighlights = (highlightsRef.current || [])
      .filter(h => Number(h.page) === Number(pageNum))

    for (const h of pageHighlights) {
      const anchor = getHighlightAnchor(h)
      // 横向用 DOM 文字层（行宽被 pdf.js 拉伸校准，两端对齐排版下比
      // item.width 可靠——后者不含 TJ 词距位移）；纵向用 PDF 字形坐标
      // （基线 + 字高，比 DOM 行盒贴字）。两组矩形按行配对杂交。
      let ratio = 1
      let glyphExact = true
      const domRects = mergeLineRects(locateTextRects(pageInfo, h.text))
      const pdfRects = mergeLineRects(locatePdfRects(pageInfo, h.text))
      let rects = domRects.map(d => {
        const g = pdfRects.find(p =>
          (p.y + p.height / 2) > d.y && (p.y + p.height / 2) < d.y + d.height)
        return g ? { x: d.x, width: d.width, y: g.y, height: g.height } : null
      }).filter(Boolean)
      if (!rects.length && domRects.length) {
        glyphExact = false
        rects = domRects
      }
      if (!rects.length) {
        glyphExact = false
        rects = mergeLineRects(Array.isArray(anchor.rects) ? anchor.rects : [])
        const sourceScale = Number(anchor.scale) || pageInfo.scale || 1
        ratio = (pageInfo.scale || 1) / sourceScale
      }
      if (!rects.length) continue
      const id = String(h.id || h.created_at || `${pageNum}-${h.text?.slice(0, 24)}`)

      for (const rect of rects) {
        const width = Number(rect.width) * ratio
        const height = Number(rect.height) * ratio
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) continue
        // 字形坐标已经贴住文字本体，不再收缩；DOM/快照来源是行盒，上下各收 10%
        const inset = glyphExact ? 0 : height * 0.1
        const marker = document.createElement('div')
        marker.className = 'pdf-quote-highlight'
        marker.dataset.quoteHighlight = id
        marker.title = h.question || h.text || ''
        marker.style.cssText = `
          position:absolute;
          left:${Number(rect.x) * ratio}px;
          top:${Number(rect.y) * ratio + inset}px;
          width:${width}px;
          height:${Math.max(height - inset * 2, 4)}px;
          border-radius:2px;
          background:rgba(224,122,95,.15);
          mix-blend-mode:multiply;
          transition:background-color .28s ease, box-shadow .28s ease;
        `
        pageInfo.highlightLayer.appendChild(marker)
      }
    }
  }, [getHighlightAnchor, mergeLineRects, locateTextRects, locatePdfRects])

  // ── load PDF ──
  useEffect(() => {
    if (!url) return
    let cancelled = false
    // pdfjs loading is an external task lifecycle; reset UI state when the source changes.
    setLoading(true)
    setError(null)
    setNumPages(0)
    setCurrentPage(1)
    currentPageRef.current = 1
    pageRefs.current = {}
    pinnedPagesRef.current.clear()
    reportedErrorsRef.current.clear()

    let task = null
    const controller = new AbortController()

    ;(async () => {
      const resolvedUrl = new URL(url, window.location.href)
      const isSameOrigin = resolvedUrl.origin === window.location.origin

      if (isSameOrigin) {
        // 库内 PDF 受设备身份和预览认证保护。先由主线程带齐凭据取回，
        // 再把二进制交给 pdf.js，避免 worker 的独立请求丢失认证信息。
        const response = await fetch(resolvedUrl, {
          credentials: 'include',
          headers: { 'X-User-ID': getUserId() },
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`PDF 请求失败 (${response.status})`)
        }
        const data = new Uint8Array(await response.arrayBuffer())
        if (cancelled) return
        task = pdfjsLib.getDocument({ data })
      } else {
        task = pdfjsLib.getDocument({ url, withCredentials: false })
      }

      const pdf = await task.promise
      if (cancelled) return
      if (!hasRenderablePdfPages(pdf.numPages)) {
        await pdf.destroy().catch(() => {})
        throw new Error('PDF 没有可显示的页面，文件可能已损坏')
      }
      pdfRef.current = pdf
      setNumPages(pdf.numPages)
      setLoading(false)
    })().catch(err => {
      if (cancelled || err?.name === 'AbortError') return
      // CORS / 404 / 文件不是 PDF 都会到这
      reportPdfError('document-load', err)
      setError(err.message || '加载失败')
      setLoading(false)
    })

    return () => {
      cancelled = true
      controller.abort()
      task?.destroy()
      if (pdfRef.current) {
        pdfRef.current.cleanup().catch(() => {})
        pdfRef.current.destroy().catch(() => {})
        pdfRef.current = null
      }
    }
  }, [reportPdfError, url])

  const releasePage = useCallback((pageNum) => {
    const info = pageRefs.current[pageNum]
    if (!info || info.renderingPromise || !info.rendered) return
    if (info.canvas) {
      info.canvas.width = 0
      info.canvas.height = 0
    }
    info.wrapEl?.replaceChildren()
    Object.assign(info, {
      canvas: null,
      highlightLayer: null,
      textLayer: null,
      activeSelectionLayer: null,
      textItems: null,
      rendered: false,
      renderTask: null,
    })
  }, [])

  // ── render one page into the pages container ──
  const renderPage = useCallback(async (pageNum, theScale) => {
    const info = pageRefs.current[pageNum]
    if (!pdfRef.current || !info) return false
    if (info.rendered) return true
    if (info.renderingPromise) return info.renderingPromise

    const renderPromise = Promise.resolve().then(async () => {
      try {
        const page = info.page || await pdfRef.current.getPage(pageNum)
        const viewport = page.getViewport({ scale: theScale })
        if (info.generation !== layoutGenerationRef.current) return false

        const outputScale = getCanvasOutputScale(viewport)
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.cssText = `display:block; width:${viewport.width}px; height:${viewport.height}px;`

        const textLayer = document.createElement('div')
        textLayer.className = 'textLayer'
        textLayer.style.cssText = `
          position:absolute; inset:0;
          width:${viewport.width}px; height:${viewport.height}px;
          line-height:1;
          z-index:2;
        `
        textLayer.style.setProperty('--scale-factor', String(theScale))
        textLayer.style.setProperty('--total-scale-factor', String(theScale))

        const highlightLayer = document.createElement('div')
        highlightLayer.className = 'quoteHighlightLayer'
        highlightLayer.style.cssText = `
          position:absolute; inset:0;
          width:${viewport.width}px; height:${viewport.height}px;
          pointer-events:none;
          z-index:1;
        `

        const activeSelectionLayer = document.createElement('div')
        activeSelectionLayer.className = 'activeSelectionLayer'
        activeSelectionLayer.style.cssText = `
          position:absolute; inset:0;
          width:${viewport.width}px; height:${viewport.height}px;
          pointer-events:none;
          z-index:3;
        `

        info.wrapEl.replaceChildren(canvas, highlightLayer, textLayer, activeSelectionLayer)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('浏览器无法创建 PDF 画布')
        const transform = outputScale !== 1
          ? [outputScale, 0, 0, outputScale, 0, 0]
          : null
        const renderTask = page.render({ canvasContext: ctx, viewport, transform })
        info.renderTask = renderTask
        await renderTask.promise

        const textContent = await page.getTextContent()
        if (pdfjsLib.TextLayer) {
          const tl = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport,
          })
          await tl.render()
        } else if (typeof pdfjsLib.renderTextLayer === 'function') {
          await pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport,
            textDivs: [],
          }).promise.catch(() => {})
        }

        if (info.generation !== layoutGenerationRef.current) return false
        Object.assign(info, {
          page,
          canvas,
          highlightLayer,
          textLayer,
          activeSelectionLayer,
          viewport,
          scale: theScale,
          outputScale,
          textItems: textContent.items,
          rendered: true,
          error: '',
        })
        paintPageHighlights(pageNum)
        onTextReady?.(pageNum, textContent)
        return true
      } catch (err) {
        if (info.generation !== layoutGenerationRef.current) return false
        console.warn(`PDF page ${pageNum} render failed:`, err)
        reportPdfError('page-render', err, pageNum)
        info.error = err?.message || '页面渲染失败'
        const failure = document.createElement('div')
        failure.className = 'absolute inset-0 flex flex-col items-center justify-center gap-2 bg-warm-white px-6 text-center'
        const title = document.createElement('p')
        title.className = 'text-sm text-navy'
        title.textContent = `第 ${pageNum} 页没有成功显示`
        const detail = document.createElement('p')
        detail.className = 'text-xs text-warm-gray'
        detail.textContent = '可能是浏览器内存不足或 PDF 页面结构异常。'
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'text-xs text-coral underline underline-offset-4'
        retry.textContent = '重新加载 PDF'
        retry.addEventListener('click', () => window.location.reload(), { once: true })
        failure.append(title, detail, retry)
        info.wrapEl.replaceChildren(failure)
        return false
      } finally {
        if (pageRefs.current[pageNum] === info) {
          info.renderTask = null
          info.renderingPromise = null
          if (
            info.rendered
            && !renderWindowRef.current.has(pageNum)
            && !pinnedPagesRef.current.has(pageNum)
          ) releasePage(pageNum)
        }
      }
    })
    info.renderingPromise = renderPromise
    return renderPromise
  }, [onTextReady, paintPageHighlights, releasePage, reportPdfError])

  // ── build lightweight page shells; render only the nearby canvas window ──
  useEffect(() => {
    if (!pdfRef.current || loading) return
    const generation = layoutGenerationRef.current + 1
    layoutGenerationRef.current = generation
    for (const info of Object.values(pageRefs.current)) {
      if (info.canvas) {
        info.canvas.width = 0
        info.canvas.height = 0
      }
    }
    if (pagesContainerRef.current) {
      pagesContainerRef.current.innerHTML = ''
    }
    pageRefs.current = {}
    pinnedPagesRef.current.clear()
    renderWindowRef.current = new Set(getPdfRenderWindow(currentPageRef.current, numPages))
    let cancelled = false
    ;(async () => {
      for (let p = 1; p <= numPages; p++) {
        if (cancelled) return
        try {
          const page = await pdfRef.current.getPage(p)
          if (cancelled || generation !== layoutGenerationRef.current) return
          const viewport = page.getViewport({ scale })
          const pageWrap = document.createElement('div')
          pageWrap.className = 'pdf-page-wrap'
          pageWrap.style.cssText = `
            position:relative;
            width:${viewport.width}px;
            height:${viewport.height}px;
            margin:0 auto 16px;
            background:#fbfaf7;
            box-shadow:0 2px 4px rgba(30,58,95,.06), 0 12px 30px -16px rgba(30,58,95,.18);
            border:1px solid rgba(30,58,95,.08);
            border-radius:4px;
            overflow:hidden;
          `
          pageWrap.dataset.pageNum = String(p)
          pageRefs.current[p] = {
            page,
            wrapEl: pageWrap,
            viewport,
            scale,
            generation,
            rendered: false,
            renderingPromise: null,
          }
          pagesContainerRef.current?.appendChild(pageWrap)

          if (renderWindowRef.current.has(p)) {
            await renderPage(p, scale)
          } else if (numPages <= 30) {
            // 自测需要全文文字，但文字提取不需要为每页创建常驻 canvas。
            const textContent = await page.getTextContent()
            if (!cancelled && generation === layoutGenerationRef.current) {
              onTextReady?.(p, textContent)
            }
          }
        } catch (err) {
          if (cancelled || generation !== layoutGenerationRef.current) return
          reportPdfError('page-prepare', err, p)
          const fallback = document.createElement('div')
          fallback.className = 'pdf-page-wrap flex items-center justify-center text-sm text-warm-gray'
          fallback.style.cssText = 'width:760px;height:980px;margin:0 auto 16px;background:#fbfaf7;'
          fallback.dataset.pageNum = String(p)
          fallback.textContent = `第 ${p} 页无法读取`
          pagesContainerRef.current?.appendChild(fallback)
        }
      }
    })()
    return () => {
      cancelled = true
      layoutGenerationRef.current += 1
    }
  }, [loading, numPages, onTextReady, renderPage, reportPdfError, scale])

  useEffect(() => {
    if (!pdfRef.current || loading || !numPages) return
    const desiredPages = new Set(getPdfRenderWindow(currentPage, numPages))
    renderWindowRef.current = desiredPages
    desiredPages.forEach(pageNum => { void renderPage(pageNum, scale) })
    Object.keys(pageRefs.current).forEach(value => {
      const pageNum = Number(value)
      if (!desiredPages.has(pageNum) && !pinnedPagesRef.current.has(pageNum)) {
        releasePage(pageNum)
      }
    })
  }, [currentPage, loading, numPages, releasePage, renderPage, scale])

  // ── intersection observer: 同步 currentPage ──
  useEffect(() => {
    if (!pagesContainerRef.current || numPages === 0) return
    const io = new IntersectionObserver(entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting && entry.intersectionRatio >= 0.1)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
      const n = parseInt(visible[0]?.target?.dataset?.pageNum, 10)
      if (n) {
        currentPageRef.current = n
        setCurrentPage(n)
        onPageChange?.(n)
      }
    }, { root: containerRef.current, threshold: [0.1, 0.25, 0.5] })

    // mutation observer：等页 wrap 出现后再 observe
    const mo = new MutationObserver(() => {
      pagesContainerRef.current?.querySelectorAll('.pdf-page-wrap').forEach(el => io.observe(el))
    })
    mo.observe(pagesContainerRef.current, { childList: true })

    return () => { io.disconnect(); mo.disconnect() }
  }, [numPages, onPageChange])

  // 浏览器会分别给 PDF.js 的透明文字 span 着色，中文行内常出现重叠深色块。
  // 原生选区保持可复制，只把视觉反馈换成按行合并后的单层矩形。
  useEffect(() => {
    let frame = 0
    const handleSelectionChange = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => paintActiveSelection(window.getSelection()))
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', handleSelectionChange)
      clearActiveSelection()
    }
  }, [clearActiveSelection, paintActiveSelection])

  // ── selection bubble: listen for mouseup inside text layer ──
  useEffect(() => {
    if (!containerRef.current || !onSelection) return
    const handler = () => {
      const sel = window.getSelection()
      const text = normalizeSelectedText(sel?.toString())
      // 中文术语很短（「静脉危象」才 4 字），阈值按 8 会把选词直接吞掉
      if (!text || text.length < 2) {
        onSelection(null)
        return
      }
      // 必须在 text layer 内
      let node = sel.anchorNode
      while (node && node !== containerRef.current) {
        if (node.classList?.contains('textLayer')) break
        node = node.parentNode
      }
      if (!node || node === containerRef.current) {
        onSelection(null)
        return
      }
      const range = sel.getRangeAt(0)
      // 找当前 page
      const wrap = node.closest('.pdf-page-wrap')
      const pageNum = wrap ? parseInt(wrap.dataset.pageNum, 10) : currentPage
      const wrapRect = wrap?.getBoundingClientRect()
      const rangeRects = Array.from(range.getClientRects())
        .filter(r => r.width >= 1 && r.height >= 1)
      const selectedRects = wrapRect
        ? mergeLineRects(rangeRects.flatMap((r) => {
            const left = Math.max(r.left, wrapRect.left)
            const top = Math.max(r.top, wrapRect.top)
            const right = Math.min(r.right, wrapRect.right)
            const bottom = Math.min(r.bottom, wrapRect.bottom)
            if (right - left < 1 || bottom - top < 1) return []
            return [{
              x: +(left - wrapRect.left).toFixed(2),
              y: +(top - wrapRect.top).toFixed(2),
              width: +(right - left).toFixed(2),
              height: +(bottom - top).toFixed(2),
            }]
          }))
        : []
      const pageInfo = pageRefs.current[pageNum]
      const needsOcr = shouldOcrSelection(text, { preferCjk: preferChineseText })
      const selectionImage = needsOcr
        ? captureSelectionImage(pageInfo, selectedRects)
        : ''
      const viewportLineRects = mergeLineRects(rangeRects.map(r => ({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      })))
      const visibleLineRects = viewportLineRects.flatMap((r) => {
        const left = Math.max(0, r.x)
        const top = Math.max(0, r.y)
        const right = Math.min(window.innerWidth, r.x + r.width)
        const bottom = Math.min(window.innerHeight, r.y + r.height)
        if (right - left < 1 || bottom - top < 1) return []
        return [{ x: left, y: top, width: right - left, height: bottom - top }]
      })
      const toolbarRects = visibleLineRects.length ? visibleLineRects : viewportLineRects
      const bounds = toolbarRects.length
        ? {
            left: Math.min(...toolbarRects.map(r => r.x)),
            top: Math.min(...toolbarRects.map(r => r.y)),
            right: Math.max(...toolbarRects.map(r => r.x + r.width)),
            bottom: Math.max(...toolbarRects.map(r => r.y + r.height)),
          }
        : null

      onSelection({
        text,
        page: pageNum,
        anchor: {
          version: 1,
          page: pageNum,
          scale: pageInfo?.scale || scale,
          rects: selectedRects,
          textStart: text.slice(0, 120),
          textEnd: text.slice(-120),
        },
        needsOcr,
        selectionImage,
        bounds,
        selectionRects: toolbarRects.map(r => ({
          left: r.x,
          top: r.y,
          right: r.x + r.width,
          bottom: r.y + r.height,
        })),
        x: bounds ? (bounds.left + bounds.right) / 2 : window.innerWidth / 2,
        y: bounds?.top ?? 80,
      })
    }
    // PDF 滚动后选区位置已变，收起浮窗避免悬在错误位置
    const onScroll = () => onSelection(null)
    const scroller = containerRef.current
    document.addEventListener('mouseup', handler)
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      document.removeEventListener('mouseup', handler)
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [currentPage, mergeLineRects, onSelection, preferChineseText, scale])

  // ── repaint persisted quote highlights whenever backend quotes change ──
  useEffect(() => {
    highlightsRef.current = Array.isArray(highlights) ? highlights : []
    Object.keys(pageRefs.current).forEach(pageNum => paintPageHighlights(Number(pageNum)))
  }, [highlights, paintPageHighlights])

  // ── imperative API ──
  const goToPage = useCallback((n) => {
    const target = Math.min(numPages || 1, Math.max(1, Number(n) || 1))
    currentPageRef.current = target
    setCurrentPage(target)
    const desiredPages = new Set(getPdfRenderWindow(target, numPages))
    renderWindowRef.current = desiredPages
    desiredPages.forEach(pageNum => { void renderPage(pageNum, scale) })
    Object.keys(pageRefs.current).forEach(value => {
      const pageNum = Number(value)
      if (!desiredPages.has(pageNum) && !pinnedPagesRef.current.has(pageNum)) {
        releasePage(pageNum)
      }
    })
    const wrap = pageRefs.current[target]?.wrapEl
    if (wrap && containerRef.current) {
      const offset = wrap.offsetTop - 20
      containerRef.current.scrollTo({ top: offset, behavior: 'smooth' })
    }
  }, [numPages, releasePage, renderPage, scale])

  const highlightQuote = useCallback((quoteOrId) => {
    const quote = typeof quoteOrId === 'object'
      ? quoteOrId
      : highlightsRef.current.find(h => String(h.id) === String(quoteOrId))
    const id = String(quote?.id || quoteOrId || '')
    if (quote?.page) goToPage(Number(quote.page))
    window.setTimeout(() => {
      const markers = containerRef.current?.querySelectorAll('.pdf-quote-highlight') || []
      markers.forEach(marker => {
        if (marker.dataset.quoteHighlight !== id) return
        marker.style.background = 'rgba(224,122,95,.42)'
        marker.style.boxShadow = '0 0 0 2px rgba(224,122,95,.28), 0 0 18px rgba(224,122,95,.22)'
        window.setTimeout(() => {
          marker.style.background = 'rgba(224,122,95,.24)'
          marker.style.boxShadow = '0 0 0 1px rgba(224,122,95,.12)'
        }, 900)
      })
    }, 420)
  }, [goToPage])

  const capturePageImage = useCallback((pageNum = currentPage) => {
    const target = Number(pageNum)
    const info = pageRefs.current[target]
    const source = info?.canvas
    if (!source) {
      if (info?.error) pinnedPagesRef.current.delete(target)
      else if (info) {
        pinnedPagesRef.current.add(target)
        void renderPage(target, scale)
      }
      return ''
    }
    const finishCapture = (dataUrl) => {
      pinnedPagesRef.current.delete(target)
      if (!renderWindowRef.current.has(target)) {
        window.setTimeout(() => releasePage(target), 0)
      }
      return dataUrl
    }
    const maxPixels = 3_000_000
    const ratio = Math.min(1, Math.sqrt(maxPixels / Math.max(1, source.width * source.height)))
    if (ratio === 1) return finishCapture(source.toDataURL('image/jpeg', 0.9))

    const output = document.createElement('canvas')
    output.width = Math.max(1, Math.round(source.width * ratio))
    output.height = Math.max(1, Math.round(source.height * ratio))
    const context = output.getContext('2d')
    if (!context) return finishCapture('')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, output.width, output.height)
    context.drawImage(source, 0, 0, output.width, output.height)
    return finishCapture(output.toDataURL('image/jpeg', 0.9))
  }, [currentPage, releasePage, renderPage, scale])

  useImperativeHandle(ref, () => ({
    goToPage,
    highlightQuote,
    capturePageImage,
    getCurrentPage: () => currentPage,
    getNumPages: () => numPages,
    setScale,
  }), [goToPage, highlightQuote, capturePageImage, currentPage, numPages])

  // ── render ──
  return (
    <div className="pdf-viewer-root flex flex-col h-full bg-gradient-to-b from-navy/[0.04] to-navy/[0.06]">
      {/* toolbar */}
      <div className="pdf-toolbar sticky top-0 z-[5] flex items-center gap-3 px-6 py-2 bg-cream/95 backdrop-blur border-b border-navy/5 text-xs text-warm-gray">
        {headerLeft}
        <button
          onClick={() => goToPage(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1 || loading}
          className="p-1 rounded hover:bg-navy/5 disabled:opacity-30"
          title="上一页">
          <ChevronLeft size={14}/>
        </button>
        <span className="font-mono tracking-wider">
          <strong className="text-navy font-medium">{currentPage}</strong> / {numPages || '—'}
        </span>
        <button
          onClick={() => goToPage(Math.min(numPages, currentPage + 1))}
          disabled={currentPage >= numPages || loading}
          className="p-1 rounded hover:bg-navy/5 disabled:opacity-30"
          title="下一页">
          <ChevronRight size={14}/>
        </button>

        <span className="w-px h-4 bg-navy/10"/>

        <button
          onClick={() => setScale(s => Math.max(MIN_SCALE, +(s - 0.15).toFixed(2)))}
          disabled={loading || scale <= MIN_SCALE}
          className="p-1 rounded hover:bg-navy/5 disabled:opacity-30"
          title="缩小">
          <ZoomOut size={14}/>
        </button>
        <span className="font-mono">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale(s => Math.min(MAX_SCALE, +(s + 0.15).toFixed(2)))}
          disabled={loading || scale >= MAX_SCALE}
          className="p-1 rounded hover:bg-navy/5 disabled:opacity-30"
          title="放大">
          <ZoomIn size={14}/>
        </button>

        {onSnip && (
          <>
            <span className="w-px h-4 bg-navy/10"/>
            <button
              onClick={() => setSnipping(s => !s)}
              disabled={loading}
              className={`p-1 rounded disabled:opacity-30 inline-flex items-center gap-1 ${
                snipping ? 'bg-coral/15 text-coral' : 'hover:bg-navy/5'
              }`}
              title={snipping ? '退出截取（Esc）' : '截取图表：框选 PDF 上的图/表'}>
              <Crop size={14}/>
              {snipping && <span className="text-[10px]">框选图表</span>}
            </button>
          </>
        )}

        {sectionHint && (
          <>
            <span className="w-px h-4 bg-navy/10"/>
            <span>{sectionHint}</span>
          </>
        )}

        <span className="ml-auto flex items-center gap-3">
          {headerRight}
        </span>
      </div>

      {/* page area (scrollable) */}
      {/* 截取模式：拖拽中的选框（视口坐标 fixed 定位） */}
      {snipBox && (
        <div className="fixed z-[80] border-2 border-coral bg-coral/10 pointer-events-none rounded-sm"
          style={{
            left: Math.min(snipBox.x1, snipBox.x2),
            top: Math.min(snipBox.y1, snipBox.y2),
            width: Math.abs(snipBox.x2 - snipBox.x1),
            height: Math.abs(snipBox.y2 - snipBox.y1),
          }}/>
      )}
      <div ref={containerRef} className="flex-1 overflow-y-auto py-6 px-4 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 size={20} className="text-coral animate-spin"/>
          </div>
        )}
        {error && (
          <div className="max-w-md mx-auto bg-warm-white border border-dashed border-coral/30 rounded-2xl p-6 text-center">
            <AlertCircle size={20} className="text-coral mx-auto mb-2"/>
            <p className="text-sm text-navy mb-1">PDF 无法直接渲染</p>
            <p className="text-xs text-warm-gray mb-4 leading-relaxed">
              {/CORS|Failed to fetch|NetworkError/i.test(error)
                ? '出版方阻止了跨域加载，请在新标签页查看原文。'
                : error}
            </p>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <a href={originalUrl || url} target="_blank" rel="noreferrer"
                className="inline-flex items-center text-xs px-3 py-1.5 rounded-full border border-coral/30 text-coral hover:bg-coral/5">
                在新标签页打开 PDF
              </a>
              {onUploadLocalPdf && (
                <label className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-coral text-warm-white cursor-pointer hover:bg-coral-deep transition-colors ${uploadingLocalPdf ? 'opacity-60 pointer-events-none' : ''}`}>
                  {uploadingLocalPdf ? <Loader2 size={11} className="animate-spin"/> : <Download size={11} className="rotate-180"/>}
                  {uploadingLocalPdf ? '上传中…' : '上传本地 PDF 精读'}
                  <input type="file" accept="application/pdf,.pdf" className="hidden"
                    onChange={e => { onUploadLocalPdf(e.target.files?.[0]); e.target.value = '' }}/>
                </label>
              )}
            </div>
          </div>
        )}
        <div ref={pagesContainerRef}/>
      </div>
    </div>
  )
})

export default PdfViewer
