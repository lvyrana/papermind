import { useState, useEffect } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, Sparkles, Send, BookmarkPlus, Bookmark, Loader2, FileText } from 'lucide-react'

const API = '/api'

export default function PaperRead() {
  const { id } = useParams()
  const location = useLocation()
  const paper = location.state?.paper || null

  const [notes, setNotes] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [summarized, setSummarized] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [savedRowId, setSavedRowId] = useState(null)
  const [activeTab, setActiveTab] = useState('notes')

  // 记录阅读
  useEffect(() => {
    if (paper) {
      localStorage.setItem('last-reading', JSON.stringify({
        ...paper, index: id, readAt: new Date().toISOString(),
      }))
      // 记录到后端
      fetch(`${API}/reading-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: paper.title, paper_rowid: savedRowId }),
      }).catch(() => {})
    }
  }, [paper, id])

  // 读取本地笔记
  useEffect(() => {
    const key = `paper-notes-${paper?.pmid || paper?.paper_id || id}`
    const saved = localStorage.getItem(key)
    if (saved) setNotes(saved)

    const bk = localStorage.getItem(`paper-bookmark-${paper?.pmid || paper?.paper_id || id}`)
    if (bk) {
      setBookmarked(true)
      setSavedRowId(parseInt(bk))
    }
  }, [paper, id])

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
        fetch(`${API}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paper_rowid: savedRowId, content: notes }),
        }).catch(() => {})
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [notes, paper, id, savedRowId])

  const toggleBookmark = async () => {
    if (!paper) return

    if (bookmarked && savedRowId) {
      // 取消收藏
      await fetch(`${API}/library/${savedRowId}`, { method: 'DELETE' }).catch(() => {})
      localStorage.removeItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`)
      setBookmarked(false)
      setSavedRowId(null)
    } else {
      // 收藏
      try {
        const r = await fetch(`${API}/library/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paper }),
        })
        const data = await r.json()
        setSavedRowId(data.id)
        localStorage.setItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`, String(data.id))
        setBookmarked(true)

        // 如果有笔记，也存到后端
        if (notes) {
          fetch(`${API}/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paper_rowid: data.id, content: notes }),
          }).catch(() => {})
        }
      } catch {}
    }
  }

  const handleSendChat = async () => {
    if (!chatInput.trim() || chatLoading) return
    const userMsg = { role: 'user', content: chatInput }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const r = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper_title: paper?.title || '',
          paper_abstract: paper?.abstract || '',
          message: chatInput,
          history: chatMessages,
          paper_rowid: savedRowId || 0,
        }),
      })
      const data = await r.json()
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

    // 如果还没收藏，先收藏
    let rowId = savedRowId
    if (!rowId && paper) {
      try {
        const r = await fetch(`${API}/library/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paper }),
        })
        const data = await r.json()
        rowId = data.id
        setSavedRowId(rowId)
        localStorage.setItem(`paper-bookmark-${paper.pmid || paper.paper_id || id}`, String(rowId))
        setBookmarked(true)
      } catch { return }
    }

    setSummarizing(true)
    try {
      const r = await fetch(`${API}/chat/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper_title: paper?.title || '',
          paper_rowid: rowId,
          messages: chatMessages,
        }),
      })
      const data = await r.json()
      if (data.ok) {
        setSummarized(true)
        // 切换到笔记 tab 并更新笔记内容
        const existingNote = notes ? notes + '\n\n---\n\n' : ''
        setNotes(existingNote + '\ud83d\udcac AI \u5bf9\u8bdd\u7b14\u8bb0\uff1a\n' + data.note)
        setActiveTab('notes')
      }
    } catch {}
    finally { setSummarizing(false) }
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
          <button onClick={toggleBookmark} className="p-2 rounded-full hover:bg-cream-dark/50 transition-colors">
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
          <h1 className="text-xl font-bold text-navy font-serif mt-3 leading-relaxed">
            {paper.title}
          </h1>
          <p className="text-warm-gray text-sm mt-2">
            {paper.authors} &middot; {paper.journal} &middot; {paper.pub_date}
          </p>
          {paper.link && (
            <a href={paper.link} target="_blank" rel="noopener noreferrer"
              className="text-coral text-xs mt-2 inline-block hover:underline">
              查看原文
            </a>
          )}

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

          {/* 英文摘要 */}
          <details className="mt-4">
            <summary className="text-sm text-warm-gray cursor-pointer hover:text-navy transition-colors">
              查看英文摘要
            </summary>
            <p className="text-sm text-navy/60 leading-relaxed mt-2 pl-4 border-l-2 border-cream-dark">
              {paper.abstract}
            </p>
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
              <div className="space-y-3 mb-4 max-h-80 overflow-y-auto">
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
                      msg.role === 'user' ? 'bg-navy text-warm-white ml-auto' : 'bg-warm-white text-navy/80 border border-cream-dark/50'
                    }`}>
                    {msg.content}
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
                <button
                  onClick={handleSummarizeChat}
                  disabled={summarizing || summarized}
                  className={`w-full py-2.5 rounded-xl text-sm font-medium mb-3 flex items-center justify-center gap-2 transition-all ${
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
