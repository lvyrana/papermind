import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Clock, Loader2, RefreshCw, AlertCircle, RotateCcw, Sprout, Heart, Lightbulb } from 'lucide-react'
import Navbar from '../components/Navbar'
import { apiGet, apiPost } from '../api'

function loadCachedJson(key, fallback) {
  try {
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) : fallback
  } catch {
    return fallback
  }
}

export default function Home() {
  const [papers, setPapers] = useState(() => loadCachedJson('cached-papers', []))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastReading] = useState(() => loadCachedJson('last-reading', null))
  const [total, setTotal] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const [allExplored, setAllExplored] = useState(false)
  const [profileFilled, setProfileFilled] = useState(true)

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  // 副标题：按时间段 + 日期种子轻微变化
  const subtitles = [
    '这是属于你的研究空间。',
    '今天也从一个好问题开始。',
    '慢一点，也能走得很深。',
    '这里会记得你在追什么。',
    '每一篇论文，都是一次对话的起点。',
    '你的好奇心，值得被认真对待。',
  ]
  const dayIndex = now.getDate() + (hour < 12 ? 0 : hour < 18 ? 1 : 2)
  const subtitle = subtitles[dayIndex % subtitles.length]

  // 上次在读的文案
  const resumeLabels = ['你上次停在这里', '继续你的思路', '接着上次的探索']
  const resumeLabel = resumeLabels[now.getDate() % resumeLabels.length]

  useEffect(() => {
    // 触发兴趣摘要更新（后端有 24h 防重复）
    apiPost('/profile/interests-summary', {}).catch(() => {})

    // 检查画像是否已填写
    apiGet('/profile')
      .then(data => {
        const filled = !!(data.focus_areas || data.method_interests || data.background || data.current_goal)
        setProfileFilled(filled)
      })
      .catch(() => {})
  }, [])

  const pollRef = React.useRef(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const handlePapersData = (data) => {
    setPapers(data.papers || [])
    setTotal(data.total || 0)
    setRemaining(data.remaining ?? 0)
    setAllExplored(data.all_explored || false)
    localStorage.setItem('cached-papers', JSON.stringify(data.papers || []))
    localStorage.setItem('cached-papers-time', new Date().toISOString())
  }

  // 轮询：当前页解读补全
  const startEnrichPoll = () => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const poll = await apiGet('/papers?poll=true')
        if (poll.papers?.length) {
          setPapers(poll.papers)
          localStorage.setItem('cached-papers', JSON.stringify(poll.papers))
        }
        if (!poll.enriching) {
          stopPolling()
        }
      } catch { /* ignore */ }
    }, 3000)
  }

  const fetchPapers = async (opts = {}) => {
    const { refresh = false, forceFetch = false } = opts
    setLoading(true)
    setError(null)
    stopPolling()
    try {
      const params = new URLSearchParams()
      if (refresh) params.set('refresh', 'true')
      if (forceFetch) params.set('force_fetch', 'true')
      const data = await apiGet(`/papers?${params}`)
      if (data.rate_limited) {
        setError(data.error)
        setLoading(false)
      } else if (data.loading) {
        // 后端在抓取中，轮询等待抓取完成
        pollRef.current = setInterval(async () => {
          try {
            const poll = await apiGet('/papers')
            if (!poll.loading) {
              stopPolling()
              handlePapersData(poll)
              setLoading(false)
              // 抓取完但可能还在解读，继续轮询解读状态
              if (poll.enriching) startEnrichPoll()
            }
          } catch { /* ignore */ }
        }, 3000)
      } else {
        handlePapersData(data)
        setLoading(false)
        // 论文返回了但解读还在后台跑
        if (data.enriching) startEnrichPoll()
      }
    } catch {
      setError('无法连接后端服务。请确认后端已启动。')
      const cached = localStorage.getItem('cached-papers')
      if (cached) setPapers(JSON.parse(cached))
      setLoading(false)
    }
  }

  // 清理轮询定时器
  useEffect(() => {
    return () => stopPolling()
  }, [])

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-14 pb-10 max-w-2xl mx-auto">
        <p className="text-warm-gray text-sm mb-3">
          {now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
        </p>
        <h1 className="text-3xl font-bold text-navy-light font-serif leading-snug tracking-wide">
          <span className="wavy-underline">{greeting}</span>
        </h1>
        <p className="text-navy/45 mt-4 leading-relaxed tracking-wide">
          {subtitle}
        </p>
      </header>

      <main className="px-6 max-w-2xl mx-auto space-y-8">
        {/* Last reading */}
        <section className="breathe-in">
          {lastReading ? (
            <>
              <div className="flex items-center gap-2 mb-4">
                <Clock size={16} className="text-coral/70" />
                <h2 className="text-sm text-warm-gray">{resumeLabel}</h2>
              </div>
              <Link to={`/paper/${lastReading._cache_index ?? lastReading.index ?? 0}`} state={{ paper: lastReading }} className="block group">
                <div className="bg-warm-white rounded-2xl p-5 shadow-sm card-hover border border-cream-dark/50 relative">
                  <p className="text-navy font-medium leading-relaxed text-[15px]">
                    {lastReading.title}
                  </p>
                  {lastReading.note && (
                    <p className="text-warm-gray text-sm mt-3 italic">"{lastReading.note}"</p>
                  )}
                  <div className="flex items-center justify-between mt-4">
                    {lastReading.readAt ? (
                      <span className="text-warm-gray/60 text-xs">
                        上次阅读：{new Date(lastReading.readAt).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    ) : <span />}
                    <span className="text-coral/0 group-hover:text-coral/80 text-sm flex items-center gap-1 transition-all duration-200">
                      接着读 <ArrowRight size={14} />
                    </span>
                  </div>
                </div>
              </Link>
            </>
          ) : (
            <p className="text-warm-gray text-sm py-2">今天还没有开始阅读，不如从一个问题开始。</p>
          )}
        </section>

        {/* Papers */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sprout size={16} className="text-coral" />
              <h2 className="text-sm font-medium text-navy/60">为你探索</h2>
            </div>
            {total > 0 && (
              <span className="text-xs text-warm-gray bg-cream-dark/50 px-3 py-1 rounded-full">
                {allExplored
                  ? `${total} 篇已全部探索完`
                  : remaining > 0
                    ? `共 ${total} 篇，还有 ${remaining} 篇未看`
                    : `共 ${total} 篇`}
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
                disabled={loading || allExplored}
                className={`flex-1 py-3 rounded-full text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-sm ${
                  allExplored
                    ? 'bg-cream-dark/50 text-warm-gray cursor-not-allowed'
                    : 'bg-coral text-warm-white hover:bg-coral-light shadow-[0_3px_14px_rgba(232,135,122,0.35)]'
                }`}
              >
                {loading ? (
                  <><Loader2 size={14} className="animate-spin" /> 加载中...</>
                ) : allExplored ? (
                  '已全部探索完'
                ) : (
                  <><RefreshCw size={14} /> 换一批{remaining > 0 ? <span className="opacity-60 text-xs ml-1">剩 {remaining} 篇</span> : null}</>
                )}
              </button>
              <button
                onClick={() => {
                  fetchPapers({ forceFetch: true })
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                disabled={loading}
                className="py-3 px-5 rounded-full text-sm text-warm-gray border border-cream-dark hover:text-navy hover:border-navy/20 transition-all disabled:opacity-50 flex items-center gap-1.5"
              >
                <RotateCcw size={14} />
                重新抓取
              </button>
            </div>
          )}

          {!loading && papers.length === 0 && !error && (
            <div className="flex flex-col items-center gap-3 py-12">
              <p className="text-warm-gray text-sm">还没有推荐结果。</p>
              <button onClick={() => fetchPapers()}
                className="px-4 py-2 bg-navy text-warm-white rounded-full text-sm hover:bg-navy-light transition-colors">
                获取推荐论文
              </button>
            </div>
          )}
        </section>

        {/* Profile nudge — 填写后隐藏 */}
        {!profileFilled && (
          <section className="breathe-in" style={{ animationDelay: '200ms' }}>
            <Link to="/profile">
              <div className="bg-navy/5 rounded-2xl p-5 border border-navy/10 card-hover">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-coral/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Heart size={16} className="text-coral" />
                  </div>
                  <div>
                    <p className="text-navy font-medium text-sm">完善你的研究画像</p>
                    <p className="text-navy/40 text-sm mt-1 leading-relaxed">
                      告诉我你的研究背景，推荐会更准。
                    </p>
                  </div>
                </div>
              </div>
            </Link>
          </section>
        )}
      </main>

      <Navbar />
    </div>
  )
}

function PaperCard({ paper, index }) {
  const cacheIndex = paper._cache_index ?? index
  return (
    <Link to={`/paper/${cacheIndex}`} state={{ paper }} className="block breathe-in" style={{ animationDelay: `${index * 80}ms` }}>
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
          <p className="text-navy-light text-sm mt-2 flex items-start gap-1.5">
            <Lightbulb size={13} className="text-coral flex-shrink-0 mt-0.5" />
            <span className="line-clamp-1 italic">{paper.relevance}</span>
          </p>
        )}
      </div>
    </Link>
  )
}
