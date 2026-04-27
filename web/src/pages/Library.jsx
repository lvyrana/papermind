import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, BookOpen, MessageCircle, FileText, Search, Trash2, Plus, X, Loader2 } from 'lucide-react'
import Navbar from '../components/Navbar'
import { apiGet, apiDelete, apiPost } from '../api'

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const now = new Date()
  const date = new Date(dateStr)
  const diff = Math.floor((now - date) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  const days = Math.floor(diff / 86400)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

export default function Library() {
  const navigate = useNavigate()
  const [papers, setPapers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')
  const [notesOnly, setNotesOnly] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  useEffect(() => {
    apiGet('/library')
      .then(data => setPapers(data.papers || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (id, e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm('确定要取消收藏吗？笔记和对话也会删除。')) return
    await apiDelete(`/library/${id}`)
    setPapers(prev => prev.filter(p => p.id !== id))
  }

  const categories = useMemo(() => {
    const cats = [...new Set(papers.map(p => p.category).filter(Boolean))]
    return ['全部', ...cats]
  }, [papers])

  const categoryCounts = useMemo(() => {
    const counts = {}
    papers.forEach(p => {
      const cat = p.category || '未分类'
      counts[cat] = (counts[cat] || 0) + 1
    })
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [papers])

  const filtered = useMemo(() => {
    let result = papers
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(p => p.title.toLowerCase().includes(q))
    }
    if (activeCategory !== '全部') {
      result = result.filter(p => p.category === activeCategory)
    }
    if (notesOnly) {
      result = result.filter(p => p.note_count > 0)
    }
    return [...result].sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at))
  }, [papers, search, activeCategory, notesOnly])

  const hasNotes = useMemo(() => papers.some(p => p.note_count > 0), [papers])
  const hasChats = useMemo(() => papers.some(p => p.chat_count > 0), [papers])
  const hasFilters = activeCategory !== '全部' || notesOnly || search.trim()

  return (
    <div className="min-h-screen pb-24 lg:pb-12">

      {/* ── Mobile layout ── */}
      <div className="lg:hidden">
        <header className="px-6 pt-20 pb-6 max-w-2xl mx-auto">
          <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
            <ArrowLeft size={16} />
            <span>返回</span>
          </Link>
          <div className="flex items-center justify-between mb-5">
            <h1 className="pm-page-title text-[30px] text-navy leading-snug">我的收藏</h1>
            <div className="flex items-center gap-3">
              {papers.length > 0 && (
                <span className="text-xs text-warm-gray/70">{filtered.length} / {papers.length} 篇</span>
              )}
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-coral text-warm-white text-xs font-medium hover:bg-coral-light transition-colors"
              >
                <Plus size={13} />
                添加论文
              </button>
            </div>
          </div>

          {papers.length > 0 && (
            <>
              <div className="relative mb-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-warm-gray/40" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="搜索论文标题..."
                  className="w-full bg-warm-white rounded-2xl pl-9 pr-4 py-2.5 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/40"
                />
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {hasNotes && (
                  <button
                    onClick={() => setNotesOnly(v => !v)}
                    className={`shrink-0 px-3 py-1 rounded-full text-xs transition-all flex items-center gap-1 ${
                      notesOnly ? 'bg-coral/90 text-warm-white' : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-coral/30 hover:text-coral'
                    }`}
                  >
                    <FileText size={11} />有笔记
                  </button>
                )}
                {categories.map(cat => (
                  <button key={cat} onClick={() => setActiveCategory(cat)}
                    className={`shrink-0 px-3 py-1 rounded-full text-xs transition-all ${
                      activeCategory === cat ? 'bg-navy/90 text-warm-white' : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
                    }`}>
                    {cat}
                  </button>
                ))}
              </div>
            </>
          )}
        </header>

        <main className="px-6 max-w-2xl mx-auto">
          {loading && <div className="text-center py-12 text-warm-gray text-sm">加载中...</div>}
          {!loading && papers.length === 0 && (
            <div className="text-center py-16">
              <BookOpen size={32} className="text-cream-dark mx-auto mb-4" />
              <p className="text-warm-gray text-sm mb-4">收藏的论文会出现在这里</p>
              <Link to="/" className="text-coral text-sm hover:underline">去看看推荐论文</Link>
            </div>
          )}
          {!loading && papers.length > 0 && filtered.length === 0 && (
            <div className="text-center py-12 text-warm-gray/60 text-sm">没有符合条件的论文</div>
          )}
          {filtered.length > 0 && (
            <div className="flex flex-col gap-2">
              {filtered.map((paper, i) => (
                <PaperRow key={paper.id} paper={paper} onDelete={handleDelete} index={i} />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* ── Desktop layout (lg+) ── */}
      <div className="hidden lg:grid lg:grid-cols-[260px_1fr] lg:gap-10 max-w-[1280px] mx-auto px-10 pt-24">

        {/* Sidebar */}
        <aside className="sticky top-6 self-start space-y-5">
          <div>
            <h1 className="pm-page-title text-[34px] text-navy leading-tight">我的收藏</h1>
            <p className="text-warm-gray text-xs mt-2">
              共 {papers.length} 篇
              {papers.filter(p => p.note_count > 0).length > 0 && ` · ${papers.filter(p => p.note_count > 0).length} 有笔记`}
              {hasChats && ` · ${papers.filter(p => p.chat_count > 0).length} 有对话`}
            </p>
          </div>

          {/* Category stats */}
          {categoryCounts.length > 0 && (
            <div className="liquid-glass p-5">
              <p className="text-[10px] uppercase tracking-[0.22em] text-warm-gray/65 mb-3">收藏概况</p>
              <div className="space-y-2.5">
                {categoryCounts.map(([cat, count]) => (
                  <div key={cat}
                    className="flex items-center gap-3 cursor-pointer group"
                    onClick={() => setActiveCategory(activeCategory === cat ? '全部' : cat)}>
                    <div className="flex-1 flex items-center justify-between">
                      <span className={`text-[12px] transition ${activeCategory === cat ? 'text-coral font-medium' : 'text-navy/75 group-hover:text-navy'}`}>
                        {cat}
                      </span>
                      <span className="text-[11px] text-warm-gray/60 tabular-nums">{count}</span>
                    </div>
                    <div className="w-[60px] h-1 bg-cream-dark/60 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-coral/60 transition-all"
                        style={{ width: `${(count / papers.length) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="liquid-glass p-5 space-y-3">
            <p className="text-[10px] uppercase tracking-[0.22em] text-warm-gray/65">筛选</p>
            {hasNotes && (
              <button onClick={() => setNotesOnly(v => !v)}
                className={`w-full px-4 py-2 rounded-full text-xs text-left flex items-center gap-2 transition ${
                  notesOnly ? 'bg-coral/10 text-coral border border-coral/30' : 'bg-cream-dark/40 text-warm-gray hover:text-navy'
                }`}>
                <FileText size={11} /> 只看有笔记
              </button>
            )}
            {hasFilters && (
              <button onClick={() => { setActiveCategory('全部'); setNotesOnly(false); setSearch('') }}
                className="w-full px-4 py-2 rounded-full text-xs text-warm-gray/60 bg-cream-dark/30 hover:text-warm-gray transition text-left">
                清除筛选
              </button>
            )}
            {!hasNotes && !hasFilters && (
              <p className="text-[12px] text-warm-gray/50">暂无可用筛选</p>
            )}
          </div>

          <button onClick={() => setShowAddModal(true)}
            className="w-full py-2.5 rounded-2xl border border-dashed border-coral/40 text-coral text-sm flex items-center justify-center gap-2 hover:bg-coral/5 transition">
            <Plus size={13} /> 添加论文
          </button>
        </aside>

        {/* Main */}
        <main className="min-h-[80vh]">
          {loading && <div className="text-center py-20 text-warm-gray text-sm">加载中...</div>}

          {!loading && papers.length === 0 && (
            <div className="text-center py-32">
              <BookOpen size={40} className="text-cream-dark mx-auto mb-4" />
              <p className="text-warm-gray text-sm mb-4">收藏的论文会出现在这里</p>
              <Link to="/" className="text-coral text-sm hover:underline">去看看推荐论文</Link>
            </div>
          )}

          {!loading && papers.length > 0 && (
            <>
              <div className="relative mb-5">
                <Search size={13} className="absolute left-4 top-1/2 -translate-y-1/2 text-warm-gray/40" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="搜索论文标题…"
                  className="w-full bg-warm-white rounded-2xl pl-10 pr-4 py-2.5 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 placeholder:text-warm-gray/40 transition" />
              </div>

              <div className="flex gap-2 mb-6 flex-wrap">
                {categories.map(cat => (
                  <button key={cat} onClick={() => setActiveCategory(cat)}
                    className={`px-3 py-1 rounded-full text-xs transition ${
                      activeCategory === cat ? 'bg-navy/90 text-warm-white' : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
                    }`}>
                    {cat}
                  </button>
                ))}
              </div>

              {filtered.length === 0 && (
                <div className="text-center py-20 text-warm-gray/60 text-sm">没有符合条件的论文</div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {filtered.map((paper, i) => (
                  <PaperCard key={paper.id} paper={paper} onDelete={handleDelete} index={i} />
                ))}
              </div>
            </>
          )}
        </main>
      </div>

      <Navbar />

      {showAddModal && (
        <AddPaperModal
          onClose={() => setShowAddModal(false)}
          onAdded={(id) => { setShowAddModal(false); navigate(`/library/${id}`) }}
        />
      )}
    </div>
  )
}

// ── Mobile list row (unchanged) ──
function PaperRow({ paper, onDelete, index = 0 }) {
  const chineseHint = paper.summary_zh ? paper.summary_zh.split(/[。！？]/)[0] : ''
  return (
    <Link
      to={`/library/${paper.id}`}
      className="block bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl px-4 py-3.5 border border-cream-dark/[0.7] group hover:border-coral/30 hover:shadow-sm transition-all duration-150 breathe-in"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-coral/10 text-coral font-medium leading-5 max-w-[120px] truncate">
          {paper.category || '未分类'}
        </span>
        <div className="flex items-center gap-2 text-[11px] text-warm-gray/50">
          {paper.note_count > 0 && (
            <span className="flex items-center gap-0.5 text-coral/70"><FileText size={11} />{paper.note_count}</span>
          )}
          {paper.chat_count > 0 && (
            <span className="flex items-center gap-0.5"><MessageCircle size={11} />{paper.chat_count}</span>
          )}
          <span className="text-warm-gray/40">{timeAgo(paper.saved_at)}</span>
          <button onClick={(e) => onDelete(paper.id, e)}
            className="opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-coral transition-all p-0.5">
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      <p className="text-[13px] text-navy leading-snug line-clamp-3 mb-1">{paper.title}</p>
      {chineseHint && (
        <p className="text-[12px] text-warm-gray/60 leading-relaxed line-clamp-1 mt-1">{chineseHint}</p>
      )}
    </Link>
  )
}

// ── Desktop card ──
function PaperCard({ paper, onDelete, index = 0 }) {
  return (
    <Link
      to={`/library/${paper.id}`}
      className="block bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7] hover:-translate-y-0.5 hover:shadow-md transition cursor-pointer group"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-coral/10 text-coral font-medium leading-5 max-w-[130px] truncate">
          {paper.category || '未分类'}
        </span>
        <div className="flex items-center gap-2 text-[11px] text-warm-gray/50">
          {paper.note_count > 0 && (
            <span className="flex items-center gap-0.5 text-coral/70"><FileText size={10} />{paper.note_count}</span>
          )}
          {paper.chat_count > 0 && (
            <span className="flex items-center gap-0.5"><MessageCircle size={10} />{paper.chat_count}</span>
          )}
          <span>{timeAgo(paper.saved_at)}</span>
          <button onClick={e => onDelete(paper.id, e)}
            className="opacity-0 group-hover:opacity-100 hover:text-coral transition-all p-0.5">
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      <h3 className="text-navy text-[14px] leading-relaxed font-medium line-clamp-3 mb-2">{paper.title}</h3>
      {paper.summary_zh && (
        <p className="text-warm-gray text-[12px] leading-relaxed line-clamp-2">{paper.summary_zh}</p>
      )}
      {paper.relevance && (
        <div className="mt-3 pt-3 border-t border-cream-dark/40 flex items-start gap-1.5">
          <span className="text-coral text-xs mt-0.5 flex-shrink-0">◆</span>
          <p className="text-navy-light text-[12px] leading-relaxed italic line-clamp-2">{paper.relevance}</p>
        </div>
      )}
    </Link>
  )
}

// ── Add paper modal (unchanged) ──
function AddPaperModal({ onClose, onAdded }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    setError('')
    setResults(null)
    try {
      const data = await apiPost('/lookup-paper', { query: query.trim() })
      if (data.error) { setError(data.error); return }
      setResults(data.papers || [])
      if ((data.papers || []).length === 0) setError('未找到相关论文，请尝试更换关键词')
    } catch {
      setError('查询失败，请稍后重试')
    } finally {
      setSearching(false)
    }
  }

  const handleAdd = async (paper) => {
    setSaving(paper.pmid || paper.title)
    try {
      const res = await apiPost('/library/save', { paper, chats: [] })
      if (res.ok) onAdded(res.id)
    } catch {
      setError('收藏失败')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-navy/40 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-warm-white rounded-3xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-cream-dark/50">
          <h2 className="text-base font-semibold text-navy">添加论文</h2>
          <button onClick={onClose} className="text-warm-gray hover:text-navy transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs text-warm-gray mb-3">输入 PMID、DOI 或标题关键词</p>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="例：38765432 / 10.1016/j.xxx / frailty elderly care"
              className="flex-1 bg-cream/50 rounded-xl px-3 py-2.5 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/40"
            />
            <button onClick={handleSearch} disabled={searching || !query.trim()}
              className="px-4 py-2.5 bg-coral text-warm-white rounded-xl text-sm font-medium hover:bg-coral-light transition-colors disabled:opacity-50 flex items-center gap-1.5">
              {searching ? <Loader2 size={14} className="animate-spin" /> : '搜索'}
            </button>
          </div>
          {error && <p className="text-xs text-coral mt-3">{error}</p>}
          {results !== null && results.length > 0 && (
            <div className="mt-4 space-y-2 max-h-72 overflow-y-auto">
              {results.map((paper, i) => (
                <div key={paper.pmid || i} className="bg-cream/40 rounded-2xl p-3.5 border border-cream-dark/40">
                  <p className="text-[13px] text-navy leading-snug font-medium line-clamp-2 mb-1.5">{paper.title}</p>
                  <p className="text-[11px] text-warm-gray/70 mb-3">
                    {paper.pub_date && <span className="mr-2">{paper.pub_date}</span>}
                    {paper.journal && <span>{paper.journal}</span>}
                  </p>
                  <button onClick={() => handleAdd(paper)} disabled={!!saving}
                    className="w-full py-2 rounded-xl text-xs font-medium bg-navy text-warm-white hover:bg-navy-light transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                    {saving === (paper.pmid || paper.title)
                      ? <><Loader2 size={12} className="animate-spin" /> 正在添加...</>
                      : <>收藏并讨论</>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
