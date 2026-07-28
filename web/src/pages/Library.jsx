import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, BookOpen, MessageCircle, FileText, Search, Trash2, Plus, X, Loader2, FolderOpen } from 'lucide-react'
import Navbar from '../components/Navbar'
import { apiGet, apiDelete, apiPost } from '../api'

// 「在读」判定与首页一致：last_read_at（缺则 saved_at）在近 14 天内
const READING_WINDOW_DAYS = 14
function deriveReadStatus(p) {
  const ts = p?.last_read_at || p?.saved_at
  if (!ts) return '读过'
  const days = (Date.now() - new Date(ts).getTime()) / 86400000
  return days <= READING_WINDOW_DAYS ? '在读' : '读过'
}

// 画像卡：卡片四类的展示顺序与配色（与 CardDrawer 一致）
const CARD_MIX_META = [
  { key: 'method', label: '方法', tone: '#E8877A' },
  { key: 'finding', label: '发现', tone: '#7BB89C' },
  { key: 'critique', label: '批判', tone: '#2D5380' },
  { key: 'transfer', label: '迁移', tone: '#B56A5A' },
]

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
  const [papers, setPapers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cached-library-papers') || '[]') } catch { return [] }
  })
  const [loading, setLoading] = useState(() => {
    try { return !localStorage.getItem('cached-library-papers') } catch { return true }
  })
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')
  const [notesOnly, setNotesOnly] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [newProjectName, setNewProjectName] = useState('')
  const [showNewProject, setShowNewProject] = useState(false)
  const newProjectRef = useRef(null)
  // 书架：画像摘要（只读副产品）+ 状态筛选
  const [portrait, setPortrait] = useState(null)
  const [shelfFilter, setShelfFilter] = useState('全部')

  useEffect(() => {
    apiGet('/library')
      .then(data => {
        const nextPapers = data.papers || []
        setPapers(nextPapers)
        localStorage.setItem('cached-library-papers', JSON.stringify(nextPapers))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    apiGet('/projects')
      .then(data => setProjects(data.projects || []))
      .catch(() => {})
    apiGet('/portrait')
      .then(setPortrait)
      .catch(() => {})
  }, [])

  // 项目（任务型收藏夹）：书架单栏化后暂无入口，逻辑保留待新 IA 安排位置。
  // 集中挂在 projectApi 上，避免散落的未引用符号。
  const projectApi = {
    projects,
    activeProject,
    setActiveProject,
    newProjectName,
    setNewProjectName,
    showNewProject,
    setShowNewProject,
    newProjectRef,
    create: async () => {
      const name = newProjectName.trim()
      if (!name) return
      const res = await apiPost('/projects', { name }).catch(() => null)
      if (res?.ok) {
        setProjects(prev => [{ id: res.id, name, description: '', paper_count: 0 }, ...prev])
        setNewProjectName('')
        setShowNewProject(false)
      }
    },
    remove: async (e, id) => {
      e.stopPropagation()
      if (!confirm('删除项目后，项目内论文会移回普通收藏，确定删除？')) return
      await apiDelete(`/projects/${id}`).catch(() => {})
      setProjects(prev => prev.filter(p => p.id !== id))
      if (activeProject === id) setActiveProject(null)
      setPapers(prev => prev.map(p => p.project_id === id ? { ...p, project_id: null } : p))
    },
  }
  void projectApi  // 暂无 UI 入口；保留能力，勿删

  const handleDelete = async (id, e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm('确定要取消收藏吗？笔记和对话也会删除。')) return
    await apiDelete(`/library/${id}`)
    setPapers(prev => {
      const nextPapers = prev.filter(p => p.id !== id)
      localStorage.setItem('cached-library-papers', JSON.stringify(nextPapers))
      return nextPapers
    })
  }

  const categories = useMemo(() => {
    const cats = [...new Set(papers.map(p => p.category).filter(Boolean))]
    return ['全部', ...cats]
  }, [papers])


  const filtered = useMemo(() => {
    let result = papers
    if (activeProject !== null) {
      result = result.filter(p => p.project_id === activeProject)
    }
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
  }, [papers, search, activeCategory, notesOnly, activeProject])

  const hasNotes = useMemo(() => papers.some(p => p.note_count > 0), [papers])

  // ── 书架（桌面）：统计行 + 状态筛选 + 按最近动过排序 ──
  const shelfStats = useMemo(() => {
    const reading = papers.filter(p => deriveReadStatus(p) === '在读').length
    return {
      total: papers.length,
      reading,
      done: papers.length - reading,
      cards: papers.reduce((s, p) => s + (p.card_count || 0), 0),
      notes: papers.reduce((s, p) => s + (p.note_count || 0), 0),
    }
  }, [papers])

  const shelfProjects = useMemo(() => {
    let result = [...papers]
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(p => p.title.toLowerCase().includes(q))
    }
    if (shelfFilter === '在读') result = result.filter(p => deriveReadStatus(p) === '在读')
    else if (shelfFilter === '读过') result = result.filter(p => deriveReadStatus(p) === '读过')
    else if (shelfFilter === '有导出') result = result.filter(p => p.has_export)
    return result.sort((a, b) =>
      new Date(b.last_read_at || b.saved_at || 0) - new Date(a.last_read_at || a.saved_at || 0))
  }, [papers, search, shelfFilter])

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

      {/* ── 书架 · 桌面（单栏：页头 + 画像卡 + 筛选 + 精读工程列表 + 导出成果）── */}
      <div className="hidden lg:block max-w-[1280px] mx-auto px-10 pt-24 pb-16">
        <div className="mb-6">
          <h1 className="pm-page-title text-[34px] text-navy leading-tight">我的书架</h1>
          <p className="text-warm-gray text-xs mt-2">
            共 {shelfStats.total} 篇 · {shelfStats.reading} 在读 · {shelfStats.done} 读过
            {shelfStats.cards > 0 && ` · ${shelfStats.cards} 卡片`}
            {shelfStats.notes > 0 && ` · ${shelfStats.notes} 笔记`}
          </p>
        </div>

        <PortraitCard portrait={portrait} />

        <div className="flex items-center justify-between gap-4 mb-4 mt-8">
          <h2 className="text-lg font-serif text-navy m-0">精读工程</h2>
          {papers.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-warm-gray/40" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="搜索标题…"
                  className="w-[220px] bg-warm-white rounded-full pl-8 pr-3 py-1.5 text-xs text-navy border border-cream-dark/60 outline-none focus:border-coral/40 placeholder:text-warm-gray/40 transition" />
              </div>
              <div className="flex gap-2 text-[11px]">
                {['全部', '在读', '读过', '有导出'].map(t => (
                  <button key={t} onClick={() => setShelfFilter(t)}
                    className={`px-3 py-1.5 rounded-full transition ${
                      shelfFilter === t ? 'bg-navy text-warm-white' : 'text-warm-gray border border-cream-dark hover:text-navy'
                    }`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {loading && papers.length === 0 && (
          <div className="text-center py-20 text-warm-gray text-sm">加载中…</div>
        )}

        {!loading && papers.length === 0 && (
          <div className="rounded-2xl border border-cream-dark/60 bg-warm-white/70 px-6 py-16 text-center">
            <BookOpen size={36} className="text-navy/15 mx-auto mb-4" />
            <p className="text-navy/75 text-[15px] mb-1.5">还没有精读工程</p>
            <p className="text-warm-gray text-[13px] mb-5">放入第一篇论文，开始你的精读书架。</p>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-coral px-4 py-2.5 text-sm font-medium text-warm-white hover:bg-coral-light transition-colors"
            >
              <Plus size={14} />
              放入一篇论文
            </button>
          </div>
        )}

        {shelfProjects.length > 0 && (
          <div className="space-y-3">
            {shelfProjects.map(p => (
              <ShelfProjectRow key={p.id} p={p} onDelete={handleDelete} />
            ))}
          </div>
        )}

        {!loading && papers.length > 0 && shelfProjects.length === 0 && (
          <div className="text-center py-16 text-warm-gray/60 text-sm">没有符合条件的精读工程</div>
        )}

        {papers.length > 0 && (
          <button onClick={() => setShowAddModal(true)}
            className="mt-6 w-full py-3 rounded-2xl border border-dashed border-coral/40 text-coral text-sm flex items-center justify-center gap-2 hover:bg-coral/5 transition">
            <Plus size={14} /> 放入一篇论文
          </button>
        )}
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

/* ═══════════════════════════════════════════════════════════════
   书架 · 画像卡（只读副产品）+ 精读工程行
   ═══════════════════════════════════════════════════════════════ */

// 画像卡：全部由行为聚合，无任何输入控件；数据不足（少于 3 篇精读）时不渲染
function PortraitCard({ portrait }) {
  if (!portrait || (portrait.total_papers ?? 0) < 3) return null

  const topics = (portrait.topics || []).filter(t => t.n > 0)
  const mix = CARD_MIX_META
    .map(m => ({ ...m, n: portrait.card_mix?.[m.key] || 0 }))
    .filter(m => m.n > 0)
  const maxMix = Math.max(1, ...mix.map(m => m.n))

  // 一句话总结由聚合结果拼出（不是编出来的文案）
  const topTopics = topics.slice(0, 2).map(t => t.name).join(' 与 ')
  const topKinds = [...mix].sort((a, b) => b.n - a.n).slice(0, 2).map(m => m.label).join('与')
  const line = topTopics
    ? `你在 ${topTopics} 这条线上读得最深${topKinds ? `；卡片集中在${topKinds}` : ''}。`
    : `已经精读 ${portrait.total_papers} 篇，卡片正在积累。`

  return (
    <div className="bg-navy text-warm-white rounded-3xl p-6 relative overflow-hidden">
      <div className="absolute -right-10 -top-12 w-44 h-44 rounded-full bg-navy-light/40 blur-2xl" />
      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-[0.22em] text-warm-white/55 m-0">我的精读画像</p>
          <span className="text-[10px] text-warm-white/45">
            近 30 天 · {portrait.recent_papers} 篇精读
          </span>
        </div>
        <p className="text-[13.5px] leading-7 text-warm-white/90 m-0">{line}</p>

        {(topics.length > 0 || mix.length > 0) && (
          <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4">
            {topics.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-warm-white/45 mb-2.5 m-0">主题</p>
                <div className="space-y-1.5">
                  {topics.map(t => (
                    <div key={t.name} className="flex items-center justify-between text-[12px]">
                      <span className="text-warm-white/80">{t.name}</span>
                      <span className="text-warm-white/45">{t.n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {mix.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-warm-white/45 mb-2.5 m-0">卡片构成</p>
                <div className="space-y-2">
                  {mix.map(m => (
                    <div key={m.key} className="flex items-center gap-2">
                      <span className="text-[11px] text-warm-white/70 w-8 shrink-0">{m.label}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-warm-white/12 overflow-hidden">
                        <div className="h-full rounded-full"
                          style={{ width: `${(m.n / maxMix) * 100}%`, background: m.tone }} />
                      </div>
                      <span className="text-[10px] text-warm-white/45 w-4">{m.n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 精读工程行（与首页同构，点进真精读台）
function ShelfProjectRow({ p, onDelete }) {
  const status = deriveReadStatus(p)
  const reading = status === '在读'
  const line = [p.authors, p.journal, p.pub_date].filter(Boolean).join(' · ')
  return (
    <Link
      to={`/paper/${p.id}?library=1`}
      state={{ paper: p }}
      className="group block bg-warm-white rounded-2xl border border-cream-dark/50 p-5 hover:shadow-md hover:-translate-y-0.5 transition no-underline"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium leading-5 bg-coral/10 text-coral">
              {p.category || '未分类'}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${reading ? 'bg-coral' : 'bg-mint-deep'}`} />
              <span className={reading ? 'text-coral' : 'text-warm-gray'}>{status}</span>
            </span>
          </div>
          <h3 className="text-navy text-[14px] leading-relaxed font-medium line-clamp-2 m-0">{p.title}</h3>
          {line && <p className="text-[11px] text-warm-gray mt-1.5 m-0 line-clamp-1">{line}</p>}
        </div>
        <div className="text-right shrink-0 flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-warm-gray/70">{timeAgo(p.last_read_at || p.saved_at)}</span>
            <button onClick={e => onDelete(p.id, e)}
              className="opacity-0 group-hover:opacity-100 text-warm-gray/40 hover:text-coral transition-all p-0.5">
              <Trash2 size={11} />
            </button>
          </div>
          {p.has_export ? (
            <span className="text-[10px] text-mint-deep bg-mint/15 rounded-full px-2 py-0.5">已导出</span>
          ) : null}
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-cream-dark/40 flex items-center justify-between">
        <div className="flex items-center gap-3 text-[11px] text-warm-gray">
          <span>◆ {p.card_count || 0} 卡片</span>
          <span>✎ {p.note_count || 0} 笔记</span>
          <span>◌ {p.chat_count || 0} 对话</span>
        </div>
        <span className="text-[11px] text-coral opacity-0 group-hover:opacity-100 transition">打开工作台 →</span>
      </div>
    </Link>
  )
}

// ── Mobile list row (unchanged) ──
function PaperRow({ paper, onDelete, index = 0 }) {
  const chineseHint = paper.summary_zh ? paper.summary_zh.split(/[。！？]/)[0] : ''
  return (
    <Link
      to={`/library/${paper.id}`}
      state={{ paper }}
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
      state={{ paper }}
      className="h-full block bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7] hover:-translate-y-0.5 hover:shadow-md transition cursor-pointer group flex flex-col"
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
      <div className="flex-1 overflow-hidden">
        {paper.summary_zh && (
          <p className="text-warm-gray text-[12px] leading-relaxed">{paper.summary_zh}</p>
        )}
      </div>
      {paper.relevance && (
        <div className="mt-4 pt-3 border-t border-cream-dark/40 flex items-start gap-1.5">
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
