import { useState, useEffect } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, Sparkles, Send, BookmarkPlus, Bookmark, Loader2, FileText, Download, ExternalLink, Languages } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { apiGet, apiPost, apiDelete, API_BASE, getUserId } from '../api'

export default function PaperRead() {
  const { id } = useParams()
  const location = useLocation()
  const [paper, setPaper] = useState(location.state?.paper || null)
  const [paperLoading, setPaperLoading] = useState(!location.state?.paper)

  const [notes, setNotes] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [summarized, setSummarized] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [savedRowId, setSavedRowId] = useState(null)
  const [activeTab, setActiveTab] = useState('notes')
  const [showExport, setShowExport] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [ripple, setRipple] = useState(false)
  const [abstractZh, setAbstractZh] = useState(null)
  const [translating, setTranslating] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const [titleZh, setTitleZh] = useState(null)
  const [showTitleZh, setShowTitleZh] = useState(false)
  const [titleTranslating, setTitleTranslating] = useState(false)
  const [summarizeError, setSummarizeError] = useState(null)

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

  // 记录阅读
  useEffect(() => {
    if (paper) {
      localStorage.setItem('last-reading', JSON.stringify({
        ...paper, index: id, readAt: new Date().toISOString(),
      }))
      // 记录到后端
      apiPost('/reading-history', { title: paper.title, paper_rowid: savedRowId }).catch(() => {})
    }
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

  const triggerRipple = () => {
    setRipple(true)
    setTimeout(() => setRipple(false), 700)
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
      // 收藏
      try {
        const data = await apiPost('/library/save', { paper })
        setSavedRowId(data.id)
        localStorage.setItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`, String(data.id))
        setBookmarked(true)
        triggerRipple()

        // 如果有笔记，也存到后端
        if (notes) {
          apiPost('/notes', { paper_rowid: data.id, content: notes }).catch(() => {})
        }
      } catch { /* ignore */ }
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
        const data = await apiPost('/library/save', { paper })
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
        // 切换到笔记 tab 并更新笔记内容
        const existingNote = notes ? notes + '\n\n---\n\n' : ''
        setNotes(existingNote + '💬 AI 对话笔记：\n' + data.note)
        setActiveTab('notes')
      } else {
        setSummarizeError(data.error || '总结失败，请重试。')
      }
    } catch {
      setSummarizeError('网络错误，请重试。')
    } finally { setSummarizing(false) }
  }

  const handleExport = async (format) => {
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
      const data = await apiGet(`/pdf-url?${params}`)
      if (data.ok) {
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
    <div className="min-h-screen pb-8">
      <header className="px-6 pt-12 pb-4 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm hover:text-navy transition-colors">
            <ArrowLeft size={16} />
            <span>返回</span>
          </Link>
          <button onClick={toggleBookmark} className={`p-2 rounded-full hover:bg-cream-dark/50 transition-colors ripple-btn ${ripple ? 'ripple-active' : ''}`}>
            {bookmarked ? (
              <Bookmark size={18} className="text-coral fill-coral" />
            ) : (
              <BookmarkPlus size={18} className="text-warm-gray" />
            )}
          </button>
        </div>
      </header>

      <main className="px-6 max-w-3xl mx-auto">
        <article className="mb-8">
          <div className="flex items-center gap-2">
            <span className="text-xs px-2.5 py-1 rounded-full bg-coral/10 text-coral font-medium">
              {paper.category || '未分类'}
            </span>
            {paper.source && (
              <span className="text-xs text-warm-gray/50">
                {paper.source === 'pubmed' ? 'PubMed' : 'Semantic Scholar'}
              </span>
            )}
          </div>
          <div className="mt-3">
            <h1 className="text-xl font-bold text-navy font-serif leading-relaxed">
              {showTitleZh && titleZh ? titleZh : paper.title}
            </h1>
            <button
              onClick={async () => {
                if (!titleZh && !titleTranslating) {
                  setTitleTranslating(true)
                  try {
                    const data = await apiPost('/translate', { text: paper.title })
                    if (data.ok) {
                      setTitleZh(data.translated)
                      setShowTitleZh(true)
                    }
                  } catch { /* ignore */ } finally { setTitleTranslating(false) }
                } else {
                  setShowTitleZh(!showTitleZh)
                }
              }}
              disabled={titleTranslating}
              className="mt-1 inline-flex items-center gap-1 text-xs text-warm-gray/50 hover:text-warm-gray transition-colors disabled:opacity-40"
            >
              {titleTranslating ? (
                <><Loader2 size={11} className="animate-spin" /> 翻译中...</>
              ) : (
                <><Languages size={11} /> {showTitleZh ? '原文' : '中文'}</>
              )}
            </button>
          </div>
          <p className="text-warm-gray text-sm mt-2">
            {paper.authors} &middot; {paper.journal} &middot; {paper.pub_date}
          </p>
          {/* 操作按钮 */}
          <div className="flex flex-wrap items-center gap-2 mt-4">
            {paper.link && (
              <a href={paper.link} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all">
                <ExternalLink size={12} />
                查看原文
              </a>
            )}
            <button
              onClick={handleDownloadPdf}
              disabled={pdfLoading || (!paper.doi && !paper.pmid)}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all disabled:opacity-40"
            >
              {pdfLoading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              下载 PDF
            </button>
            <div className="relative">
              <button
                onClick={() => setShowExport(!showExport)}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all"
              >
                <FileText size={12} />
                导出引用
              </button>
              {showExport && (
                <div className="absolute top-full left-0 mt-1 bg-white rounded-xl shadow-lg border border-cream-dark/50 py-1 z-10 min-w-[160px]">
                  <button onClick={() => handleExport('ris')}
                    className="w-full text-left px-4 py-2 text-sm text-navy hover:bg-cream-dark/30 transition-colors">
                    RIS (Zotero/EndNote)
                  </button>
                  <button onClick={() => handleExport('bibtex')}
                    className="w-full text-left px-4 py-2 text-sm text-navy hover:bg-cream-dark/30 transition-colors">
                    BibTeX (LaTeX)
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 中文解读 */}
          {paper.summary_zh && (
            <div className="bg-warm-white rounded-2xl p-5 mt-6 border border-cream-dark/50">
              <h3 className="text-sm font-medium text-navy mb-2">中文解读</h3>
              <p className="text-sm text-navy/80 leading-relaxed whitespace-pre-line">{paper.summary_zh}</p>
            </div>
          )}

          {/* 相关性 */}
          {paper.relevance && (
            <div className="bg-coral/5 rounded-2xl p-5 mt-4 border border-coral/10">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles size={14} className="text-coral" />
                <h3 className="text-sm font-medium text-coral">为什么和你相关</h3>
              </div>
              <p className="text-sm text-navy/80 leading-relaxed">{paper.relevance}</p>
            </div>
          )}

          {/* 核心发现 */}
          {paper.key_findings?.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-navy mb-3">核心发现</h3>
              <div className="space-y-2">
                {paper.key_findings.map((finding, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm text-navy/80">
                    <span className="w-5 h-5 rounded-full bg-mint/20 text-navy text-xs flex items-center justify-center flex-shrink-0 mt-0.5 font-medium">
                      {i + 1}
                    </span>
                    <p className="leading-relaxed">{finding}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 摘要 */}
          <details className="mt-4">
            <summary className="text-sm text-warm-gray cursor-pointer hover:text-navy transition-colors">
              查看摘要
            </summary>
            <div className="mt-2 pl-4 border-l-2 border-cream-dark">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-warm-gray">
                  {showTranslation ? '中文翻译' : 'Abstract'}
                </span>
                <button
                  onClick={async () => {
                    if (!abstractZh && !translating) {
                      setTranslating(true)
                      try {
                        const data = await apiPost('/translate', { text: paper.abstract })
                        if (data.ok) {
                          setAbstractZh(data.translated)
                          setShowTranslation(true)
                        }
                      } catch { /* ignore */ } finally { setTranslating(false) }
                    } else {
                      setShowTranslation(!showTranslation)
                    }
                  }}
                  disabled={translating}
                  className="inline-flex items-center gap-1 text-xs text-warm-gray hover:text-navy transition-colors disabled:opacity-50"
                >
                  {translating ? (
                    <><Loader2 size={12} className="animate-spin" /> 翻译中...</>
                  ) : (
                    <><Languages size={12} /> {showTranslation ? '原文' : '译'}</>
                  )}
                </button>
              </div>
              <p className="text-sm text-navy/60 leading-relaxed">
                {showTranslation && abstractZh ? abstractZh : paper.abstract}
              </p>
            </div>
          </details>
        </article>

        {/* 收藏提示 */}
        {!bookmarked && (
          <div className="bg-navy/5 rounded-xl p-4 mb-6 flex items-center justify-between">
            <p className="text-sm text-warm-gray">收藏后，笔记和对话会永久保存</p>
            <button onClick={toggleBookmark}
              className="text-sm text-coral font-medium hover:underline">
              收藏这篇
            </button>
          </div>
        )}

        {/* 笔记和对话 */}
        <div className="border-t border-cream-dark/50 pt-6">
          <div className="flex gap-4 mb-4">
            <button onClick={() => setActiveTab('notes')}
              className={`text-sm pb-1 transition-colors ${activeTab === 'notes' ? 'text-navy font-medium border-b-2 border-coral' : 'text-warm-gray hover:text-navy'}`}>
              我的想法
            </button>
            <button onClick={() => setActiveTab('chat')}
              className={`text-sm pb-1 transition-colors ${activeTab === 'chat' ? 'text-navy font-medium border-b-2 border-coral' : 'text-warm-gray hover:text-navy'}`}>
              和 AI 讨论
            </button>
          </div>

          {activeTab === 'notes' ? (
            <div>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="读完这篇，你想记下什么？"
                rows={6}
                className="w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none resize-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/50 leading-relaxed" />
              {notes && (
                <p className="text-xs text-warm-gray mt-2 italic">
                  {bookmarked ? '笔记已自动保存到收藏。' : '笔记已保存。收藏后可永久保存。'}
                </p>
              )}
            </div>
          ) : (
            <div>
              <div className="space-y-3 mb-4 max-h-80 overflow-y-auto rounded-2xl bg-cream-dark/20 p-3">
                {chatMessages.length === 0 && (
                  <div className="text-center py-6">
                    <p className="text-sm text-warm-gray/60 italic mb-3">试试问我</p>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {['总结核心发现', '方法学有什么亮点？', '和我的研究有什么交集？'].map(q => (
                        <button key={q} onClick={() => setChatInput(q)}
                          className="text-xs px-3 py-1.5 rounded-full bg-warm-white border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i}
                    className={`text-sm px-4 py-3 rounded-2xl max-w-[85%] leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-navy text-warm-white ml-auto breathe-in-right'
                        : 'glass-chat text-navy/80 breathe-in-left'
                    }`}
                    style={{ animationDelay: `${i * 60}ms` }}>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown
                        components={{
                          p: ({children}) => <p className="mb-1 last:mb-0">{children}</p>,
                          strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                          ul: ({children}) => <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>,
                          ol: ({children}) => <ol className="list-decimal list-inside space-y-0.5 my-1">{children}</ol>,
                          li: ({children}) => <li>{children}</li>,
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    ) : msg.content}
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex items-center gap-2 text-warm-gray text-sm">
                    <Loader2 size={14} className="animate-spin" />
                    <span>思考中...</span>
                  </div>
                )}
              </div>
              {/* 保存对话为笔记按钮 */}
              {chatMessages.length >= 2 && (
                <>
                  <button
                    onClick={handleSummarizeChat}
                    disabled={summarizing || summarized}
                    className={`w-full py-2.5 rounded-xl text-sm font-medium mb-1 flex items-center justify-center gap-2 transition-all ripple-btn ${ripple && summarized ? 'ripple-active' : ''} ${
                      summarized
                        ? 'bg-mint/20 text-navy'
                        : 'border border-coral/20 text-coral hover:bg-coral/5'
                    } disabled:opacity-60`}
                  >
                    {summarizing ? (
                      <><Loader2 size={14} className="animate-spin" /> 正在总结对话...</>
                    ) : summarized ? (
                      <><FileText size={14} /> 已保存到笔记</>
                    ) : (
                      <><FileText size={14} /> 将对话保存为笔记</>
                    )}
                  </button>
                  {summarizeError && (
                    <p className="text-xs text-coral mb-2 text-center">{summarizeError}</p>
                  )}
                </>
              )}
              <div className="flex gap-2">
                <input type="text" value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                  placeholder="关于这篇论文，你想聊什么？"
                  className="flex-1 bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/50" />
                <button onClick={handleSendChat} disabled={chatLoading}
                  className="p-3 bg-navy text-warm-white rounded-xl hover:bg-navy-light transition-colors disabled:opacity-50">
                  <Send size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
