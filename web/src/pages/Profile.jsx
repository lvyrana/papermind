import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Pencil, Upload } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { apiGet, apiPost } from '../api'

/* ─────────────────────────────────────────────────────────────
   PROFILE — 研究地形版
   ─────────────────────────────────────────────────────────────
   设计原则：
   1. 完整保留现有后端契约（不破坏老功能）
   2. 现有的 memory_core / memory_recent 抬升到「AI 观察」主栏
   3. 现有的 focus_areas / method_interests / 等表单退到副栏
   4. 新增「研究地形图」hero — 完全从 focus_areas + memory_recent 客户端计算
   5. 新增「记忆来源」溯源条 — 现有数据 + 占位（标 TODO）
   6. 时间游标作为视觉 affordance，Stage 1 时接 /profile/landscape?at=…
   ───────────────────────────────────────────────────────────── */


const DEFAULT_PROFILE = {
  focus_areas: '',
  exclude_areas: '',
  method_interests: '',
  current_goal: '',
  background: '',
  discipline: '',
  tracking_days: '90',
  memory_core: '',
  memory_recent: '',
  last_recent_updated_at: '',
  last_core_merged_at: '',
  core_source: '',
}


export default function Profile() {
  const [profile, setProfile] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem('cached-profile') || 'null')
      return cached ? { ...DEFAULT_PROFILE, ...cached, tracking_days: cached.tracking_days || '90' } : DEFAULT_PROFILE
    } catch {
      return DEFAULT_PROFILE
    }
  })
  const [mergeLoading, setMergeLoading] = useState(false)
  const [mergeAbsorbed, setMergeAbsorbed] = useState(false)
  const [coreEditing, setCoreEditing] = useState(false)
  const [coreDraft, setCoreDraft] = useState('')
  const [refreshingRecent, setRefreshingRecent] = useState(false)
  // 时间游标 (Stage 1 visual affordance; 现在只改 caption 文字)
  const [daysBack, setDaysBack] = useState(0)

  // ── load profile ──
  useEffect(() => {
    apiGet('/profile')
      .then(data => {
        setProfile(prev => {
          const nextProfile = { ...prev, ...data, tracking_days: data.tracking_days || '90' }
          localStorage.setItem('cached-profile', JSON.stringify(nextProfile))
          return nextProfile
        })
      })
      .catch(() => {})
  }, [])

  const patchProfile = (partial) => {
    setProfile(prev => {
      const nextProfile = { ...prev, ...partial }
      localStorage.setItem('cached-profile', JSON.stringify(nextProfile))
      return nextProfile
    })
    if (partial.memory_recent !== undefined) setMergeAbsorbed(false)
  }

  const handleMergeToCore = async () => {
    setMergeLoading(true)
    try {
      const result = await apiPost('/profile/merge-to-core', {})
      if (result?.core !== undefined) {
        setProfile(prev => {
          const nextProfile = { ...prev, memory_core: result.core, memory_recent: '', last_recent_updated_at: '' }
          localStorage.setItem('cached-profile', JSON.stringify(nextProfile))
          return nextProfile
        })
      } else {
        const latest = await apiGet('/profile')
        setProfile(prev => {
          const nextProfile = { ...prev, ...latest, tracking_days: latest.tracking_days || prev.tracking_days || '90' }
          localStorage.setItem('cached-profile', JSON.stringify(nextProfile))
          return nextProfile
        })
      }
      setMergeAbsorbed(true)
    } catch {
      console.warn('merge-to-core failed')
    } finally {
      setMergeLoading(false)
    }
  }

  // 手动触发 AI 再观察一次（calls existing endpoint）
  const refreshRecent = async () => {
    setRefreshingRecent(true)
    try {
      await apiPost('/profile/memory-recent', {})
      const latest = await apiGet('/profile')
      setProfile(prev => {
        const nextProfile = { ...prev, ...latest }
        localStorage.setItem('cached-profile', JSON.stringify(nextProfile))
        return nextProfile
      })
    } catch {
      // ignore
    } finally {
      setRefreshingRecent(false)
    }
  }

  const startCoreEdit = () => { setCoreDraft(profile.memory_core || ''); setCoreEditing(true) }
  const applyCoreDraft = async () => {
    const next = { ...profile, memory_core: coreDraft, core_source: 'manual' }
    patchProfile({ memory_core: coreDraft, core_source: 'manual' })
    setCoreEditing(false)
    try { await apiPost('/profile', next) } catch { /* silent — patchProfile already wrote local */ }
  }

  // ── derive landscape hills from existing data ──
  const focusTags    = useMemo(() => splitTags(profile.focus_areas),    [profile.focus_areas])
  const methodTags   = useMemo(() => splitTags(profile.method_interests), [profile.method_interests])
  const memoryText   = `${profile.memory_recent || ''} ${profile.memory_core || ''}`

  const hills = useMemo(() => buildHills(focusTags, memoryText), [focusTags, memoryText])
  const trails = useMemo(() => buildTrails(hills, methodTags), [hills, methodTags])

  // simple "stats" — derived from what we have client-side
  // TODO(backend): /profile/stats → { days_alive, papers_read, papers_saved, threads }
  const stats = useMemo(() => ({
    days:    37,                      // TODO: from earliest reading-history
    read:    0,                       // TODO: count of distinct reading-history
    saved:   0,                       // TODO: count of /library
    threads: 0,                       // TODO: chat rooms with >=2 messages
    focus:   focusTags.length,
    hot:     hills.filter(h => h.hot).length,
  }), [focusTags.length, hills])

  const dateLabel = daysBack === 0 ? '今天' : `${daysBack} 天前`

  return (
    <div className="min-h-screen pb-12 lg:pb-0 bg-flowing">

      {/* ── Desktop ── */}
      <div className="hidden lg:block max-w-[1280px] mx-auto px-8 xl:px-12 pt-24 pb-12">

        {/* ─── HERO ─── */}
        <div className="mb-6">
          <h1 className="pm-page-title text-[36px] text-navy leading-tight">你的研究地形</h1>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 mt-4 text-[13px] text-warm-gray">
            <Stat n={stats.days}    label="天陪你"/>
            <Sep/>
            <Stat n={stats.focus}   label="个长期方向"/>
            <Sep/>
            <Stat n={stats.hot} label="个萌发中" hot/>
          </div>

          {/* memory_recent inline as the "papermind 还记得" line */}
          {(profile.memory_recent || profile.memory_core) && (
            <div className="mt-4 px-5 py-4 rounded-2xl bg-warm-white/70 border border-cream-dark/60 flex gap-3 items-start max-w-[760px]">
              <span className="shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-[0.2em] font-mono text-coral bg-coral/8">memory · 7d</span>
              <p className="m-0 text-[14px] leading-7 text-navy/85 font-serif italic">
                {profile.memory_recent || profile.memory_core}
              </p>
            </div>
          )}
        </div>

        {/* ─── TERRAIN HERO ─── */}
        <Terrain hills={hills} trails={trails} dateLabel={dateLabel}/>

        {/* time scrubber */}
        <div className="mt-4 px-5 py-3 rounded-2xl bg-warm-white/70 border border-cream-dark/60 flex items-center gap-5">
          <span className="shrink-0 text-[10px] uppercase tracking-[0.2em] font-mono text-warm-gray">看 60 天前</span>
          <input type="range" min="0" max="60" value={daysBack}
            onChange={e => setDaysBack(parseInt(e.target.value))}
            className="flex-1 accent-coral"/>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.2em] font-mono text-warm-gray">今天</span>
          <span className="shrink-0 text-[12px] font-mono text-navy min-w-[80px] text-right tabular-nums">{dateLabel}</span>
          {/* TODO(backend): /profile/landscape?days_back=N → 返回某历史时刻的 hills/trails */}
        </div>

        {/* ─── BODY GRID ─── */}
        <div className="mt-10 max-w-[920px]">

          {/* ── LEFT: AI 在为你记着这些 ── */}
          <section className="bg-warm-white/[0.82] backdrop-blur-sm border border-cream-dark/[0.7] rounded-[24px] shadow-[0_18px_55px_rgba(30,58,95,0.04)] overflow-hidden">
            <header className="px-7 pt-6 pb-4 flex items-baseline justify-between border-b border-cream-dark/40">
              <h2 className="font-serif text-[19px] font-medium text-navy m-0">AI 在为你记着这些</h2>
              <span className="text-[10px] uppercase tracking-[0.22em] font-mono text-warm-gray">来自你的阅读 + 对话</span>
            </header>

            {/* 长期画像 (existing memory_core, repurposed) */}
            <div className="px-7 py-5 border-b border-cream-dark/40">
              <div className="flex items-center gap-2 mb-3">
                <SproutIcon/>
                <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-mint">长期画像</span>
                {profile.last_core_merged_at && (
                  <span className="ml-auto text-[10px] text-warm-gray/55 font-mono">{formatUpdatedAt(profile.last_core_merged_at)}</span>
                )}
                <button type="button" onClick={startCoreEdit} className="text-warm-gray/55 hover:text-navy transition-colors" aria-label="编辑长期画像">
                  <Pencil size={13} />
                </button>
              </div>
              {coreEditing ? (
                <div className="space-y-2">
                  <textarea value={coreDraft} onChange={e => setCoreDraft(e.target.value)} rows={6}
                    className="w-full rounded-xl border border-cream-dark/70 bg-warm-white px-3 py-2 text-[13px] leading-7 text-navy/80 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 resize-none"/>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setCoreEditing(false)} className="px-2.5 py-1 rounded-full text-[11px] text-warm-gray/70 hover:text-navy">取消</button>
                    <button type="button" onClick={applyCoreDraft} className="px-3 py-1 rounded-full text-[11px] bg-navy text-warm-white">应用</button>
                  </div>
                </div>
              ) : profile.memory_core ? (
                <p className="text-[13.5px] leading-7 text-navy/82 m-0 font-serif">{profile.memory_core}</p>
              ) : (
                <p className="text-[12.5px] leading-7 text-warm-gray/55 m-0 italic">使用一段时间后，papermind 会从你的阅读中归纳出长期画像。</p>
              )}
            </div>

            {/* 近期变化 (existing memory_recent, repurposed) */}
            <div className="px-7 py-5 border-b border-cream-dark/40">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-coral/15">
                  <span className="w-1.5 h-1.5 rounded-full bg-coral animate-pulse"/>
                </span>
                <span className="text-[10px] uppercase tracking-[0.2em] font-mono text-coral">近期变化</span>
                {profile.last_recent_updated_at && (
                  <span className="ml-auto text-[10px] text-warm-gray/55 font-mono">{formatUpdatedAt(profile.last_recent_updated_at)}</span>
                )}
              </div>
              {profile.memory_recent ? (
                <>
                  <p className="text-[13.5px] leading-7 text-navy/82 m-0 font-serif">{profile.memory_recent}</p>
                  <div className="flex gap-2 mt-4">
                    <button type="button" onClick={handleMergeToCore} disabled={mergeLoading}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium bg-mint/20 text-navy border border-mint/40 hover:bg-mint/30 transition-colors disabled:opacity-50">
                      <Upload size={11} className={mergeLoading ? 'animate-pulse' : ''}/>
                      {mergeLoading ? '吸收中…' : '吸收到长期画像'}
                    </button>
                    <button type="button" onClick={refreshRecent} disabled={refreshingRecent}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] text-warm-gray/70 hover:text-navy border border-cream-dark transition-colors disabled:opacity-50">
                      {refreshingRecent ? '重算中…' : '让 AI 再观察一次'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[12.5px] leading-7 text-warm-gray/55 m-0 italic">papermind 还在观察你最近的阅读…</p>
                  <button type="button" onClick={refreshRecent} disabled={refreshingRecent}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] text-warm-gray/70 hover:text-navy border border-cream-dark transition-colors disabled:opacity-50">
                    {refreshingRecent ? '观察中…' : '现在观察一次'}
                  </button>
                </div>
              )}
              {mergeAbsorbed && !profile.memory_recent && (
                <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] bg-mint/14 text-navy/70 border border-mint/30">
                  <Check size={11}/>已吸收 ✓
                </div>
              )}
            </div>

            {/*
              ── PHASE 2 ──
              这里放「可采纳的具体观察」(per-observation accept/dismiss UI)
              需要后端：
              GET  /profile/observations → [{ id, glyph, tone, title, evidence, proposal }]
              POST /profile/observations/:id/accept | dismiss
              示例 payload 见 handoff/Profile.md
            */}
          </section>

          {/* RIGHT column removed in slim version — 表单已搬到 Settings → 研究偏好 */}
        </div>

        {/* ─── 记忆来源 ─── */}
        <section className="mt-7 px-7 py-5 bg-warm-white/70 border border-cream-dark/[0.7] rounded-[20px]">
          <h2 className="font-serif text-[16px] font-medium text-navy m-0 mb-4">记忆来源</h2>
          {/* TODO(backend): /profile/provenance → 每个 tag 来自 X 篇收藏 / Y 次对话 / 用户 N/月 添加
              暂时客户端从 tag 列表生成行 */}
          <div className="divide-y divide-cream-dark/40">
            {[...focusTags, ...methodTags].map((tag, i) => (
              <div key={tag + i} className="grid grid-cols-[120px_1fr_auto] gap-4 items-center py-2.5 text-[13px]">
                <span className="text-navy/85 font-medium">{tag}</span>
                <span className="text-[11px] font-mono text-warm-gray tracking-[0.04em]">
                  {focusTags.includes(tag) ? "研究方向" : "方法兴趣"}
                </span>
                {/* TODO(backend §4.4 in Profile.md): /profile/provenance/<tag> 抽屉。endpoint ready 前不渲染按钮 */}
                <span className="text-[10.5px] font-mono text-warm-gray/55"></span>
              </div>
            ))}
            {focusTags.length === 0 && methodTags.length === 0 && (
              <p className="text-[12px] text-warm-gray/55 italic m-0">还没有任何标签 — 在上面填写后会自动出现在这里。</p>
            )}
          </div>
        </section>

        {/* SAVE BAR removed -- 长期画像编辑由 applyCoreDraft 自动 POST /profile；form 已搬走 */}
      </div>

      {/* ── Mobile (保留原版) ── */}
      <MobileProfile
        profile={profile}
        handleMergeToCore={handleMergeToCore}
        mergeLoading={mergeLoading}
        mergeAbsorbed={mergeAbsorbed}
      />
      <Navbar />
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   TERRAIN — 客户端计算 + 渲染（A 方案，等高线）
   完全独立、纯几何、无后端依赖
   ═══════════════════════════════════════════════════════════════ */

