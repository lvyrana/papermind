import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowRight, ChevronLeft, X, Sprout } from 'lucide-react'
import { apiPost } from '../api'

const METHOD_CHIPS = ['RCT', '系统综述', '质性研究', 'Meta 分析', '观察性研究']
const RANGE_OPTIONS = [
  { label: '近 1 个月', value: '30' },
  { label: '近 3 个月', value: '90' },
  { label: '近 6 个月', value: '180' },
]

export default function Onboarding() {
  const navigate = useNavigate()
  const location = useLocation()
  const [step, setStep] = useState(location.state?.intro ? 0 : 1)
  const [dir, setDir] = useState(1)
  const [focusAreas, setFocusAreas] = useState('')
  const [selectedMethods, setSelectedMethods] = useState([])
  const [customMethod, setCustomMethod] = useState('')
  const [background, setBackground] = useState('')
  const [trackingDays, setTrackingDays] = useState('90')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function goNext() { setDir(1); setStep(s => s + 1) }
  function goBack() { setDir(-1); setStep(s => s - 1) }

  function skipOnboarding() {
    sessionStorage.setItem('pm-skip-onboarding', '1')
    navigate('/', { replace: true })
  }

  function toggleMethod(chip) {
    setSelectedMethods(prev =>
      prev.includes(chip) ? prev.filter(c => c !== chip) : [...prev, chip]
    )
  }

  function addCustom(e) {
    if (e) e.preventDefault()
    const trimmed = customMethod.trim()
    if (trimmed && !selectedMethods.includes(trimmed)) {
      setSelectedMethods(prev => [...prev, trimmed])
    }
    setCustomMethod('')
  }

  async function handleSubmit() {
    setLoading(true)
    setError('')
    try {
      await apiPost('/profile', {
        focus_areas: focusAreas,
        method_interests: selectedMethods.join('、'),
        background,
        tracking_days: trackingDays,
      })
      sessionStorage.removeItem('pm-skip-onboarding')
      sessionStorage.setItem('pm-auto-fetch', '1')
      navigate('/', { replace: true })
    } catch {
      setError('保存失败，请稍后再试')
      setLoading(false)
    }
  }

  const slideClass = dir > 0 ? 'onb-slide-right' : 'onb-slide-left'

  // ── Step 0: Intro ──────────────────────────────────────────────────────────
  const now = new Date()
  const days = ['日', '一', '二', '三', '四', '五', '六']
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 · 星期${days[now.getDay()]}`

  if (step === 0) {
    return (
      <div className="min-h-screen bg-flowing">
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 20px 40px' }}>

          {/* 问候 */}
          <div style={{ marginBottom: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 10, color: '#8E8A85', letterSpacing: '.22em', textTransform: 'uppercase', marginBottom: 12, fontFamily: 'monospace' }}>
              {dateLabel}
            </p>
            <h1 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 32, fontWeight: 500, color: '#1E3A5F', margin: '0 0 12px', letterSpacing: 1, lineHeight: 1.4 }}>
              你好，还不认识你呢
            </h1>
            <p style={{ fontSize: 15, color: '#8E8A85', margin: 0, lineHeight: 1.8 }}>
              告诉我你在研究什么，我就能开始为你找论文
            </p>
          </div>

          {/* 引导卡片 */}
          <div style={{
            background: 'rgba(255,253,249,.82)',
            border: '1px solid rgba(237,228,216,.7)',
            borderRadius: 24,
            backdropFilter: 'blur(8px)',
            padding: '36px 40px',
            textAlign: 'center',
            marginBottom: 20,
          }}>
            {/* Papermind icon */}
            <div style={{
              width: 52, height: 52, borderRadius: 16,
              background: 'rgba(255,253,249,.9)',
              border: '1px solid rgba(237,228,216,.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="30" height="30" viewBox="0 0 64 64">
                <line x1="32" y1="50" x2="32" y2="27" stroke="#1E3A5F" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M32 33C32 25 38 20 44 19c0 8-6 13-12 14z" fill="#1E3A5F" opacity=".85" />
                <path d="M32 28C32 21 26 17 20 17c0 7 6 11 12 11z" fill="#A8D5BA" opacity=".9" />
                <path d="M26 48c0 0 2-3 6-4 4 1 6 4 6 4" stroke="#E8877A" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              </svg>
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#1E3A5F', margin: '0 0 8px', fontFamily: "'DM Sans', system-ui" }}>
              开始你的第一次检索
            </h2>
            <p style={{ fontSize: 13.5, color: '#8E8A85', margin: '0 auto 28px', lineHeight: 1.8, maxWidth: 380 }}>
              填写研究方向，系统会生成专属检索词，<br />从 PubMed 为你找最新论文。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <button
                onClick={goNext}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '14px 32px', borderRadius: 14, border: 'none',
                  background: '#E8877A', color: '#FFFDF9',
                  fontSize: 15, fontWeight: 500, cursor: 'pointer',
                  fontFamily: "'DM Sans', system-ui",
                  boxShadow: '0 3px 14px rgba(232,135,122,.3)',
                  transition: 'all .18s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#F0A89E'}
                onMouseLeave={e => e.currentTarget.style.background = '#E8877A'}
              >
                告诉我你在研究什么 →
              </button>
              <button
                onClick={skipOnboarding}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', borderRadius: 10,
                  border: '1px solid rgba(237,228,216,.9)', background: 'none',
                  color: '#8E8A85', fontSize: 12, cursor: 'pointer',
                  fontFamily: "'DM Sans', system-ui", transition: 'all .15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#1E3A5F'; e.currentTarget.style.borderColor = 'rgba(30,58,95,.2)' }}
                onMouseLeave={e => { e.currentTarget.style.color = '#8E8A85'; e.currentTarget.style.borderColor = 'rgba(237,228,216,.9)' }}
              >
                先逛逛，稍后再填
              </button>
            </div>
          </div>

          {/* 功能提示三条 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 8 }}>
            {[
              { color: '#E8877A', title: '理解你', desc: '记住你的方向与偏好，越用越懂你' },
              { color: '#A8D5BA', title: '精准推荐', desc: 'AI 生成检索词，自动拉取最新文献' },
              { color: '#8E8A85', title: '越积越厚', desc: '收藏、笔记、对话都沉淀为你的研究资产' },
            ].map(({ color, title, desc }) => (
              <div key={title} style={{
                background: 'rgba(255,253,249,.5)',
                border: '1px solid rgba(237,228,216,.5)',
                borderRadius: 16,
                padding: '18px 20px',
              }}>
                <p style={{ fontSize: 11, color, fontWeight: 500, margin: '0 0 6px' }}>{title}</p>
                <p style={{ fontSize: 12.5, color: '#8E8A85', margin: 0, lineHeight: 1.7 }}>{desc}</p>
              </div>
            ))}
          </div>

        </div>
      </div>
    )
  }

  // ── Steps 1–3: Wizard ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-flowing flex flex-col items-center px-6 pt-14 pb-24 lg:justify-center lg:pt-0 lg:pb-0 lg:px-8">
      <div className="w-full max-w-md lg:max-w-lg lg:bg-warm-white/50 lg:border lg:border-navy/5 lg:shadow-[0_8px_40px_rgba(30,58,95,0.07)] lg:rounded-[32px] lg:px-12 lg:py-12">

        {/* Header: back + progress dots */}
        <div className="flex items-center justify-between mb-10">
          <button
            onClick={goBack}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-navy/5 transition-colors"
          >
            <ChevronLeft size={20} className="text-navy/50" />
          </button>
          <div className="flex items-center gap-2">
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === step ? 'w-6 bg-coral' : i < step ? 'w-4 bg-coral/30' : 'w-4 bg-navy/10'
                }`}
              />
            ))}
          </div>
          <div className="w-9" />
        </div>

        {/* Animated step content */}
        <div key={step} className={slideClass}>

          {step === 1 && (
            <div>
              <h2 className="text-2xl font-serif text-navy mb-1.5">你在研究什么？</h2>
              <p className="text-sm text-warm-gray/65 mb-6">一句话就够，可以随时修改</p>
              <textarea
                value={focusAreas}
                onChange={e => setFocusAreas(e.target.value)}
                placeholder="例：肺癌护理 / 中医干预 / 慢病管理"
                rows={3}
                autoFocus
                className="w-full px-4 py-3.5 rounded-2xl bg-warm-white/70 border border-navy/10 text-navy text-sm placeholder-warm-gray/40 resize-none focus:outline-none focus:border-coral/40 focus:ring-1 focus:ring-coral/20 transition"
              />
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-2xl font-serif text-navy mb-1.5">有没有特别感兴趣的方法？</h2>
              <p className="text-sm text-warm-gray/65 mb-6">可多选，也可以直接跳过</p>
              <div className="flex flex-wrap gap-2 mb-4">
                {METHOD_CHIPS.map(chip => (
                  <button
                    key={chip}
                    onClick={() => toggleMethod(chip)}
                    className={`px-3.5 py-1.5 rounded-full text-sm transition-all ${
                      selectedMethods.includes(chip)
                        ? 'bg-coral text-warm-white shadow-sm'
                        : 'bg-warm-white/70 text-navy/65 border border-navy/10 hover:border-coral/30'
                    }`}
                  >
                    {chip}
                  </button>
                ))}
              </div>
              {selectedMethods.filter(m => !METHOD_CHIPS.includes(m)).length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {selectedMethods
                    .filter(m => !METHOD_CHIPS.includes(m))
                    .map(m => (
                      <div key={m} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-coral/10 text-coral text-sm">
                        {m}
                        <button onClick={() => toggleMethod(m)} className="ml-0.5 hover:opacity-70">
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                </div>
              )}
              <form onSubmit={addCustom} className="flex gap-2 mt-2">
                <input
                  value={customMethod}
                  onChange={e => setCustomMethod(e.target.value)}
                  placeholder="+ 其他方法"
                  className="flex-1 px-4 py-2.5 rounded-full bg-warm-white/70 border border-navy/10 text-sm text-navy placeholder-warm-gray/40 focus:outline-none focus:border-coral/40 transition"
                />
                <button type="submit" className="px-4 py-2 rounded-full bg-navy/5 text-navy/55 text-sm hover:bg-navy/10 transition">
                  添加
                </button>
              </form>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-2xl font-serif text-navy mb-1.5">还有什么想说的？</h2>
              <p className="text-sm text-warm-gray/65 mb-6">可以跳过，之后也能随时补充</p>
              <textarea
                value={background}
                onChange={e => setBackground(e.target.value)}
                placeholder="例：我是一名肿瘤科护士，关注癌症患者照护中的中医整合干预，重点看 RCT 和系统综述，希望找到有临床实践价值的证据。"
                rows={4}
                autoFocus
                className="w-full px-4 py-3.5 rounded-2xl bg-warm-white/70 border border-navy/10 text-navy text-sm placeholder-warm-gray/40 resize-none focus:outline-none focus:border-coral/40 focus:ring-1 focus:ring-coral/20 transition mb-6"
              />
              <div>
                <p className="text-xs text-warm-gray/65 mb-2.5">检索范围</p>
                <div className="flex gap-2">
                  {RANGE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setTrackingDays(opt.value)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        trackingDays === opt.value
                          ? 'bg-coral text-warm-white shadow-sm'
                          : 'bg-warm-white/70 text-navy/60 border border-navy/10 hover:border-coral/30'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="mt-8 space-y-3">
          {step < 3 ? (
            <>
              <button
                onClick={goNext}
                className="w-full py-3.5 rounded-full bg-coral text-warm-white text-sm font-semibold hover:bg-coral-light transition-colors shadow-[0_4px_16px_rgba(232,135,122,0.35)] flex items-center justify-center gap-2"
              >
                下一步 <ArrowRight size={16} />
              </button>
              <button onClick={goNext} className="w-full py-2 text-sm text-warm-gray/55 hover:text-warm-gray transition-colors">
                跳过这一步
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="w-full py-3.5 rounded-full bg-coral text-warm-white text-sm font-semibold hover:bg-coral-light transition-colors shadow-[0_4px_16px_rgba(232,135,122,0.35)] disabled:opacity-60"
              >
                {loading ? '保存中…' : '开始检索 →'}
              </button>
              {error && <p className="text-sm text-coral text-center">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
