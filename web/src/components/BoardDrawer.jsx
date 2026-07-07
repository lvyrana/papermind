import { useState } from 'react'
import { Presentation, X, Trash2, Loader2, Download, ChevronRight, Pencil } from 'lucide-react'
import { apiPatch, apiDelete, API_BASE, getUserId } from '../api'

/* ─────────────────────────────────────────────────────────────
   Presentation Board — 组会汇报板（PaperMind v0.12.0）
   ─────────────────────────────────────────────────────────────
   把组会 PPT 倒转为精读的容器：打开论文即有汇报骨架，
   划词/带读/卡片/对话都可「送到汇报」，空板块灰显即阅读进度。

   本文件三件套（全部与 PaperRead 解耦，靠 props 通信）：
   - BoardRail          右栏紧凑区块：板块×条目数 + 打开/导出
   - BoardSectionPicker 「送到汇报」时的板块选单（居中小弹层）
   - BoardDrawer        全览抽屉：分板块整理条目、编辑、删除、导出
   ───────────────────────────────────────────────────────────── */

export const SOURCE_LABELS = {
  selection: '划词',
  deep_read: '带读',
  card: '卡片',
  chat: '对话',
  manual: '手动',
  figure: '图表',
}

// <img> 无法带 X-User-ID header，图片地址用 ?uid= 鉴权（沿用深链模式）
export function figureUrl(paperRowid, name) {
  return `${API_BASE}/board/${paperRowid}/figures/${name}?uid=${encodeURIComponent(getUserId())}`
}

// 卡片类型 → 默认板块映射（可在选单里改投）
export const CARD_SECTION_MAP = {
  method: 'methods',
  finding: 'results',
  critique: 'critique',
  transfer: 'implications',
}

// pub_date 格式不定（"2026-09" / "09/2026" / "Sep 2026"），统一正则提取四位年份
function yearOf(pubDate) {
  const m = /\b(19|20)\d{2}\b/.exec(String(pubDate || ''))
  return m ? m[0] : ''
}

function countBySection(items) {
  const m = {}
  for (const it of items) m[it.section] = (m[it.section] || 0) + 1
  return m
}

