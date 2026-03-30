import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Sparkles, Clock, Loader2, RefreshCw, AlertCircle, RotateCcw } from 'lucide-react'
import Navbar from '../components/Navbar'

const API = '/api'

export default function Home() {
  const [papers, setPapers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastReading, setLastReading] = useState(null)
  const [total, setTotal] = useState(0)
  const [remaining, setRemaining] = useState(0)

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  useEffect(() => {
    const saved = localStorage.getItem('last-reading')
    if (saved) setLastReading(JSON.parse(saved))
  }, [])

  const fetchPapers = async (opts = {}) => {
    const { refresh = false, forceFetch = false } = opts
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ days: '7' })
      if (refresh) params.set('refresh', 'true')
      if (forceFetch) params.set('force_fetch', 'true')
      const r = await fetch(`${API}/papers?${params}`)
      const data = await r.json()
      setPapers(data.papers || [])
      setTotal(data.total || 0)
      setRemaining(data.remaining ?? 0)
      // 缓存
      localStorage.setItem('cached-papers', JSON.stringify(data.papers || []))
      localStorage.setItem('cached-papers-time', new Date().toISOString())
    } catch (e) {
      setError('无法连接后端服务。请确认后端已启动。')
      const cached = localStorage.getItem('cached-papers')
      if (cached) setPapers(JSON.parse(cached))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // 先尝试读缓存
    const cached = localStorage.getItem('cached-papers')
    const cachedTime = localStorage.getItem('cached-papers-time')
    if (cached && cachedTime) {
      const age = Date.now() - new Date(cachedTime).getTime()
      if (age < 1000 * 60 * 30) {
        setPapers(JSON.parse(cached))
        return
      }
    }
    fetchPapers()
  }, [])

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-12 pb-8 max-w-2xl mx-auto">
        <p className="text-warm-gray text-sm mb-2">
          {now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
        </p>
        <h1 className="text-3xl font-bold text-navy font-serif leading-snug">
          {greeting}，<span className="wavy-underline">研究者</span>
        </h1>
        <p className="text-warm-gray mt-3 leading-relaxed">
          这是属于你的研究空间。
        </p>
      </header>

      <main className="px-6 max-w-2xl mx-auto space-y-8">
        {/* Last reading */}
        {lastReading && (
          <section className="breathe-in">
            <div className="flex items-center gap-2 mb-4">
              <Clock size={16} className="text-coral" />
              <h2 className="text-sm font-medium text-warm-gray">上次在读</h2>
            </div>
            <Link to={`/paper/${lastReading.index || 0}`} state={{ paper: lastReading }} className="block">
              <div className="bg-warm-white rounded-2xl p-5 shadow-sm card-hover border border-cream-dark/50">
                <p className="text-navy font-medium leading-relaxed text-[15px]">
                  {lastReading.title}
                </p>
                {lastReading.note && (
                  <p className="text-warm-gray text-sm mt-3 italic">"{lastReading.note}"</p>
                )}
                <div className="flex items-center justify-end mt-4">
                  <span className="text-coral text-sm flex items-center gap-1">
                    继续阅读 <ArrowRight size={14} />
                  </span>
                </div>
              </div>
            </Link>
          </section>
        )}

        {/* Papers */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-coral" />
              <h2 className="text-sm font-medium text-warm-gray">为你推荐</h2>
            </div>
            {total > 0 && (
              <span className="text-xs text-warm-gray bg-cream-dark/50 px-3 py-1 rounded-full">
                共 {total} 篇可选{remaining > 0 ? `，还有 ${remaining} 篇未看` : ''}
              </span>
            )}
          </div>

          {error && (
            <div className="bg-coral/5 border border-coral/20 rounded-xl p-4 mb-4 flex items-start gap-2">
              <AlertCircle size={16} className="text-coral flex-shrink-0 mt-0.5" />
              <p className="text-sm text-navy/70">{error}</p>
            </div>
          )}

          {loading && papers.length === 0 && (
            <div className="text-center py-12">
              <Loader2 size={24} className="text-coral animate-spin mx-auto mb-3" />
              <p className="text-warm-gray text-sm">正在获取文献并生成个性化解读...</p>
              <p className="text-warm-gray/60 text-xs mt-1">首次加载需要 1-2 分钟，之后换批秒出</p>
            </div>
          )}

          {/* Loading overlay when refreshing with existing papers */}
          <div className={`space-y-4 transition-opacity ${loading && papers.length > 0 ? 'opacity-40 pointer-events-none' : ''}`}>
            {papers.map((paper, index) => (
              <PaperCard key={paper.pmid || paper.paper_id || index} paper={paper} index={index} />
            ))}
          </div>

          {/* 操作按钮 */}
          {papers.length > 0 && (
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  fetchPapers({ refresh: true })
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                disabled={loading}
                className="flex-1 py-3 rounded-xl text-sm font-medium bg-coral text-warm-white hover:bg-coral-light transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-sm"
              >
                {loading ? (
                  <><Loader2 size={14} className="animate-spin" /> 加载中...</>
                ) : (
                  <><RefreshCw size={14} /> 换一批</>
                )}
              </button>
              <button
                onClick={() => {
                  fetchPapers({ forceFetch: true })
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                disabled={loading}
                className="py-3 px-5 rounded-xl text-sm text-warm-gray border border-cream-dark hover:text-navy hover:border-navy/20 transition-all disabled:opacity-50 flex items-center gap-1.5"
              >
                <RotateCcw size={14} />
                重新抓取
              </button>
            </div>
          )}

          {!loading && papers.length === 0 && !error && (
            <div className="text-center py-12">
              <p className="text-warm-gray text-sm">还没有论文。</p>
              <button onClick={() => fetchPapers()}
                className="mt-3 px-4 py-2 bg-navy text-warm-white rounded-full text-sm hover:bg-navy-light transition-colors">
                获取本周文献
              </button>
            </div>
          )}
        </section>

        {/* Profile nudge */}
        <section className="breathe-in" style={{ animationDelay: '200ms' }}>
          <Link to="/profile">
            <div className="bg-navy/5 rounded-2xl p-5 border border-navy/10 card-hover">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-coral/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Sparkles size={16} className="text-coral" />
                </div>
                <div>
                  <p className="text-navy font-medium text-sm">完善你的研究画像</p>
                  <p className="text-warm-gray text-sm mt-1 leading-relaxed">
                    告诉我你的研究背景，推荐会更准。
                  </p>
                </div>
              </div>
            </div>
          </Link>
        </section>
      </main>

      <Navbar />
    </div>
  )
}

function PaperCard({ paper, index }) {
  return (
    <Link to={`/paper/${index}`} state={{ paper }} className="block breathe-in" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="bg-warm-white rounded-2xl p-5 shadow-sm card-hover border border-cream-dark/50">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs px-2.5 py-1 rounded-full bg-coral/10 text-coral font-medium">
            {paper.category || '未分类'}
          </span>
          <span className="text-xs text-warm-gray">{paper.pub_date}</span>
          {paper.source && (
            <span className="text-xs text-warm-gray/50">
              {paper.source === 'pubmed' ? 'PubMed' : 'S2'}
            </span>
          )}
        </div>
        <h3 className="text-navy font-medium leading-relaxed text-[15px]">
          {paper.title}
        </h3>
        {paper.summary_zh && (
          <p className="text-warm-gray text-sm mt-2 leading-relaxed line-clamp-2">
            {paper.summary_zh}
          </p>
        )}
        {paper.relevance && (
          <p className="text-warm-gray text-sm mt-2 flex items-start gap-1.5">
            <Sparkles size={13} className="text-coral flex-shrink-0 mt-0.5" />
            <span className="line-clamp-1">{paper.relevance}</span>
          </p>
        )}
      </div>
    </Link>
  )
}
