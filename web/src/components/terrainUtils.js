export const VARIANTS = {
  default: { W: 1200, H: 480, showCorners: true, showTrails: true, gridStep: 100 },
  mini: { W: 540, H: 260, showCorners: false, showTrails: false, gridStep: 70 },
  hero: { W: 1200, H: 620, showCorners: true, showTrails: true, gridStep: 100 },
}

/**
 * 把 focus_areas 字符串拆成 tag 数组，结合 memory_recent 文本判断哪些是热区。
 * 当后端给真实快照时（GET /profile/landscape），这个函数就不用了。
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
 * 从 Zotero 解析出的 papers 数组里抽出主题 cluster -> hills。
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
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7)
  const focusStr = top.map(([t]) => t).join(', ')
  const hills = buildHills(focusStr, '', variant)
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

export function splitTags(str) {
  if (!str) return []
  return str.split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean)
}

function layoutPositions(n, W, H) {
  if (n === 1) return [{ x: W / 2, y: H / 2 }]
  if (n === 2) return [{ x: W * 0.35, y: H / 2 }, { x: W * 0.65, y: H / 2 }]
  if (n === 3) return [
    { x: W * 0.25, y: H * 0.42 }, { x: W * 0.55, y: H * 0.38 }, { x: W * 0.78, y: H * 0.55 },
  ]
  if (n === 4) return [
    { x: W * 0.22, y: H * 0.40 }, { x: W * 0.48, y: H * 0.35 },
    { x: W * 0.72, y: H * 0.55 }, { x: W * 0.85, y: H * 0.30 },
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

export function gratLines(W, H, step) {
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
    const n = Math.sin(a * 3 + seed * 1.7) * amp
      + Math.sin(a * 5 + seed * 2.3) * amp2
      + Math.sin(a * 7 + seed * 3.1) * amp3
    const r = baseR * (1 + n)
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
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
