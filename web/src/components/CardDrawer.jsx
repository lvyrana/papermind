import { useState, useEffect, useRef } from 'react'
import { Plus, Loader2, Sparkles, Pencil, Trash2, X, Layers } from 'lucide-react'
import { apiPost, apiPatch, apiDelete } from '../api'

/* ─────────────────────────────────────────────────────────────
   CardDrawer — 阅读卡片抽屉（PaperRead 右栏）
   ─────────────────────────────────────────────────────────────
   - 卡片类型：方法 / 发现 / 批判 / 迁移
   - 来源：手动新建、划词沉淀（seed.quote）、对话归卡（seed.question/answer）
   - AI 起草走 /api/cards/draft（不落库），保存走 /api/cards
   - 卡片必须挂在已收藏的论文上：保存前由父组件 ensureSaved() 兜底自动收藏
   ───────────────────────────────────────────────────────────── */

const CARD_TYPES = [
  { key: 'method', label: '方法', badge: 'bg-coral/12 text-coral-deep', border: 'border-coral' },
  { key: 'finding', label: '发现', badge: 'bg-mint/20 text-mint-deep', border: 'border-mint-deep' },
  { key: 'critique', label: '批判', badge: 'bg-navy/8 text-navy', border: 'border-navy' },
  { key: 'transfer', label: '迁移', badge: 'bg-coral-deep/10 text-coral-deep', border: 'border-coral-deep' },
]

const typeOf = (key) => CARD_TYPES.find(t => t.key === key) || CARD_TYPES[0]

