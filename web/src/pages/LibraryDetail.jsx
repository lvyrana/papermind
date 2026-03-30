import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Sparkles, Send, Loader2, FileText, MessageCircle, Download, ExternalLink } from 'lucide-react'

const API = '/api'

export default function LibraryDetail() {
  const { id } = useParams()
  const [paper, setPaper] = useState(null)
  const [notes, setNotes] = useState([])
  const [chats, setChats] = useState([])
  const [noteText, setNoteText] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('notes')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)

  useEffect(() => {
    fetch(`${API}/library/${id}`)
      .then(r => r.json())
      .then(data => {
        setPaper(data.paper)
        setNotes(data.notes || [])
        setChats(data.chats || [])
        if (data.notes?.length) {
          setNoteText(data.notes[0].content)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  const handleSaveNote = async () => {
    if (!noteText.trim()) return
    setSaving(true)
    try {
      await fetch(`${API}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper_rowid: parseInt(id), content: noteText }),
      })
    } catch {}
    setSaving(false)
  }

  // 自动保存笔记（防抖）
  useEffect(() => {
    if (!noteText.trim() || !paper) return
    const timer = setTimeout(() => handleSaveNote(), 1500)
    return () => clearTimeout(timer)
  }, [noteText])

  const handleSendChat = async () => {
    if (!chatInput.trim() || chatLoading || !paper) return
    const userMsg = { role: 'user', content: chatInput }
    setChats(prev => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const r = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper_title: paper.title,
          paper_abstract: paper.abstract || '',
          message: chatInput,
          history: chats,
          paper_rowid: parseInt(id),
        }),
      })
      const data = await r.json()
      setChats(prev => [...prev, { role: 'assistant', content: data.reply }])
    } catch {
      setChats(prev => [...prev, { role: 'assistant', content: '连接失败，请重试。' }])
    } finally {
      setChatLoading(false)
    }
  }

  const handleExport = (format) => {
    window.open(`${API}/export/${format}/${id}`, '_blank')
    setShowExport(false)
  }

  const handleDownloadPdf = async () => {
    if (!paper) return
    setPdfLoading(true)
    try {
      const params = new URLSearchParams()
      if (paper.doi) params.set('doi', paper.doi)
      if (paper.pmid) params.set('pmid', paper.pmid)
      const r = await fetch(`${API}/pdf-url?${params}`)
      const data = await r.json()
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
          <h1 className="text-xl font-bold text-navy font-serif mt-3 leading-relaxed">
            {paper.title}
          </h1>
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

          {paper.summary_zh && (
            <div className="bg-warm-white rounded-2xl p-5 mt-6 border border-cream-dark/50">
              <h3 className="text-sm font-medium text-navy mb-2">中文解读</h3>
              <p className="text-sm text-navy/80 leading-relaxed">{paper.summary_zh}</p>
            </div>
          )}

          {paper.relevance && (
            <div className="bg-coral/5 rounded-2xl p-5 mt-4 border border-coral/10">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles size={14} className="text-coral" />
                <h3 className="text-sm font-medium text-coral">为什么和你相关</h3>
              </div>
              <p className="text-sm text-navy/80 leading-relaxed">{paper.relevance}</p>
            </div>
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
            <div>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="写下你对这篇论文的思考..."
                rows={8}
                className="w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none resize-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/50 leading-relaxed"
              />
              <p className="text-xs text-warm-gray mt-2 italic">
                {saving ? '保存中...' : noteText ? '自动保存中' : ''}
              </p>
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
                  <div key={i}
                    className={`text-sm px-4 py-3 rounded-2xl max-w-[85%] leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-navy text-warm-white ml-auto breathe-in-right'
                        : 'glass-chat text-navy/80 breathe-in-left'
                    }`}
                    style={{ animationDelay: `${i * 60}ms` }}>
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
              <div className="flex gap-2">
                <input type="text" value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                  placeholder="继续讨论..."
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
