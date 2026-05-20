import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight, Bookmark, ChevronLeft, Clock, Heart, Loader2, RefreshCw, RotateCcw, Sprout,
  AlertCircle,
} from 'lucide-react'
import Navbar from '../components/Navbar'
import TourBubble from '../components/TourBubble'
import { apiGet, apiPost } from '../api'
import Terrain, { buildHills, buildTrails } from '../components/Terrain'

/* ─────────────────────────────────────────────────────────────
   HOME — 研究地形版 · "papermind 还记得"
   ─────────────────────────────────────────────────────────────
   设计原则：
   1. 保留全部现有逻辑（轮询、缓存、tour、searchDebug、mobile）
   2. Hero 抬升：memory_recent + 地形缩略图 + 上次停在这里
   3. 卡片重做：reason 银底从卡片底部 → 顶部 eyebrow
   4. 新增「papermind 还在替你 hold」线索区（lastReading 派生）
   5. 地形组件复用（与 Profile.jsx 共享同一套几何，先内联，稳定后抽 src/components/Terrain.jsx）
   ───────────────────────────────────────────────────────────── */

function loadCachedJson(key, fallback) {
  try {
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) : fallback
  } catch { return fallback }
}
function loadCachedNumber(key, fallback = 0) {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const parsed = parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch { return fallback }
}
function loadCachedBool(key, fallback = false) {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : raw === 'true'
  } catch { return fallback }
}
function persistHomeMeta({ total, remaining, allExplored, canGoBack }) {
  localStorage.setItem('cached-total', String(total ?? 0))
  localStorage.setItem('cached-remaining', String(remaining ?? 0))
  localStorage.setItem('cached-all-explored', String(!!allExplored))
  localStorage.setItem('cached-can-go-back', String(!!canGoBack))
}