export default function CardDrawer({
  paper, cards, setCards, ensureSaved, seed, clearSeed, onJumpToPage,
}) {
  const [composerOpen, setComposerOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)   // null = 新建
  const [cardType, setCardType] = useState('method')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [quote, setQuote] = useState('')
  const [page, setPage] = useState(null)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const composerRef = useRef(null)

  // 划词 / 对话归卡：父组件塞 seed 进来 → 打开预填的 composer
  useEffect(() => {
    if (!seed) return
    setEditingId(null)
    setCardType(seed.cardType || 'method')
    setTitle('')
    setContent(seed.answer ? seed.answer.slice(0, 1000) : '')
    setQuote(seed.quote || '')
    setPage(seed.page || null)
    setError(null)
    setComposerOpen(true)
    setTimeout(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
  }, [seed])

  const resetComposer = () => {
    setComposerOpen(false)
    setEditingId(null)
    setTitle('')
    setContent('')
    setQuote('')
    setPage(null)
    setError(null)
    clearSeed?.()
  }

  const openBlank = () => {
    setEditingId(null)
    setCardType('method')
    setTitle('')
    setContent('')
    setQuote('')
    setPage(null)
    setError(null)
    setComposerOpen(true)
  }

  const openEdit = (card) => {
    setEditingId(card.id)
    setCardType(card.card_type)
    setTitle(card.title || '')
    setContent(card.content || '')
    setQuote(card.quote || '')
    setPage(card.page || null)
    setError(null)
    setComposerOpen(true)
    setTimeout(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
  }

  const handleDraft = async () => {
    if (drafting) return
    setDrafting(true)
    setError(null)
    try {
      const data = await apiPost('/cards/draft', {
        paper_title: paper?.title || '',
        paper_abstract: paper?.abstract || '',
        card_type: cardType,
        quote,
        page,
        question: seed?.question || '',
        answer: seed?.answer || '',
      })
      if (data.ok) {
        setTitle(data.title || '')
        setContent(data.content || '')
      } else setError(data.error || '起草失败，请重试。')
    } catch { setError('网络错误，请重试。') }
    finally { setDrafting(false) }
  }

  const handleSave = async () => {
    if (!content.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        const data = await apiPatch(`/cards/${editingId}`, { card_type: cardType, title, content })
        if (data.ok) {
          setCards(prev => prev.map(c => c.id === editingId ? { ...c, card_type: cardType, title, content } : c))
          resetComposer()
        } else setError(data.error || '保存失败。')
      } else {
        const rowId = await ensureSaved()
        if (!rowId) { setError('自动收藏失败，请先手动收藏这篇论文。'); return }
        const data = await apiPost('/cards', {
          paper_rowid: rowId, card_type: cardType, title, content,
          quote, page, source: seed ? (seed.answer ? 'chat' : 'quote') : 'manual',
        })
        if (data.ok) {
          setCards(prev => [...prev, {
            id: data.id, paper_rowid: rowId, card_type: cardType, title, content,
            quote, page, created_at: new Date().toISOString(),
          }])
          resetComposer()
        } else setError(data.error || '保存失败。')
      }
    } catch { setError('网络错误，请重试。') }
    finally { setSaving(false) }
  }

  const handleDelete = async (cardId) => {
    try {
      const data = await apiDelete(`/cards/${cardId}`)
      if (data.ok) setCards(prev => prev.filter(c => c.id !== cardId))
    } catch { /* ignore */ }
  }

  return (
    <section className="px-6 py-4 border-b border-navy/5">
      <div className="flex items-baseline justify-between mb-3">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-widest uppercase text-coral">
          <Layers size={11}/> 阅读卡片
        </span>
        <div className="flex items-center gap-2">
          {cards.length > 0 && (
            <span className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70">{cards.length} 张</span>
          )}
          {!composerOpen && (
            <button onClick={openBlank}
              className="inline-flex items-center gap-1 text-[11px] text-coral hover:text-coral-deep font-medium">
              <Plus size={11}/> 新卡片
            </button>
          )}
        </div>
      </div>

      {/* 空状态 */}
      {cards.length === 0 && !composerOpen && (
        <div className="text-xs text-warm-gray/70 leading-relaxed py-3 px-3 border border-dashed border-navy/15 rounded-xl text-center">
          划选原文「存为卡片」，或从对话「归卡」，<br/>把读懂的方法和发现沉淀下来
        </div>
      )}

      {/* 卡片列表 */}
      {cards.map(card => (
        <ReadingCard key={card.id} card={card}
          onEdit={() => openEdit(card)}
          onDelete={() => handleDelete(card.id)}
          onJump={() => card.page && onJumpToPage?.(card.page)}/>
      ))}

      {/* composer */}
      {composerOpen && (
        <div ref={composerRef} className="bg-warm-white border border-coral/25 rounded-xl p-3.5 mt-2">
          <div className="flex items-center justify-between mb-2.5">
            <span className="font-mono text-[10px] tracking-widest uppercase text-warm-gray/70">
              {editingId ? '编辑卡片' : '新卡片'}
            </span>
            <button onClick={resetComposer} className="p-0.5 text-warm-gray hover:text-navy"><X size={13}/></button>
          </div>

          {/* 类型选择 */}
          <div className="flex gap-1.5 mb-2.5">
            {CARD_TYPES.map(t => (
              <button key={t.key} onClick={() => setCardType(t.key)}
                className={`px-2.5 py-1 text-[11px] rounded-full transition-all ${
                  cardType === t.key ? `${t.badge} font-medium ring-1 ring-current/20` : 'text-warm-gray hover:text-navy bg-cream-dark/40'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* 引用锚点预览 */}
          {quote && (
            <div className="bg-coral/[0.06] border-l-2 border-coral pl-2.5 pr-2 py-1.5 rounded-r-lg mb-2.5">
              <p className="italic text-[11.5px] leading-snug text-navy/70" style={{ fontFamily: '"Source Serif Pro", Georgia, serif' }}>
                &ldquo;{quote.length > 150 ? quote.slice(0, 150) + '…' : quote}&rdquo;
              </p>
              {page && <p className="font-mono text-[9.5px] tracking-widest uppercase text-coral-deep mt-1">P.{page}</p>}
            </div>
          )}

          <input
            type="text" value={title} onChange={e => setTitle(e.target.value)}
            placeholder="卡片标题（可让 AI 起草）"
            className="w-full bg-cream/60 rounded-lg px-3 py-1.5 text-[13px] text-navy border border-navy/10 outline-none focus:border-coral/40 mb-2"/>
          <textarea
            value={content} onChange={e => setContent(e.target.value)}
            placeholder="卡片内容：这段讲了什么方法/发现？为什么重要？"
            className="w-full bg-cream/60 rounded-lg px-3 py-2 text-[12.5px] text-navy border border-navy/10 outline-none resize-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 leading-relaxed min-h-[110px] mb-2"/>

          {error && <p className="text-[11px] text-coral mb-2">{error}</p>}

          <div className="flex gap-2">
            <button onClick={handleDraft} disabled={drafting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] rounded-lg border border-coral/30 text-coral hover:bg-coral/5 disabled:opacity-50 font-medium">
              {drafting ? <><Loader2 size={11} className="animate-spin"/> 起草中…</> : <><Sparkles size={11}/> AI 起草</>}
            </button>
            <button onClick={handleSave} disabled={!content.trim() || saving}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] rounded-lg bg-navy text-warm-white hover:bg-navy-light disabled:opacity-50 font-medium">
              {saving ? <Loader2 size={11} className="animate-spin"/> : (editingId ? '保存修改' : '保存卡片')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function ReadingCard({ card, onEdit, onDelete, onJump }) {
  const t = typeOf(card.card_type)
  return (
    <div className="bg-warm-white border border-navy/8 rounded-xl px-3.5 py-3 mb-2.5 group relative hover:border-coral/30 transition-all">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${t.badge}`}>{t.label}</span>
        {card.page && (
          <button onClick={onJump}
            className="font-mono text-[9.5px] tracking-wider uppercase text-coral-deep hover:underline">
            P.{card.page}
          </button>
        )}
        <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onEdit} className="p-1 text-warm-gray hover:text-navy"><Pencil size={11}/></button>
          <button onClick={onDelete} className="p-1 text-warm-gray hover:text-coral"><Trash2 size={11}/></button>
        </span>
      </div>
      {card.title && <p className="text-[13px] font-medium text-navy leading-snug mb-1">{card.title}</p>}
      <p className="text-[12px] text-navy/75 leading-relaxed whitespace-pre-wrap">{card.content}</p>
      {card.quote && (
        <p className={`border-l-2 ${t.border} pl-2 italic text-[11px] leading-snug text-warm-gray mt-2`}
          style={{ fontFamily: '"Source Serif Pro", Georgia, serif' }}>
          &ldquo;{card.quote.length > 100 ? card.quote.slice(0, 100) + '…' : card.quote}&rdquo;
        </p>
      )}
    </div>
  )
}
