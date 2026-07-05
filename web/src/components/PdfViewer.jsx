import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut, AlertCircle, Download } from 'lucide-react'

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

const PdfViewer = forwardRef(function PdfViewer(
  {
    url, originalUrl, onSelection, onPageChange, onTextReady, sectionHint,
    headerRight, onUploadLocalPdf, uploadingLocalPdf,
  },
  ref,
) {
  const containerRef = useRef(null)
  const pagesContainerRef = useRef(null)
  const pdfRef = useRef(null)
  const pageRefs = useRef({})  // pageNum -> { canvasEl, textLayerEl, viewport, scale }
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // ── load PDF ──
  useEffect(() => {
    if (!url) return
    let cancelled = false
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

      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.cssText = 'display:block;'

      const textLayer = document.createElement('div')
      textLayer.className = 'textLayer'
      textLayer.style.cssText = `
        position:absolute; inset:0;
        width:${viewport.width}px; height:${viewport.height}px;
        line-height:1;
      `

      pageWrap.appendChild(canvas)
      pageWrap.appendChild(textLayer)
      pagesContainerRef.current?.appendChild(pageWrap)

      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise

      const textContent = await page.getTextContent()
      // pdfjs 5.x 推荐 API：renderTextLayer 接 source；4.x 也兼容
      if (typeof pdfjsLib.renderTextLayer === 'function') {
        await pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
          textDivs: [],
        }).promise.catch(() => {})
      } else if (pdfjsLib.TextLayer) {
        // 5.x 新写法：构造 TextLayer 类
        const tl = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
        })
        await tl.render()
      }

      pageRefs.current[pageNum] = { wrapEl: pageWrap, canvas, textLayer, viewport, scale: theScale }
      onTextReady?.(pageNum, textContent)
    } catch (err) {
      // 单页渲染失败不影响其它页
      console.warn(`PDF page ${pageNum} render failed:`, err)
    }
  }, [onTextReady])

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
      const cRect = containerRef.current.getBoundingClientRect()
      // 找当前 page
      const wrap = node.closest('.pdf-page-wrap')
      const pageNum = wrap ? parseInt(wrap.dataset.pageNum, 10) : currentPage

      onSelection({
        text,
        page: pageNum,
        // 相对于 viewer 容器的坐标
        x: rect.left + rect.width / 2 - cRect.left + containerRef.current.scrollLeft,
        y: rect.top - cRect.top + containerRef.current.scrollTop,
      })
    }
    document.addEventListener('mouseup', handler)
    return () => document.removeEventListener('mouseup', handler)
  }, [currentPage, onSelection])

  // ── imperative API ──
  const goToPage = useCallback((n) => {
    const wrap = pageRefs.current[n]?.wrapEl
    if (wrap && containerRef.current) {
      const offset = wrap.offsetTop - 20
      containerRef.current.scrollTo({ top: offset, behavior: 'smooth' })
    }
  }, [])

  useImperativeHandle(ref, () => ({
    goToPage,
    getCurrentPage: () => currentPage,
    getNumPages: () => numPages,
    setScale,
  }), [goToPage, currentPage, numPages])

  // ── render ──
  return (
    <div className="pdf-viewer-root flex flex-col h-full bg-gradient-to-b from-navy/[0.04] to-navy/[0.06]">
      {/* toolbar */}
      <div className="pdf-toolbar sticky top-0 z-[5] flex items-center gap-3 px-6 py-2 bg-cream/95 backdrop-blur border-b border-navy/5 text-xs text-warm-gray">
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
