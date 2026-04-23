import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Mic, RefreshCw, Save, Sparkles, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { apiGet, apiPost } from '../api'

const BROAD_EXCLUDE_TERMS = ['研究', '文章', '论文', '综述', '文献', '期刊', '论著', '报告', '资料']

function detectBroadTerms(exclude_areas) {
  if (!exclude_areas) return []
  const tags = exclude_areas.split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean)
  return tags.filter(tag => BROAD_EXCLUDE_TERMS.includes(tag))
}

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

const RANGE_OPTIONS = [
  { label: '近 1 个月', value: '30' },
  { label: '近 3 个月', value: '90' },
  { label: '近 6 个月', value: '180' },
]

export default function Profile() {
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [broadWarn, setBroadWarn] = useState('')
  const [mergeLoading, setMergeLoading] = useState(false)

  useEffect(() => {
    apiGet('/profile')
      .then(data => setProfile(prev => ({ ...prev, ...data, tracking_days: data.tracking_days || '90' })))
      .catch(() => {})
  }, [])

  const patchProfile = (partial) => {
    setProfile(prev => ({ ...prev, ...partial }))
    setSaved(false)
    setSaveError('')
  }

  const handleSave = async () => {
    const broad = detectBroadTerms(profile.exclude_areas)
    if (broad.length > 0) {
      setBroadWarn(`「${broad.join('、')}」可能过于宽泛，会过滤掉大量文献。建议改为具体类型，如「动物实验」「基础研究」`)
      setTimeout(() => setBroadWarn(''), 5000)
    }
    try {
      await apiPost('/profile', profile)
      setSaveError('')
    } catch {
      setSaved(false)
      setSaveError('保存失败，请稍后再试')
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)

    // 后台触发记忆更新，不阻塞保存反馈
    apiPost('/profile/memory-recent', {})
      .then(() => apiGet('/profile'))
      .then(latest => setProfile(prev => ({ ...prev, ...latest })))
      .catch(() => {})
  }

  const handleMergeToCore = async () => {
    setMergeLoading(true)
    setSaveError('')
    try {
      const result = await apiPost('/profile/merge-to-core', {})
      if (result?.core !== undefined) {
        setProfile(prev => ({ ...prev, memory_core: result.core, memory_recent: '', last_recent_updated_at: '' }))
      } else {
        const latest = await apiGet('/profile')
        setProfile(prev => ({ ...prev, ...latest }))
      }
    } catch {
      setSaveError('更新长期画像失败，请稍后再试')
    } finally {
      setMergeLoading(false)
    }
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-14 pb-10 max-w-3xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <div className="bg-warm-white/85 backdrop-blur-sm border border-cream-dark/60 rounded-[28px] p-6 shadow-sm">
          <h1 className="text-3xl font-bold text-navy font-serif leading-snug">我的研究画像</h1>
          <p className="text-warm-gray mt-4 leading-relaxed text-sm max-w-2xl">
            标记你关注的方向与近期需求，系统会逐步理解你的研究偏好。
          </p>
          <div className="grid grid-cols-2 gap-3 mt-5">
            <div className="rounded-2xl border border-cream-dark/60 bg-cream/60 px-4 py-3">
              <p className="text-xs text-warm-gray/60 mb-1">研究方向</p>
              <div className="flex flex-wrap gap-1 mb-2">
                {splitTags(profile.focus_areas).length > 0 ? (
                  splitTags(profile.focus_areas).map(tag => (
                    <span key={tag} className="px-2 py-0.5 rounded-full bg-navy/10 text-navy/70 text-xs font-medium">
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-warm-gray/40">未设置</span>
                )}
              </div>
              <p className="text-xs text-warm-gray/60 mb-1">方法兴趣</p>
              <div className="flex flex-wrap gap-1">
                {splitTags(profile.method_interests).length > 0 ? (
                  splitTags(profile.method_interests).map(tag => (
                    <span key={tag} className="px-2 py-0.5 rounded-full bg-navy/8 text-navy/60 text-xs">
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-warm-gray/40">未设置</span>
                )}
              </div>
            </div>
            <HeaderRangePicker
              value={profile.tracking_days}
              onChange={value => patchProfile({ tracking_days: value })}
            />
          </div>
        </div>
      </header>

      <main className="px-6 max-w-3xl mx-auto space-y-6">
        <SectionCard title="研究偏好">
          <TagInput
            label="研究方向"
            value={profile.focus_areas}
            onChange={value => patchProfile({ focus_areas: value })}
            placeholder="例如：肺癌、中医护理、慢病管理、术后康复"
          />
          <TagInput
            label="方法兴趣"
            hint="会和研究方向一起生成检索词"
            value={profile.method_interests}
            onChange={value => patchProfile({ method_interests: value })}
            placeholder="例如：系统综述、随机对照试验、质性研究、Meta分析"
          />
          <VoiceTextarea
            label="自由描述"
            value={profile.background}
            onChange={val => patchProfile({ background: val })}
            placeholder="不知道怎么描述？用日常的话说就行，AI 会理解你的意思并生成检索词——比如：我想看带状疱疹相关的中医干预类文章"
          />
          <TagInput
            label="不想看的内容"
            value={profile.exclude_areas}
            onChange={value => patchProfile({ exclude_areas: value })}
            placeholder="例如：基础实验研究、动物模型、药物合成、纯分子机制"
          />
          <TagInput
            label="学科领域"
            value={profile.discipline}
            onChange={value => patchProfile({ discipline: value })}
            placeholder="例如：护理学、公共卫生、心理学、康复医学、老年医学"
          />
        </SectionCard>

        <SectionCard
          title="系统观察摘要"
          description="由系统根据你的收藏与对话行为自动归纳，作为上下文背景让 AI 更贴近你的研究脉络。"
        >
          <MemoryBlock
            title="长期画像"
            content={profile.memory_core}
            updatedAt={profile.last_core_merged_at}
            emptyText="保存画像后自动生成。"
            badge={formatCoreSource(profile.core_source)}
          />
          <MemoryBlock
            title="近期变化"
            content={profile.memory_recent}
            updatedAt={profile.last_recent_updated_at}
            emptyText="使用一段时间后自动补充。"
          />
          {profile.memory_recent ? (
            <button
              type="button"
              onClick={handleMergeToCore}
              disabled={mergeLoading}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs transition-all duration-200 ${
                mergeLoading
                  ? 'bg-cream-dark/50 text-warm-gray/60 cursor-not-allowed'
                  : 'text-warm-gray/70 border border-cream-dark hover:border-navy/20 hover:text-navy'
              }`}
            >
              <RefreshCw size={12} className={mergeLoading ? 'animate-spin' : ''} />
              吸收到长期画像
            </button>
          ) : null}
        </SectionCard>

        <button
          onClick={handleSave}
          className={`w-full py-4 rounded-2xl font-medium text-sm transition-all duration-300 flex items-center justify-center gap-2 ${
            saved
              ? 'bg-mint/20 text-navy'
              : 'bg-coral text-warm-white hover:bg-coral-light shadow-sm'
          }`}
        >
          {saved ? (
            <>
              <Sparkles size={16} />
              已保存，将按更新后的画像重新推荐
            </>
          ) : (
            <>
              <Save size={16} />
              保存画像
            </>
          )}
        </button>
        {saveError && (
          <p className="text-sm text-coral text-center -mt-2">{saveError}</p>
        )}
        {saved && (
          <Link
            to="/"
            className="flex items-center justify-center gap-1.5 w-full py-3 rounded-2xl border border-coral/30 text-coral text-sm font-medium hover:bg-coral/5 transition-colors -mt-2"
          >
            去首页看推荐 →
          </Link>
        )}
      </main>

      {broadWarn && (
        <div className="fixed bottom-24 left-4 right-4 z-50 max-w-lg mx-auto">
          <div className="bg-[#7C5A2A] text-[#FFF8EE] text-xs px-4 py-3 rounded-2xl shadow-lg leading-relaxed">
            ⚠️ {broadWarn}
          </div>
        </div>
      )}

      <Navbar />
    </div>
  )
}

function SectionCard({ eyebrow, title, description, children }) {
  return (
    <section className="bg-warm-white/82 backdrop-blur-sm border border-cream-dark/60 rounded-[28px] p-6 shadow-sm space-y-7">
      <div>
        {eyebrow && <p className="text-[11px] uppercase tracking-[0.24em] text-warm-gray/65 mb-3">{eyebrow}</p>}
        <h2 className="text-[22px] font-semibold text-navy font-serif leading-snug">{title}</h2>
        {description && <p className="text-sm text-warm-gray mt-3 leading-relaxed">{description}</p>}
      </div>
      {children}
    </section>
  )
}


function ProfileField({ label, hint, value, onChange, placeholder, multiline = false }) {
  const inputClass = 'w-full bg-warm-white rounded-2xl px-4 py-3 text-sm text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200 placeholder:text-warm-gray/50'

  return (
    <div>
      <label className="text-sm font-medium text-navy/75 mb-2 block">{label}</label>
      {hint && <p className="text-xs text-warm-gray mb-3">{hint}</p>}
      {multiline ? (
        <textarea
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          rows={4}
          className={`${inputClass} resize-none leading-7`}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className={inputClass}
        />
      )}
    </div>
  )
}

function TagInput({ label, hint, value, onChange, placeholder }) {
  const [input, setInput] = useState('')
  const tags = splitTags(value)

  const addTag = () => {
    const tag = input.trim()
    if (!tag || tags.includes(tag)) {
      setInput('')
      return
    }
    onChange([...tags, tag].join(', '))
    setInput('')
  }

  const removeTag = (tag) => {
    onChange(tags.filter(item => item !== tag).join(', '))
  }

  return (
    <div>
      <label className="text-sm font-medium text-navy/75 mb-2 block">{label}</label>
      {hint && <p className="text-xs text-warm-gray mb-3">{hint}</p>}
      <div className="flex flex-wrap gap-2 mb-3">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-cream-dark/55 text-navy text-xs">
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-warm-gray hover:text-coral transition-colors"
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === '，' || e.key === ',') {
            e.preventDefault()
            addTag()
          }
        }}
        onBlur={addTag}
        placeholder={placeholder}
        className="w-full bg-warm-white rounded-2xl px-4 py-3 text-sm text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200 placeholder:text-warm-gray/50"
      />
    </div>
  )
}

function RangePicker({ value, onChange }) {
  const presetValues = RANGE_OPTIONS.map(option => option.value)
  const isCustom = value && !presetValues.includes(value)
  const [customMonths, setCustomMonths] = useState(() => {
    if (isCustom) return String(Math.max(1, Math.round(Number(value) / 30)))
    return '12'
  })

  return (
    <div>
      <label className="text-sm font-medium text-navy mb-2 block">时间范围</label>
      <div className="flex flex-wrap gap-2">
        {RANGE_OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`px-4 py-2 rounded-full text-sm transition-all duration-200 ${
              value === option.value
                ? 'bg-navy/90 text-warm-white shadow-sm'
                : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
            }`}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const months = Math.max(1, Number(customMonths) || 12)
            setCustomMonths(String(months))
            onChange(String(months * 30))
          }}
          className={`px-4 py-2 rounded-full text-sm transition-all duration-200 ${
            isCustom
              ? 'bg-navy/90 text-warm-white shadow-sm'
              : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
          }`}
        >
          自定义
        </button>
      </div>
      {isCustom && (
        <div className="mt-3 flex items-center gap-3">
          <input
            type="number"
            min="1"
            max="24"
            value={customMonths}
            onChange={e => {
              const next = e.target.value
              setCustomMonths(next)
              const months = Math.max(1, Number(next) || 1)
              onChange(String(months * 30))
            }}
            className="w-24 bg-warm-white rounded-2xl px-4 py-3 text-sm text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200"
          />
          <span className="text-sm text-warm-gray">个月</span>
        </div>
      )}
    </div>
  )
}


function splitTags(value) {
  return value
    ? value.split(/[，,]/).map(item => item.trim()).filter(Boolean)
    : []
}

function HeaderRangePicker({ value, onChange }) {
  const presetValues = RANGE_OPTIONS.map(o => o.value)
  const isCustom = value && !presetValues.includes(value)
  const [showCustom, setShowCustom] = useState(isCustom)
  const [customMonths, setCustomMonths] = useState(() =>
    isCustom ? String(Math.max(1, Math.round(Number(value) / 30))) : '2'
  )

  const applyCustom = (months) => {
    const n = Math.max(1, Number(months) || 1)
    onChange(String(n * 30))
  }

  return (
    <div className="rounded-2xl border border-cream-dark/60 bg-cream/60 px-4 py-3">
      <p className="text-xs text-warm-gray/60 mb-2">检索范围</p>
      <div className="flex flex-wrap gap-1.5">
        {RANGE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => { onChange(opt.value); setShowCustom(false) }}
            className={`px-2.5 py-1 rounded-full text-xs transition-all duration-200 ${
              value === opt.value && !showCustom
                ? 'bg-navy/90 text-warm-white shadow-sm'
                : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setShowCustom(v => !v); if (!showCustom) applyCustom(customMonths) }}
          className={`px-2.5 py-1 rounded-full text-xs transition-all duration-200 ${
            showCustom
              ? 'bg-navy/90 text-warm-white shadow-sm'
              : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
          }`}
        >
          自定义
        </button>
      </div>
      {showCustom && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-warm-gray">近</span>
          <input
            type="number"
            min="1"
            max="36"
            value={customMonths}
            onChange={e => {
              setCustomMonths(e.target.value)
              applyCustom(e.target.value)
            }}
            className="w-14 bg-warm-white rounded-xl px-2 py-1 text-sm text-navy border border-cream-dark/60 outline-none focus:border-coral/40 text-center"
          />
          <span className="text-xs text-warm-gray">个月</span>
        </div>
      )}
    </div>
  )
}

function VoiceTextarea({ label, value, onChange, placeholder }) {
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef(null)

  const toggleVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return

    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const recognition = new SR()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = false
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('')
      onChange((value ? value + '，' : '') + transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.start()
    recognitionRef.current = recognition
    setListening(true)
  }

  const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-navy/75">{label}</label>
        {hasSR && (
          <button
            type="button"
            onClick={toggleVoice}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-all duration-200 ${
              listening
                ? 'bg-coral/10 text-coral'
                : 'text-warm-gray/50 hover:text-warm-gray border border-cream-dark'
            }`}
          >
            <Mic size={11} className={listening ? 'animate-pulse' : ''} />
            {listening ? '录音中' : '语音'}
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full bg-warm-white rounded-2xl px-4 py-3 text-sm text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200 placeholder:text-warm-gray/50 resize-none leading-7"
      />
    </div>
  )
}

function formatUpdatedAt(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '1 天前'
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  return `${months} 个月前`
}

function formatCoreSource(source) {
  if (!source) return ''
  if (source === 'manual_confirmed') return '已确认'
  if (source.startsWith('auto')) return '自动生成'
  if (source === 'manual') return '手动'
  return ''
}

function MemoryBlock({ title, content, updatedAt, emptyText, badge = '' }) {
  const timeLabel = formatUpdatedAt(updatedAt)

  return (
    <div className="rounded-2xl border border-cream-dark/60 bg-cream/70 px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-medium text-navy/75">{title}</h3>
        {badge ? (
          <span className="px-2 py-0.5 rounded-full bg-navy/6 text-warm-gray/60 text-[10px]">
            {badge}
          </span>
        ) : null}
        {timeLabel ? (
          <span className="text-[10px] text-warm-gray/40 ml-auto">{timeLabel}</span>
        ) : null}
      </div>
      {content ? (
        <p className="text-sm leading-7 text-navy/80">{content}</p>
      ) : (
        <p className="text-sm leading-7 text-warm-gray/50">{emptyText}</p>
      )}
    </div>
  )
}