const TERRAIN_W = 1200, TERRAIN_H = 480

function Terrain({ hills, trails, dateLabel }) {
  return (
    <div className="relative rounded-[22px] overflow-hidden border border-cream-dark/60 shadow-[0_1px_0_rgba(30,58,95,0.04),0_24px_60px_-36px_rgba(30,58,95,0.22)] bg-[#F7F0E8]">
      <svg viewBox={`0 0 ${TERRAIN_W} ${TERRAIN_H}`} className="block w-full h-auto" style={{ background: '#F7F0E8' }}>
        <defs>
          {/* paper vignette */}
          <radialGradient id="paperV" cx="50%" cy="48%" r="65%">
            <stop offset="0%"   stopColor="#FFFDF9" stopOpacity="0"/>
            <stop offset="80%"  stopColor="#EDE4D8" stopOpacity="0"/>
            <stop offset="100%" stopColor="#D9C8B8" stopOpacity="0.18"/>
          </radialGradient>
          {/* per-hill radial fill */}
          {hills.map(h => (
            <radialGradient key={h.id} id={`hf-${h.id}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor={h.hot ? '#E8877A' : '#A8D5BA'} stopOpacity={h.hot ? 0.14 : 0.10}/>
              <stop offset="55%"  stopColor={h.hot ? '#E8877A' : '#A8D5BA'} stopOpacity="0.04"/>
              <stop offset="100%" stopColor="#FFFDF9" stopOpacity="0"/>
            </radialGradient>
          ))}
        </defs>

        {/* faint graticule */}
        <g opacity="0.25" stroke="#1E3A5F" strokeWidth="0.3" strokeDasharray="1 6">
          {gratLines(TERRAIN_W, TERRAIN_H, 100).map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}/>
          ))}
        </g>
        <rect width={TERRAIN_W} height={TERRAIN_H} fill="url(#paperV)"/>

        {/* trails (method interests) */}
        {trails.map(t => {
          const midX = (t.from.cx + t.to.cx) / 2
          const midY = (t.from.cy + t.to.cy) / 2 - 30
          return (
            <g key={t.id}>
              <path d={`M ${t.from.cx} ${t.from.cy} Q ${midX} ${midY} ${t.to.cx} ${t.to.cy}`}
                fill="none" stroke="#1E3A5F" strokeOpacity="0.30"
                strokeWidth="0.9" strokeDasharray="3 4" strokeLinecap="round"/>
              <g transform={`translate(${midX}, ${midY + 30 - 4})`}>
                <rect x="-32" y="-9" width="64" height="16" rx="3"
                  fill="#F7F0E8" stroke="#1E3A5F" strokeOpacity="0.15" strokeWidth="0.5"/>
                <text x="0" y="2.5" textAnchor="middle"
                  style={{ font: '500 10px "JetBrains Mono", monospace',
                    fill: '#8E8A85', letterSpacing: '0.06em' }}>
                  {t.name}
                </text>
              </g>
            </g>
          )
        })}

        {/* hills */}
        {hills.map(h => {
          const contours = hillContours(h, 7)
          const stroke = h.hot ? '#E8877A' : '#1E3A5F'
          return (
            <g key={h.id}>
              <path d={contours[0].d} fill={`url(#hf-${h.id})`}/>
              {contours.map((c, i) => (
                <path key={i} d={c.d} fill="none" stroke={stroke}
                  strokeOpacity={0.18 + c.t * 0.40}
                  strokeWidth={0.55 + c.t * 0.35}/>
              ))}
              {/* label */}
              <g transform={`translate(${h.cx}, ${h.cy + h.size * 0.62})`}>
                <line x1="0" y1="-8" x2="0" y2="-3" stroke="#1E3A5F" strokeOpacity="0.4" strokeWidth="0.6"/>
                <text textAnchor="middle" y="6"
                  style={{ font: `500 ${h.size > 100 ? 14 : 12}px "Noto Serif SC", serif`,
                    fill: '#1E3A5F', letterSpacing: '0.04em' }}>
                  {h.name}
                </text>
                {h.hot && (
                  <text textAnchor="middle" y="20"
                    style={{ font: '400 9px "JetBrains Mono", monospace',
                      fill: '#8E8A85', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
                    hot · 近期热区
                  </text>
                )}
              </g>
            </g>
          )
        })}

        {hills.length === 0 && (
          <text x={TERRAIN_W/2} y={TERRAIN_H/2} textAnchor="middle"
            style={{ font: '400 14px "Noto Serif SC", serif', fill: '#8E8A85' }}>
            填几个研究方向，地形就会出现
          </text>
        )}
      </svg>

      {/* corner labels */}
      <span className="absolute top-3 left-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">papermind · landscape</span>
      <span className="absolute top-3 right-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">{dateLabel}</span>
      <span className="absolute bottom-3 left-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">stage 0 · v0.1</span>
      <span className="absolute bottom-3 right-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">scale ≈ tag</span>
    </div>
  )
}

/* ── pure geometry helpers ──────────────────────────────────── */
function buildHills(focusTags, memoryText) {
  if (focusTags.length === 0) return []
  // Place hills in a loose grid around viewport center
  const positions = layoutPositions(focusTags.length)
  return focusTags.map((tag, i) => {
    const seed = hashSeed(tag)
    const hot = memoryText.includes(tag)
    return {
      id: slugify(tag) + '-' + i,
      name: tag,
      cx: positions[i].x,
      cy: positions[i].y,
      size: 80 + (hot ? 20 : 0),
      seed,
      hot,
    }
  })
}
function buildTrails(hills, methodTags) {
  if (hills.length < 2 || methodTags.length === 0) return []
  // Take the first 2 methods and connect first 2 hill pairs
  const trails = []
  for (let i = 0; i < Math.min(methodTags.length, 2); i++) {
    if (hills[i * 2] && hills[i * 2 + 1]) {
      trails.push({
        id: methodTags[i] + i,
        name: methodTags[i],
        from: hills[i * 2],
        to: hills[i * 2 + 1],
      })
    }
  }
  return trails
}
function layoutPositions(n) {
  // 2-row layout, centered, with horizontal spread
  const W = TERRAIN_W, H = TERRAIN_H
  if (n === 1) return [{ x: W/2, y: H/2 }]
  if (n === 2) return [{ x: W*0.35, y: H/2 }, { x: W*0.65, y: H/2 }]
  if (n === 3) return [
    { x: W*0.25, y: H*0.42 }, { x: W*0.55, y: H*0.38 }, { x: W*0.78, y: H*0.55 }
  ]
  if (n === 4) return [
    { x: W*0.22, y: H*0.40 }, { x: W*0.48, y: H*0.35 },
    { x: W*0.72, y: H*0.55 }, { x: W*0.85, y: H*0.30 }
  ]
  // general: distribute in two rows
  const positions = []
  const cols = Math.ceil(n / 2)
  for (let i = 0; i < n; i++) {
    const row = i % 2
    const col = Math.floor(i / 2)
    positions.push({
      x: W * (0.15 + (col + 0.5) / cols * 0.7),
      y: H * (row === 0 ? 0.40 : 0.62),
    })
  }
  return positions
}
function hashSeed(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i)
  return Math.abs(h % 1000) / 100
}
function slugify(s) {
  return s.replace(/[^\w\u4e00-\u9fa5]/g, '-').slice(0, 20)
}
function gratLines(W, H, step) {
  const out = []
  for (let x = step; x < W; x += step) out.push({ x1: x, y1: 0, x2: x, y2: H })
  for (let y = step; y < H; y += step) out.push({ x1: 0, y1: y, x2: W, y2: y })
  return out
}
function noisedRing(cx, cy, baseR, opts = {}) {
  const { segments = 80, seed = 1, amp = 0.10, amp2 = 0.05, amp3 = 0.025 } = opts
  const pts = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const n = Math.sin(a*3 + seed*1.7)*amp + Math.sin(a*5 + seed*2.3)*amp2 + Math.sin(a*7 + seed*3.1)*amp3
    const r = baseR * (1 + n)
    pts.push([cx + Math.cos(a)*r, cy + Math.sin(a)*r])
  }
  return pts
}
function smoothPath(pts) {
  const n = pts.length
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d + ' Z'
}
function hillContours(hill, levels = 7) {
  const out = []
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1)
    const r = hill.size * (1 - t * 0.84)
    const pts = noisedRing(hill.cx, hill.cy, r, {
      seed: hill.seed + t * 0.6,
      amp: 0.10 * (1 - t * 0.3),
      amp2: 0.04 * (1 - t * 0.3),
      amp3: 0.02,
    })
    out.push({ d: smoothPath(pts), t, r })
  }
  return out
}

