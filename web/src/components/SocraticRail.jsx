import { useState, useEffect, useCallback } from 'react'
import { Loader2, Mic, MicOff, Send, X } from 'lucide-react'
import { apiGet, apiPost } from '../api'

/* ═══════════════════════════════════════════════════════════════
   苏格拉底自测 · 右栏内嵌
   ───────────────────────────────────────────────────────────────
   它是诊断工具，不是老师：只提问、不教学；照出盲点即完成任务。
   - 四态状态图，绝不打分（分数是伪科学，也让人焦虑）
   - 判定分档由后端给：站住了 / 部分对(缺哪块) / 不对(原文是什么)
   - 「不确定 · 转到对话」带上下文过去，并保留回程（返回作答）
   - 内嵌而非全屏：自测时要随时翻原文对照，不能离开论文
   ═══════════════════════════════════════════════════════════════ */

const STATE_META = {
  untouched: { label: '还没问', dot: 'border border-cream-dark bg-transparent', text: 'text-warm-gray/45' },
  vague:     { label: '还模糊', dot: 'bg-coral',                                text: 'text-coral' },
  asked:     { label: '已去问', dot: 'bg-coral/40 ring-2 ring-coral/25',        text: 'text-coral/80' },
  solid:     { label: '已厘清', dot: 'bg-mint-deep',                            text: 'text-mint-deep' },
}

const VERDICT_META = {
  solid:   { label: '站住了',   cls: 'bg-mint/20 text-mint-deep' },
  partial: { label: '部分对',   cls: 'bg-coral/12 text-coral' },
  off:     { label: '还不对',   cls: 'bg-navy/10 text-navy' },
}

