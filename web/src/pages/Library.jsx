import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, BookOpen, MessageCircle, FileText, Trash2, Clock, Search } from 'lucide-react'
import Navbar from '../components/Navbar'
import { apiGet, apiDelete } from '../api'

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const now = new Date()
  const date = new Date(dateStr)
  const diff = Math.floor((now - date) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'short'
  })
}

export default function Library() {
  const [papers, setPapers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')
  const [sortBy, setSortBy] = useState('saved') // 'saved' | 'read'

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

  // 分类列表（自动提取）
  const categories = useMemo(() => {
    const cats = [...new Set(papers.map(p => p.category).filter(Boolean))]
    return ['全部', ...cats]
  }, [papers])

  // 过滤 + 排序
  const filtered = useMemo(() => {
    let result = papers
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(p => p.title.toLowerCase().includes(q))
    }
    if (activeCategory !== '全部') {
      result = result.filter(p => p.category === activeCategory)
    }
    return [...result].sort((a, b) => {
      const aTime = sortBy === 'read' ? (a.last_read_at || a.saved_at) : a.saved_at
      const bTime = sortBy === 'read' ? (b.last_read_at || b.saved_at) : b.saved_at
      return new Date(bTime) - new Date(aTime)
    })
  }, [papers, search, activeCategory, sortBy])

  // 按日期分组
  const grouped = {}
  filtered.forEach(p => {
    const dateKey = formatDate(sortBy === 'read' ? (p.last_read_at || p.saved_at) : p.saved_at)
    if (!grouped[dateKey]) grouped[dateKey] = []
    grouped[dateKey].push(p)
  })

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-12 pb-4 max-w-3xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold text-navy font-serif">我的收藏</h1>
          <button
            onClick={() => setSortBy(v => v === 'saved' ? 'read' : 'saved')}
            className="text-xs text-warm-gray hover:text-navy transition-colors"
          >
            {sortBy === 'saved' ? '按收藏时间' : '按最近阅读'}
          </button>
        </div>

        {/* 搜索框 */}
        {papers.length > 0 && (
          <div className="relative mt-4">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-warm-gray/50" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索论文标题..."
              className="w-full bg-warm-white rounded-xl pl-9 pr-4 py-2.5 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all placeholder:text-warm-gray/40"
            />
          </div>
        )}

        {/* 分类筛选 */}
        {categories.length > 1 && (
          <div className="flex gap-2 mt-3 overflow-x-auto pb-1 scrollbar-hide">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`shrink-0 px-3 py-1 rounded-full text-xs transition-all duration-200 ${
                  activeCategory === cat
                    ? 'bg-navy/90 text-warm-white'
                    : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="px-6 max-w-3xl mx-auto">
        {loading && (
          <div className="text-center py-12 text-warm-gray text-sm">加载中...</div>
        )}

        {!loading && papers.length === 0 && (
          <div className="text-center py-16">
            <BookOpen size={32} className="text-cream-dark mx-auto mb-4" />
            <p className="text-warm-gray text-sm mb-4">收藏的论文会出现在这里</p>
            <Link to="/" className="text-coral text-sm hover:underline">
              去看看本周论文
            </Link>
          </div>
        )}

        {/* 按日期分组的卡片网格 */}
        {Object.entries(grouped).map(([date, datePapers], groupIdx) => (
          <div key={date} className="mb-8 breathe-in" style={{ animationDelay: `${groupIdx * 120}ms` }}>
            {/* 日期时间戳 */}
            <div className="flex items-center gap-2 mb-4">
              <Clock size={14} className="text-coral" />
              <span className="text-sm font-medium text-warm-gray">{date}</span>
              <div className="flex-1 h-px bg-cream-dark/50" />
            </div>

            {/* 卡片网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {datePapers.map((paper, i) => (
                <LibraryCard key={paper.id} paper={paper} onDelete={handleDelete} index={i} />
              ))}
            </div>
          </div>
        ))}
      </main>

      <Navbar />
    </div>
  )
}

function LibraryCard({ paper, onDelete, index = 0 }) {
  return (
    <Link to={`/library/${paper.id}`} className="block breathe-in" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="bg-warm-white rounded-2xl p-5 shadow-sm card-hover border border-cream-dark/50 relative group h-full">
        {/* 删除按钮 */}
        <button
          onClick={(e) => onDelete(paper.id, e)}
          className="absolute top-3 right-3 p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-coral/10 text-warm-gray hover:text-coral transition-all"
        >
          <Trash2 size={14} />
        </button>

        {/* 分类标签 */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs px-2.5 py-1 rounded-full bg-coral/10 text-coral font-medium">
            {paper.category || '未分类'}
          </span>
          <span className="text-xs text-warm-gray/50">
            {paper.source === 'pubmed' ? 'PubMed' : 'S2'}
          </span>
        </div>

        {/* 标题 */}
        <h3 className="text-navy font-medium leading-relaxed text-[14px] line-clamp-3 mb-3">
          {paper.title}
        </h3>

        {/* 中文摘要预览 */}
        {paper.summary_zh && (
          <p className="text-warm-gray text-xs leading-relaxed line-clamp-2 mb-3">
            {paper.summary_zh}
          </p>
        )}

        {/* 底部：笔记数 + 对话数 + 时间 */}
        <div className="flex items-center gap-3 text-xs text-warm-gray/60 mt-auto pt-2 border-t border-cream-dark/30">
          {paper.note_count > 0 && (
            <span className="flex items-center gap-1">
              <FileText size={12} />
              {paper.note_count} 条笔记
            </span>
          )}
          {paper.chat_count > 0 && (
            <span className="flex items-center gap-1">
              <MessageCircle size={12} />
              {paper.chat_count} 条对话
            </span>
          )}
          <span className="ml-auto">{timeAgo(paper.last_read_at || paper.saved_at)}</span>
        </div>
      </div>
    </Link>
  )
}
