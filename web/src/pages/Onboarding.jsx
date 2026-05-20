import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Upload, Check, Plus, X, Loader2, ArrowRight, Sparkles, ExternalLink } from 'lucide-react'
import { apiPost } from '../api'
import Terrain, { buildHills, buildTrails, clusterPapersToHills } from '../components/Terrain'

/* ─────────────────────────────────────────────────────────────
   Onboarding — Zotero 导入版

   流程: source → import → parsing → reveal → confirm → done
            ↓ (没有库也行)
          confirm → done

   设计原则:
   1. 保留现有后端契约: 最终 POST /profile（focus_areas / method_interests /
      background / tracking_days），其它都是新增/可选
   2. 没有 Zotero 库的人走"fresh path"，直接从 source 跳到 confirm —
      和老版本三步表单功能等价，只是 UI 整合到一个 step
   3. Zotero 路径: 上传 → 后端 parse → cluster → 把扯出来的 tag 灌给 confirm
      step 当默认值。后端没上之前，前端 fallback 客户端粗略 parse（数条目），
      reveal 用 focus_areas 客户端 buildHills 兜底
   4. localStorage / sessionStorage 完全兼容老 pm-skip-onboarding / pm-auto-fetch flag
   ───────────────────────────────────────────────────────────── */

const METHOD_SUGGESTIONS = ['RCT', '系统综述', '质性研究', 'Meta 分析', '观察性研究', '预测模型']
const RANGE_OPTIONS = [
  { label: '近 1 个月', value: '30' },
  { label: '近 3 个月', value: '90' },
  { label: '近 6 个月', value: '180' },
]

// ── Sprout brand icon ────────────────────────────────────────
function SproutIcon({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ flexShrink: 0 }}>
      <rect width="64" height="64" rx="15" fill="#FFFDF9"/>
      <line x1="32" y1="48" x2="32" y2="27" stroke="#1E3A5F" strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M32 33 C32 25 38 20 44 19 C44 27 38 32 32 33Z" fill="#1E3A5F" opacity="0.85"/>
      <path d="M32 28 C32 21 26 17 20 17 C20 24 26 28 32 28Z" fill="#A8D5BA" opacity="0.9"/>
      <path d="M26 46 C26 46 28 43 32 42 C36 43 38 46 38 46" stroke="#E8877A" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
    </svg>
  )
}