export default function SocraticRail({
  paper, paperRowid, currentPage, currentPageText,
  onExit, onJumpToPage, onHandoffToChat, onMakeCard,
  speechSupported, listening, startListening, stopListening,
  speechDraft, clearSpeechDraft,
}) {
  const [pillars, setPillars] = useState([])
  const [gaps, setGaps] = useState([])
  const [activeKey, setActiveKey] = useState(null)
  const [panel, setPanel] = useState(null)      // null | 'map' | 'gaps'
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [handoff, setHandoff] = useState(null)  // {prompt, chips}
  const [loading, setLoading] = useState(true)

  const active = pillars.find(p => p.pillar_key === activeKey) || null
  const solidCount = pillars.filter(p => p.state === 'solid').length
  const askedTurns = active ? (active.turns || []).filter(t => t.role === 'ai' && !t.judged).length : 0

  // 语音输入结果灌进答题框
  useEffect(() => {
    if (speechDraft) { setAnswer(prev => (prev ? `${prev} ${speechDraft}` : speechDraft)); clearSpeechDraft?.() }
  }, [speechDraft, clearSpeechDraft])

  useEffect(() => {
    if (!paperRowid) { setLoading(false); return }
    apiGet(`/self-test/${paperRowid}`)
      .then(data => {
        if (!data.ok) { setError('自测需要先收藏这篇论文。'); return }
        setPillars(data.pillars || [])
        setGaps(data.gaps || [])
        const next = (data.pillars || []).find(p => p.state !== 'solid') || (data.pillars || [])[0]
        setActiveKey(next?.pillar_key || null)
      })
      .catch(() => setError('自测加载失败。'))
      .finally(() => setLoading(false))
  }, [paperRowid])

  const paperCtx = useCallback(() => ({
    paper_title: paper?.title || '',
    paper_abstract: paper?.abstract || '',
    current_page_text: currentPageText || '',
  }), [paper, currentPageText])

  const syncPillar = (key, patch) =>
    setPillars(prev => prev.map(p => (p.pillar_key === key ? { ...p, ...patch } : p)))

  const ask = async (key = activeKey) => {
    if (!key || busy) return
    setBusy(true); setError(''); setHandoff(null)
    try {
      const data = await apiPost(`/self-test/${paperRowid}/ask`, { pillar_key: key, ...paperCtx() })
      if (!data.ok) { setError(data.error || '出题失败。'); return }
      syncPillar(key, { turns: data.turns, turn_count: data.turn_count, state: data.state })
    } catch { setError('出题失败，请重试。') } finally { setBusy(false) }
  }

  const submit = async () => {
    if (!answer.trim() || busy || !active) return
    setBusy(true); setError('')
    try {
      const data = await apiPost(`/self-test/${paperRowid}/answer`, {
        pillar_key: active.pillar_key, answer: answer.trim(), ...paperCtx(),
      })
      if (!data.ok) { setError(data.error || '判定失败。'); return }
      syncPillar(active.pillar_key, { turns: data.turns, state: data.state })
      setAnswer('')
    } catch { setError('判定失败，请重试。') } finally { setBusy(false) }
  }

  // 「不确定 · 转到对话」：带上下文过去，自测停在这等着
  const toChat = async () => {
    if (!active || busy) return
    setBusy(true)
    try {
      const data = await apiPost(`/self-test/${paperRowid}/handoff`, {
        pillar_key: active.pillar_key, paper_title: paper?.title || '', current_page: currentPage || null,
      })
      if (!data.ok) { setError(data.error || '转入对话失败。'); return }
      syncPillar(active.pillar_key, { state: 'asked' })
      setHandoff({ prompt: data.prompt, chips: data.chips || [] })
    } catch { setError('转入对话失败。') } finally { setBusy(false) }
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center text-warm-gray text-sm">
      <Loader2 size={14} className="animate-spin mr-2"/>加载自测…
    </div>
  }

  return (
    <div className="h-full flex flex-col bg-cream min-h-0">

      {/* 顶：标题 + 收敛进度（不是分数） */}
      <div className="px-4 py-2.5 border-b border-cream-dark/50 shrink-0">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[13px] font-serif text-navy">自测</span>
          <button onClick={onExit} className="text-[11px] text-warm-gray hover:text-navy">退出</button>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex gap-1">
            {pillars.map(p => (
              <span key={p.pillar_key} className={`h-1 w-6 rounded-full ${
                p.state === 'solid' ? 'bg-mint-deep'
                  : p.state === 'vague' || p.state === 'asked' ? 'bg-coral/45' : 'bg-cream-dark'
              }`}/>
            ))}
          </div>
          <span className="text-[10.5px] text-warm-gray/70">已厘清 {solidCount}/{pillars.length}</span>
        </div>
      </div>

      {/* 两个折叠面板：核心问题 / 方法学盲区（默认收起，不抢主流） */}
      <div className="border-b border-cream-dark/50 shrink-0">
        <div className="flex">
          <button onClick={() => setPanel(panel === 'map' ? null : 'map')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] transition ${
              panel === 'map' ? 'text-navy bg-cream-dark/25' : 'text-warm-gray hover:text-navy'}`}>
            核心问题<span className="text-warm-gray/55">{solidCount}/{pillars.length}</span>
          </button>
          <div className="w-px bg-cream-dark/50"/>
          <button onClick={() => setPanel(panel === 'gaps' ? null : 'gaps')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] transition ${
              panel === 'gaps' ? 'text-navy bg-cream-dark/25' : 'text-warm-gray hover:text-navy'}`}>
            方法学盲区<span className="text-warm-gray/55">{gaps.length}</span>
          </button>
        </div>

        {panel === 'map' && (
          <div className="px-2 pb-3 max-h-[190px] overflow-auto border-t border-cream-dark/40 space-y-1.5 pt-2">
            {pillars.map(p => {
              const s = STATE_META[p.state] || STATE_META.untouched
              const isActive = p.pillar_key === activeKey
              return (
                <button key={p.pillar_key}
                  onClick={() => { setActiveKey(p.pillar_key); setPanel(null); setHandoff(null) }}
                  className={`w-full text-left flex items-start gap-2.5 rounded-xl transition px-3 py-2.5 ${
                    isActive ? 'bg-warm-white shadow-sm border border-coral/30' : 'hover:bg-warm-white/60 border border-transparent'}`}>
                  <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${s.dot}`}/>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`text-[12px] font-medium ${isActive ? 'text-navy' : 'text-navy/75'}`}>{p.pillar_name}</span>
                      <span className={`text-[10px] ${s.text}`}>{s.label}</span>
                    </span>
                    <span className="block text-[10.5px] text-warm-gray/65 mt-0.5 leading-snug">{p.pillar_short}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {panel === 'gaps' && (
          <div className="px-4 py-3.5 max-h-[190px] overflow-auto border-t border-cream-dark/40">
            <p className="text-[10px] uppercase tracking-[0.18em] text-warm-gray/65 mb-2.5 m-0">我的方法学盲区</p>
            {gaps.length === 0 ? (
              <p className="text-[11.5px] text-warm-gray/55 m-0">还没有累积。答不上来的概念会记在这里。</p>
            ) : (
              <div className="space-y-1.5">
                {gaps.map(g => (
                  <div key={g.term} className="flex items-center justify-between text-[11.5px]">
                    <span className="text-navy/75 truncate">{g.term}</span>
                    <span className="text-warm-gray/55 text-[10px] shrink-0 ml-2">问过 {g.times} 次</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 追问流 —— 主角 */}
      <div className="flex-1 overflow-auto px-4 py-3.5 space-y-4 min-h-[220px]">
        {active && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-coral/75">{active.pillar_name}</span>
            <div className="flex-1 h-px bg-cream-dark/50"/>
            <span className="text-[10px] text-warm-gray/50">第 {Math.max(askedTurns, 1)} / 3 问</span>
          </div>
        )}

        {(active?.turns || []).map((t, i) => {
          // 沉卡时要带上「我自己的话」——判定轮的前一条就是我的回答
          const myAnswer = t.judged
            ? [...(active.turns || [])].slice(0, i).reverse().find(x => x.role === 'me')?.text || ''
            : ''
          return <Turn key={i} t={{ ...t, _myAnswer: myAnswer }}
            onJumpToPage={onJumpToPage} onMakeCard={onMakeCard}/>
        })}

        {active && (active.turns || []).length === 0 && (
          <div className="text-center py-8">
            <p className="text-[12.5px] text-warm-gray/70 leading-6 mb-3">
              基于你的卡片、划过但没做卡的段落，<br/>以及还没碰的部分出题。
            </p>
            <button onClick={() => ask()} disabled={busy}
              className="px-4 py-2 rounded-full bg-navy text-warm-white text-[12px] font-medium hover:bg-navy-light disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy ? <><Loader2 size={12} className="animate-spin"/>出题中…</> : '开始自测'}
            </button>
          </div>
        )}

        {error && <p className="text-[11.5px] text-coral text-center m-0">{error}</p>}

        {/* 转入对话卡（含回程） */}
        {handoff ? (
          <div style={{ marginLeft: '34px' }} className="bg-warm-white border border-coral/30 rounded-2xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-2.5">
              <span className="w-2 h-2 rounded-full bg-coral"/>
              <p className="text-[10px] uppercase tracking-[0.18em] text-warm-gray/70 m-0">转入对话 · 已附上下文</p>
            </div>
            <p className="text-[12.5px] text-navy/85 leading-7 m-0">{handoff.prompt}</p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {handoff.chips.map(c => (
                <button key={c} onClick={() => onHandoffToChat?.(handoff.prompt, c)}
                  className="text-[11px] text-navy/70 bg-cream-dark/45 hover:bg-cream-dark/70 rounded-full px-2.5 py-1 transition">
                  {c}
                </button>
              ))}
            </div>
            <div className="mt-3.5 pt-3 border-t border-cream-dark/50 flex items-center justify-between gap-3">
              <span className="text-[10.5px] text-warm-gray/65 leading-snug">自测已暂停 · 标记为待澄清</span>
              <button onClick={() => setHandoff(null)} className="text-[11px] text-coral hover:underline shrink-0">
                返回作答 ↩
              </button>
            </div>
          </div>
        ) : active && (active.turns || []).length > 0 && (
          /* 答题区 */
          <div className="space-y-2.5" style={{ paddingLeft: '34px' }}>
            <div className="relative bg-warm-white border border-cream-dark/70 rounded-2xl">
              <textarea
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                placeholder="用你自己的话说…"
                className="w-full bg-transparent px-3.5 py-3 pr-10 text-[12.5px] text-navy outline-none resize-none min-h-[72px] leading-6 placeholder:text-warm-gray/45"/>
              {speechSupported && (
                <button onClick={listening ? stopListening : startListening} title="语音输入"
                  className={`absolute right-2.5 bottom-2.5 w-7 h-7 rounded-full flex items-center justify-center transition ${
                    listening ? 'bg-coral text-warm-white animate-pulse' : 'text-warm-gray/60 hover:text-coral hover:bg-coral/10'}`}>
                  {listening ? <MicOff size={13}/> : <Mic size={13}/>}
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <button onClick={toChat} disabled={busy}
                className="text-[11.5px] text-warm-gray hover:text-coral transition inline-flex items-center gap-1.5 disabled:opacity-50">
                <span className="text-[13px]">◌</span>不确定 · 转到对话
              </button>
              <button onClick={submit} disabled={busy || !answer.trim()}
                className="bg-navy text-warm-white font-medium rounded-full hover:bg-navy-light transition text-[12px] px-5 py-2 disabled:opacity-50 inline-flex items-center gap-1.5">
                {busy ? <><Loader2 size={12} className="animate-spin"/>判定中</> : <>回答<Send size={11}/></>}
              </button>
            </div>
          </div>
        )}

        {/* 收口后进入下一个核心问题 */}
        {active?.state === 'solid' && (
          <div className="text-center pt-2">
            <button
              onClick={() => {
                const next = pillars.find(p => p.state !== 'solid' && p.pillar_key !== active.pillar_key)
                if (next) { setActiveKey(next.pillar_key); setHandoff(null); setAnswer('') }
              }}
              className="text-[11.5px] text-coral hover:underline">
              下一个核心问题 →
            </button>
          </div>
        )}
      </div>

      {/* 底：一行出口提示 */}
      <div className="border-t border-cream-dark/60 bg-cream/80 px-4 py-2.5 shrink-0">
        <p className="text-[10.5px] text-warm-gray/60 leading-relaxed m-0">回答可沉成卡片，并入汇报板</p>
      </div>
    </div>
  )
}

/* 一轮对话：AI 提问 / 我的回答 / 判定反馈（判定必须带可点回原文的锚点） */
function Turn({ t, onJumpToPage, onMakeCard }) {
  const isAi = t.role === 'ai'

  if (!isAi) {
    return (
      <div style={{ paddingLeft: '34px' }}>
        <div className="bg-cream-dark/40 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
          <p className="text-[12.5px] leading-7 text-navy/75 m-0">{t.text}</p>
        </div>
      </div>
    )
  }

  const v = t.verdict ? VERDICT_META[t.verdict] : null

  return (
    <div className="flex gap-2.5">
      <span className="w-6 h-6 rounded-full bg-coral/12 text-coral flex items-center justify-center text-[11px] shrink-0 mt-0.5">?</span>
      <div className="min-w-0 flex-1">
        {t.probe && <p className="text-[10px] uppercase tracking-[0.16em] text-coral/70 mb-1.5 m-0">再追一层</p>}
        {v && (
          <span className={`inline-block text-[10px] font-medium rounded-full px-2 py-0.5 mb-1.5 ${v.cls}`}>{v.label}</span>
        )}
        {t.text && <p className="text-[13px] leading-7 text-navy/85 m-0">{t.text}</p>}

        {/* 原文锚点：没有锚点的反馈一律不可信，所以判定必附可点回原文的依据 */}
        {t.anchor_quote && (
          <button
            onClick={() => t.anchor_page && onJumpToPage?.(t.anchor_page)}
            className="mt-2 w-full text-left bg-coral/[0.06] border-l-2 border-coral pl-2.5 pr-2 py-1.5 rounded-r-lg hover:bg-coral/10 transition">
            <p className="italic text-[11.5px] leading-snug text-navy/70 m-0">&ldquo;{t.anchor_quote}&rdquo;</p>
            {t.anchor_page && (
              <p className="font-mono text-[9.5px] tracking-widest uppercase text-coral-deep mt-1 m-0">P.{t.anchor_page} ↩</p>
            )}
          </button>
        )}

        {/* 只有站住了的回答才允许沉成卡片——用自己的话说明白的，是质量最高的卡片 */}
        {t.verdict === 'solid' && onMakeCard && (
          <button onClick={() => onMakeCard(t)}
            className="mt-2 text-[11px] text-coral hover:underline">
            沉成卡片 →
          </button>
        )}
      </div>
    </div>
  )
}
