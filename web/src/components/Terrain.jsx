/* ─────────────────────────────────────────────────────────────
   Terrain · 共享研究地形图组件
   ─────────────────────────────────────────────────────────────
   抽自 Profile.jsx 的 inline 实现。Home.jsx / Onboarding.jsx /
   Profile.jsx 三个页面共用。

   用法:
     import Terrain, { buildHills, buildTrails } from '../components/Terrain'

     const hills  = buildHills(focusTags, memoryText)
     const trails = buildTrails(hills, methodTags)

     <Terrain hills={hills} trails={trails} dateLabel="…" />
     <Terrain hills={hills} variant="mini" />     // Home 缩略图
     <Terrain hills={hills} variant="hero" />     // Onboarding reveal

   Variants:
     default — 1200×480, 完整 graticule + 角标
     mini    — 540×260, 角标 / 走线全省略，给 Home 用
     hero    — 1200×620, 更高，给 Onboarding reveal step 用

   不依赖任何 npm 包，纯 SVG。
   ───────────────────────────────────────────────────────────── */

const VARIANTS = {
  default: { W: 1200, H: 480, showCorners: true, showTrails: true, gridStep: 100 },
  mini:    { W: 540,  H: 260, showCorners: false, showTrails: false, gridStep: 70 },
  hero:    { W: 1200, H: 620, showCorners: true, showTrails: true, gridStep: 100 },
}