export default function Home() {
  const navigate = useNavigate()
  const [papers, setPapers] = useState(() => loadCachedJson('cached-papers', []))
  const [searchDebug, setSearchDebug] = useState(() => loadCachedJson('cached-search-debug', null))
  const [showSearchDebug, setShowSearchDebug] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastReading] = useState(() => loadCachedJson('last-reading', null))
  const [total, setTotal] = useState(() => loadCachedNumber('cached-total', 0))
  const [remaining, setRemaining] = useState(() => loadCachedNumber('cached-remaining', 0))
  const [allExplored, setAllExplored] = useState(() => loadCachedBool('cached-all-explored', false))
  const [canGoBack, setCanGoBack] = useState(() => loadCachedBool('cached-can-go-back', false))
  const [profileFilled, setProfileFilled] = useState(true)
  const [profileChecked, setProfileChecked] = useState(false)
  const [needsProfile, setNeedsProfile] = useState(false)
  const [memoryRecent, setMemoryRecent] = useState('')
  const [memoryCore, setMemoryCore] = useState('')
  const [focusAreas, setFocusAreas] = useState('')
  const [methodInterests, setMethodInterests] = useState('')
  const [trackingDays, setTrackingDays] = useState('90')

  // ── Home tour (unchanged) ─────────────────────────────────────────────────
  const [homeTourStep, setHomeTourStep] = useState(0)
  const firstCardRef = useRef(null)
  const nextPageRef = useRef(null)
  const desktopFirstCardRef = useRef(null)
  const desktopNextPageRef = useRef(null)
  const homeTourStartedRef = useRef(false)

  useEffect(() => {
    if (papers.length > 0 && !homeTourStartedRef.current && !localStorage.getItem('pm-home-tour-done')) {
      homeTourStartedRef.current = true
      const t = setTimeout(() => {
        localStorage.setItem('pm-home-tour-done', '1')
        setHomeTourStep(1)
      }, 800)
      return () => clearTimeout(t)
    }
  }, [papers.length]) // eslint-disable-line react-hooks/exhaustive-deps

  function advanceHomeTour() {
    if (homeTourStep < 2) setHomeTourStep(s => s + 1)
    else { setHomeTourStep(0); localStorage.setItem('pm-home-tour-done', '1') }
  }

  // ── greeting + subtitle (unchanged vibe) ─────────────────────────────────
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  // ── load profile + memory ─────────────────────────────────────────────────
  useEffect(() => {
    apiPost('/profile/memory-recent', {}).catch(() => {})
    apiGet('/profile')
      .then(data => {
        const filled = !!(data.focus_areas || data.method_interests || data.background || data.current_goal)
        setProfileFilled(filled)
        setProfileChecked(true)
        setMemoryRecent(data.memory_recent || '')
        setMemoryCore(data.memory_core || '')
        setFocusAreas(data.focus_areas || '')
        setMethodInterests(data.method_interests || '')
        setTrackingDays(data.tracking_days || '90')
      })
      .catch(() => { setProfileChecked(true) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── onboarding redirect (unchanged) ──────────────────────────────────────
  useEffect(() => {
    if (profileChecked && !profileFilled && papers.length === 0) {
      if (sessionStorage.getItem('pm-skip-onboarding')) return
      navigate('/onboarding', { replace: true, state: { intro: true } })
    }
  }, [profileChecked, profileFilled, papers.length, navigate])

  // ── polling + fetchPapers (unchanged) ────────────────────────────────────
  const pollRef = useRef(null)
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

  const handlePapersData = (data) => {
    setPapers(data.papers || [])
    setSearchDebug(data.search_debug || null)
    setTotal(data.total ?? 0)
    setRemaining(data.remaining ?? 0)
    setAllExplored(!!data.all_explored)
    setCanGoBack(!!data.can_go_back)
    localStorage.setItem('cached-papers', JSON.stringify(data.papers || []))
    localStorage.setItem('cached-papers-time', new Date().toISOString())
    localStorage.setItem('cached-search-debug', JSON.stringify(data.search_debug || null))
    persistHomeMeta({
      total: data.total ?? 0, remaining: data.remaining ?? 0,
      allExplored: !!data.all_explored, canGoBack: !!data.can_go_back,
    })
  }

  const startEnrichPoll = () => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const poll = await apiGet('/papers?poll=true')
        if (poll.papers?.length) { setPapers(poll.papers); localStorage.setItem('cached-papers', JSON.stringify(poll.papers)) }
        if (poll.search_debug) { setSearchDebug(poll.search_debug); localStorage.setItem('cached-search-debug', JSON.stringify(poll.search_debug)) }
        if (poll.total !== undefined) setTotal(poll.total)
        if (poll.remaining !== undefined) setRemaining(poll.remaining)
        if (poll.all_explored !== undefined) setAllExplored(!!poll.all_explored)
        if (poll.can_go_back !== undefined) setCanGoBack(!!poll.can_go_back)
        persistHomeMeta({
          total: poll.total ?? loadCachedNumber('cached-total', 0),
          remaining: poll.remaining ?? loadCachedNumber('cached-remaining', 0),
          allExplored: poll.all_explored ?? loadCachedBool('cached-all-explored', false),
          canGoBack: poll.can_go_back ?? loadCachedBool('cached-can-go-back', false),
        })
        if (!poll.enriching) stopPolling()
      } catch { /* ignore */ }
    }, 3000)
  }

  const fetchPapers = async (opts = {}) => {
    const { refresh = false, forceFetch = false, back = false } = opts
    setLoading(true)
    setError(null)
    stopPolling()
    try {
      const params = new URLSearchParams()
      if (refresh) params.set('refresh', 'true')
      if (forceFetch) params.set('force_fetch', 'true')
      if (back) params.set('back', 'true')
      const data = await apiGet(`/papers?${params}`)
      if (data.needs_profile) { setNeedsProfile(true); setLoading(false) }
      else if (data.rate_limited) { setNeedsProfile(false); setError(data.error); setLoading(false) }
      else if (data.loading) {
        setNeedsProfile(false)
        pollRef.current = setInterval(async () => {
          try {
            const poll = await apiGet('/papers')
            if (!poll.loading) {
              stopPolling(); handlePapersData(poll); setLoading(false)
              if (poll.enriching) startEnrichPoll()
            }
          } catch { /* ignore */ }
        }, 3000)
      } else {
        handlePapersData(data); setLoading(false)
        if (data.enriching) startEnrichPoll()
      }
    } catch {
      setError('无法连接后端服务。请确认后端已启动。')
      const cached = localStorage.getItem('cached-papers')
      if (cached) setPapers(JSON.parse(cached))
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!profileFilled) return
    if (!sessionStorage.getItem('pm-auto-fetch')) return
    sessionStorage.removeItem('pm-auto-fetch')
    fetchPapers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileFilled])

  useEffect(() => { return () => stopPolling() }, [])

  useEffect(() => {
    const y = sessionStorage.getItem('home-scroll-y')
    if (y !== null) {
      sessionStorage.removeItem('home-scroll-y')
      requestAnimationFrame(() => window.scrollTo(0, parseInt(y)))
    }
  }, [])

  // ── derived ───────────────────────────────────────────────────────────────
  const focusTags = useMemo(() => splitTags(focusAreas), [focusAreas])
  const memoryText = `${memoryRecent || ''} ${memoryCore || ''}`

  // memory_recent 第一句 = 主推文案
  const memoryHighlight = useMemo(() => {
    if (!memoryRecent) return ''
    const match = memoryRecent.match(/^[^。！？\n]+[。！？]/)
    return match ? match[0].trim() : memoryRecent.slice(0, 90)
  }, [memoryRecent])

  // 地形 hills
  const hills = useMemo(() => buildHills(focusAreas, memoryText, 'mini'), [focusAreas, memoryText])
  const trails = useMemo(() => buildTrails(hills, methodInterests), [hills, methodInterests])

  // threads（papermind 还在 hold 的线索）— 从现有缓存派生
  // TODO(backend): /home/threads → 真实线索（低 dwell、问一句就停、收藏未读、冷却中）
  const threads = useMemo(() => {
    const out = []
    if (lastReading) {
      out.push({
        kind: 'paper',
        kindLabel: '上次停在这里',
        title: lastReading.title,
        why: lastReading.readAt ? `上次阅读于 ${formatTimeAgo(lastReading.readAt)} · 还可以继续` : '还可以继续',
        cta: '接着读',
        to: `/paper/${lastReading._cache_index ?? lastReading.index ?? 0}`,
        state: { paper: lastReading },
      })
    }
    return out
  }, [lastReading])

  return (
    <div className="min-h-screen pb-24 lg:pb-0">

      {/* ═══ DESKTOP ═══ */}
      <div className="hidden lg:block max-w-[1280px] mx-auto px-10 pt-24 pb-12">

        {/* ─── HERO ─── */}
        <section className="grid grid-cols-[1.4fr_1fr] gap-9 items-stretch mb-12">

          {/* hero text */}
          <div className="flex flex-col">
            <p className="text-[10.5px] uppercase tracking-[0.25em] font-mono text-coral mb-3">
              papermind · 还记得这些
            </p>
            <h1 className="font-serif text-[42px] font-medium text-navy leading-[1.2] tracking-wide m-0">
              <span className="wavy-underline">{greeting}</span>
            </h1>

            {memoryHighlight ? (
              <p className="mt-5 font-serif italic text-[17px] leading-[1.85] text-navy/75 m-0 max-w-[560px]">
                {memoryHighlight}
              </p>
            ) : profileFilled ? (
              <p className="mt-5 text-[15px] leading-relaxed text-navy/55 m-0 max-w-[560px]">
                这里会逐渐记住你最近在追的方向。先去看看推荐吧。
              </p>
            ) : (
              <p className="mt-5 text-[15px] leading-relaxed text-navy/55 m-0 max-w-[560px]">
                先去画像页告诉 papermind 你关注什么，它就开始记你了。
              </p>
            )}

            {/* stats line */}
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 mt-7 text-[13px] text-warm-gray">
              {focusTags.length > 0 && <><Stat n={focusTags.length} label="个长期方向"/><Sep/></>}
              {total > 0 && <><Stat n={total} label="篇推荐"/><Sep/></>}
              {remaining > 0 && !allExplored && <><Stat n={remaining} label="篇未看"/><Sep/></>}
              <span className="whitespace-nowrap font-mono text-[12px]">{formatSearchRange(trackingDays)}</span>
            </div>

            {/* resume card */}
            {lastReading && (
              <Link to={`/paper/${lastReading._cache_index ?? lastReading.index ?? 0}`}
                state={{ paper: lastReading }}
                onClick={() => sessionStorage.setItem('home-scroll-y', String(window.scrollY))}
                className="mt-auto pt-6 group">
                <div className="flex gap-4 items-center px-5 py-4 rounded-2xl bg-warm-white/70 border border-cream-dark/60 hover:border-cream-dark transition">
                  <span className="shrink-0 w-9 h-9 rounded-full bg-coral/10 text-coral flex items-center justify-center">
                    <Clock size={15}/>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[9.5px] uppercase tracking-[0.22em] font-mono text-warm-gray">上次停在这里 · {lastReading.readAt ? formatTimeAgo(lastReading.readAt) : '刚才'}</p>
                    <p className="m-0 mt-1 text-[13.5px] leading-[1.5] text-navy line-clamp-1">{lastReading.title}</p>
                  </div>
                  <ArrowRight size={14} className="shrink-0 text-coral group-hover:translate-x-0.5 transition-transform"/>
                </div>
              </Link>
            )}
          </div>

          {/* terrain mini */}
          <Link to="/profile" className="block relative rounded-2xl overflow-hidden border border-cream-dark/60 shadow-[0_1px_0_rgba(30,58,95,0.04),0_18px_50px_-30px_rgba(30,58,95,0.22)] bg-[#F7F0E8] hover:-translate-y-0.5 transition-transform">
            <Terrain hills={hills} trails={trails} variant="mini"/>
            <span className="absolute top-3 left-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">your landscape</span>
            <span className="absolute top-3 right-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">{focusTags.length} 个方向</span>
            <div className="absolute bottom-3.5 right-3.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-navy/90 text-warm-white text-[11.5px] font-medium tracking-wide">
              看完整地形
              <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5.5 H9 M6 2 L9 5.5 L6 9"/>
              </svg>
            </div>
          </Link>
        </section>

        {/* ─── FOR YOU ─── */}
        <section>
          <div className="flex items-end justify-between mb-7 pb-4 border-b border-cream-dark/50">
            <div>
              <p className="text-[10.5px] uppercase tracking-[0.25em] font-mono text-coral mb-2">
                for you · today · {total > 0 ? `${papers.length} new` : 'soon'}
              </p>
              <h2 className="font-serif text-[24px] font-medium text-navy m-0 leading-[1.35]">
                {papers.length > 0
                  ? <>papermind 在你的方向附近<br/>找到这 {papers.length} 篇</>
                  : '为你探索'}
              </h2>
            </div>
            {papers.length > 0 && (
              <div className="flex items-center gap-2 shrink-0">
                {canGoBack && (
                  <button onClick={() => { fetchPapers({ back: true }); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                    disabled={loading}
                    className="px-4 py-2 rounded-full text-sm text-warm-gray border border-cream-dark hover:text-navy hover:border-navy/20 transition disabled:opacity-50 flex items-center gap-1 whitespace-nowrap">
                    <ChevronLeft size={13}/>上一页
                  </button>
                )}
                {profileFilled && (
                  <button onClick={() => { fetchPapers({ forceFetch: true }); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                    disabled={loading}
                    className="px-4 py-2 rounded-full text-sm text-warm-gray border border-cream-dark hover:text-navy hover:border-navy/20 transition disabled:opacity-50 whitespace-nowrap">
                    重新抓取
                  </button>
                )}
                <button ref={desktopNextPageRef}
                  onClick={() => { fetchPapers({ refresh: true }); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                  disabled={loading || allExplored}
                  className={`px-5 py-2 rounded-full text-sm font-medium transition disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap ${
                    allExplored ? 'bg-cream-dark/60 text-warm-gray cursor-not-allowed' : 'bg-coral text-warm-white hover:bg-coral-light shadow-[0_3px_12px_rgba(232,135,122,0.35)]'
                  }`}>
                  {loading ? <><Loader2 size={13} className="animate-spin"/>加载中</>
                    : allExplored ? '已全部探索'
                    : <><RefreshCw size={13}/>下一页</>}
                </button>
              </div>
            )}
          </div>

          {/* error / needs profile */}
          {needsProfile && (
            <div className="bg-coral/5 border border-coral/20 rounded-xl p-4 mb-5">
              <p className="text-sm text-navy/70 mb-2">还没有填写研究方向，推荐无法生成。</p>
              <Link to="/profile" className="inline-flex items-center gap-1 text-coral text-sm font-medium hover:underline">
                去填写研究画像 <ArrowRight size={13}/>
              </Link>
            </div>
          )}
          {error && !needsProfile && (
            <div className="bg-coral/5 border border-coral/20 rounded-xl p-4 mb-5 flex items-start gap-2">
              <AlertCircle size={16} className="text-coral flex-shrink-0 mt-0.5"/>
              <p className="text-sm text-navy/70">{error}</p>
            </div>
          )}

          {loading && papers.length === 0 && (
            <div className="text-center py-24">
              <Loader2 size={24} className="text-coral animate-spin mx-auto mb-3"/>
              <p className="text-warm-gray text-sm">正在获取文献并生成个性化解读...</p>
              <p className="text-warm-gray/60 text-xs mt-1">首次加载需要 1-2 分钟，之后换批秒出</p>
            </div>
          )}

          {/* paper cards — 3 cols, reason on top */}
          <div className={`grid grid-cols-3 gap-4 transition-opacity ${loading && papers.length > 0 ? 'opacity-40 pointer-events-none' : ''}`}>
            {papers.map((paper, index) => (
              <div key={paper.pmid || paper.paper_id || index} ref={index === 0 ? desktopFirstCardRef : null}>
                <PaperCard paper={paper} index={index}/>
              </div>
            ))}
          </div>

          {!loading && papers.length === 0 && !error && (
            <div className="flex flex-col items-center gap-3 py-24">
              <p className="text-warm-gray text-sm">还没有推荐结果。</p>
              <button onClick={() => profileFilled ? fetchPapers() : navigate('/onboarding')}
                className="px-4 py-2 bg-navy text-warm-white rounded-full text-sm hover:bg-navy-light transition-colors">
                {profileFilled ? '获取推荐论文' : '先填写研究方向'}
              </button>
            </div>
          )}
        </section>

        {/* ─── STILL TRACKING ─── */}
        {threads.length > 0 && (
          <section className="mt-16">
            <p className="text-[10.5px] uppercase tracking-[0.25em] font-mono text-warm-gray mb-2">
              still tracking · {threads.length} open
            </p>
            <h2 className="font-serif text-[22px] font-medium text-navy m-0 leading-[1.35]">
              papermind 还在替你 hold 这些
            </h2>
            <p className="m-0 mt-2 text-[13.5px] text-warm-gray leading-[1.75] max-w-[620px]">
              你开始读但没追下去的、问了一句就停的、收藏了还没翻的 — papermind 替你记着，
              你想回去看的时候随时翻牌。
            </p>

            <div className="mt-6 rounded-[18px] bg-warm-white/65 border border-cream-dark/60 overflow-hidden">
              {threads.map((t, i) => (
                <Link key={i} to={t.to} state={t.state}
                  onClick={() => sessionStorage.setItem('home-scroll-y', String(window.scrollY))}
                  className="grid grid-cols-[100px_1fr_auto] gap-5 items-center px-6 py-4 border-t border-cream-dark/50 first:border-t-0 hover:bg-warm-white/85 transition-colors">
                  <span className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] font-mono text-warm-gray whitespace-nowrap">
                    <ThreadGlyph kind={t.kind}/>{t.kindLabel}
                  </span>
                  <div className="min-w-0">
                    <p className="m-0 text-[13.5px] font-medium text-navy line-clamp-1">{t.title}</p>
                    <p className="m-0 mt-1 text-[12px] text-warm-gray line-clamp-1">{t.why}</p>
                  </div>
                  <span className="flex items-center gap-1 text-[12px] text-coral whitespace-nowrap">
                    {t.cta}
                    <ArrowRight size={11}/>
                  </span>
                </Link>
              ))}
            </div>
            {/* TODO(backend): /home/threads — 真实派生（dwell < 20s 的 reading_history、只问 1 轮的 chat、saved 未读 7 天的 library） */}
          </section>
        )}

        {/* ─── SEARCH DEBUG (unchanged) ─── */}
        {searchDebug && (
          <div className="mt-10 rounded-2xl border border-cream-dark/40">
            <button type="button" onClick={() => setShowSearchDebug(prev => !prev)}
              className="w-full flex items-center justify-between px-4 py-3 text-left">
              <p className="text-sm font-medium text-warm-gray/85">
                本次检索：{formatTraceSummary(searchDebug)}
              </p>
              <span className="text-xs text-coral">{showSearchDebug ? '收起' : '查看检索轨迹'}</span>
            </button>
            {showSearchDebug && <SearchDebugDetails debug={searchDebug}/>}
          </div>
        )}
      </div>

      {/* ═══ MOBILE ═══ */}
      <MobileHome
        greeting={greeting}
        memoryHighlight={memoryHighlight}
        total={total}
        remaining={remaining}
        allExplored={allExplored}
        canGoBack={canGoBack}
        lastReading={lastReading}
        papers={papers}
        loading={loading}
        error={error}
        needsProfile={needsProfile}
        profileFilled={profileFilled}
        fetchPapers={fetchPapers}
        navigate={navigate}
        firstCardRef={firstCardRef}
        nextPageRef={nextPageRef}
        searchDebug={searchDebug}
        showSearchDebug={showSearchDebug}
        setShowSearchDebug={setShowSearchDebug}
      />

      <Navbar/>

      {homeTourStep === 1 && (
        <TourBubble
          targetRef={window.innerWidth >= 1024 ? desktopFirstCardRef : firstCardRef}
          text="这是 AI 根据你的研究方向精选的论文，点击查看详情和 AI 解读"
          step={1} total={2} placement="bottom" onNext={advanceHomeTour}/>
      )}
      {homeTourStep === 2 && (
        <TourBubble
          targetRef={window.innerWidth >= 1024 ? desktopNextPageRef : nextPageRef}
          text="看完这批？点这里获取下一批推荐"
          step={2} total={2} placement="top" onNext={advanceHomeTour}/>
      )}
    </div>
  )
}

function Stat({ n, label }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="font-mono text-[13px] text-navy">{n}</span>
      <span>{label}</span>
    </span>
  )
}

function Sep() {
  return <span className="text-cream-dark">/</span>
}

function MobileHome({
  greeting, memoryHighlight, total, remaining, allExplored, canGoBack, lastReading,
  papers, loading, error, needsProfile, profileFilled, fetchPapers, navigate,
  firstCardRef, nextPageRef, searchDebug, showSearchDebug, setShowSearchDebug,
}) {
  const handleTop = (action) => {
    action()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <main className="lg:hidden px-4 pt-16 pb-24">
      <section className="mb-7">
        <p className="text-[10px] uppercase tracking-[0.22em] font-mono text-coral mb-2">
          papermind · for you
        </p>
        <h1 className="font-serif text-[32px] font-medium text-navy leading-tight m-0">{greeting}</h1>
        <p className="mt-4 text-[14px] leading-[1.85] text-navy/70 m-0">
          {memoryHighlight || (profileFilled ? '这里会逐渐记住你最近在追的方向。先去看看推荐吧。' : '先告诉 papermind 你关注什么，它就开始记你了。')}
        </p>

        <div className="mt-5 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-cream-dark/60 bg-warm-white/70 px-3 py-3">
            <Bookmark size={14} className="text-coral mb-1"/>
            <p className="m-0 font-mono text-[15px] text-navy">{total || papers.length || 0}</p>
            <p className="m-0 mt-0.5 text-[11px] text-warm-gray">篇推荐</p>
          </div>
          <div className="rounded-2xl border border-cream-dark/60 bg-warm-white/70 px-3 py-3">
            <Heart size={14} className="text-coral mb-1"/>
            <p className="m-0 font-mono text-[15px] text-navy">{remaining || 0}</p>
            <p className="m-0 mt-0.5 text-[11px] text-warm-gray">篇未看</p>
          </div>
          <Link to="/profile" className="rounded-2xl border border-cream-dark/60 bg-warm-white/70 px-3 py-3 no-underline">
            <Sprout size={14} className="text-coral mb-1"/>
            <p className="m-0 font-mono text-[15px] text-navy">{profileFilled ? '已记住' : '待填写'}</p>
            <p className="m-0 mt-0.5 text-[11px] text-warm-gray">研究画像</p>
          </Link>
        </div>

        {lastReading && (
          <Link to={`/paper/${lastReading._cache_index ?? lastReading.index ?? 0}`}
            state={{ paper: lastReading }}
            onClick={() => sessionStorage.setItem('home-scroll-y', String(window.scrollY))}
            className="mt-4 flex gap-3 items-center px-4 py-3 rounded-2xl bg-warm-white/70 border border-cream-dark/60">
            <span className="shrink-0 w-9 h-9 rounded-full bg-coral/10 text-coral flex items-center justify-center">
              <Clock size={15}/>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-[0.18em] font-mono text-warm-gray">上次停在这里</span>
              <span className="block mt-1 text-[13px] leading-[1.5] text-navy line-clamp-1">{lastReading.title}</span>
            </span>
            <ArrowRight size={14} className="shrink-0 text-coral"/>
          </Link>
        )}
      </section>

      <section>
        <div className="flex items-end justify-between gap-4 mb-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] font-mono text-coral mb-1">
              today · {papers.length ? `${papers.length} new` : 'soon'}
            </p>
            <h2 className="font-serif text-[22px] font-medium text-navy m-0 leading-[1.35]">
              {papers.length ? '为你找到这些文献' : '为你探索'}
            </h2>
          </div>
          {papers.length > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              {canGoBack && (
                <button type="button" onClick={() => handleTop(() => fetchPapers({ back: true }))}
                  disabled={loading}
                  className="w-9 h-9 rounded-full border border-cream-dark text-warm-gray flex items-center justify-center disabled:opacity-50"
                  aria-label="上一页">
                  <ChevronLeft size={16}/>
                </button>
              )}
              <button ref={nextPageRef} type="button" onClick={() => handleTop(() => fetchPapers({ refresh: true }))}
                disabled={loading || allExplored}
                className={`h-9 px-3 rounded-full text-[13px] font-medium transition disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap ${
                  allExplored ? 'bg-cream-dark/60 text-warm-gray' : 'bg-coral text-warm-white shadow-[0_3px_12px_rgba(232,135,122,0.28)]'
                }`}>
                {loading ? <><Loader2 size={13} className="animate-spin"/>加载中</>
                  : allExplored ? '已全部探索'
                  : <><RefreshCw size={13}/>下一页</>}
              </button>
            </div>
          )}
        </div>

        {needsProfile && (
          <div className="bg-coral/5 border border-coral/20 rounded-xl p-4 mb-4">
            <p className="text-sm text-navy/70 mb-2">还没有填写研究方向，推荐无法生成。</p>
            <Link to="/profile" className="inline-flex items-center gap-1 text-coral text-sm font-medium">
              去填写研究画像 <ArrowRight size={13}/>
            </Link>
          </div>
        )}

        {error && !needsProfile && (
          <div className="bg-coral/5 border border-coral/20 rounded-xl p-4 mb-4 flex items-start gap-2">
            <AlertCircle size={16} className="text-coral flex-shrink-0 mt-0.5"/>
            <p className="text-sm text-navy/70 m-0">{error}</p>
          </div>
        )}

        {loading && papers.length === 0 && (
          <div className="text-center py-20">
            <Loader2 size={24} className="text-coral animate-spin mx-auto mb-3"/>
            <p className="text-warm-gray text-sm">正在获取文献并生成个性化解读...</p>
            <p className="text-warm-gray/60 text-xs mt-1">首次加载需要 1-2 分钟</p>
          </div>
        )}

        <div className={`grid gap-4 transition-opacity ${loading && papers.length > 0 ? 'opacity-45 pointer-events-none' : ''}`}>
          {papers.map((paper, index) => (
            <div key={paper.pmid || paper.paper_id || index} ref={index === 0 ? firstCardRef : null}>
              <PaperCard paper={paper} index={index}/>
            </div>
          ))}
        </div>

        {!loading && papers.length === 0 && !error && (
          <div className="flex flex-col items-center gap-3 py-20">
            <p className="text-warm-gray text-sm">还没有推荐结果。</p>
            <button type="button" onClick={() => profileFilled ? fetchPapers() : navigate('/onboarding')}
              className="px-4 py-2 bg-navy text-warm-white rounded-full text-sm">
              {profileFilled ? '获取推荐论文' : '先填写研究方向'}
            </button>
          </div>
        )}

        {papers.length > 0 && profileFilled && (
          <div className="mt-5 flex justify-center">
            <button type="button" onClick={() => handleTop(() => fetchPapers({ forceFetch: true }))}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm text-warm-gray border border-cream-dark disabled:opacity-50">
              <RotateCcw size={13}/>重新抓取
            </button>
          </div>
        )}

        {searchDebug && (
          <div className="mt-8 rounded-2xl border border-cream-dark/40">
            <button type="button" onClick={() => setShowSearchDebug(prev => !prev)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
              <p className="m-0 text-sm font-medium text-warm-gray/85">
                本次检索：{formatTraceSummary(searchDebug)}
              </p>
              <span className="text-xs text-coral whitespace-nowrap">{showSearchDebug ? '收起' : '轨迹'}</span>
            </button>
            {showSearchDebug && <SearchDebugDetails debug={searchDebug}/>}
          </div>
        )}
      </section>
    </main>
  )
}

function SearchDebugDetails({ debug }) {
  const dropped = debug?.dropped_queries || []
  const queries = debug?.queries || []

  return (
    <div className="px-4 pb-4 pt-1 border-t border-cream-dark/40">
      {dropped.length > 0 && (
        <div className="mb-4">
          <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.18em] font-mono text-warm-gray">已过滤查询</p>
          <div className="space-y-2">
            {dropped.map((item, index) => (
              <div key={`${item.query || 'drop'}-${index}`} className="rounded-xl bg-coral/5 border border-coral/10 px-3 py-2">
                <p className="m-0 text-[12px] text-navy/75 leading-relaxed">{item.query}</p>
                <p className="m-0 mt-1 text-[11px] text-warm-gray">{formatDropReason(item.reason)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {queries.length > 0 ? (
        <div className="space-y-2">
          {queries.map((query, index) => (
            <div key={`${query.query || 'query'}-${index}`} className="rounded-xl bg-warm-white/65 border border-cream-dark/50 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <p className="m-0 text-[12px] text-navy/80 leading-relaxed">{query.query}</p>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] font-mono text-coral">{formatOrigin(query.origin)}</span>
              </div>
              {Array.isArray(query.sources) && query.sources.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {query.sources.map((source, sourceIndex) => (
                    <span key={`${source.source || 'source'}-${sourceIndex}`} className="px-2 py-0.5 rounded-full bg-cream-dark/50 text-[11px] text-warm-gray">
                      {formatSourceBadge(source)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 text-[12px] text-warm-gray">暂无详细检索轨迹。</p>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   PaperCard — reason banner ON TOP (instead of bottom)
   ═══════════════════════════════════════════════════════════════ */
function PaperCard({ paper, index }) {
  const cacheIndex = paper._cache_index ?? index
  const isPendingSummary = !paper.summary_zh && paper.summary_status === 'pending'
  const isFailedSummary  = !paper.summary_zh && paper.summary_status === 'failed'

  return (
    <Link to={`/paper/${cacheIndex}`} state={{ paper }}
      className="block breathe-in h-full group"
      style={{ animationDelay: `${index * 70}ms` }}
      onClick={() => sessionStorage.setItem('home-scroll-y', String(window.scrollY))}>
      <article className="bg-warm-white/[0.82] backdrop-blur-sm border border-cream-dark/[0.7] rounded-2xl h-full flex flex-col overflow-hidden transition-all card-hover">

        {/* REASON banner */}
        {paper.relevance && (
          <header className="flex items-center gap-2 px-4 py-2.5 bg-coral/[0.06] border-b border-coral/15 text-[11.5px] text-coral leading-tight">
            <ReasonGlyph/>
            <span className="flex-1 line-clamp-1">{paper.relevance}</span>
            <span className="shrink-0 font-mono text-[9.5px] tracking-[0.16em] uppercase text-warm-gray">
              {paper.source === 'pubmed' ? 'PubMed' : paper.source === 'semantic_scholar' ? 'S2' : ''}
            </span>
          </header>
        )}

        {/* body */}
        <div className="flex-1 flex flex-col p-5">
          {/* category + date */}
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-coral/10 text-coral font-medium">
              {paper.category || '未分类'}
            </span>
            <span className="text-[11px] text-warm-gray">{paper.pub_date}</span>
          </div>

          {/* title */}
          <h3 className="text-navy font-medium leading-[1.55] text-[14.5px] m-0 line-clamp-3">
            {paper.title}
          </h3>
          {paper.title_zh && (
            <p className="m-0 mt-1 text-navy/70 font-medium leading-[1.55] text-[13px] line-clamp-2">
              {paper.title_zh}
            </p>
          )}

          {/* summary */}
          <div className="flex-1 mt-3 overflow-hidden">
            {paper.summary_zh && (
              <p className="m-0 text-warm-gray text-[12.5px] leading-[1.7] line-clamp-4">{paper.summary_zh}</p>
            )}
            {isPendingSummary && (
              <p className="m-0 text-warm-gray text-[12.5px] leading-[1.7] flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin text-coral flex-shrink-0"/>
                <span>AI 解读生成中...</span>
              </p>
            )}
            {isFailedSummary && (
              <p className="m-0 text-warm-gray text-[12.5px] leading-[1.7]">
                AI 解读暂时不可用，稍后刷新可再试。
              </p>
            )}
          </div>
        </div>
      </article>
    </Link>
  )
}

function ReasonGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" className="shrink-0 opacity-85">
      <path d="M2 12 C2 8 4 6 7 6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none"/>
      <circle cx="7" cy="6" r="2.4" fill="currentColor"/>
    </svg>
  )
}

function ThreadGlyph({ kind }) {
  const props = { width: 11, height: 11, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }
  if (kind === 'chat') return (<svg {...props}><path d="M2 4 a1 1 0 0 1 1 -1 H10 a1 1 0 0 1 1 1 v4 a1 1 0 0 1 -1 1 H6 L3 12 V9 H2 a1 1 0 0 1 -1 -1 V5 Z"/></svg>)
  if (kind === 'save') return (<svg {...props}><path d="M4 2 H10 V12 L7 10 L4 12 Z"/></svg>)
  if (kind === 'topic') return (<svg {...props}><path d="M7 2 L8 5 L11 7 L8 9 L7 12 L6 9 L3 7 L6 5 Z"/></svg>)
  return (<svg {...props}><rect x="3" y="2" width="8" height="10" rx="1"/><path d="M5 5 H9 M5 7 H9 M5 9 H7"/></svg>)
}

function splitTags(value) {
  return value
    ? value.split(/[,，、\n]+/).map(s => s.trim()).filter(s => s && s.length <= 12).slice(0, 8)
    : []
}
function formatSearchRange(trackingDays) {
  const days = parseInt(trackingDays) || 90
  if (days <= 7)  return `近${days}天`
  if (days <= 14) return '近两周'
  if (days <= 31) return '近1个月'
  if (days <= 62) return '近2个月'
  if (days <= 93) return '近3个月'
  return `近${Math.round(days / 30)}个月`
}
function formatTimeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1)   return '刚刚'
  if (min < 60)  return `${min} 分钟前`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)  return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}
function formatTraceSummary(trace) {
  const totals = trace?.totals || {}
  const sourceCounts = trace?.final_source_counts || {}
  const sourceParts = Object.entries(sourceCounts).map(([source, count]) => `${source === 'pubmed' ? 'PubMed' : 'S2'} ${count}`)
  const queryCount = totals.query_count || trace?.queries?.length || 0
  const finalPapers = totals.final_papers ?? 0
  return `${queryCount} 组查询 · 保留 ${finalPapers} 篇${sourceParts.length ? ` · ${sourceParts.join(' · ')}` : ''}`
}
function formatDropReason(reason) {
  if (reason === 'missing_focus_anchor') return '缺少研究主题锚点'
  if (reason === 'too_generic') return '过于宽泛，容易跑偏'
  return '已过滤'
}
function formatOrigin(origin) {
  if (origin === 'manual') return '手动输入'
  if (origin === 'deterministic') return '系统补充'
  if (origin === 'broad_fallback') return '宽松兜底'
  if (origin === 'translated_fallback') return '翻译兜底'
  return 'LLM 生成'
}
function formatSourceBadge(s) {
  const sourceLabel = s.source === 'pubmed' ? 'PubMed' : 'S2'
  if (s.status === 'ok') return `${sourceLabel} ${s.count} 篇`
  if (s.status === 'skipped_limit') return `${sourceLabel} 已跳过`
  return `${sourceLabel} 失败`
}
