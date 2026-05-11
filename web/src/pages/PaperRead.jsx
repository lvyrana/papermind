import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, Sparkles, Send, BookmarkPlus, Bookmark, Loader2, FileText, Download, ExternalLink, Languages, Mic, MicOff } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { apiGet, apiPost, apiDelete, apiPatch, API_BASE, getUserId } from '../api'
import { useSpeechInput } from '../hooks/useSpeechInput'
import TourBubble from '../components/TourBubble'

export default function PaperRead() {
  const { id } = useParams()
  const location = useLocation()
  const [paper, setPaper] = useState(location.state?.paper || null)
  const [paperLoading, setPaperLoading] = useState(!location.state?.paper)

  const [notes, setNotes] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const { listening, supported: speechSupported, startListening, stopListening } = useSpeechInput(
    (text) => setChatInput(prev => prev ? prev + ' ' + text : text)
  )
  const [summarizing, setSummarizing] = useState(false)
  const [summarized, setSummarized] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [savedRowId, setSavedRowId] = useState(null)
  const [activeTab, setActiveTab] = useState('chat')
  const [showExport, setShowExport] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [ripple, setRipple] = useState(false)
  const [abstractZh, setAbstractZh] = useState(null)
  const [translating, setTranslating] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const [titleZh, setTitleZh] = useState(null)
  const [showTitleZh, setShowTitleZh] = useState(false)
  const [titleTranslating, setTitleTranslating] = useState(false)
  const [titleTranslateError, setTitleTranslateError] = useState(null)
  const [summarizeError, setSummarizeError] = useState(null)
  const [projects, setProjects] = useState([])
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const chatEndRef = useRef(null)
  const readingRecordedRef = useRef(false)
  const actionRecordedRef = useRef({})
  const [paperTourStep, setPaperTourStep] = useState(0)
  const bookmarkBtnRef = useRef(null)
  const externalLinkRef = useRef(null)
  const chatTabRef = useRef(null)
  const paperTourStartedRef = useRef(false)
  const projectPickerRef = useRef(null)

  // 如果 location.state 没有 paper（刷新/直链），尝试从后端恢复
  useEffect(() => {
    if (paper) { setPaperLoading(false); return }
    // 先尝试从缓存按索引获取
    apiGet(`/papers/${id}`)
      .then(data => {
        if (data.paper) {
          setPaper(data.paper)
        } else {
          // 尝试从 localStorage 恢复
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

  const recordEngagement = (reason) => {
    if (!paper?.title) return Promise.resolve()
    return apiPost('/reading-history', {
      title: paper.title,
      paper_rowid: savedRowId || 0,
      reason,
    }).catch(() => {})
  }

  const recordActionOnce = (key) => {
    if (actionRecordedRef.current[key]) return
    actionRecordedRef.current[key] = true
    recordEngagement(key)
  }

  // 记录最近阅读位置；停留超过 20 秒后才算一次有效阅读
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, id])

  // 读取本地笔记 + 已收藏状态
  useEffect(() => {
    const key = `paper-notes-${paper?.pmid || paper?.paper_id || id}`
    const saved = localStorage.getItem(key)
    if (saved) setNotes(saved)

    const bk = localStorage.getItem(`paper-bookmark-${paper?.pmid || paper?.paper_id || id}`)
    if (bk) {
      setBookmarked(true)
      setSavedRowId(parseInt(bk))
    }

    // 从 localStorage 恢复对话记录（未收藏的论文）
    const chatKey = `paper-chat-${paper?.pmid || paper?.paper_id || id}`
    const savedChat = localStorage.getItem(chatKey)
    if (savedChat) {
      try { setChatMessages(JSON.parse(savedChat)) } catch { /* ignore */ }
    }
  }, [paper, id])

  useEffect(() => {
    apiGet('/projects').then(data => setProjects(data.projects || [])).catch(() => {})
  }, [])

  // 如果已收藏，从后端加载对话历史（覆盖 localStorage）
  useEffect(() => {
    if (!savedRowId) return
    apiGet(`/library/${savedRowId}`)
      .then(data => {
        if (data.chats?.length) setChatMessages(data.chats)
        if (data.notes?.length) setNotes(data.notes[0].content)
      })
      .catch(() => {})
  }, [savedRowId])

  // 保存笔记到 localStorage + 后端
  useEffect(() => {
    if (!paper || !notes) return
    const key = `paper-notes-${paper.pmid || paper.paper_id || id}`
    localStorage.setItem(key, notes)

    // 更新上次阅读
    const lastReading = JSON.parse(localStorage.getItem('last-reading') || '{}')
    if (lastReading.index === id) {
      lastReading.note = notes.slice(0, 60)
      localStorage.setItem('last-reading', JSON.stringify(lastReading))
    }

    // 如果已收藏，也保存到后端
    if (savedRowId) {
      const timer = setTimeout(() => {
        apiPost('/notes', { paper_rowid: savedRowId, content: notes }).catch(() => {})
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [notes, paper, id, savedRowId])

  // 对话记录自动保存到 localStorage（刷新不丢失）
  useEffect(() => {
    if (!paper || chatMessages.length === 0) return
    const chatKey = `paper-chat-${paper.pmid || paper.paper_id || id}`
    localStorage.setItem(chatKey, JSON.stringify(chatMessages))
  }, [chatMessages, paper, id])

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
    } else {
      setPaperTourStep(s => s + 1)
    }
  }

  const triggerRipple = () => {
    setRipple(true)
    setTimeout(() => setRipple(false), 700)
  }

  // 新消息时滚动到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  const saveToProject = async (projectId) => {
    setShowProjectPicker(false)
    try {
      const data = await apiPost('/library/save', { paper, chats: chatMessages })
      setSavedRowId(data.id)
      localStorage.setItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`, String(data.id))
      setBookmarked(true)
      triggerRipple()
      if (projectId !== null) {
        apiPatch(`/library/${data.id}/project`, { project_id: projectId }).catch(() => {})
      }
      if (notes) {
        apiPost('/notes', { paper_rowid: data.id, content: notes }).catch(() => {})
      }
    } catch { /* ignore */ }
  }

  const toggleBookmark = async () => {
    if (!paper) return

    if (bookmarked && savedRowId) {
      // 取消收藏
      await apiDelete(`/library/${savedRowId}`).catch(() => {})
      localStorage.removeItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`)
      setBookmarked(false)
      setSavedRowId(null)
    } else {
      if (projects.length > 0) {
        setShowProjectPicker(true)
        setTimeout(() => projectPickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
      } else {
        await saveToProject(null)
      }
    }
  }

  const handleSendChat = async () => {
    if (!chatInput.trim() || chatLoading) return
    const userMsg = { role: 'user', content: chatInput }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const data = await apiPost('/chat', {
        paper_title: paper?.title || '',
        paper_abstract: paper?.abstract || '',
        message: chatInput,
        history: chatMessages,
        paper_rowid: savedRowId || 0,
      })
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: '连接失败，请重试。' }])
    } finally {
      setChatLoading(false)
      setSummarized(false) // 新对话后可以重新总结
    }
  }

  const handleSummarizeChat = async () => {
    if (chatMessages.length < 2 || summarizing) return
    setSummarizeError(null)

    // 如果还没收藏，先收藏
    let rowId = savedRowId
    if (!rowId && paper) {
      try {
        const data = await apiPost('/library/save', { paper, chats: chatMessages })
        rowId = data.id
        setSavedRowId(rowId)
        localStorage.setItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`, String(rowId))
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
      if (data.ok) {
        setSummarized(true)
        triggerRipple()
        setActiveTab('chat')
      } else {
        setSummarizeError(data.error || '总结失败，请重试。')
      }
    } catch {
      setSummarizeError('网络错误，请重试。')
    } finally { setSummarizing(false) }
  }

  const handleExport = async (format) => {
    recordActionOnce(`export_${format}`)
    if (savedRowId) {
      window.open(`${API_BASE}/export/${format}/${savedRowId}`, '_blank')
    } else {
      // Use POST for direct export
      const resp = await fetch(`${API_BASE}/export/${format}-direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': getUserId() },
        body: JSON.stringify({ paper }),
      })
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `paper.${format === 'bibtex' ? 'bib' : 'ris'}`
      a.click()
      URL.revokeObjectURL(url)
    }
    setShowExport(false)
  }

  const handleDownloadPdf = async () => {
    setPdfLoading(true)
    try {
      const params = new URLSearchParams()
      if (paper.doi) params.set('doi', paper.doi)
      if (paper.pmid) params.set('pmid', paper.pmid)
      if (paper.pmcid) params.set('pmcid', paper.pmcid)
      const data = await apiGet(`/pdf-url?${params}`)
      if (data.ok) {
        recordActionOnce('download_pdf')
        window.open(data.url, '_blank')
      } else {
        alert(data.error || '未找到免费全文')
      }
    } catch {
      alert('查询失败，请稍后重试')
    } finally {
      setPdfLoading(false)
    }
  }

  if (paperLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={24} className="text-coral animate-spin" />
      </div>
    )
  }

  if (!paper) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-warm-gray mb-4">论文数据未找到</p>
          <Link to="/" className="text-coral text-sm">返回首页</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden lg:flex bg-warm-white">

      {/* ── 左栏：论文参照区 ────────────────────────── */}
      <div className="lg:flex-1 lg:min-w-0 lg:flex lg:flex-col lg:overflow-hidden lg:border-r lg:border-cream-dark/50">

        {/* 顶部导航 + 操作按钮 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-cream-dark/40 bg-warm-white sticky top-0 z-10 lg:static gap-3">
          <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm hover:text-navy transition-colors shrink-0">
            <ArrowLeft size={16} />
            <span>返回</span>
          </Link>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {/* 收藏按钮（移动端显示在这里） */}
            <button onClick={toggleBookmark}
              className={`lg:hidden p-1.5 rounded-full hover:bg-cream-dark/50 transition-colors ripple-btn ${ripple ? 'ripple-active' : ''}`}>
              {bookmarked ? <Bookmark size={17} className="text-coral fill-coral" /> : <BookmarkPlus size={17} className="text-warm-gray" />}
            </button>
            {paper.link && (
              <a ref={externalLinkRef} href={paper.link} target="_blank" rel="noopener noreferrer"
                onClick={() => recordActionOnce('open_external')}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all">
                <ExternalLink size={11} />
                原文
              </a>
            )}
            <button onClick={handleDownloadPdf}
              disabled={pdfLoading || (!paper.doi && !paper.pmid)}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all disabled:opacity-40">
              {pdfLoading ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
              PDF
            </button>
            <div className="relative">
              <button onClick={() => setShowExport(!showExport)}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all">
                <FileText size={11} />
                引用
              </button>
              {showExport && (
                <div className="absolute top-full right-0 mt-1 bg-white rounded-xl shadow-lg border border-cream-dark/50 py-1 z-20 min-w-[160px]">
                  <button onClick={() => handleExport('ris')} className="w-full text-left px-4 py-2 text-sm text-navy hover:bg-cream-dark/30 transition-colors">RIS (Zotero/EndNote)</button>
                  <button onClick={() => handleExport('bibtex')} className="w-full text-left px-4 py-2 text-sm text-navy hover:bg-cream-dark/30 transition-colors">BibTeX (LaTeX)</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 论文内容（可独立滚动） */}
        <div className="lg:flex-1 lg:overflow-y-auto px-6 py-6">
          {/* 分类标签 */}
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs px-2.5 py-1 rounded-full bg-coral/10 text-coral font-medium">
              {paper.category || '未分类'}
            </span>
            {paper.source && (
              <span className="text-xs text-warm-gray/50">
                {paper.source === 'pubmed' ? 'PubMed' : 'Semantic Scholar'}
              </span>
            )}
          </div>

          {/* 标题 */}
          <div>
            <h1 className={`${showTitleZh && titleZh ? 'pm-paper-title-zh' : 'pm-paper-title-en'} text-[23px]`}>
              {showTitleZh && titleZh ? titleZh : paper.title}
            </h1>
            <button
              onClick={async () => {
                if (!titleZh && !titleTranslating) {
                  setTitleTranslating(true)
                  setTitleTranslateError(null)
                  try {
                    const data = await apiPost('/translate', { text: paper.title })
                    if (data.ok) { setTitleZh(data.translated); setShowTitleZh(true) }
                  } catch { setTitleTranslateError('标题翻译暂时失败，请稍后再试') }
                  finally { setTitleTranslating(false) }
                } else {
                  setTitleTranslateError(null)
                  setShowTitleZh(!showTitleZh)
                }
              }}
              disabled={titleTranslating}
              className="mt-1 inline-flex items-center gap-1 text-xs text-warm-gray/50 hover:text-warm-gray transition-colors disabled:opacity-40"
            >
              {titleTranslating ? <><Loader2 size={11} className="animate-spin" /> 翻译中...</> : <><Languages size={11} /> {showTitleZh ? '原文' : '中文'}</>}
            </button>
            {titleTranslateError && <p className="mt-1 text-xs text-coral">{titleTranslateError}</p>}
          </div>
          <p className="text-warm-gray text-sm mt-2 mb-5">
            {paper.authors} &middot; {paper.journal} &middot; {paper.pub_date}
          </p>

          {/* 为什么和你相关 */}
          {paper.relevance && (
            <div className="bg-coral/5 rounded-2xl p-5 mb-4 border border-coral/10">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles size={14} className="text-coral" />
                <h3 className="text-sm font-medium text-coral">为什么和你相关</h3>
              </div>
              <p className="text-sm text-navy/80 leading-relaxed">{paper.relevance}</p>
            </div>
          )}

          {/* 中文解读 */}
          {paper.summary_zh && (
            <div className="bg-warm-white rounded-2xl p-5 mb-4 border border-cream-dark/50">
              <h3 className="text-sm font-medium text-navy mb-2">中文解读</h3>
              <p className="text-sm text-navy/80 leading-relaxed whitespace-pre-line">{paper.summary_zh}</p>
            </div>
          )}

          {/* 核心发现 */}
          {paper.key_findings?.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-navy mb-3">核心发现</h3>
              <div className="space-y-2">
                {paper.key_findings.map((finding, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm text-navy/80">
                    <span className="w-5 h-5 rounded-full bg-mint/20 text-navy text-xs flex items-center justify-center flex-shrink-0 mt-0.5 font-medium">{i + 1}</span>
                    <p className="leading-relaxed">{finding}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 摘要 */}
          {paper.abstract && (
            <details className="mt-2">
              <summary className="text-sm text-warm-gray cursor-pointer hover:text-navy transition-colors">查看摘要</summary>
              <div className="mt-2 pl-4 border-l-2 border-cream-dark">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-warm-gray">{showTranslation ? '中文翻译' : 'Abstract'}</span>
                  <button
                    onClick={async () => {
                      if (!abstractZh && !translating) {
                        setTranslating(true)
                        try {
                          const data = await apiPost('/translate', { text: paper.abstract })
                          if (data.ok) { setAbstractZh(data.translated); setShowTranslation(true) }
                        } catch { /* ignore */ } finally { setTranslating(false) }
                      } else { setShowTranslation(!showTranslation) }
                    }}
                    disabled={translating}
                    className="inline-flex items-center gap-1 text-xs text-warm-gray hover:text-navy transition-colors disabled:opacity-50">
                    {translating ? <><Loader2 size={12} className="animate-spin" /> 翻译中...</> : <><Languages size={12} /> {showTranslation ? '原文' : '译'}</>}
                  </button>
                </div>
                <p className="text-sm text-navy/60 leading-relaxed">{showTranslation && abstractZh ? abstractZh : paper.abstract}</p>
              </div>
            </details>
          )}
          <div className="h-8" />
        </div>
      </div>

      {/* ── 右栏：对话区 ────────────────────────────── */}
      <div className="w-full lg:w-[420px] lg:shrink-0 flex flex-col lg:h-full border-t lg:border-t-0 border-cream-dark/40">

        {/* 论文标题 + 收藏（桌面端显示） */}
        <div className="hidden lg:block px-5 pt-4 pb-3 border-b border-cream-dark/40 shrink-0">
          <p className="text-[11px] text-warm-gray/60 mb-1">{paper.journal} · {paper.pub_date}</p>
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-navy leading-snug flex-1 line-clamp-2">{paper.title}</p>
            <button ref={bookmarkBtnRef} onClick={toggleBookmark}
              className={`shrink-0 p-1.5 rounded-full hover:bg-cream-dark/50 transition-colors ripple-btn ${ripple ? 'ripple-active' : ''}`}>
              {bookmarked ? <Bookmark size={16} className="text-coral fill-coral" /> : <BookmarkPlus size={16} className="text-warm-gray" />}
            </button>
          </div>
        </div>

        {/* 收藏提示 */}
        {!bookmarked && (
          <div ref={projectPickerRef} className="px-5 py-2.5 border-b border-cream-dark/30 shrink-0 bg-navy/[0.02]">
            {showProjectPicker ? (
              <div>
                <p className="text-xs text-warm-gray/60 mb-2">收藏到</p>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => saveToProject(null)}
                    className="px-2.5 py-1 text-xs rounded-lg border border-cream-dark/80 text-warm-gray hover:text-navy transition-colors">
                    直接收藏
                  </button>
                  {projects.map(p => (
                    <button key={p.id} onClick={() => saveToProject(p.id)}
                      className="px-2.5 py-1 text-xs rounded-lg bg-coral/5 border border-coral/25 text-coral hover:bg-coral/10 transition-colors">
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-xs text-warm-gray">收藏后笔记和对话永久保存</p>
                <button onClick={toggleBookmark} className="text-xs text-coral font-medium hover:underline">收藏这篇</button>
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-4 px-5 pt-3 pb-2 border-b border-cream-dark/30 shrink-0">
          <button ref={chatTabRef} onClick={() => setActiveTab('chat')}
            className={`text-sm pb-1 transition-colors ${activeTab === 'chat' ? 'text-navy font-medium border-b-2 border-coral' : 'text-warm-gray hover:text-navy'}`}>
            和 AI 讨论
          </button>
          <button onClick={() => setActiveTab('notes')}
            className={`text-sm pb-1 transition-colors ${activeTab === 'notes' ? 'text-navy font-medium border-b-2 border-coral' : 'text-warm-gray hover:text-navy'}`}>
            我的想法
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="lg:flex-1 lg:overflow-hidden flex flex-col">
          {activeTab === 'chat' ? (
            <div className="lg:flex-1 lg:flex lg:flex-col lg:overflow-hidden p-4">
              {/* 消息列表 */}
              <div className="lg:flex-1 lg:overflow-y-auto space-y-3 mb-3 min-h-[280px]">
                {chatMessages.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-sm text-warm-gray/60 italic mb-3">试试问我</p>
                    <div className="flex flex-col gap-2">
                      {['总结核心发现', '方法学有什么亮点？', '和我的研究有什么交集？'].map(q => (
                        <button key={q} onClick={() => setChatInput(q)}
                          className="text-xs px-3 py-2 rounded-xl bg-cream-dark/40 text-warm-gray hover:text-navy hover:bg-cream-dark/60 transition-all text-left">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`text-sm px-4 py-3 rounded-2xl leading-relaxed ${
                    msg.role === 'user' ? 'bg-navy text-warm-white ml-8' : 'bg-cream-dark/40 text-navy/80 mr-8'
                  }`}>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown components={{
                        p: ({children}) => <p className="mb-1 last:mb-0">{children}</p>,
                        strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                        ul: ({children}) => <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>,
                        ol: ({children}) => <ol className="list-decimal list-inside space-y-0.5 my-1">{children}</ol>,
                        li: ({children}) => <li>{children}</li>,
                      }}>
                        {msg.content}
                      </ReactMarkdown>
                    ) : msg.content}
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex items-center gap-2 text-warm-gray text-sm">
                    <Loader2 size={14} className="animate-spin" /><span>思考中...</span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              {/* 保存对话按钮 */}
              {chatMessages.length >= 2 && (
                <>
                  <button onClick={handleSummarizeChat} disabled={summarizing || summarized}
                    className={`w-full py-2 rounded-xl text-xs font-medium mb-2 flex items-center justify-center gap-1.5 transition-all ${
                      summarized ? 'bg-mint/20 text-navy' : 'border border-coral/20 text-coral hover:bg-coral/5'
                    } disabled:opacity-60`}>
                    {summarizing ? <><Loader2 size={12} className="animate-spin" />正在总结...</>
                      : summarized ? <><FileText size={12} />已保存到笔记</>
                      : <><FileText size={12} />将对话保存为笔记</>}
                  </button>
                  {summarizeError && <p className="text-xs text-coral mb-2 text-center">{summarizeError}</p>}
                </>
              )}
              {/* 输入框 */}
              <div className="flex gap-2 shrink-0">
                <input type="text" value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                  placeholder="关于这篇论文，你想聊什么？"
                  className="flex-1 bg-warm-white rounded-xl px-3 py-2.5 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/50" />
                {speechSupported && (
                  <button onClick={listening ? stopListening : startListening} type="button"
                    className={`p-2.5 rounded-xl transition-all ${listening ? 'bg-coral text-warm-white animate-pulse' : 'bg-cream-dark/60 text-warm-gray hover:text-navy'}`}>
                    {listening ? <MicOff size={15} /> : <Mic size={15} />}
                  </button>
                )}
                <button onClick={handleSendChat} disabled={chatLoading}
                  className="p-2.5 bg-navy text-warm-white rounded-xl hover:bg-navy-light transition-colors disabled:opacity-50">
                  <Send size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col p-4">
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="读完这篇，你想记下什么？"
                className="flex-1 w-full bg-cream/40 rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none resize-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/50 leading-relaxed min-h-[200px]" />
              {notes && (
                <p className="text-xs text-warm-gray mt-2 italic">
                  {bookmarked ? '笔记已自动保存到收藏。' : '笔记已保存。收藏后可永久保存。'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {paperTourStep === 1 && <TourBubble targetRef={bookmarkBtnRef} text="点击收藏，笔记和对话都会永久保存" step={1} total={3} placement="bottom" onNext={advancePaperTour} />}
      {paperTourStep === 2 && <TourBubble targetRef={externalLinkRef} text="跳转到 PubMed 查看原文" step={2} total={3} placement="bottom" onNext={advancePaperTour} />}
      {paperTourStep === 3 && <TourBubble targetRef={chatTabRef} text="可以和论文直接对话，问它任何问题" step={3} total={3} placement="bottom" onNext={advancePaperTour} />}
    </div>
  )
}
