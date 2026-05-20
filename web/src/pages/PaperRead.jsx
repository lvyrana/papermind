import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import {
  ArrowLeft, Sparkles, Send, BookmarkPlus, Bookmark, Loader2,
  FileText, Download, ExternalLink, Languages, Mic, MicOff,
  ChevronDown, ChevronUp, MessageSquare, Quote as QuoteIcon, X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { apiGet, apiPost, apiDelete, apiPatch, API_BASE, getUserId } from '../api'
import { useSpeechInput } from '../hooks/useSpeechInput'
import TourBubble from '../components/TourBubble'
import PdfViewer from '../components/PdfViewer'

/* ─────────────────────────────────────────────────────────────
   PaperRead — 三栏版 (PDF + 记忆通道)
   ─────────────────────────────────────────────────────────────
   设计原则：
   1. 完整保留现有后端契约（/chat、/library、/notes、/translate、/pdf-url、/reading-history、
      /export/{ris,bibtex}、/projects、/library/<id>/project）
   2. 三栏：左 (240) TOC + meta + actions / 中 PDF / 右 (420) 记忆通道
   3. 中栏的 PDF 用 pdfjs-dist 渲染（支持文本选中），无法渲染时降级为「在新标签打开」
   4. 划词浮窗 → 一键把这段话作为 quote 灌进右栏 chat foot
   5. 右栏「你在这篇里追问过」= 把过去 chat 中 user 消息里带 quote 的，按段归档
   6. localStorage 兜底：未收藏的论文也能存 quotes + chat（和原版一致）
   7. mobile (< 1024px) 退化为单栏 tab，等同老版功能不丢

   依赖：
   - pdfjs-dist（新装；见 handoff 文档 §2）
   - 其余全部沿用
   ───────────────────────────────────────────────────────────── */

// ── helpers ──────────────────────────────────────────────────
const QUOTE_KEY = (id) => `paper-quotes-${id}`
const sliceId = (paper, id) => paper?.pmid || paper?.paper_id || id

function loadLocalQuotes(id) {
  try { return JSON.parse(localStorage.getItem(QUOTE_KEY(id)) || '[]') }
  catch { return [] }
}
function saveLocalQuotes(id, qs) {
  try { localStorage.setItem(QUOTE_KEY(id), JSON.stringify(qs)) } catch { /* ignore */ }
}

// 把 chat 历史里出现过的 user-with-quote 抽出来形成 quote 卡片
// 当后端 /papers/<id>/quotes 上线后这个函数就废了
function deriveQuotesFromHistory(chatMessages) {
  const quotes = []
  for (let i = 0; i < chatMessages.length; i++) {
    const m = chatMessages[i]
    if (m.role === 'user' && m._quote) {
      const next = chatMessages[i + 1]
      quotes.push({
        n: quotes.length + 1,
        text: m._quote.text,
        page: m._quote.page,
        section: m._quote.section,
        createdAt: m._quote.createdAt || new Date().toISOString(),
        question: m.content,
        answer: next?.role === 'assistant' ? next.content : null,
      })
    }
  }
  return quotes
}

// ── icons / glyphs ───────────────────────────────────────────
function SproutGlyph({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14">
      <line x1="7" y1="12" x2="7" y2="7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <path d="M7 8 C7 5 9 3.5 11 3.5 C11 6 9 8 7 8 Z" fill="currentColor" opacity="0.85"/>
      <path d="M7 7.5 C7 5 5 3.5 3 3.5 C3 6 5 7.5 7 7.5 Z" fill="currentColor" opacity="0.5"/>
    </svg>
  )
}

function ReasonGlyph({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14">
      <path d="M2 12 C2 8 4 6 7 6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none"/>
      <circle cx="7" cy="6" r="2.4" fill="currentColor"/>
    </svg>
  )
}

// ═════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════
export default function PaperRead() {
  const { id } = useParams()
  const location = useLocation()
  const [paper, setPaper] = useState(location.state?.paper || null)
  const [paperLoading, setPaperLoading] = useState(!location.state?.paper)

  // — existing state —
  const [notes, setNotes] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const { listening, supported: speechSupported, startListening, stopListening } = useSpeechInput(
    (text) => setChatInput(prev => prev ? prev + ' ' + text : text),
  )
  const [summarizing, setSummarizing] = useState(false)
  const [summarized, setSummarized] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [savedRowId, setSavedRowId] = useState(null)
  const [showExport, setShowExport] = useState(false)
  const [pdfUrlLoading, setPdfUrlLoading] = useState(false)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [pdfOriginalUrl, setPdfOriginalUrl] = useState(null)
  const [pdfUrlError, setPdfUrlError] = useState(null)
  const [ripple, setRipple] = useState(false)
  const [abstractZh, setAbstractZh] = useState(null)
  const [translating, setTranslating] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const [titleZh, setTitleZh] = useState(null)
  const [showTitleZh, setShowTitleZh] = useState(false)
  const [titleTranslating, setTitleTranslating] = useState(false)
  const [summarizeError, setSummarizeError] = useState(null)
  const [projects, setProjects] = useState([])
  const [showProjectPicker, setShowProjectPicker] = useState(false)

  // — three-pane new state —
  const [selection, setSelection] = useState(null)  // {text, page, x, y}
  const [pendingQuote, setPendingQuote] = useState(null)  // quote about to be sent
  const [currentPage, setCurrentPage] = useState(1)
  const [chatOpen, setChatOpen] = useState(true)
  const [mobileTab, setMobileTab] = useState('pdf')  // pdf | meta | chat

  // — refs —
  const chatEndRef = useRef(null)
  const chatInputRef = useRef(null)
  const readingRecordedRef = useRef(false)
  const actionRecordedRef = useRef({})
  const bookmarkBtnRef = useRef(null)
  const pdfViewerRef = useRef(null)
  const paperTourStartedRef = useRef(false)
  const [paperTourStep, setPaperTourStep] = useState(0)
  const externalLinkRef = useRef(null)
  const chatFootRef = useRef(null)
  const projectPickerRef = useRef(null)

  // — derived: quotes for this paper —
  const quotes = deriveQuotesFromHistory(chatMessages)

  // ── load paper (unchanged from v1) ──
  useEffect(() => {
    if (paper) { setPaperLoading(false); return }
    apiGet(`/papers/${id}`)
      .then(data => {
        if (data.paper) setPaper(data.paper)
        else {
          const last = localStorage.getItem('last-reading')
          if (last) {
            const parsed = JSON.parse(last)
            if (String(parsed.index) === String(id)) setPaper(parsed)
          }
        }
      })
      .catch(() => {})
      .finally(() => setPaperLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // ── engagement tracking (unchanged) ──
  const recordEngagement = useCallback((reason) => {
    if (!paper?.title) return Promise.resolve()
    return apiPost('/reading-history', {
      title: paper.title,
      paper_rowid: savedRowId || 0,
      reason,
    }).catch(() => {})
  }, [paper, savedRowId])

  const recordActionOnce = (key) => {
    if (actionRecordedRef.current[key]) return
    actionRecordedRef.current[key] = true
    recordEngagement(key)
  }

  // 20s dwell
  useEffect(() => {
    if (!paper) return
    localStorage.setItem('last-reading', JSON.stringify({
      ...paper, index: id, readAt: new Date().toISOString(),
    }))
    readingRecordedRef.current = false
    actionRecordedRef.current = {}
    const timer = setTimeout(() => {
      if (readingRecordedRef.current) return
      readingRecordedRef.current = true
      recordEngagement('dwell_20s')
    }, 20000)
    return () => clearTimeout(timer)
  }, [paper, id, recordEngagement])

  // ── notes + bookmark + chat restore (unchanged from v1) ──
  useEffect(() => {
    const _id = sliceId(paper, id)
    const saved = localStorage.getItem(`paper-notes-${_id}`)
    if (saved) setNotes(saved)
    const bk = localStorage.getItem(`paper-bookmark-${_id}`)
    if (bk) { setBookmarked(true); setSavedRowId(parseInt(bk)) }
    const chatKey = `paper-chat-${_id}`
    const savedChat = localStorage.getItem(chatKey)
    if (savedChat) {
      try { setChatMessages(JSON.parse(savedChat)) } catch { /* ignore */ }
    }
  }, [paper, id])

  useEffect(() => {
    apiGet('/projects').then(data => setProjects(data.projects || [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!savedRowId) return
    apiGet(`/library/${savedRowId}`)
      .then(data => {
        if (data.chats?.length) setChatMessages(data.chats)
        if (data.notes?.length) setNotes(data.notes[0].content)
      })
      .catch(() => {})
  }, [savedRowId])

  // notes autosave
  useEffect(() => {
    if (!paper || !notes) return
    const key = `paper-notes-${sliceId(paper, id)}`
    localStorage.setItem(key, notes)
    const lastReading = JSON.parse(localStorage.getItem('last-reading') || '{}')
    if (lastReading.index === id) {
      lastReading.note = notes.slice(0, 60)
      localStorage.setItem('last-reading', JSON.stringify(lastReading))
    }
    if (savedRowId) {
      const timer = setTimeout(() => {
        apiPost('/notes', { paper_rowid: savedRowId, content: notes }).catch(() => {})
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [notes, paper, id, savedRowId])

  // chat autosave (localStorage)
  useEffect(() => {
    if (!paper || chatMessages.length === 0) return
    const chatKey = `paper-chat-${sliceId(paper, id)}`
    localStorage.setItem(chatKey, JSON.stringify(chatMessages))
  }, [chatMessages, paper, id])

  // scroll chat to end
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatOpen])

  // ── PDF URL fetch (auto on mount when we have doi/pmid) ──
  useEffect(() => {
    if (!paper) return
    if (!paper.doi && !paper.pmid && !paper.pmcid) return
    if (pdfUrl) return
    setPdfUrlLoading(true)
    const params = new URLSearchParams()
    if (paper.doi) params.set('doi', paper.doi)
    if (paper.pmid) params.set('pmid', paper.pmid)
    if (paper.pmcid) params.set('pmcid', paper.pmcid)
    apiGet(`/pdf-url?${params}`)
      .then(data => {
        if (data.ok && data.url) {
          setPdfUrl(data.url)
          setPdfOriginalUrl(data.original_url || data.url)
        } else {
          setPdfUrlError(data.error || '未找到免费全文')
        }
      })
      .catch(() => setPdfUrlError('查询失败'))
      .finally(() => setPdfUrlLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper])

  // ── tour (unchanged) ──
  useEffect(() => {
    if (!paper || paperTourStartedRef.current) return
    if (localStorage.getItem('pm-paper-tour-done')) return
    paperTourStartedRef.current = true
    const t = setTimeout(() => {
      localStorage.setItem('pm-paper-tour-done', '1')
      setPaperTourStep(1)
    }, 1000)
    return () => clearTimeout(t)
  }, [paper])

  function advancePaperTour() {
    if (paperTourStep >= 3) {
      localStorage.setItem('pm-paper-tour-done', '1')
      setPaperTourStep(0)
    } else setPaperTourStep(s => s + 1)
  }

  const triggerRipple = () => {
    setRipple(true); setTimeout(() => setRipple(false), 700)
  }

  // ── bookmark flow (unchanged) ──
  const saveToProject = async (projectId) => {
    setShowProjectPicker(false)
    try {
      const data = await apiPost('/library/save', { paper, chats: chatMessages })
      setSavedRowId(data.id)
      localStorage.setItem(`paper-bookmark-${sliceId(paper, id)}`, String(data.id))
      setBookmarked(true)
      triggerRipple()
      if (projectId !== null) {
        apiPatch(`/library/${data.id}/project`, { project_id: projectId }).catch(() => {})
      }
      if (notes) apiPost('/notes', { paper_rowid: data.id, content: notes }).catch(() => {})
    } catch { /* ignore */ }
  }

  const toggleBookmark = async () => {
    if (!paper) return
    if (bookmarked && savedRowId) {
      await apiDelete(`/library/${savedRowId}`).catch(() => {})
      localStorage.removeItem(`paper-bookmark-${sliceId(paper, id)}`)
      setBookmarked(false); setSavedRowId(null)
    } else {
      if (projects.length > 0) {
        setShowProjectPicker(true)
        setTimeout(() => projectPickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
      } else {
        await saveToProject(null)
      }
    }
  }

  // ── selection bubble → preload quote ──
  const askAboutSelection = () => {
    if (!selection) return
    setPendingQuote({
      text: selection.text,
      page: selection.page,
      section: null, // TODO(backend): pdfjs 给的纯文本无 section 信息，需要后端 /papers/<id>/sections 或前端做 outline 匹配
      createdAt: new Date().toISOString(),
    })
    setSelection(null)
    setChatOpen(true)
    window.getSelection()?.removeAllRanges()
    setTimeout(() => {
      chatInputRef.current?.focus()
      chatFootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, 80)
  }

  // ── send chat (extended: attach pendingQuote if present) ──
  const handleSendChat = async () => {
    if (!chatInput.trim() || chatLoading) return
    const userMsg = {
      role: 'user',
      content: chatInput,
      ...(pendingQuote ? { _quote: pendingQuote } : {}),
    }
    setChatMessages(prev => [...prev, userMsg])
    const sentQuote = pendingQuote
    setChatInput('')
    setPendingQuote(null)
    setChatLoading(true)

    try {
      const data = await apiPost('/chat', {
        paper_title: paper?.title || '',
        paper_abstract: paper?.abstract || '',
        message: sentQuote
          ? `[引用 p.${sentQuote.page}] "${sentQuote.text}"\n\n${chatInput}`
          : chatInput,
        history: chatMessages,
        paper_rowid: savedRowId || 0,
      })
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: '连接失败，请重试。' }])
    } finally {
      setChatLoading(false)
      setSummarized(false)
    }
  }

  // ── summarize chat (unchanged) ──
  const handleSummarizeChat = async () => {
    if (chatMessages.length < 2 || summarizing) return
    setSummarizeError(null)
    let rowId = savedRowId
    if (!rowId && paper) {
      try {
        const data = await apiPost('/library/save', { paper, chats: chatMessages })
        rowId = data.id
        setSavedRowId(rowId)
        localStorage.setItem(`paper-bookmark-${sliceId(paper, id)}`, String(rowId))
        setBookmarked(true)
      } catch {
        setSummarizeError('自动收藏失败，请先手动收藏这篇论文。')
        return
      }
    }
    setSummarizing(true)
    try {
      const data = await apiPost('/chat/summarize', {
        paper_title: paper?.title || '',
        paper_rowid: rowId,
        messages: chatMessages,
      })
      if (data.ok) { setSummarized(true); triggerRipple() }
      else setSummarizeError(data.error || '总结失败，请重试。')
    } catch { setSummarizeError('网络错误，请重试。') }
    finally { setSummarizing(false) }
  }

  // ── export (unchanged) ──
  const handleExport = async (format) => {
    recordActionOnce(`export_${format}`)
    if (savedRowId) {
      window.open(`${API_BASE}/export/${format}/${savedRowId}`, '_blank')
    } else {
      const resp = await fetch(`${API_BASE}/export/${format}-direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': getUserId() },
        body: JSON.stringify({ paper }),
      })
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `paper.${format === 'bibtex' ? 'bib' : 'ris'}`
      a.click()
      URL.revokeObjectURL(url)
    }
    setShowExport(false)
  }

  // ── title translate (unchanged) ──
  const toggleTitleZh = async () => {
    if (!titleZh && !titleTranslating) {
      setTitleTranslating(true)
      try {
        const data = await apiPost('/translate', { text: paper.title })
        if (data.ok) { setTitleZh(data.translated); setShowTitleZh(true) }
      } catch { /* ignore */ }
      finally { setTitleTranslating(false) }
    } else setShowTitleZh(s => !s)
  }

  // ── jump to quote ──
  const jumpToQuote = (q) => {
    if (q.page && pdfViewerRef.current) {
      pdfViewerRef.current.goToPage(q.page)
    }
  }

  // ── loading states ──
  if (paperLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={24} className="text-coral animate-spin"/>
      </div>
    )
  }
  if (!paper) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center">
        <div>
          <p className="text-warm-gray mb-4">论文数据未找到</p>
          <Link to="/" className="text-coral text-sm">返回首页</Link>
        </div>
      </div>
    )
  }

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════
  return (
    <div className="h-screen overflow-hidden bg-cream text-navy flex flex-col">

      {/* ─── slim topbar (重用 Navbar 风格但更窄) ─── */}
      <div className="flex items-center justify-between px-7 h-[54px] border-b border-cream-dark/60 bg-cream/90 backdrop-blur shrink-0 z-50">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-warm-gray hover:text-navy transition-colors">
          <ArrowLeft size={14}/> <span>返回首页</span>
        </Link>
        <div className="flex items-center gap-3 font-mono text-[10.5px] tracking-widest uppercase text-warm-gray/70">
          {paper.pmid && <span>PMID {paper.pmid}</span>}
          {pdfUrl && <span className="text-mint-deep">PDF 已加载</span>}
          {pdfUrlError && <span className="text-coral/70">无免费全文</span>}
        </div>
      </div>

      {/* ─── 3-pane main ─── */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[240px_1fr_420px] xl:grid-cols-[240px_1fr_420px] 2xl:grid-cols-[260px_1fr_440px]">

        {/* ───── LEFT RAIL (hidden on mobile, optionally on tablet) ───── */}
        <aside className="hidden lg:flex flex-col border-r border-navy/5 bg-warm-white/55 overflow-y-auto px-5 py-5">
          <RailContent
            paper={paper}
            bookmarked={bookmarked}
            onToggleBookmark={toggleBookmark}
            bookmarkBtnRef={bookmarkBtnRef}
            ripple={ripple}
            externalLinkRef={externalLinkRef}
            onExport={handleExport}
            showExport={showExport}
            setShowExport={setShowExport}
            recordActionOnce={recordActionOnce}
            currentPage={currentPage}
          />
        </aside>

        {/* ───── MIDDLE PDF ───── */}
        <main className="min-w-0 flex flex-col overflow-hidden">
          {/* mobile tab switcher (只在 lg 以下出现) */}
          <div className="lg:hidden flex gap-1 px-3 py-1.5 border-b border-cream-dark/40 bg-warm-white shrink-0">
            {[
              { v: 'pdf', label: 'PDF' },
              { v: 'meta', label: '元信息' },
              { v: 'chat', label: '记忆 & 对话' },
            ].map(t => (
              <button key={t.v}
                onClick={() => setMobileTab(t.v)}
                className={`px-3 py-1 rounded-full text-xs ${mobileTab === t.v ? 'bg-navy text-warm-white' : 'text-warm-gray'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* PDF area */}
          <div className={`flex-1 min-h-0 relative ${mobileTab === 'pdf' ? '' : 'hidden lg:block'}`}>
            {pdfUrlLoading && (
              <div className="absolute inset-0 flex items-center justify-center text-warm-gray text-sm gap-2 pointer-events-none">
                <Loader2 size={16} className="animate-spin text-coral"/>
                寻找 PDF 全文...
              </div>
            )}
            {!pdfUrlLoading && pdfUrl && (
              <PdfViewer
                ref={pdfViewerRef}
                url={pdfUrl}
                originalUrl={pdfOriginalUrl}
                onSelection={setSelection}
                onPageChange={setCurrentPage}
                sectionHint={null}
                headerRight={
                  quotes.length > 0 && (
                    <span className="font-mono text-[10px] tracking-wider uppercase">
                      <span className="text-coral">{quotes.length} quotes</span> on this paper
                    </span>
                  )
                }
              />
            )}
            {!pdfUrlLoading && !pdfUrl && (
              <NoPdfState paper={paper} error={pdfUrlError}/>
            )}

            {/* selection bubble */}
            {selection && (
              <button
                onClick={askAboutSelection}
                className="absolute z-20 flex items-center gap-2 px-3.5 py-2 rounded-full bg-navy text-warm-white text-sm font-medium shadow-[0_6px_22px_-6px_rgba(30,58,95,.45)] hover:bg-navy-light transition-all"
                style={{
                  left: selection.x,
                  top: selection.y - 12,
                  transform: 'translate(-50%, -100%)',
                }}>
                <Sparkles size={13}/>
                问 papermind 关于这段
                <span className="font-mono text-[10px] tracking-wider uppercase opacity-70 pl-1.5 ml-1.5 border-l border-white/20">
                  ↵ enter
                </span>
              </button>
            )}
          </div>

          {/* mobile-only meta tab */}
          <div className={`flex-1 min-h-0 overflow-y-auto p-5 lg:hidden ${mobileTab === 'meta' ? '' : 'hidden'}`}>
            <RailContent
              paper={paper}
              bookmarked={bookmarked}
              onToggleBookmark={toggleBookmark}
              bookmarkBtnRef={bookmarkBtnRef}
              ripple={ripple}
              externalLinkRef={externalLinkRef}
              onExport={handleExport}
              showExport={showExport}
              setShowExport={setShowExport}
              recordActionOnce={recordActionOnce}
              currentPage={currentPage}
            />
          </div>
        </main>

        {/* ───── RIGHT MEMORY CHANNEL ───── */}
        <aside className={`border-l border-navy/5 bg-cream flex flex-col overflow-hidden lg:flex ${mobileTab === 'chat' ? 'flex' : 'hidden lg:flex'}`}>
          <MemoryChannel
            paper={paper}
            quotes={quotes}
            chatMessages={chatMessages}
            chatLoading={chatLoading}
            chatInput={chatInput}
            setChatInput={setChatInput}
            handleSendChat={handleSendChat}
            handleSummarizeChat={handleSummarizeChat}
            summarizing={summarizing}
            summarized={summarized}
            summarizeError={summarizeError}
            speechSupported={speechSupported}
            listening={listening}
            startListening={startListening}
            stopListening={stopListening}
            pendingQuote={pendingQuote}
            setPendingQuote={setPendingQuote}
            chatOpen={chatOpen}
            setChatOpen={setChatOpen}
            chatEndRef={chatEndRef}
            chatInputRef={chatInputRef}
            chatFootRef={chatFootRef}
            jumpToQuote={jumpToQuote}
            // bookmark + project picker passthrough
            bookmarked={bookmarked}
            onToggleBookmark={toggleBookmark}
            projects={projects}
            showProjectPicker={showProjectPicker}
            setShowProjectPicker={setShowProjectPicker}
            projectPickerRef={projectPickerRef}
            saveToProject={saveToProject}
            // title translate + notes (compact)
            titleZh={titleZh}
            showTitleZh={showTitleZh}
            titleTranslating={titleTranslating}
            onToggleTitleZh={toggleTitleZh}
            notes={notes}
            setNotes={setNotes}
            abstractZh={abstractZh}
            translating={translating}
            showTranslation={showTranslation}
            setShowTranslation={setShowTranslation}
            setAbstractZh={setAbstractZh}
            setTranslating={setTranslating}
          />
        </aside>
      </div>

      {/* ─── tour ─── */}
      {paperTourStep === 1 && <TourBubble targetRef={bookmarkBtnRef} text="点击收藏，笔记和对话都会永久保存" step={1} total={3} placement="bottom" onNext={advancePaperTour}/>}
      {paperTourStep === 2 && externalLinkRef.current && <TourBubble targetRef={externalLinkRef} text="跳转到 PubMed 查看原文" step={2} total={3} placement="bottom" onNext={advancePaperTour}/>}
      {paperTourStep === 3 && <TourBubble targetRef={chatFootRef} text="划选 PDF 里的句子 → 这里会带着引用追问；对话会自动归档" step={3} total={3} placement="top" onNext={advancePaperTour}/>}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// RAIL (left)
// ═════════════════════════════════════════════════════════════
function RailContent({
  paper, bookmarked, onToggleBookmark, bookmarkBtnRef, ripple,
  externalLinkRef, onExport, showExport, setShowExport, recordActionOnce,
  currentPage,
}) {
  // TODO(backend): real TOC from pdfjs outline (pdf.getOutline()) — 这里先用静态映射
  // 让 PdfViewer 在 onLoad 时 emit outline 给父，再传进来。Stage 1 用 page-based fallback。
  return (
    <>
      <p className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70 mb-3">paper</p>

      {/* 分类 + source */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-coral/10 text-coral font-medium">
          {paper.category || '未分类'}
        </span>
        {paper.source && (
          <span className="text-[10px] text-warm-gray/60">
            {paper.source === 'pubmed' ? 'PubMed' : 'Semantic Scholar'}
          </span>
        )}
      </div>

      {/* 标题（紧凑） */}
      <h2 className="text-[15px] font-medium leading-snug mb-2 text-navy">
        {paper.title}
      </h2>
      <p className="text-xs text-warm-gray/70 mb-5 leading-relaxed">
        {paper.authors}
      </p>

      {/* metadata */}
      <h4 className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70 mb-2">Metadata</h4>
      <dl className="text-xs space-y-2 mb-5">
        <div>
          <dt className="text-warm-gray/60 mb-0.5">Journal</dt>
          <dd className="text-navy/80">{paper.journal || '—'}</dd>
        </div>
        <div>
          <dt className="text-warm-gray/60 mb-0.5">Published</dt>
          <dd className="text-navy/80">{paper.pub_date || '—'}</dd>
        </div>
        {paper.doi && (
          <div>
            <dt className="text-warm-gray/60 mb-0.5">DOI</dt>
            <dd className="font-mono text-[11px] text-navy/80 break-all">{paper.doi}</dd>
          </div>
        )}
      </dl>

      {/* actions */}
      <h4 className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70 mb-2">Actions</h4>
      <div className="flex flex-col gap-1.5">
        <button
          ref={bookmarkBtnRef}
          onClick={onToggleBookmark}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-all ripple-btn ${ripple ? 'ripple-active' : ''} ${
            bookmarked
              ? 'bg-coral/8 border-coral/30 text-coral-deep'
              : 'bg-warm-white border-navy/10 text-warm-gray hover:text-navy hover:border-navy/25'
          }`}>
          {bookmarked
            ? <><Bookmark size={12} className="fill-current"/> 已收藏</>
            : <><BookmarkPlus size={12}/> 收藏到 papermind</>}
        </button>

        {paper.link && (
          <a ref={externalLinkRef} href={paper.link} target="_blank" rel="noreferrer"
            onClick={() => recordActionOnce('open_external')}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border bg-warm-white border-navy/10 text-warm-gray hover:text-navy hover:border-navy/25">
            <ExternalLink size={12}/> 在 PubMed 打开
          </a>
        )}

        <div className="relative">
          <button onClick={() => setShowExport(!showExport)}
            className="w-full inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border bg-warm-white border-navy/10 text-warm-gray hover:text-navy hover:border-navy/25">
            <FileText size={12}/> 引用 (BibTeX / RIS)
          </button>
          {showExport && (
            <div className="absolute left-0 right-0 mt-1 bg-white rounded-xl shadow-lg border border-cream-dark/50 py-1 z-20">
              <button onClick={() => onExport('ris')} className="w-full text-left px-3 py-1.5 text-xs text-navy hover:bg-cream-dark/30">RIS (Zotero/EndNote)</button>
              <button onClick={() => onExport('bibtex')} className="w-full text-left px-3 py-1.5 text-xs text-navy hover:bg-cream-dark/30">BibTeX (LaTeX)</button>
            </div>
          )}
        </div>
      </div>

      {/* 你正在看 p.N (poor man's TOC sync) */}
      <div className="mt-6 pt-4 border-t border-navy/5">
        <p className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70 mb-1">Reading</p>
        <p className="text-xs text-navy/70">你正在看 <span className="font-mono text-coral">p.{currentPage}</span></p>
      </div>
    </>
  )
}

// ═════════════════════════════════════════════════════════════
// MEMORY CHANNEL (right)
// ═════════════════════════════════════════════════════════════
function MemoryChannel(props) {
  const {
    paper, quotes, chatMessages, chatLoading, chatInput, setChatInput,
    handleSendChat, handleSummarizeChat, summarizing, summarized, summarizeError,
    speechSupported, listening, startListening, stopListening,
    pendingQuote, setPendingQuote, chatOpen, setChatOpen,
    chatEndRef, chatInputRef, chatFootRef, jumpToQuote,
    bookmarked, onToggleBookmark, projects, showProjectPicker, setShowProjectPicker,
    projectPickerRef, saveToProject,
    titleZh, showTitleZh, titleTranslating, onToggleTitleZh,
    notes, setNotes,
    abstractZh, translating, showTranslation, setShowTranslation,
    setAbstractZh, setTranslating,
  } = props

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* WHY hero (compact) */}
      {paper.relevance && (
        <div className="px-6 py-5 bg-gradient-to-b from-coral/[0.07] to-coral/[0.02] border-b border-coral/15">
          <div className="flex items-center gap-2 mb-2.5 font-mono text-[10.5px] tracking-widest uppercase text-coral">
            <ReasonGlyph/>
            <span>为什么把这篇推给你</span>
          </div>
          <p className="text-[14.5px] leading-[1.65] text-navy font-medium" style={{ fontFamily: '"Noto Serif SC", serif' }}>
            {paper.relevance}
          </p>
        </div>
      )}

      {/* compact title block (no rail on mobile so we restate it) */}
      <div className="lg:hidden px-6 py-3 border-b border-navy/5">
        <p className="text-[11px] text-warm-gray/60 mb-1">{paper.journal} · {paper.pub_date}</p>
        <p className="text-sm font-medium text-navy leading-snug">{paper.title}</p>
      </div>

      {/* bookmark prompt */}
      {!bookmarked && (
        <div ref={projectPickerRef} className="px-6 py-3 border-b border-navy/5 bg-navy/[0.02]">
          {showProjectPicker ? (
            <div>
              <p className="text-xs text-warm-gray/60 mb-2">收藏到</p>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => saveToProject(null)}
                  className="px-2.5 py-1 text-xs rounded-lg border border-cream-dark text-warm-gray hover:text-navy">
                  直接收藏
                </button>
                {projects.map(p => (
                  <button key={p.id} onClick={() => saveToProject(p.id)}
                    className="px-2.5 py-1 text-xs rounded-lg bg-coral/5 border border-coral/25 text-coral hover:bg-coral/10">
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-warm-gray">收藏后笔记和对话永久保存</p>
              <button onClick={onToggleBookmark} className="text-xs text-coral font-medium hover:underline">收藏这篇</button>
            </div>
          )}
        </div>
      )}

      {/* ★ YOUR QUOTES */}
      <section className="px-6 py-4 border-b border-navy/5">
        <SectionHeader
          left={<><QuoteIcon size={11}/> 你在这篇里追问过</>}
          right={quotes.length > 0 ? `${quotes.length} 段` : null}
          accent="coral"/>
        {quotes.length === 0 ? (
          <div className="text-xs text-warm-gray/70 leading-relaxed py-3 px-3 border border-dashed border-navy/15 rounded-xl text-center">
            划选 PDF 中的文字，<br/>把它带进对话作为追问的起点
          </div>
        ) : (
          quotes.map(q => (
            <QuoteCard key={q.n} quote={q} onJump={() => jumpToQuote(q)}/>
          ))
        )}
      </section>

      {/* PROFILE PREVIEW
          TODO(backend): 真实派生需要 LLM 看完这次对话之后给出 add/strengthen 提议
          当前只在「收藏 + chat 中有 >= 2 个 user 消息」时 占位显示 */}
      {bookmarked && chatMessages.filter(m => m.role === 'user').length >= 2 && (
        <section className="px-6 py-4 border-b border-navy/5">
          <SectionHeader
            left={<><SproutGlyph/> 这篇会让画像往这里走</>}
            right="收藏时生效"
            accent="muted"/>
          <ProfileUpdatePreview paper={paper}/>
        </section>
      )}

      {/* NOTES — collapsible */}
      <details className="px-6 py-3 border-b border-navy/5 group">
        <summary className="cursor-pointer flex items-center justify-between text-[10.5px] font-mono tracking-widest uppercase text-warm-gray/70 hover:text-navy list-none">
          <span>我的笔记</span>
          <ChevronDown size={12} className="group-open:rotate-180 transition-transform"/>
        </summary>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="读完这篇，你想记下什么？"
          className="mt-2 w-full bg-warm-white rounded-lg px-3 py-2 text-sm text-navy border border-navy/10 outline-none resize-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 leading-relaxed min-h-[120px]"/>
        {notes && (
          <p className="text-[10.5px] text-warm-gray/60 mt-1 italic">
            {bookmarked ? '已自动保存到收藏' : '已保存到本地；收藏后永久'}
          </p>
        )}
      </details>

      {/* Title translate + abstract（次要） */}
      <details className="px-6 py-3 border-b border-navy/5 group">
        <summary className="cursor-pointer flex items-center justify-between text-[10.5px] font-mono tracking-widest uppercase text-warm-gray/70 hover:text-navy list-none">
          <span>标题翻译 · 摘要</span>
          <ChevronDown size={12} className="group-open:rotate-180 transition-transform"/>
        </summary>

        <div className="mt-2 mb-3">
          <button onClick={onToggleTitleZh}
            disabled={titleTranslating}
            className="inline-flex items-center gap-1 text-xs text-warm-gray hover:text-navy disabled:opacity-50">
            {titleTranslating
              ? <><Loader2 size={11} className="animate-spin"/> 翻译中…</>
              : <><Languages size={11}/> {showTitleZh ? '回到原文' : '中文标题'}</>}
          </button>
          {showTitleZh && titleZh && (
            <p className="text-sm text-navy/80 mt-1 leading-snug" style={{ fontFamily: '"Noto Serif SC", serif' }}>{titleZh}</p>
          )}
        </div>

        {paper.abstract && (
          <div className="text-xs text-navy/70 leading-relaxed">
            <div className="flex items-center justify-between mb-1">
              <span className="text-warm-gray/60">{showTranslation ? '中文翻译' : 'Abstract'}</span>
              <button
                onClick={async () => {
                  if (!abstractZh && !translating) {
                    setTranslating(true)
                    try {
                      const data = await apiPost('/translate', { text: paper.abstract })
                      if (data.ok) { setAbstractZh(data.translated); setShowTranslation(true) }
                    } catch { /* ignore */ }
                    finally { setTranslating(false) }
                  } else setShowTranslation(!showTranslation)
                }}
                disabled={translating}
                className="inline-flex items-center gap-1 text-[11px] text-warm-gray hover:text-navy">
                {translating ? <><Loader2 size={10} className="animate-spin"/> 翻译中…</> : <><Languages size={10}/> {showTranslation ? '原文' : '译'}</>}
              </button>
            </div>
            <p>{showTranslation && abstractZh ? abstractZh : paper.abstract}</p>
          </div>
        )}
      </details>

      {/* spacer */}
      <div className="flex-1"/>

      {/* CHAT FOOT (sticky) */}
      <div ref={chatFootRef} className="sticky bottom-0 bg-cream/96 backdrop-blur border-t border-navy/8 z-10">
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className="w-full px-5 py-3 flex items-center gap-2.5 text-sm font-medium text-navy">
          <MessageSquare size={14} className="text-coral"/>
          {pendingQuote ? '继续这段追问' : (chatMessages.length > 0 ? `对话 · ${chatMessages.length} 条` : '想和这篇聊点什么')}
          <span className="ml-auto font-mono text-[9.5px] tracking-widest uppercase text-warm-gray/70">
            claude · 会保存
          </span>
          {chatOpen ? <ChevronDown size={13}/> : <ChevronUp size={13}/>}
        </button>

        {chatOpen && (
          <div className="px-5 pb-4">
            {/* messages */}
            {chatMessages.length > 0 && (
              <div className="max-h-[260px] overflow-y-auto space-y-2 mb-3 -mx-1 px-1">
                {chatMessages.map((m, i) => (
                  <div key={i} className={`text-[13px] px-3 py-2 rounded-xl leading-relaxed ${
                    m.role === 'user' ? 'bg-navy text-warm-white ml-6' : 'bg-warm-white text-navy/85 mr-6 border border-navy/5'
                  }`}>
                    {m._quote && (
                      <p className="font-mono text-[9.5px] tracking-widest uppercase opacity-70 mb-1">
                        ↳ 引用 p.{m._quote.page}
                      </p>
                    )}
                    {m.role === 'assistant' ? (
                      <ReactMarkdown components={{
                        p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-1">{children}</ol>,
                      }}>{m.content}</ReactMarkdown>
                    ) : m.content}
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex items-center gap-2 text-warm-gray text-xs">
                    <Loader2 size={12} className="animate-spin"/> 思考中…
                  </div>
                )}
                <div ref={chatEndRef}/>
              </div>
            )}

            {/* pending quote preload */}
            {pendingQuote && (
              <div className="bg-coral/[0.06] border-l-2 border-coral pl-3 pr-7 py-2 rounded-r-lg mb-2 relative">
                <p className="italic text-[12.5px] leading-snug text-navy/75" style={{ fontFamily: '"Source Serif Pro", Georgia, serif' }}>
                  &ldquo;{pendingQuote.text}&rdquo;
                </p>
                <p className="font-mono text-[9.5px] tracking-widest uppercase text-coral-deep mt-1.5">
                  QUOTING · p.{pendingQuote.page}
                </p>
                <button onClick={() => setPendingQuote(null)}
                  className="absolute top-1.5 right-1.5 p-0.5 text-warm-gray hover:text-navy">
                  <X size={12}/>
                </button>
              </div>
            )}

            {/* summarize */}
            {chatMessages.length >= 2 && (
              <>
                <button onClick={handleSummarizeChat} disabled={summarizing || summarized}
                  className={`w-full py-1.5 rounded-lg text-[11px] font-medium mb-2 flex items-center justify-center gap-1.5 transition-all ${
                    summarized ? 'bg-mint/20 text-navy' : 'border border-coral/25 text-coral hover:bg-coral/5'
                  } disabled:opacity-60`}>
                  {summarizing ? <><Loader2 size={11} className="animate-spin"/>正在总结…</>
                    : summarized ? <><FileText size={11}/>已保存到笔记</>
                    : <><FileText size={11}/>把这段对话存为笔记</>}
                </button>
                {summarizeError && <p className="text-[11px] text-coral mb-2 text-center">{summarizeError}</p>}
              </>
            )}

            {/* input */}
            <div className="flex gap-2 items-center">
              <input
                ref={chatInputRef}
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                placeholder={pendingQuote ? '这一段你想问什么？' : '或者直接问…'}
                className="flex-1 bg-warm-white rounded-xl px-3 py-2 text-sm text-navy border border-navy/10 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 placeholder:text-warm-gray/50"/>
              {speechSupported && (
                <button onClick={listening ? stopListening : startListening} type="button"
                  className={`p-2 rounded-xl ${listening ? 'bg-coral text-warm-white animate-pulse' : 'bg-cream-dark/60 text-warm-gray hover:text-navy'}`}>
                  {listening ? <MicOff size={14}/> : <Mic size={14}/>}
                </button>
              )}
              <button onClick={handleSendChat} disabled={chatLoading}
                className="p-2 bg-navy text-warm-white rounded-xl hover:bg-navy-light disabled:opacity-50">
                <Send size={14}/>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// helpers / sub-components
// ═════════════════════════════════════════════════════════════
function SectionHeader({ left, right, accent }) {
  const accentClass = accent === 'coral' ? 'text-coral' : 'text-warm-gray'
  return (
    <div className="flex items-baseline justify-between mb-3">
      <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-widest uppercase ${accentClass}`}>
        {left}
      </span>
      {right && <span className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70">{right}</span>}
    </div>
  )
}

function QuoteCard({ quote, onJump }) {
  return (
    <div className="bg-warm-white border border-navy/8 rounded-xl px-3.5 py-3 mb-2.5 cursor-pointer hover:border-coral/35 hover:-translate-y-px transition-all relative"
      onClick={onJump}>
      <span className="absolute top-2.5 right-3 font-mono text-[9.5px] tracking-wider text-coral bg-coral/10 px-1.5 rounded">
        #{quote.n}
      </span>
      <p className="border-l-2 border-coral pl-2.5 italic text-[12.5px] leading-snug text-navy/78 mr-8 mb-2"
        style={{ fontFamily: '"Source Serif Pro", Georgia, serif' }}>
        &ldquo;{quote.text.length > 220 ? quote.text.slice(0, 220) + '…' : quote.text}&rdquo;
      </p>
      <p className="text-[11px] text-warm-gray font-mono tracking-wider uppercase mb-2">
        <span className="text-coral-deep">P.{quote.page}</span>
        {quote.section && <> · {quote.section}</>}
        <> · {fmtRelativeTime(quote.createdAt)}</>
      </p>
      {quote.question && (
        <div className="bg-mint/10 rounded-lg px-2.5 py-1.5 text-[12px] leading-snug text-navy/82">
          <span className="font-mono text-[9.5px] tracking-widest uppercase text-mint-deep mr-1.5">Q</span>
          {quote.question}
        </div>
      )}
    </div>
  )
}

function fmtRelativeTime(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  return new Date(iso).toLocaleDateString()
}

function NoPdfState({ paper, error }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="bg-warm-white border border-dashed border-navy/15 rounded-2xl p-8 text-center max-w-md">
        <p className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/60 mb-3">no free pdf</p>
        <p className="text-sm text-navy mb-2">这篇没有免费全文</p>
        <p className="text-xs text-warm-gray leading-relaxed mb-5">
          {error || '右栏的摘要和解读照常可读，也能在 PubMed 跳转原文。'}
        </p>
        {paper.link && (
          <a href={paper.link} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-coral/30 text-coral hover:bg-coral/5">
            <ExternalLink size={11}/> 在 PubMed 打开原文
          </a>
        )}
      </div>
    </div>
  )
}

function ProfileUpdatePreview({ paper }) {
  // TODO(backend): 看完 chat 后由后端给出真实的画像更新建议
  // 当前是从 paper.relevance 抽 1-2 个高频词做占位
  const candidates = (paper.relevance || '')
    .split(/[，、,。\s]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 8)
    .slice(0, 2)
  if (candidates.length === 0) return null
  return (
    <div className="bg-mint/10 border border-mint/30 rounded-xl px-3.5 py-3">
      <div className="flex flex-col gap-1.5 mb-3">
        {candidates.map((tag, i) => (
          <div key={tag} className="flex items-center gap-2 text-[12.5px] text-navy">
            <span className="font-mono text-[11.5px] text-mint-deep w-3">+</span>
            <span className={`text-[11.5px] px-2 py-0.5 rounded-full ${
              i === 0 ? 'bg-coral/13 text-coral-deep' : 'bg-mint/20 text-mint-deep'
            }`}>{tag}</span>
            <span className="text-[10.5px] text-warm-gray">{i === 0 ? '新方向' : '强化'}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        <button className="text-[11px] px-3 py-1 rounded-full bg-mint-deep text-warm-white">采纳</button>
        <button className="text-[11px] px-3 py-1 rounded-full border border-mint/40 text-mint-deep">改一下</button>
        <button className="text-[11px] px-3 py-1 rounded-full text-warm-gray">不要</button>
      </div>
    </div>
  )
}