export async function downloadBoardMarp(paperRowid, title) {
  const res = await fetch(`${API_BASE}/board/${paperRowid}/export/marp`, {
    headers: { 'X-User-ID': getUserId() },
  })
  if (!res.ok) throw new Error('export failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `组会汇报-${(title || 'paper').slice(0, 40)}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/* ── 右栏紧凑区块 ─────────────────────────────────────────── */
export function BoardRail({ board, onOpen, onExport, exporting }) {
  if (!board) return null
  const counts = countBySection(board.items || [])
  const filled = (board.sections || []).filter(s => counts[s.key]).length
  const total = (board.sections || []).length
  return (
    <section className="px-6 py-4 border-b border-navy/5">
      <div className="flex items-center justify-between mb-2.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-widest uppercase text-coral">
          <Presentation size={11}/> 组会汇报板
        </span>
        <span className="font-mono text-[10px] text-warm-gray/60">{filled}/{total} 板块有内容</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(board.sections || []).map(s => {
          const n = counts[s.key] || 0
          return (
            <span key={s.key}
              className={`px-2 py-0.5 rounded-full text-[10.5px] border ${
                n ? 'bg-mint/15 text-navy border-mint-deep/30' : 'bg-warm-white text-warm-gray/50 border-navy/8'
              }`}>
              {s.title}{n > 0 && <span className="ml-1 font-semibold text-mint-deep">{n}</span>}
            </span>
          )
        })}
      </div>
      <div className="flex gap-2">
        <button onClick={onOpen}
          className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium border border-navy/12 text-navy hover:border-coral/40 hover:text-coral transition-colors">
          打开汇报板 <ChevronRight size={11}/>
        </button>
        <button onClick={onExport} disabled={exporting}
          className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium bg-navy text-warm-white hover:bg-navy-light transition-colors disabled:opacity-50">
          {exporting ? <Loader2 size={11} className="animate-spin"/> : <Download size={11}/>} 导出 PPT
        </button>
      </div>
      <p className="mt-2 text-[10.5px] text-warm-gray/55 leading-relaxed m-0">
        划词、带读结果、卡片、AI 回复都可「送到汇报」；空板块 = 还没读到的部分。
      </p>
    </section>
  )
}

/* ── 板块选单（送到汇报时弹出） ───────────────────────────── */
export function BoardSectionPicker({ board, seed, onPick, onCancel, sending }) {
  if (!seed || !board) return null
  const counts = countBySection(board.items || [])
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-navy/25 backdrop-blur-[2px]"
      onClick={onCancel}>
      <div className="w-[340px] max-w-[90vw] bg-warm-white rounded-2xl shadow-[0_18px_50px_-12px_rgba(30,58,95,.35)] p-4"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <p className="m-0 font-mono text-[10.5px] tracking-widest uppercase text-coral">送到哪个板块？</p>
          <button onClick={onCancel} className="text-warm-gray/60 hover:text-navy"><X size={14}/></button>
        </div>
        {seed.imageUrl ? (
          <img src={seed.imageUrl} alt="图表截图"
            className="w-full max-h-40 object-contain rounded-lg border border-navy/10 bg-white mb-3"/>
        ) : (
          <p className="text-[11px] text-warm-gray/70 leading-snug mb-3 line-clamp-2">
            {(seed.content || '').slice(0, 80)}
          </p>
        )}
        <div className="space-y-1">
          {(board.sections || []).map(s => (
            <button key={s.key} disabled={sending}
              onClick={() => onPick(s.key)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] text-left transition-colors disabled:opacity-50 ${
                seed.defaultSection === s.key
                  ? 'bg-coral/10 text-coral-deep border border-coral/30'
                  : 'text-navy hover:bg-cream border border-transparent'
              }`}>
              <span>{s.title}{seed.defaultSection === s.key && <span className="ml-1.5 text-[10px]">推荐</span>}</span>
              <span className="font-mono text-[10px] text-warm-gray/50">{counts[s.key] || 0}</span>
            </button>
          ))}
        </div>
        {sending && (
          <p className="mt-2 mb-0 text-[11px] text-warm-gray/60 inline-flex items-center gap-1">
            <Loader2 size={10} className="animate-spin"/> 正在投递…
          </p>
        )}
      </div>
    </div>
  )
}

/* ── 全览抽屉 ────────────────────────────────────────────── */
export default function BoardDrawer({ paper, board, open, onClose, onRefresh, onJumpToPage }) {
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [whyEditing, setWhyEditing] = useState(false)
  const [whyText, setWhyText] = useState('')
  const [exporting, setExporting] = useState(false)

  if (!open || !board) return null
  const paperRowid = board.paperRowid
  const bySection = {}
  for (const it of board.items || []) {
    (bySection[it.section] = bySection[it.section] || []).push(it)
  }

  const saveEdit = async () => {
    if (!editingId || !editText.trim()) { setEditingId(null); return }
    await apiPatch(`/board/items/${editingId}`, { content: editText.trim() }).catch(() => {})
    setEditingId(null)
    onRefresh()
  }

  const removeItem = async (id) => {
    await apiDelete(`/board/items/${id}`).catch(() => {})
    onRefresh()
  }

  const moveItem = async (id, sectionKey) => {
    await apiPatch(`/board/items/${id}`, { section: sectionKey }).catch(() => {})
    onRefresh()
  }

  const saveWhy = async () => {
    await apiPatch(`/board/${paperRowid}`, { why_reading: whyText }).catch(() => {})
    setWhyEditing(false)
    onRefresh()
  }

  const doExport = async () => {
    setExporting(true)
    try { await downloadBoardMarp(paperRowid, paper?.title) } catch { /* ignore */ }
    setExporting(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-navy/25 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-[560px] max-w-[95vw] h-full bg-cream overflow-y-auto shadow-[-12px_0_40px_-12px_rgba(30,58,95,.3)]"
        onClick={e => e.stopPropagation()}>

        {/* header */}
        <div className="sticky top-0 z-10 bg-cream/95 backdrop-blur px-6 py-4 border-b border-navy/8 flex items-center justify-between">
          <div className="min-w-0">
            <p className="m-0 font-mono text-[10px] tracking-widest uppercase text-coral inline-flex items-center gap-1.5">
              <Presentation size={11}/> 组会汇报板
            </p>
            <p className="m-0 mt-0.5 text-[13px] text-navy font-medium truncate">{paper?.title}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={doExport} disabled={exporting}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-navy text-warm-white hover:bg-navy-light disabled:opacity-50">
              {exporting ? <Loader2 size={11} className="animate-spin"/> : <Download size={11}/>} 导出 PPT
            </button>
            <button onClick={onClose} className="text-warm-gray/70 hover:text-navy p-1"><X size={16}/></button>
          </div>
        </div>

        {/* 首页信息（自动生成） */}
        <div className="px-6 py-4 border-b border-navy/6 bg-warm-white/60">
          <p className="m-0 font-mono text-[9.5px] tracking-widest uppercase text-warm-gray/60 mb-1.5">首页 · 自动生成</p>
          <p className="m-0 text-[13px] text-navy leading-snug">{paper?.title}</p>
          <p className="m-0 mt-1 text-[11.5px] text-warm-gray">{paper?.authors}</p>
          <p className="m-0 mt-0.5 text-[11px] text-warm-gray/70">
            {paper?.journal}{yearOf(paper?.pub_date) ? ` · ${yearOf(paper.pub_date)}` : ''}{paper?.doi ? ` · ${paper.doi}` : ''}
          </p>
          <div className="mt-2 text-[11.5px] leading-relaxed">
            <span className="text-warm-gray/70">为什么读这篇：</span>
            {whyEditing ? (
              <span className="block mt-1">
                <textarea value={whyText} onChange={e => setWhyText(e.target.value)} rows={2}
                  className="w-full bg-warm-white rounded-lg px-2.5 py-1.5 text-[12px] text-navy border border-navy/12 outline-none resize-none focus:border-coral/40"/>
                <button onClick={saveWhy} className="mt-1 px-2.5 py-1 rounded-lg text-[11px] bg-coral text-warm-white">保存</button>
                <button onClick={() => setWhyEditing(false)} className="mt-1 ml-1.5 px-2.5 py-1 rounded-lg text-[11px] text-warm-gray">取消</button>
              </span>
            ) : (
              <>
                <span className="text-navy/85">{board.whyReading || '（待填入）'}</span>
                <button onClick={() => { setWhyText(board.whyReading || ''); setWhyEditing(true) }}
                  className="ml-1.5 text-warm-gray/50 hover:text-coral align-middle"><Pencil size={10}/></button>
              </>
            )}
          </div>
        </div>

        {/* sections */}
        {(board.sections || []).map(sec => {
          const items = bySection[sec.key] || []
          return (
            <div key={sec.key} className="px-6 py-4 border-b border-navy/6">
              <div className="flex items-center justify-between mb-2">
                <p className={`m-0 text-[13px] font-semibold ${items.length ? 'text-navy' : 'text-warm-gray/45'}`}>
                  {sec.title}
                </p>
                <span className="font-mono text-[10px] text-warm-gray/50">{items.length || '待填入'}</span>
              </div>
              {items.map(it => (
                <div key={it.id} className="mb-2 bg-warm-white rounded-xl border border-navy/8 px-3 py-2.5">
                  <div className="flex items-center justify-between text-[9.5px] font-mono tracking-wide text-warm-gray/55 mb-1">
                    <span>
                      <span className="text-mint-deep">{SOURCE_LABELS[it.source] || it.source}</span>
                      {it.page && (
                        <button onClick={() => onJumpToPage?.(it.page)} className="ml-1.5 hover:text-coral">P.{it.page} ↗</button>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <select value={it.section} onChange={e => moveItem(it.id, e.target.value)}
                        className="bg-transparent text-[9.5px] text-warm-gray/60 outline-none cursor-pointer">
                        {(board.sections || []).map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
                      </select>
                      <button onClick={() => { setEditingId(it.id); setEditText(it.content) }}
                        className="hover:text-coral"><Pencil size={10}/></button>
                      <button onClick={() => removeItem(it.id)} className="hover:text-coral"><Trash2 size={10}/></button>
                    </span>
                  </div>
                  {it.image && (
                    <img src={figureUrl(paperRowid, it.image)} alt={it.content}
                      className="w-full max-h-64 object-contain rounded-lg border border-navy/8 bg-white mb-1.5"/>
                  )}
                  {editingId === it.id ? (
                    <div>
                      <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3}
                        className="w-full bg-cream/60 rounded-lg px-2.5 py-1.5 text-[12.5px] text-navy border border-navy/12 outline-none resize-y focus:border-coral/40"/>
                      <button onClick={saveEdit} className="mt-1 px-2.5 py-1 rounded-lg text-[11px] bg-coral text-warm-white">保存</button>
                      <button onClick={() => setEditingId(null)} className="mt-1 ml-1.5 px-2.5 py-1 rounded-lg text-[11px] text-warm-gray">取消</button>
                    </div>
                  ) : (
                    <p className="m-0 text-[12.5px] text-navy/90 leading-relaxed whitespace-pre-wrap">{it.content}</p>
                  )}
                  {it.quote && it.quote !== it.content && (
                    <p className="m-0 mt-1.5 pl-2 border-l-2 border-navy/12 text-[11px] text-warm-gray/70 leading-snug line-clamp-3">
                      {it.quote}
                    </p>
                  )}
                </div>
              ))}
              {!items.length && (
                <p className="m-0 text-[11.5px] text-warm-gray/40 italic">读到相关内容时，划词或从卡片「送到汇报」</p>
              )}
            </div>
          )
        })}
        <div className="h-10"/>
      </div>
    </div>
  )
}
