/* ─────────────────────────────────────────────────────────────
   Terrain · 共享研究地形图组件
   ─────────────────────────────────────────────────────────────
   抽自 Profile.jsx 的 inline 实现。Home.jsx / Onboarding.jsx /
   Profile.jsx 三个页面共用。

   用法:
     import Terrain from '../components/Terrain'
     import { buildHills, buildTrails } from '../components/terrainUtils'

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

import { VARIANTS, gratLines, hillContours } from './terrainUtils'

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
