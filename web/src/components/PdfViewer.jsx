import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut, AlertCircle, Download, Crop } from 'lucide-react'

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
// Vite 专属语法：?url 导入资源得到最终构建后的 URL，绕过 import 解析
// 如果项目用 webpack/parcel，看 README 末尾的替代方案
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc
}

// 引入 pdfjs 自带的 text layer 样式（让 textDivs 透明覆盖在 canvas 上）
// 5.x 路径是 pdfjs-dist/web/pdf_viewer.css；4.x 路径相同
import 'pdfjs-dist/web/pdf_viewer.css'

const DEFAULT_SCALE = 1.4
const MIN_SCALE = 0.6
const MAX_SCALE = 3.0
const MAX_CANVAS_DPR = 2
const MAX_CANVAS_PIXELS = 6_000_000

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
    onSnip,
  },
  ref,
) {
  const containerRef = useRef(null)
  const pagesContainerRef = useRef(null)
  const pdfRef = useRef(null)
  const pageRefs = useRef({})  // pageNum -> { canvasEl, textLayerEl, viewport, scale }
  const highlightsRef = useRef([])
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [snipping, setSnipping] = useState(false)   // 图表截取模式
  const [snipBox, setSnipBox] = useState(null)      // 拖拽中的选框（视口坐标）
  const snipStartRef = useRef(null)

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
        const out = document.createElement('canvas')
        out.width = Math.round(sw); out.height = Math.round(sh)
        out.getContext('2d').drawImage(info.canvas, sx, sy, sw, sh, 0, 0, sw, sh)
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
      const line = lines.find(L => Math.abs(L.cy - cy) < Math.max(L.h, r.height) * 0.6)
      if (line) {
        line.x1 = Math.min(line.x1, r.x); line.x2 = Math.max(line.x2, r.x + r.width)
        line.y1 = Math.min(line.y1, r.y); line.y2 = Math.max(line.y2, r.y + r.height)
        line.cy = (line.y1 + line.y2) / 2; line.h = line.y2 - line.y1
      } else {
        lines.push({ x1: r.x, x2: r.x + r.width, y1: r.y, y2: r.y + r.height, cy, h: r.height })
      }
    }
    return lines.map(L => ({
      x: +L.x1.toFixed(2), y: +L.y1.toFixed(2),
      width: +(L.x2 - L.x1).toFixed(2), height: +(L.y2 - L.y1).toFixed(2),
    }))
  }, [])

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

  const paintPageHighlights = useCallback((pageNum) => {
    const pageInfo = pageRefs.current[pageNum]
    if (!pageInfo?.highlightLayer) return
    pageInfo.highlightLayer.innerHTML = ''
    const pageHighlights = (highlightsRef.current || [])
      .filter(h => Number(h.page) === Number(pageNum))

    for (const h of pageHighlights) {
      const anchor = getHighlightAnchor(h)
      // 文本重定位优先（矩形来自当前渲染，ratio=1）；失败退回快照×缩放比
      let ratio = 1
      let rects = mergeLineRects(locateTextRects(pageInfo, h.text))
      if (!rects.length) {
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
        // 行框高度含行距，上下各收 10% 贴近文字本体（Zotero 观感）
        const inset = height * 0.1
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
  }, [getHighlightAnchor, mergeLineRects, locateTextRects])

  // ── load PDF ──
  useEffect(() => {
    if (!url) return
    let cancelled = false
    // pdfjs loading is an external task lifecycle; reset UI state when the source changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    pageRefs.current = {}

    const task = pdfjsLib.getDocument({ url, withCredentials: false })
    task.promise.then(pdf => {
      if (cancelled) return
      pdfRef.current = pdf
      setNumPages(pdf.numPages)
      setLoading(false)
    }).catch(err => {
      if (cancelled) return
      // CORS / 404 / 文件不是 PDF 都会到这
      setError(err.message || '加载失败')
      setLoading(false)
    })

    return () => {
      cancelled = true
      task.destroy()
      if (pdfRef.current) {
        pdfRef.current.cleanup().catch(() => {})
        pdfRef.current.destroy().catch(() => {})
        pdfRef.current = null
      }
    }
  }, [url])

  // ── render one page into the pages container ──
  const renderPage = useCallback(async (pageNum, theScale) => {
    if (!pdfRef.current || pageRefs.current[pageNum]) return
    try {
      const page = await pdfRef.current.getPage(pageNum)
      const viewport = page.getViewport({ scale: theScale })

      const pageWrap = document.createElement('div')
      pageWrap.className = 'pdf-page-wrap'
      pageWrap.style.cssText = `
        position: relative;
        width: ${viewport.width}px;
        height: ${viewport.height}px;
        margin: 0 auto 16px;
        background: #fbfaf7;
        box-shadow: 0 2px 4px rgba(30,58,95,.06), 0 12px 30px -16px rgba(30,58,95,.18);
        border: 1px solid rgba(30,58,95,.08);
        border-radius: 4px;
        overflow: hidden;
      `
      pageWrap.dataset.pageNum = String(pageNum)

      const outputScale = getCanvasOutputScale(viewport)
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.cssText = `
        display:block;
        width:${viewport.width}px;
        height:${viewport.height}px;
      `

      const textLayer = document.createElement('div')
      textLayer.className = 'textLayer'
      textLayer.style.cssText = `
        position:absolute; inset:0;
        width:${viewport.width}px; height:${viewport.height}px;
        line-height:1;
        z-index:2;
      `
      // pdf_viewer.css 里文字 span 的定位全部乘以 --scale-factor；
      // 不设置时按 1 倍铺文字层、画布却按实际缩放渲染，选区整体错位
      textLayer.style.setProperty('--scale-factor', String(theScale))

      const highlightLayer = document.createElement('div')
      highlightLayer.className = 'quoteHighlightLayer'
      highlightLayer.style.cssText = `
        position:absolute; inset:0;
        width:${viewport.width}px; height:${viewport.height}px;
        pointer-events:none;
        z-index:1;
      `

      pageWrap.appendChild(canvas)
      pageWrap.appendChild(highlightLayer)
      pageWrap.appendChild(textLayer)
      pagesContainerRef.current?.appendChild(pageWrap)

      const ctx = canvas.getContext('2d')
      const transform = outputScale !== 1
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null
      await page.render({ canvasContext: ctx, viewport, transform }).promise

      const textContent = await page.getTextContent()
      if (pdfjsLib.TextLayer) {
        // pdfjs 5.x API
        const tl = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
        })
        await tl.render()
      } else if (typeof pdfjsLib.renderTextLayer === 'function') {
        // 4.x 兼容
        await pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
          textDivs: [],
        }).promise.catch(() => {})
      }

      pageRefs.current[pageNum] = { wrapEl: pageWrap, canvas, highlightLayer, textLayer, viewport, scale: theScale, outputScale }
      paintPageHighlights(pageNum)
      onTextReady?.(pageNum, textContent)
    } catch (err) {
      // 单页渲染失败不影响其它页
      console.warn(`PDF page ${pageNum} render failed:`, err)
    }
  }, [onTextReady, paintPageHighlights])

  // ── render all pages whenever pdf or scale changes ──
  useEffect(() => {
    if (!pdfRef.current || loading) return
    // 清空容器
    if (pagesContainerRef.current) {
      pagesContainerRef.current.innerHTML = ''
    }
    pageRefs.current = {}
    // 顺序渲染（避免一次创建过多 canvas 卡死）
    let cancelled = false
    ;(async () => {
      for (let p = 1; p <= numPages; p++) {
        if (cancelled) return
        await renderPage(p, scale)
      }
    })()
    return () => { cancelled = true }
  }, [numPages, scale, loading, renderPage])

  // ── intersection observer: 同步 currentPage ──
  useEffect(() => {
    if (!pagesContainerRef.current || numPages === 0) return
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > 0.5) {
          const n = parseInt(e.target.dataset.pageNum, 10)
          if (n) {
            setCurrentPage(n)
            onPageChange?.(n)
          }
        }
      }
    }, { root: containerRef.current, threshold: [0.5] })

    // mutation observer：等页 wrap 出现后再 observe
    const mo = new MutationObserver(() => {
      pagesContainerRef.current?.querySelectorAll('.pdf-page-wrap').forEach(el => io.observe(el))
    })
    mo.observe(pagesContainerRef.current, { childList: true })

    return () => { io.disconnect(); mo.disconnect() }
  }, [numPages, onPageChange])

  // ── selection bubble: listen for mouseup inside text layer ──
  useEffect(() => {
    if (!containerRef.current || !onSelection) return
    const handler = () => {
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text || text.length < 8) {
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
      const rect = range.getBoundingClientRect()
      // 找当前 page
      const wrap = node.closest('.pdf-page-wrap')
      const pageNum = wrap ? parseInt(wrap.dataset.pageNum, 10) : currentPage
      const wrapRect = wrap?.getBoundingClientRect()
      const selectedRects = wrapRect
        ? mergeLineRects(Array.from(range.getClientRects())
            .map(r => ({
              x: +(r.left - wrapRect.left).toFixed(2),
              y: +(r.top - wrapRect.top).toFixed(2),
              width: +r.width.toFixed(2),
              height: +r.height.toFixed(2),
            })))
        : []
      const pageInfo = pageRefs.current[pageNum]

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
        // 视口坐标，配合浮窗的 position:fixed 使用；
        // 之前加 scrollTop 换算成滚动内容坐标，但浮窗渲染在外层
        // 不滚动的容器里，翻页后浮窗会被定位到屏幕外
        x: rect.left + rect.width / 2,
        y: rect.top,
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
  }, [currentPage, onSelection, scale])

  // ── repaint persisted quote highlights whenever backend quotes change ──
  useEffect(() => {
    highlightsRef.current = Array.isArray(highlights) ? highlights : []
    Object.keys(pageRefs.current).forEach(pageNum => paintPageHighlights(Number(pageNum)))
  }, [highlights, paintPageHighlights])

  // ── imperative API ──
  const goToPage = useCallback((n) => {
    const wrap = pageRefs.current[n]?.wrapEl
    if (wrap && containerRef.current) {
      const offset = wrap.offsetTop - 20
      containerRef.current.scrollTo({ top: offset, behavior: 'smooth' })
    }
  }, [])

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

  useImperativeHandle(ref, () => ({
    goToPage,
    highlightQuote,
    getCurrentPage: () => currentPage,
    getNumPages: () => numPages,
    setScale,
  }), [goToPage, highlightQuote, currentPage, numPages])

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