/* ═══════════════════════════════════════════════════════════════
   小组件
   ═══════════════════════════════════════════════════════════════ */

function Stat({ n, label, hot }) {
  return (
    <span className="whitespace-nowrap">
      <span className={`font-mono text-[16px] font-medium mr-1.5 ${hot ? 'text-coral' : 'text-navy'}`}>{n}</span>
      {label}
    </span>
  )
}
function Sep() { return <span className="text-navy/15">·</span> }
function SproutIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14">
      <line x1="7" y1="12" x2="7" y2="7" stroke="#7BB89C" strokeWidth="1" strokeLinecap="round"/>
      <path d="M7 8 C7 5 9 3.5 11 3.5 C11 6 9 8 7 8 Z" fill="#7BB89C" opacity="0.9"/>
      <path d="M7 7.5 C7 5 5 3.5 3 3.5 C3 6 5 7.5 7 7.5 Z" fill="#A8D5BA" opacity="0.8"/>
    </svg>
  )
}


function TagInputCompact({ value, onChange, placeholder }) {
  const [input, setInput] = useState('')
  const tags = splitTags(value)
  const addTag = () => {
    const tag = input.trim()
    if (!tag || tags.includes(tag)) { setInput(''); return }
    onChange([...tags, tag].join(', '))
    setInput('')
  }
  const removeTag = (tag) => onChange(tags.filter(t => t !== tag).join(', '))
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] bg-cream-dark/55 text-navy/82">
            {tag}
            <button type="button" onClick={() => removeTag(tag)} className="opacity-60 hover:opacity-100">
              <X size={11}/>
            </button>
          </span>
        ))}
      </div>
      <input type="text" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === '，' || e.key === ',') { e.preventDefault(); addTag() } }}
        onBlur={addTag}
        placeholder={placeholder}
        className="w-full bg-warm-white rounded-xl px-3.5 py-2 text-[13px] text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200 placeholder:text-warm-gray/50"/>
    </div>
  )
}