export default function Terrain({
  hills = [],
  trails = [],
  dateLabel = '',
  variant = 'default',
  caption = null,           // 'memory · 7 days · 你最近在追外部验证…'
  emptyText = '填几个研究方向，地形就会出现',
  className = '',
}) {
  const v = VARIANTS[variant] || VARIANTS.default
  return (
    <div className={`relative rounded-[22px] overflow-hidden border border-cream-dark/60 shadow-[0_1px_0_rgba(30,58,95,0.04),0_24px_60px_-36px_rgba(30,58,95,0.22)] bg-[#F7F0E8] ${className}`}>
      <svg viewBox={`0 0 ${v.W} ${v.H}`} className="block w-full h-auto" style={{ background: '#F7F0E8' }}>
        <defs>
          <radialGradient id={`paperV-${variant}`} cx="50%" cy="48%" r="65%">
            <stop offset="0%"   stopColor="#FFFDF9" stopOpacity="0"/>
            <stop offset="80%"  stopColor="#EDE4D8" stopOpacity="0"/>
            <stop offset="100%" stopColor="#D9C8B8" stopOpacity="0.18"/>
          </radialGradient>
          {hills.map(h => (
            <radialGradient key={h.id} id={`hf-${variant}-${h.id}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor={h.hot ? '#E8877A' : '#A8D5BA'} stopOpacity={h.hot ? 0.14 : 0.10}/>
              <stop offset="55%"  stopColor={h.hot ? '#E8877A' : '#A8D5BA'} stopOpacity="0.04"/>
              <stop offset="100%" stopColor="#FFFDF9" stopOpacity="0"/>
            </radialGradient>
          ))}
          <symbol id="sprout-tr" viewBox="0 0 12 12">
            <path d="M6 11 V 6" stroke="#E8877A" strokeWidth="0.9" strokeLinecap="round"/>
            <path d="M6 7 C6 4 8 2 10 2 C10 5 8 7 6 7 Z" fill="#E8877A" opacity="0.85"/>
            <path d="M6 6 C6 3.5 4 2 2 2 C2 4.5 4 6 6 6 Z" fill="#A8D5BA" opacity="0.9"/>
          </symbol>
        </defs>

        {/* graticule */}
        <g opacity="0.25" stroke="#1E3A5F" strokeWidth="0.3" strokeDasharray="1 6">
          {gratLines(v.W, v.H, v.gridStep).map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}/>
          ))}
        </g>
        <rect width={v.W} height={v.H} fill={`url(#paperV-${variant})`}/>

        {/* trails */}
        {v.showTrails && trails.map(t => {
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
                  style={{ font: '500 10px "JetBrains Mono", monospace', fill: '#8E8A85', letterSpacing: '0.06em' }}>
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
              <path d={contours[0].d} fill={`url(#hf-${variant}-${h.id})`}/>
              {contours.map((c, i) => (
                <path key={i} d={c.d} fill="none" stroke={stroke}
                  strokeOpacity={0.18 + c.t * 0.40}
                  strokeWidth={0.55 + c.t * 0.35}/>
              ))}

              {h.emerging && variant !== 'mini' && (
                <g transform={`translate(${h.cx - 10}, ${h.cy - h.size * 0.55})`}>
                  <use href="#sprout-tr" width="16" height="16"/>
                  <text x="22" y="11"
                    style={{ font: '500 9.5px "JetBrains Mono", monospace', fill: '#E8877A', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
                    new · 萌芽
                  </text>
                </g>
              )}

              <g transform={`translate(${h.cx}, ${h.cy + h.size * 0.62})`}>
                <line x1="0" y1="-8" x2="0" y2="-3" stroke="#1E3A5F" strokeOpacity="0.4" strokeWidth="0.6"/>
                <text textAnchor="middle" y="6"
                  style={{ font: `500 ${h.size > 100 ? 14 : 12}px "Noto Serif SC", serif`, fill: '#1E3A5F', letterSpacing: '0.04em' }}>
                  {h.name}
                </text>
                {h.hot && variant !== 'mini' && (
                  <text textAnchor="middle" y="20"
                    style={{ font: '400 9px "JetBrains Mono", monospace', fill: '#8E8A85', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
                    hot · 近期热区
                  </text>
                )}
              </g>
            </g>
          )
        })}

        {hills.length === 0 && (
          <text x={v.W/2} y={v.H/2} textAnchor="middle"
            style={{ font: '400 14px "Noto Serif SC", serif', fill: '#8E8A85' }}>
            {emptyText}
          </text>
        )}
      </svg>

      {/* corner labels */}
      {v.showCorners && (
        <>
          <span className="absolute top-3 left-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">papermind · landscape</span>
          {dateLabel && <span className="absolute top-3 right-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">{dateLabel}</span>}
          <span className="absolute bottom-3 left-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">stage 0 · v0.1</span>
          <span className="absolute bottom-3 right-4 text-[9px] uppercase tracking-[0.2em] font-mono text-warm-gray pointer-events-none">scale ≈ tag</span>
        </>
      )}

      {/* optional memory caption */}
      {caption && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 max-w-[520px] text-center px-4 py-1.5 rounded-full bg-warm-white/80 backdrop-blur border border-navy/10 text-[12px] text-navy/85"
          style={{ fontFamily: '"Noto Serif SC", serif' }}>
          {caption}
        </div>
      )}
    </div>
  )
}

/* ── data builders ──────────────────────────────────────────── */

/**
 * 把 focus_areas 字符串拆成 tag 数组，结合 memory_recent 文本判断哪些是热区。
 * 用法：
 *   const hills = buildHills(profile.focus_areas, profile.memory_recent)
 *
 * 当后端给真实快照时（GET /profile/landscape），这个函数就不用了 —
 * 直接 setHills(serverData.hills)。
 */
export function buildHills(focusAreas, memoryText = '', variant = 'default') {
  const v = VARIANTS[variant] || VARIANTS.default
  const tags = splitTags(focusAreas)
  if (tags.length === 0) return []
  const positions = layoutPositions(tags.length, v.W, v.H)
  return tags.map((tag, i) => {
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

export function buildTrails(hills, methodInterests) {
  if (hills.length < 2) return []
  const methods = splitTags(methodInterests)
  if (methods.length === 0) return []
  const trails = []
  for (let i = 0; i < Math.min(methods.length, 2); i++) {
    if (hills[i * 2] && hills[i * 2 + 1]) {
      trails.push({
        id: methods[i] + i,
        name: methods[i],
        from: hills[i * 2],
        to: hills[i * 2 + 1],
      })
    }
  }
  return trails
}

/**
 * 从 Zotero 解析出的 papers 数组里抽出主题 cluster → hills。
 * Stage 1 之前是简陋版（看 tag 字段计数）；
 * Stage 1 后会被后端 /import/zotero/clusters 替代。
 */
export function clusterPapersToHills(papers, variant = 'default') {
  if (!papers || papers.length === 0) return []
  const counts = new Map()
  for (const p of papers) {
    const tags = [...(p.tags || []), ...((p.keywords || '').split(/[,;]/))]
    for (const raw of tags) {
      const t = (raw || '').trim()
      if (!t || t.length < 2 || t.length > 12) continue
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  // top 5-7
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7)
  const focusStr = top.map(([t]) => t).join(', ')
  const hills = buildHills(focusStr, '', variant)
  // attach paper counts
  return hills.map(h => {
    const tag = h.name
    const papersHere = papers.filter(p =>
      (p.tags || []).includes(tag) || (p.keywords || '').includes(tag)
    )
    const recentCount = papersHere.filter(p => isRecent(p.dateAdded)).length
    return {
      ...h,
      papers: papersHere.length,
      emerging: recentCount >= 3,
    }
  })
}

function isRecent(d) {
  if (!d) return false
  const ms = (new Date(d)).getTime()
  return !isNaN(ms) && (Date.now() - ms) < 30 * 86400000
}

/* ── pure geometry helpers ──────────────────────────────────── */
export function splitTags(str) {
  if (!str) return []
  return str.split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean)
}

function layoutPositions(n, W, H) {
  if (n === 1) return [{ x: W/2, y: H/2 }]
  if (n === 2) return [{ x: W*0.35, y: H/2 }, { x: W*0.65, y: H/2 }]
  if (n === 3) return [
    { x: W*0.25, y: H*0.42 }, { x: W*0.55, y: H*0.38 }, { x: W*0.78, y: H*0.55 }
  ]
  if (n === 4) return [
    { x: W*0.22, y: H*0.40 }, { x: W*0.48, y: H*0.35 },
    { x: W*0.72, y: H*0.55 }, { x: W*0.85, y: H*0.30 }
  ]
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

export function hillContours(hill, levels = 7) {
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
