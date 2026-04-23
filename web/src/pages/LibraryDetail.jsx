import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Sparkles, Send, Loader2, FileText, MessageCircle, Download, ExternalLink, Languages, BookmarkPlus, Trash2, Plus, Mic, MicOff } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { apiGet, apiPost, apiDelete, API_BASE } from '../api'
import { useSpeechInput } from '../hooks/useSpeechInput'

export default function LibraryDetail() {
  const { id } = useParams()
  const [paper, setPaper] = useState(null)
  const [notes, setNotes] = useState([])
  const [chats, setChats] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const { listening, supported: speechSupported, startListening, stopListening } = useSpeechInput(
    (text) => setChatInput(prev => prev ? prev + ' ' + text : text)
  )
  const [activeTab, setActiveTab] = useState('notes')
  const [loading, setLoading] = useState(true)
  const [showExport, setShowExport] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [abstractZh, setAbstractZh] = useState(null)
  const [translating, setTranslating] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const [titleZh, setTitleZh] = useState(null)
  const [showTitleZh, setShowTitleZh] = useState(false)
  const [titleTranslating, setTitleTranslating] = useState(false)
  const [savedMsgIndexes, setSavedMsgIndexes] = useState(new Set())

  const enrichPollRef = useRef(null)
  const enrichPollCountRef = useRef(0)
  const ENRICH_POLL_MAX = 15  // 最多轮询 15 次（60s），超时自动放弃

  const stopEnrichPoll = () => {
    if (enrichPollRef.current) {
      clearInterval(enrichPollRef.current)
      enrichPollRef.current = null
    }
    enrichPollCountRef.current = 0
  }

  useEffect(() => {
    apiGet(`/library/${id}`)
      .then(data => {
        const p = data.paper
        setPaper(p)
        setNotes(data.notes || [])
        setChats(data.chats || [])
        // 手动添加的论文可能还没有 AI 解读，轮询等待后台补全
        if (p && p.abstract && !p.summary_zh) {
          enrichPollCountRef.current = 0
          enrichPollRef.current = setInterval(async () => {
            enrichPollCountRef.current += 1
            if (enrichPollCountRef.current >= ENRICH_POLL_MAX) {
              stopEnrichPoll()  // 超时放弃，不再转圈
              return
            }
            try {
              const fresh = await apiGet(`/library/${id}`)
              if (fresh.paper?.summary_zh) {
                setPaper(fresh.paper)
                stopEnrichPoll()
              }
            } catch { /* ignore */ }
          }, 4000)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    return () => stopEnrichPoll()
  }, [id])

  const handleAddNote = async () => {
    const newNote = { id: `tmp-${Date.now()}`, content: '', source: 'manual', created_at: new Date().toISOString(), isNew: true }
    setNotes(prev => [newNote, ...prev])
  }

  const handleSaveNoteContent = async (noteId, content) => {
    if (!content.trim()) return
    const isTemp = String(noteId).startsWith('tmp-')
    try {
      const res = await apiPost('/notes', {
        paper_rowid: parseInt(id),
        content,
        source: 'manual',
        ...(isTemp ? {} : { note_id: noteId }),
      })
      if (isTemp && res.id) {
        setNotes(prev => prev.map(n => n.id === noteId ? { ...n, id: res.id, isNew: false } : n))
      }
    } catch { /* ignore */ }
  }

  const handleDeleteNote = async (noteId) => {
    if (String(noteId).startsWith('tmp-')) {
      setNotes(prev => prev.filter(n => n.id !== noteId))
      return
    }
    await apiDelete(`/notes/${noteId}`)
    setNotes(prev => prev.filter(n => n.id !== noteId))
  }

  const [summarizing, setSummarizing] = useState(false)

  const handleSummarizeChat = async () => {
    if (summarizing || chats.length === 0 || !paper) return
    setSummarizing(true)
    try {
      const data = await apiPost('/chat/summarize', {
        paper_rowid: parseInt(id),
        paper_title: paper.title,
        messages: chats,
      })
      if (data.ok && data.note) {
        setNotes(prev => [{
          id: Date.now(),
          content: data.note,
          source: 'chat_summary',
          created_at: new Date().toISOString(),
        }, ...prev])
        setActiveTab('notes')
      }
    } catch { /* ignore */ } finally {
      setSummarizing(false)
    }
  }

  const handleSendChat = async () => {
    if (!chatInput.trim() || chatLoading || !paper) return
    const userMsg = { role: 'user', content: chatInput }
    setChats(prev => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const data = await apiPost('/chat', {
        paper_title: paper.title,
        paper_abstract: paper.abstract || '',
        message: chatInput,
        history: chats,
        paper_rowid: parseInt(id),
      })
      setChats(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setChats(prev => [...prev, { role: 'assistant', content: '连接失败，请重试。' }])
    } finally {
      setChatLoading(false)
    }
  }

  const handleExport = (format) => {
    window.open(`${API_BASE}/export/${format}/${id}`, '_blank')
    setShowExport(false)
  }

  const handleDownloadPdf = async () => {
    if (!paper) return
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

  if (loading) {
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
          <p className="text-warm-gray mb-4">论文未找到</p>
          <Link to="/library" className="text-coral text-sm">返回收藏库</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-8">
      <header className="px-6 pt-12 pb-4 max-w-3xl mx-auto">
        <Link to="/library" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} />
          <span>返回收藏</span>
        </Link>
      </header>

      <main className="px-6 max-w-3xl mx-auto">
        {/* 论文信息 */}
        <article className="mb-8">
          <span className="text-xs px-2.5 py-1 rounded-full bg-coral/10 text-coral font-medium">
            {paper.category || '未分类'}
          </span>
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
                    if (data.ok) { setTitleZh(data.translated); setShowTitleZh(true) }
                  } catch { /* ignore */ } finally { setTitleTranslating(false) }
                } else {
                  setShowTitleZh(v => !v)
                }
              }}
              disabled={titleTranslating}
              className="mt-1 inline-flex items-center gap-1 text-xs text-warm-gray hover:text-navy transition-colors disabled:opacity-50"
            >
              {titleTranslating ? <Loader2 size={12} className="animate-spin" /> : <Languages size={12} />}
              <span>{showTitleZh ? '原文' : '译'}</span>
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

          {paper.summary_zh ? (
            <div className="bg-warm-white rounded-2xl p-5 mt-6 border border-cream-dark/50">
              <h3 className="text-sm font-medium text-navy mb-2">中文解读</h3>
              <p className="text-sm text-navy/80 leading-relaxed">{paper.summary_zh}</p>
            </div>
          ) : paper.abstract && enrichPollRef.current ? (
            <div className="bg-warm-white rounded-2xl p-5 mt-6 border border-cream-dark/50 flex items-center gap-2 text-warm-gray text-sm">
              <Loader2 size={14} className="animate-spin text-coral flex-shrink-0" />
              AI 解读生成中，稍等片刻…
            </div>
          ) : null}

          {paper.relevance && (
            <div className="bg-coral/5 rounded-2xl p-5 mt-4 border border-coral/10">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles size={14} className="text-coral" />
                <h3 className="text-sm font-medium text-coral">为什么和你相关</h3>
              </div>
              <p className="text-sm text-navy/80 leading-relaxed">{paper.relevance}</p>
            </div>
          )}

          {/* 摘要 */}
          {paper.abstract && (
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
          )}
        </article>

        {/* 笔记和对话 tabs */}
        <div className="border-t border-cream-dark/50 pt-6">
          <div className="flex gap-4 mb-4">
            <button
              onClick={() => setActiveTab('notes')}
              className={`text-sm pb-1 flex items-center gap-1.5 transition-colors ${
                activeTab === 'notes'
                  ? 'text-navy font-medium border-b-2 border-coral'
                  : 'text-warm-gray hover:text-navy'
              }`}
            >
              <FileText size={14} />
              我的笔记
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`text-sm pb-1 flex items-center gap-1.5 transition-colors ${
                activeTab === 'chat'
                  ? 'text-navy font-medium border-b-2 border-coral'
                  : 'text-warm-gray hover:text-navy'
              }`}
            >
              <MessageCircle size={14} />
              AI 对话
              {chats.length > 0 && (
                <span className="text-xs text-warm-gray/50">({chats.length})</span>
              )}
            </button>
          </div>

          {activeTab === 'notes' ? (
            <div className="space-y-3">
              <button
                onClick={handleAddNote}
                className="flex items-center gap-1.5 text-xs text-warm-gray hover:text-navy transition-colors"
              >
                <Plus size={13} />
                新建笔记
              </button>
              {notes.length === 0 && (
                <p className="text-sm text-warm-gray/60 italic text-center py-8">还没有笔记，写下你的思考</p>
              )}
              {notes.map(note => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onSave={(content) => handleSaveNoteContent(note.id, content)}
                  onDelete={() => handleDeleteNote(note.id)}
                />
              ))}
            </div>
          ) : (
            <div>
              <div className="space-y-3 mb-4 max-h-96 overflow-y-auto rounded-2xl bg-cream-dark/20 p-3">
                {chats.length === 0 && (
                  <div className="text-center py-6">
                    <p className="text-sm text-warm-gray/60 italic mb-3">
                      关于这篇论文，你想聊什么？
                    </p>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {['这篇的方法学有什么亮点？', '和我的研究有什么交集？', '有哪些局限性？'].map(q => (
                        <button key={q} onClick={() => setChatInput(q)}
                          className="text-xs px-3 py-1.5 rounded-full bg-warm-white border border-cream-dark text-warm-gray hover:text-navy hover:border-coral/30 transition-all">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chats.map((msg, i) => (
                  <div key={i} className={`max-w-[85%] ${msg.role === 'user' ? 'ml-auto' : ''}`}
                    style={{ animationDelay: `${i * 60}ms` }}>
                    <div className={`text-sm px-4 py-3 rounded-2xl leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-navy text-warm-white breathe-in-right'
                        : 'glass-chat text-navy/80 breathe-in-left'
                    }`}>
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
                    {msg.role === 'assistant' && (
                      <button
                        disabled={savedMsgIndexes.has(i)}
                        onClick={async () => {
                          if (savedMsgIndexes.has(i)) return
                          const res = await apiPost('/notes', {
                            paper_rowid: parseInt(id),
                            content: msg.content,
                            source: 'chat_single',
                          })
                          if (res.ok) {
                            setSavedMsgIndexes(prev => new Set([...prev, i]))
                            setNotes(prev => [{
                              id: res.id,
                              content: msg.content,
                              source: 'chat_single',
                              created_at: new Date().toISOString(),
                            }, ...prev])
                            setActiveTab('notes')
                          }
                        }}
                        className={`mt-1 ml-1 flex items-center gap-1 text-xs transition-colors ${
                          savedMsgIndexes.has(i) ? 'text-coral/60 cursor-default' : 'text-warm-gray/50 hover:text-coral'
                        }`}
                      >
                        <BookmarkPlus size={12} />
                        {savedMsgIndexes.has(i) ? '已保存' : '保存为笔记'}
                      </button>
                    )}
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex items-center gap-2 text-warm-gray text-sm">
                    <Loader2 size={14} className="animate-spin" />
                    <span>思考中...</span>
                  </div>
                )}
              </div>
              {chats.length >= 2 && (
                <button
                  onClick={handleSummarizeChat}
                  disabled={summarizing}
                  className="mb-3 flex items-center gap-1.5 text-xs text-warm-gray hover:text-coral transition-colors disabled:opacity-50"
                >
                  <BookmarkPlus size={13} />
                  {summarizing ? '正在总结...' : '总结对话为笔记'}
                </button>
              )}
              <div className="flex gap-2">
                <input type="text" value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                  placeholder="继续讨论..."
                  className="flex-1 bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/50" />
                {speechSupported && (
                  <button onClick={listening ? stopListening : startListening} type="button"
                    className={`p-3 rounded-xl transition-all ${listening ? 'bg-coral text-warm-white animate-pulse' : 'bg-cream-dark/60 text-warm-gray hover:text-navy'}`}>
                    {listening ? <MicOff size={16} /> : <Mic size={16} />}
                  </button>
                )}
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

const SOURCE_LABEL = {
  chat_summary: '✨ 总结',
  chat_single: '💬 对话',
}

function NoteCard({ note, onSave, onDelete }) {
  const [editing, setEditing] = useState(note.isNew || false)
  const [content, setContent] = useState(note.content)
  const [saveStatus, setSaveStatus] = useState('idle')
  const isLongformNote = note.source === 'chat_summary' || (content?.length || 0) > 240

  useEffect(() => {
    if (!editing || !content.trim()) return
    setSaveStatus('idle')
    const t = setTimeout(async () => {
      setSaveStatus('saving')
      await onSave(content)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 1500)
    }, 1200)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  return (
    <div className="bg-warm-white rounded-2xl border border-cream-dark/50 p-4 group relative">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {SOURCE_LABEL[note.source] && (
            <span className="text-xs text-warm-gray/60">{SOURCE_LABEL[note.source]}</span>
          )}
          <span className="text-xs text-warm-gray/40">
            {note.created_at ? new Date(note.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-xs text-warm-gray hover:text-navy transition-colors">编辑</button>
          )}
          <button onClick={onDelete} className="text-warm-gray hover:text-coral transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            autoFocus
            value={content}
            onChange={e => setContent(e.target.value)}
            onBlur={() => { if (content.trim()) setEditing(false) }}
            rows={isLongformNote ? 10 : 6}
            placeholder="写下你的思考..."
            className={`w-full bg-transparent text-sm text-navy outline-none resize-y placeholder:text-warm-gray/40 leading-relaxed ${isLongformNote ? 'min-h-[260px]' : 'min-h-[140px]'}`}
          />
          <p className="text-xs text-warm-gray/40 mt-1">
            {saveStatus === 'saving' ? '保存中...' : saveStatus === 'saved' ? '已保存' : '自动保存'}
          </p>
        </>
      ) : (
        <p className="text-sm text-navy/80 leading-relaxed whitespace-pre-wrap cursor-text" onClick={() => setEditing(true)}>
          {content || <span className="text-warm-gray/40 italic">点击编辑</span>}
        </p>
      )}
    </div>
  )
}