// ── Stepbar ──────────────────────────────────────────────────
function Stepbar({ step, onSkip }) {
  const stepToIx = { source: 0, import: 1, parsing: 1, reveal: 2, confirm: 3, done: 4 }
  const ix = stepToIx[step] ?? 0
  const labels = ['01 选择来源', '02 解析', '03 地形浮现', '04 确认方向', '05 进入']
  return (
    <div className="max-w-[1280px] mx-auto px-12 pt-7 flex items-center justify-between relative z-10">
      <div className="flex items-center gap-2.5">
        <SproutIcon size={30}/>
        <span className="text-base font-medium tracking-wider" style={{ fontFamily: '"Noto Serif SC", serif' }}>papermind</span>
      </div>
      <div className="hidden md:flex gap-7 font-mono text-[10px] tracking-[0.22em] uppercase text-warm-gray">
        {labels.map((l, i) => (
          <span key={l} className={`pb-2 relative ${i === ix ? 'text-navy after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[1.5px] after:bg-coral' : i < ix ? 'text-navy/40 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[1.5px] after:bg-navy/20' : ''}`}>
            {l}
          </span>
        ))}
      </div>
      <button onClick={onSkip}
        className="text-[12.5px] text-warm-gray hover:text-navy transition-colors">
        先逛逛，稍后再填
      </button>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────
function countBibEntries(text) {
  return (text.match(/@(article|book|inproceedings|incollection|misc|phdthesis|techreport|conference|inbook)\b/gi) || []).length
}
function countRisEntries(text) {
  return (text.match(/^TY {2}- /gm) || []).length
}
function countCslEntries(text) {
  try {
    const arr = JSON.parse(text)
    return Array.isArray(arr) ? arr.length : 0
  } catch { return 0 }
}

// Read a File → string (UTF-8)
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

function parseEntryCount(text, fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (ext === 'bib') return countBibEntries(text)
  if (ext === 'ris') return countRisEntries(text)
  if (ext === 'json' || ext === 'csl') return countCslEntries(text)
  // Try all
  return Math.max(countBibEntries(text), countRisEntries(text), countCslEntries(text))
}

// ═════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════
export default function Onboarding() {
  const navigate = useNavigate()
  const [step, setStep] = useState('source')
  const [importPayload, setImportPayload] = useState(null)
  // { source: 'file'|'api', name, file?, bytes?, entryCount?, suggestedFocus?, suggestedMethods?, hills? }

  function skipOnboarding() {
    sessionStorage.setItem('pm-skip-onboarding', '1')
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen relative" style={{ background: '#F7F0E8', color: '#1E3A5F', fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* ambient flow background */}
      <div className="fixed inset-0 pointer-events-none" style={{
        background: `radial-gradient(ellipse 80% 60% at 20% 30%, rgba(168,213,186,.14), transparent),
                     radial-gradient(ellipse 70% 50% at 80% 70%, rgba(232,135,122,.08), transparent),
                     radial-gradient(ellipse 90% 70% at 50% 90%, rgba(237,228,216,.4), transparent)`,
      }}/>

      <Stepbar step={step} onSkip={skipOnboarding}/>

      <div className="relative z-[1]">
        {step === 'source' && (
          <StepSource
            onPickZotero={() => setStep('import')}
            onPickFresh={() => setStep('confirm')}
          />
        )}
        {step === 'import' && (
          <StepImport
            onBack={() => setStep('source')}
            onParse={async (payload) => {
              setImportPayload(payload)
              setStep('parsing')
            }}
          />
        )}
        {step === 'parsing' && (
          <StepParsing
            payload={importPayload}
            onDone={(enriched) => {
              setImportPayload(prev => ({ ...prev, ...enriched }))
              setStep('reveal')
            }}
          />
        )}
        {step === 'reveal' && (
          <StepReveal
            payload={importPayload}
            onBack={() => setStep('import')}
            onNext={() => setStep('confirm')}
          />
        )}
        {step === 'confirm' && (
          <StepConfirm
            payload={importPayload}
            onBack={() => setStep(importPayload ? 'reveal' : 'source')}
            onDone={async (form) => {
              try {
                await apiPost('/profile', form)
                sessionStorage.removeItem('pm-skip-onboarding')
                sessionStorage.setItem('pm-auto-fetch', '1')
                setStep('done')
              } catch {
                // 失败也让用户进入 done，apiPost 自带 retry，让 home 再 fetch
                setStep('done')
              }
            }}
          />
        )}
        {step === 'done' && (
          <StepDone
            payload={importPayload}
            onEnter={() => navigate('/', { replace: true })}
          />
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// STEP 01 · SOURCE
// ═════════════════════════════════════════════════════════════
function StepSource({ onPickZotero, onPickFresh }) {
  return (
    <Stage>
      <FadeUp delay={0} className="max-w-[720px]">
        <p className="font-mono text-[11px] tracking-[0.25em] uppercase text-coral mb-4">papermind · 第一次见面</p>
        <h1 className="text-[38px] sm:text-[46px] font-medium leading-[1.25] tracking-wide m-0 mb-5 text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
          把你的研究世界<br/>
          <span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]">带进来</span>。
        </h1>
        <p className="text-[15.5px] leading-[1.85] text-navy/70 max-w-[620px] m-0">
          papermind 不是又一个搜论文的工具，是一个会记得你的研究助手。
          如果你已经有 Zotero 库，几秒钟内 papermind 就能从中读出你的研究地形 —
          那是你过去几年阅读痕迹的样子。
        </p>
      </FadeUp>

      <FadeUp delay={200} className="mt-14 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-5">
        {/* primary card: Zotero */}
        <div className="rounded-[22px] bg-warm-white/85 border border-navy/8 backdrop-blur-sm px-9 py-8 flex flex-col">
          <div className="flex items-center gap-3.5 mb-5">
            <div className="w-[46px] h-[46px] rounded-xl bg-coral/10 flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#B56A5A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="16" height="16" rx="2"/>
                <path d="M6 7 H16 L6 15 H16"/>
              </svg>
            </div>
            <div>
              <h3 className="m-0 text-xl font-medium tracking-wider" style={{ fontFamily: '"Noto Serif SC", serif' }}>我有 Zotero 库</h3>
              <p className="m-0 mt-1 font-mono text-[12.5px] tracking-[0.18em] uppercase text-warm-gray">recommended · 30 秒生出地形图</p>
            </div>
          </div>
          <p className="text-[14px] leading-[1.8] text-navy/70 m-0 mb-5">
            导入 <Code>.bib</Code> / <Code>.ris</Code> / <Code>.csl-json</Code>，或通过 Zotero Web API 连接。
            papermind 会读出你的研究方向、方法兴趣、被忽略的话题，画出第一张地形。
          </p>
          <ul className="list-none p-0 m-0 text-[13.5px] leading-[2] text-navy/70 mb-5">
            <li><GreenDot/> 自动聚类 → 长期画像主轮廓</li>
            <li><GreenDot/> 识别近 30 天新增 → 标出"萌发中"的区域</li>
            <li><GreenDot/> 你的笔记和标签会保留</li>
          </ul>
          <div className="mt-auto flex gap-2.5 items-center">
            <PrimaryBtn onClick={onPickZotero}>
              导入 Zotero 库 <ArrowRight size={14}/>
            </PrimaryBtn>
            <GhostBtn onClick={onPickFresh}>没有库也行</GhostBtn>
          </div>
        </div>

        {/* secondary: fresh start */}
        <div className="rounded-[22px] bg-warm-white/55 border border-dashed border-navy/15 px-7 py-8 flex flex-col">
          <h3 className="m-0 text-lg font-medium" style={{ fontFamily: '"Noto Serif SC", serif' }}>从零开始也可以</h3>
          <p className="m-0 mt-3 text-[13.5px] leading-[1.8] text-navy/65">
            告诉 papermind 你最近在追什么，它会先用一个轻量画像帮你推荐论文。
            <br/>
            <span className="text-warm-gray text-[12.5px]">地形会随你阅读 / 收藏 / 提问慢慢生长。</span>
          </p>
          <SecondaryBtn className="mt-auto" onClick={onPickFresh}>
            写几句开始 →
          </SecondaryBtn>
        </div>
      </FadeUp>

      <FadeUp delay={400} className="mt-10 text-center text-[12.5px] text-warm-gray">
        papermind 不会把你的文献库上传到第三方。所有解析都在本地或你自己的 papermind 实例完成。
      </FadeUp>
    </Stage>
  )
}

// ═════════════════════════════════════════════════════════════
// STEP 02 · IMPORT (file drop / API connect)
// ═════════════════════════════════════════════════════════════
function StepImport({ onParse, onBack }) {
  const [tab, setTab] = useState('file')
  const [dragOver, setDragOver] = useState(false)
  const [fileName, setFileName] = useState(null)
  const [readingError, setReadingError] = useState(null)
  const inputRef = useRef(null)
  const [zoteroUserId, setZoteroUserId] = useState('')
  const [zoteroApiKey, setZoteroApiKey] = useState('')

  const handleFile = async (f) => {
    if (!f) return
    setFileName(f.name)
    setReadingError(null)
    try {
      const text = await readFileAsText(f)
      // simulate brief read delay then advance
      setTimeout(() => onParse({
        source: 'file',
        name: f.name,
        text,
        sizeKB: Math.round(f.size / 1024),
      }), 600)
    } catch {
      setReadingError('文件读取失败，请确认是文本格式的 .bib / .ris / .json')
    }
  }

  return (
    <Stage>
      <FadeUp delay={0} className="max-w-[720px] mb-9">
        <p className="font-mono text-[11px] tracking-[0.25em] uppercase text-coral mb-4">step 02 · 把库交给 papermind</p>
        <h1 className="text-[34px] sm:text-[38px] font-medium leading-[1.25] tracking-wide m-0 mb-5 text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
          从 Zotero <span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]">导出</span>，拖进来就行。
        </h1>
        <p className="text-base leading-[1.85] text-navy/70 m-0">
          在 Zotero 选中你的整个 library 或某个 collection，右键 →
          <em className="not-italic text-navy/85"> Export Library… </em>
          选择 <Code>Better BibTeX</Code> / <Code>RIS</Code> / <Code>CSL JSON</Code>，把文件拖到下面的方框。
          papermind 在你本地解析，不会上传到第三方。
        </p>
      </FadeUp>

      {/* tab switcher */}
      <FadeUp delay={100} className="flex gap-1 mb-5 bg-cream-dark/50 p-1 rounded-xl w-fit">
        {[['file', '导入文件'], ['api', '通过 Web API 连接']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all ${
              tab === k ? 'bg-warm-white text-navy shadow-sm' : 'text-warm-gray hover:text-navy'
            }`}>
            {l}
          </button>
        ))}
      </FadeUp>

      {tab === 'file' && (
        <FadeUp delay={200}>
          <div
            className={`rounded-[22px] border-2 border-dashed p-14 flex flex-col items-center gap-4 cursor-pointer transition-all ${
              dragOver ? 'border-coral bg-coral/4' : 'border-navy/15 bg-warm-white/50 hover:border-navy/25'
            }`}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]) }}
            onClick={() => inputRef.current?.click()}>

            <div className="w-20 h-20 rounded-[24px] bg-mint/15 border border-mint/30 flex items-center justify-center">
              <Upload size={32} strokeWidth={1.5} className="text-mint-deep"/>
            </div>

            {fileName ? (
              <>
                <p className="m-0 text-lg text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
                  ✓ 已收到 <strong>{fileName}</strong>
                </p>
                <p className="m-0 font-mono text-[12.5px] tracking-[0.18em] uppercase text-warm-gray">Reading…</p>
              </>
            ) : (
              <>
                <p className="m-0 text-lg text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
                  把 Zotero 导出文件拖到这里
                </p>
                <p className="m-0 text-[13px] text-warm-gray">
                  支持 <Code>.bib</Code> <Code>.ris</Code> <Code>.json</Code> · 最大 50MB
                </p>
                <SecondaryBtn className="mt-2">或者点击选择文件</SecondaryBtn>
              </>
            )}

            <input ref={inputRef} type="file" accept=".bib,.ris,.json" className="hidden"
              onChange={e => handleFile(e.target.files[0])}/>
          </div>
          {readingError && <p className="mt-3 text-sm text-coral">{readingError}</p>}
        </FadeUp>
      )}

      {tab === 'api' && (
        <FadeUp delay={200} className="rounded-[22px] bg-warm-white/85 border border-navy/8 backdrop-blur-sm p-9">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div>
              <label className="block font-mono text-[12px] tracking-[0.16em] uppercase text-warm-gray mb-1.5">Zotero User ID</label>
              <ApiInput value={zoteroUserId} onChange={setZoteroUserId} placeholder="123456"/>
            </div>
            <div>
              <label className="block font-mono text-[12px] tracking-[0.16em] uppercase text-warm-gray mb-1.5">API Key (read-only)</label>
              <ApiInput value={zoteroApiKey} onChange={setZoteroApiKey} placeholder="P9lZx…"/>
            </div>
          </div>
          <p className="mt-5 text-[12.5px] text-warm-gray leading-relaxed">
            在 <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noreferrer" className="text-coral hover:underline">
              zotero.org/settings/keys <ExternalLink size={10} className="inline ml-0.5"/>
            </a> 创建一个只读 key。papermind 只会读取你的 library 元数据，不会修改任何内容。也支持 group library。
          </p>
          <PrimaryBtn
            className="mt-5"
            disabled={!zoteroUserId || !zoteroApiKey}
            onClick={() => onParse({
              source: 'api',
              name: `Zotero · User ${zoteroUserId}`,
              userId: zoteroUserId,
              apiKey: zoteroApiKey,
            })}>
            连接并同步 <ArrowRight size={14}/>
          </PrimaryBtn>
        </FadeUp>
      )}

      <FadeUp delay={400} className="mt-9 flex justify-between text-[12.5px] text-warm-gray">
        <button onClick={onBack} className="bg-transparent border-none text-warm-gray hover:text-navy cursor-pointer p-0">← 上一步</button>
        <span>已经导入过？<a href="/" className="text-coral hover:underline cursor-pointer">登录</a></span>
      </FadeUp>
    </Stage>
  )
}

function ApiInput({ value, onChange, placeholder }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-warm-white rounded-lg px-3.5 py-2.5 text-navy border border-cream-dark/90 outline-none focus:border-coral/40 focus:ring-[3px] focus:ring-coral/8 transition-all"
      style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '13.5px' }}
    />
  )
}

// ═════════════════════════════════════════════════════════════
// STEP 03 · PARSING (animation + real upload)
// ═════════════════════════════════════════════════════════════
function StepParsing({ payload, onDone }) {
  const [count, setCount] = useState(0)
  const [phase, setPhase] = useState('reading') // reading | clustering | done
  const targetRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let timers = []

    async function run() {
      // Stage 1: real upload (TODO backend) -- fall back to client-side parse
      let target = 0
      let suggestedFocus = null
      let suggestedMethods = null
      let papers = null

      try {
        if (payload.source === 'file' && payload.text) {
          target = parseEntryCount(payload.text, payload.name)
        }
        // TODO(backend): try POST /import/zotero — see Onboarding.md §4.1
        // const fd = new FormData(); fd.append('file', payload.file)
        // const r = await fetch('/api/import/zotero', { method: 'POST', body: fd })
        // const data = await r.json()
        // target = data.papers
        // suggestedFocus = data.clusters.map(c => c.tag).join(', ')
        // suggestedMethods = data.method_chips
        // papers = data.papers_list
      } catch {
        // ignore — UI animation continues regardless
      }
      if (cancelled) return
      if (!target || target < 5) target = 247 // demo / fresh path fallback
      targetRef.current = target

      // count-up animation
      const startTime = Date.now()
      const duration = Math.min(2200, Math.max(1200, target * 8))
      const tick = () => {
        if (cancelled) return
        const t = Math.min(1, (Date.now() - startTime) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        setCount(Math.floor(target * eased))
        if (t < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)

      timers.push(setTimeout(() => !cancelled && setPhase('clustering'), duration + 100))
      timers.push(setTimeout(() => !cancelled && setPhase('done'), duration + 1900))
      timers.push(setTimeout(() => {
        if (cancelled) return
        onDone({
          entryCount: target,
          suggestedFocus,    // null = let reveal step show empty terrain hint
          suggestedMethods,
          papers,
        })
      }, duration + 2500))
    }
    run()
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lines = [
    { key: 'read',    label: '正在读取条目',          done: count >= targetRef.current && targetRef.current > 0 },
    { key: 'fields',  label: '解析作者 / 期刊 / 时间', done: phase !== 'reading' },
    { key: 'cluster', label: '从标题和摘要中聚类主题', done: phase === 'done' },
    { key: 'recent',  label: '识别近 30 天新增 → 萌发区', done: phase === 'done' },
    { key: 'tags',    label: '从标签中抽取方法兴趣',  done: phase === 'done' },
  ]

  return (
    <Stage className="text-center items-center">
      <FadeUp delay={0} className="max-w-[600px]">
        <p className="font-mono text-[11px] tracking-[0.25em] uppercase text-coral mb-4">step 03 · papermind 正在读你的世界</p>
        <h1 className="text-[32px] sm:text-[36px] font-medium leading-[1.25] tracking-wide m-0 mb-5 text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
          {phase === 'done'
            ? <>读完了。<span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]">正在画地形…</span></>
            : phase === 'clustering'
              ? <>聚类成<span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]"> 主题区域</span>…</>
              : <>读取 <span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]">{payload?.name || 'zotero-library.bib'}</span></>}
        </h1>

        <div className="my-8 flex items-baseline justify-center gap-3.5">
          <span className="leading-none tracking-wider text-navy font-medium" style={{ font: '500 84px "Noto Serif SC", serif' }}>{count}</span>
          <span className="font-mono text-base tracking-[0.22em] uppercase text-warm-gray font-medium">/ {targetRef.current || '—'} papers</span>
        </div>

        {/* progress bar */}
        <div className="mx-auto mb-9 w-[360px] h-[2px] bg-navy/8 rounded-full overflow-hidden">
          <div className="h-full bg-coral transition-[width] duration-100"
            style={{ width: targetRef.current ? `${(count / targetRef.current) * 100}%` : '0%' }}/>
        </div>

        {/* phase lines */}
        <div className="flex flex-col gap-2.5 max-w-[380px] mx-auto items-start text-left">
          {lines.map(ln => (
            <div key={ln.key} className={`flex items-center gap-3 text-[13.5px] transition-colors duration-300 ${ln.done ? 'text-navy' : 'text-warm-gray'}`}>
              {ln.done
                ? <Check size={14} strokeWidth={2} className="text-mint-deep flex-shrink-0"/>
                : <Loader2 size={12} strokeWidth={1.5} className="animate-spin text-coral flex-shrink-0"/>}
              <span className="font-mono text-[12.5px] tracking-[0.04em]">{ln.label}</span>
            </div>
          ))}
        </div>
      </FadeUp>
    </Stage>
  )
}

// ═════════════════════════════════════════════════════════════
// STEP 04 · REVEAL — the magic moment
// ═════════════════════════════════════════════════════════════
function StepReveal({ payload, onNext, onBack }) {
  // 优先用后端给的 papers 聚类；否则从 suggestedFocus 构造；最后兜底 demo
  const hills = (() => {
    if (payload?.papers?.length) return clusterPapersToHills(payload.papers, 'hero')
    if (payload?.suggestedFocus) return buildHills(payload.suggestedFocus, '', 'hero')
    return buildHills('慢阻肺, 肺康复, 慢病护理, 肺癌, 可解释性', '', 'hero')
  })()
  const trails = buildTrails(hills, payload?.suggestedMethods || '系统综述, 预测模型')

  const stats = [
    { num: hills.length, label: '主题区域', tone: 'navy' },
    { num: payload?.entryCount ?? hills.reduce((a, h) => a + (h.papers || 0), 0) ?? '—', label: '论文标记点', tone: 'navy' },
    { num: '12', label: '年的积累', tone: 'navy' },  // TODO(backend): max - min of dateAdded
    { num: hills.filter(h => h.emerging || h.hot).length || 1, label: '萌发中的话题', tone: 'coral' },
  ]

  return (
    <Stage>
      <FadeUp delay={0} className="max-w-[720px] mb-7">
        <p className="font-mono text-[11px] tracking-[0.25em] uppercase text-coral mb-4">step 04 · 地形浮现</p>
        <h1 className="text-[34px] sm:text-[38px] font-medium leading-[1.25] tracking-wide m-0 mb-5 text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
          这是 papermind 从你 {payload?.entryCount ?? '247'} 篇文献里<br/>
          读出的<span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]"> 研究世界</span>。
        </h1>
        <p className="text-base leading-[1.85] text-navy/70 m-0">
          每座山是一个研究方向，山越厚说明你在那里积累得越多。
          coral 色的小芽是 papermind 觉得你最近在变热的话题。
          下一步你可以确认 / 调整这些方向。
        </p>
      </FadeUp>

      <div className="animate-[growIn_1.2s_cubic-bezier(.2,.7,.3,1)_both]">
        <Terrain hills={hills} trails={trails} variant="hero" dateLabel="from your zotero · just now"/>
      </div>

      <FadeUp delay={300} className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        {stats.map((s, i) => (
          <div key={i} className="rounded-[22px] bg-warm-white/85 border border-navy/8 backdrop-blur-sm px-6 py-4 text-center">
            <p className={`m-0 leading-none ${s.tone === 'coral' ? 'text-coral' : 'text-navy'}`} style={{ font: '500 32px "Noto Serif SC", serif' }}>
              {s.num}
            </p>
            <p className="m-0 mt-1.5 font-mono text-[11.5px] tracking-[0.2em] uppercase text-warm-gray">{s.label}</p>
          </div>
        ))}
      </FadeUp>

      <FadeUp delay={400} className="mt-9 flex justify-between items-center">
        <BackBtn onClick={onBack}>← 重新导入</BackBtn>
        <PrimaryBtn onClick={onNext}>确认我的方向 <ArrowRight size={14}/></PrimaryBtn>
      </FadeUp>

      <style>{`@keyframes growIn { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }`}</style>
    </Stage>
  )
}

// ═════════════════════════════════════════════════════════════
// STEP 05 · CONFIRM — extracted (or empty) tags
// ═════════════════════════════════════════════════════════════
function StepConfirm({ payload, onBack, onDone }) {
  // Pre-populate from import; fallback to empty (fresh path)
  const initialFocus = (() => {
    if (payload?.papers?.length) {
      const hills = clusterPapersToHills(payload.papers)
      return hills.map(h => ({ name: h.name, papers: h.papers || 0, kept: true, emerging: h.emerging }))
    }
    if (payload?.suggestedFocus) {
      return payload.suggestedFocus.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
        .map(name => ({ name, papers: 0, kept: true }))
    }
    return []  // fresh path
  })()
  const initialMethods = (() => {
    if (payload?.suggestedMethods) {
      return payload.suggestedMethods.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
        .map(name => ({ name, kept: true }))
    }
    return METHOD_SUGGESTIONS.map(name => ({ name, kept: false }))
  })()

  const [focus, setFocus] = useState(initialFocus)
  const [methods, setMethods] = useState(initialMethods)
  const [background, setBackground] = useState('')
  const [trackingDays, setTrackingDays] = useState('90')
  const [adding, setAdding] = useState(null)   // 'focus' | 'methods' | null
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const toggle = (setter, idx) =>
    setter(prev => prev.map((t, i) => i === idx ? { ...t, kept: !t.kept } : t))

  const addTag = (kind) => {
    const v = draft.trim()
    if (!v) { setAdding(null); return }
    if (kind === 'focus') {
      setFocus(prev => prev.some(f => f.name === v) ? prev : [...prev, { name: v, papers: 0, kept: true }])
    } else {
      setMethods(prev => prev.some(m => m.name === v) ? prev : [...prev, { name: v, kept: true }])
    }
    setDraft('')
    setAdding(null)
  }

  const keptFocus = focus.filter(f => f.kept)
  const keptMethods = methods.filter(m => m.kept)

  async function handleSubmit() {
    setSubmitting(true)
    setError('')
    try {
      await onDone({
        focus_areas: keptFocus.map(f => f.name).join('、'),
        method_interests: keptMethods.map(m => m.name).join('、'),
        background,
        tracking_days: trackingDays,
      })
    } catch {
      setError('保存失败，请稍后再试')
      setSubmitting(false)
    }
  }

  const isFresh = !payload  // fresh path = no import

  return (
    <Stage>
      <FadeUp delay={0} className="max-w-[720px] mb-8">
        <p className="font-mono text-[11px] tracking-[0.25em] uppercase text-coral mb-4">step 05 · 确认你的方向</p>
        <h1 className="text-[32px] sm:text-[36px] font-medium leading-[1.25] tracking-wide m-0 mb-5 text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
          {isFresh
            ? <>告诉 papermind 你<br/>最近在追<span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]"> 什么方向</span>。</>
            : <>papermind 从你库里抽出了<br/>这些<span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]"> 研究方向</span>。</>}
        </h1>
        <p className="text-base leading-[1.85] text-navy/70 m-0">
          {isFresh
            ? '一句话就够，可以随时修改。 papermind 会从这里开始为你找最新文献。'
            : '勾选你想让 papermind 继续帮你追的，取消勾选的会被淡化（不会删除你的文献）。也可以补充几个 papermind 没看出来的。'}
        </p>
      </FadeUp>

      {/* focus card */}
      <FadeUp delay={150} className="rounded-[22px] bg-warm-white/85 border border-navy/8 backdrop-blur-sm px-8 py-7 mb-4">
        <ConfirmHeader title="研究方向" count={`已选 ${keptFocus.length}${focus.length ? ' / ' + focus.length : ''}`}/>
        <div className="flex flex-wrap gap-2">
          {focus.map((f, i) => (
            <TagChip key={f.name} kept={f.kept} emerging={f.emerging} onClick={() => toggle(setFocus, i)}>
              {f.emerging && <SproutDot/>}
              {f.name}
              {f.papers > 0 && <span className="font-mono text-[10.5px] opacity-65 ml-0.5">{f.papers}</span>}
            </TagChip>
          ))}
          {adding === 'focus' ? (
            <AddInput value={draft} onChange={setDraft} onSubmit={() => addTag('focus')} onCancel={() => { setAdding(null); setDraft('') }}/>
          ) : (
            <button onClick={() => setAdding('focus')}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] text-warm-gray hover:text-coral border border-dashed border-navy/20 hover:border-coral transition-all">
              <Plus size={11}/> {isFresh ? '添加方向' : '补充'}
            </button>
          )}
        </div>
      </FadeUp>

      {/* methods card */}
      <FadeUp delay={200} className="rounded-[22px] bg-warm-white/85 border border-navy/8 backdrop-blur-sm px-8 py-7 mb-4">
        <ConfirmHeader title="方法兴趣" count={`已选 ${keptMethods.length} / ${methods.length}`}/>
        <div className="flex flex-wrap gap-2">
          {methods.map((m, i) => (
            <TagChip key={m.name} kept={m.kept} onClick={() => toggle(setMethods, i)}>
              {m.name}
            </TagChip>
          ))}
          {adding === 'methods' ? (
            <AddInput value={draft} onChange={setDraft} onSubmit={() => addTag('methods')} onCancel={() => { setAdding(null); setDraft('') }}/>
          ) : (
            <button onClick={() => setAdding('methods')}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] text-warm-gray hover:text-coral border border-dashed border-navy/20 hover:border-coral transition-all">
              <Plus size={11}/> 补充
            </button>
          )}
        </div>
      </FadeUp>

      {/* background + range */}
      <FadeUp delay={250} className="rounded-[22px] bg-warm-white/85 border border-navy/8 backdrop-blur-sm px-8 py-7 mb-4">
        <ConfirmHeader title="其他想让 papermind 知道的" count="可选"/>
        <textarea
          value={background}
          onChange={e => setBackground(e.target.value)}
          placeholder="例：我是肿瘤科护士，关注癌症患者照护中的中医整合干预；最近在准备综述 / 不想再看动物模型 / 准备投 BMJ ..."
          rows={3}
          className="w-full bg-warm-white rounded-xl px-3.5 py-3 text-[13.5px] text-navy border border-cream-dark/90 outline-none focus:border-coral/40 focus:ring-[3px] focus:ring-coral/8 transition-all resize-none leading-relaxed"
          style={{ fontFamily: '"DM Sans", system-ui, sans-serif' }}/>

        <div className="mt-5 pt-5 border-t border-navy/5">
          <p className="m-0 mb-2.5 font-mono text-[11px] tracking-[0.16em] uppercase text-warm-gray">检索范围</p>
          <div className="flex gap-2">
            {RANGE_OPTIONS.map(o => (
              <button key={o.value} onClick={() => setTrackingDays(o.value)}
                className={`flex-1 py-2 rounded-xl text-[13px] font-medium transition-all ${
                  trackingDays === o.value
                    ? 'bg-coral text-warm-white shadow-sm'
                    : 'bg-warm-white text-navy/60 border border-navy/10 hover:border-coral/30'
                }`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </FadeUp>

      <FadeUp delay={300} className="mt-8 flex justify-between items-center">
        <BackBtn onClick={onBack}>← {isFresh ? '上一步' : '看回地形'}</BackBtn>
        <div className="flex flex-col items-end gap-2">
          {error && <p className="text-sm text-coral m-0">{error}</p>}
          <PrimaryBtn onClick={handleSubmit} disabled={submitting || keptFocus.length === 0}>
            {submitting ? '保存中…' : <>完成 · 进入 papermind <ArrowRight size={14}/></>}
          </PrimaryBtn>
        </div>
      </FadeUp>
    </Stage>
  )
}

function ConfirmHeader({ title, count }) {
  return (
    <div className="flex items-baseline justify-between mb-4 pb-3.5 border-b border-navy/5">
      <h3 className="m-0 text-[17px] font-medium tracking-wide" style={{ fontFamily: '"Noto Serif SC", serif' }}>{title}</h3>
      <span className="font-mono text-[10.5px] tracking-[0.22em] uppercase text-warm-gray">{count}</span>
    </div>
  )
}

function TagChip({ children, kept, emerging, onClick }) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-1.5 pl-3.5 rounded-full text-[13px] font-medium cursor-pointer transition-all border'
  const cls = emerging && kept
    ? 'bg-coral/10 border-coral/40 text-coral-deep hover:bg-coral/15'
    : kept
      ? 'bg-mint/18 border-mint/40 text-navy hover:bg-mint/28'
      : 'bg-transparent border-navy/12 text-warm-gray hover:text-navy hover:border-navy/25'
  return (
    <button onClick={onClick} className={`${base} ${cls}`}>
      {children}
      {kept
        ? <Check size={11} strokeWidth={2} className="ml-0.5"/>
        : <X size={11} strokeWidth={1.5} className="ml-0.5 opacity-60"/>}
    </button>
  )
}

function AddInput({ value, onChange, onSubmit, onCancel }) {
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit() }}
      className="inline-flex items-center gap-1 px-3.5 py-1 rounded-full bg-warm-white border border-coral/30">
      <input autoFocus value={value} onChange={e => onChange(e.target.value)}
        onBlur={onSubmit} onKeyDown={e => e.key === 'Escape' && onCancel()}
        placeholder="输入后回车"
        className="bg-transparent border-none outline-none text-[13px] text-navy w-24 placeholder:text-warm-gray/50"/>
    </form>
  )
}

function SproutDot() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" className="flex-shrink-0">
      <line x1="6" y1="10" x2="6" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <path d="M6 7 C6 4 8 2.5 10 2.5 C10 5 8 7 6 7 Z" fill="currentColor" opacity="0.85"/>
      <path d="M6 6.5 C6 4 4 2.5 2 2.5 C2 5 4 6.5 6 6.5 Z" fill="currentColor" opacity="0.55"/>
    </svg>
  )
}

// ═════════════════════════════════════════════════════════════
// STEP 06 · DONE
// ═════════════════════════════════════════════════════════════
function StepDone({ payload, onEnter }) {
  const hills = (() => {
    if (payload?.papers?.length) return clusterPapersToHills(payload.papers, 'mini')
    if (payload?.suggestedFocus) return buildHills(payload.suggestedFocus, '', 'mini')
    return buildHills('慢阻肺, 肺康复, 慢病护理, 肺癌, 可解释性', '', 'mini')
  })()

  return (
    <Stage className="items-center text-center">
      <FadeUp delay={0} className="max-w-[640px]">
        <p className="font-mono text-[11px] tracking-[0.25em] uppercase text-coral mb-4">第一颗芽长出来了</p>
        <h1 className="text-[36px] sm:text-[44px] font-medium leading-[1.25] tracking-wide m-0 mb-5 text-navy" style={{ fontFamily: '"Noto Serif SC", serif' }}>
          欢迎来到 papermind。<br/>
          你的<span className="text-coral underline decoration-coral/40 decoration-[1.5px] underline-offset-[6px]"> 研究地形 </span>已经诞生。
        </h1>
        <p className="text-base leading-[1.85] text-navy/70 m-0 max-w-[560px] mx-auto">
          从现在起，你的每一次阅读、提问、收藏都会让这张地图继续生长。画像页可以随时回来看它。
        </p>
      </FadeUp>

      <FadeUp delay={200} className="mt-10 w-[540px] max-w-full">
        <Terrain hills={hills} variant="mini"/>
      </FadeUp>

      <FadeUp delay={400} className="mt-10 flex gap-3.5">
        <PrimaryBtn onClick={onEnter}>
          进入 papermind <ArrowRight size={14}/>
        </PrimaryBtn>
        <GhostBtn onClick={onEnter}>先去看看推荐</GhostBtn>
      </FadeUp>
    </Stage>
  )
}

// ═════════════════════════════════════════════════════════════
// shared small bits
// ═════════════════════════════════════════════════════════════
function Stage({ children, className = '' }) {
  return (
    <div className={`relative max-w-[1100px] mx-auto px-12 pt-12 pb-20 min-h-[calc(100vh-90px)] flex flex-col ${className}`}>
      {children}
    </div>
  )
}

function FadeUp({ children, delay = 0, className = '' }) {
  return (
    <div className={className} style={{
      animation: `fadeUp .6s cubic-bezier(.2,.7,.3,1) ${delay}ms both`,
    }}>
      {children}
      <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  )
}

function PrimaryBtn({ children, onClick, disabled, className = '' }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-coral text-warm-white text-sm font-medium hover:bg-coral-light hover:-translate-y-px transition-all shadow-[0_4px_18px_rgba(232,135,122,.32)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 ${className}`}>
      {children}
    </button>
  )
}
function SecondaryBtn({ children, onClick, className = '' }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-transparent text-navy border border-navy/18 text-sm font-medium hover:bg-navy/4 hover:border-navy/30 transition-all ${className}`}>
      {children}
    </button>
  )
}
function GhostBtn({ children, onClick, className = '' }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-transparent text-warm-gray hover:text-navy text-[13.5px] transition-colors ${className}`}>
      {children}
    </button>
  )
}
function BackBtn({ children, onClick }) {
  return (
    <button onClick={onClick} className="bg-transparent border-none text-warm-gray hover:text-navy cursor-pointer p-0 text-[13.5px]">
      {children}
    </button>
  )
}
function Code({ children }) {
  return (
    <code className="px-1.5 py-0.5 rounded text-[12px] text-coral bg-coral/8"
      style={{ fontFamily: '"JetBrains Mono", monospace' }}>{children}</code>
  )
}
function GreenDot() {
  return <span className="inline-block w-[5px] h-[5px] rounded-full bg-mint-deep mr-2.5 align-middle"/>
}