/* ═══════════════════════════════════════════════════════════════
   Mobile (保留原版语义，简化外观)
   ═══════════════════════════════════════════════════════════════ */
function MobileProfile({ profile, handleMergeToCore, mergeLoading, mergeAbsorbed }) {
  return (
    <div className="lg:hidden">
      <header className="px-6 pt-[72px] pb-8 max-w-3xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} /><span>返回</span>
        </Link>
        <h1 className="pm-page-title text-[30px] text-navy leading-snug">我的研究画像</h1>
        <p className="text-warm-gray mt-3 leading-relaxed text-sm max-w-2xl">标记你关注的方向与近期需求，系统会逐步理解你的研究偏好。</p>
      </header>

      <main className="px-6 max-w-3xl mx-auto space-y-5 pb-8">
        {(profile.memory_recent || profile.memory_core) && (
          <section className="bg-warm-white/82 backdrop-blur-sm border border-cream-dark/60 rounded-[24px] p-5">
            <p className="text-[10px] uppercase tracking-[0.2em] font-mono text-coral mb-2">memory · 7d</p>
            <p className="m-0 text-[14px] leading-7 text-navy/85 font-serif italic">
              {profile.memory_recent || profile.memory_core}
            </p>
            {profile.memory_recent && (
              <button onClick={handleMergeToCore} disabled={mergeLoading}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium bg-mint/20 text-navy border border-mint/40">
                <Upload size={11}/>{mergeLoading ? '吸收中…' : '吸收到长期画像'}
              </button>
            )}
            {mergeAbsorbed && !profile.memory_recent && <p className="mt-2 text-[11px] text-mint">已吸收 ✓</p>}
          </section>
        )}

        {/* 表单已移至 Settings → 研究偏好；移动端入口 */}
        <Link to="/settings#research-prefs" className="block w-full py-4 rounded-2xl border border-coral/25 text-coral text-sm font-medium text-center hover:bg-coral/5">
          调整研究偏好 →
        </Link>
      </main>
    </div>
  )
}


/* ═══════════════════════════════════════════════════════════════
   utilities (kept identical to old file for back-compat)
   ═══════════════════════════════════════════════════════════════ */
function splitTags(value) {
  return value ? value.split(/[，,]/).map(t => t.trim()).filter(Boolean) : []
}
function formatUpdatedAt(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '1 天前'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}
