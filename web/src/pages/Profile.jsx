import { useState, useEffect } from 'react'
import { ArrowLeft, Save, Sparkles, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { apiGet, apiPost } from '../api'

export default function Profile() {
  const [profile, setProfile] = useState({
    focus_areas: '',
    exclude_areas: '',
    current_goal: '',
    background: '',
    discipline: '',
    tracking_days: '7',
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    apiGet('/profile')
      .then(data => setProfile(prev => ({ ...prev, ...data })))
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    try {
      await apiPost('/profile', profile)
    } catch { /* ignore */ }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (field) => (e) => {
    setProfile(prev => ({ ...prev, [field]: e.target.value }))
    setSaved(false)
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-12 pb-6 max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <h1 className="text-2xl font-bold text-navy font-serif">我的研究画像</h1>
        <p className="text-warm-gray mt-2 leading-relaxed text-sm">
          告诉我你关注什么，我会为你筛选和解读每一篇文献。
        </p>
      </header>

      <main className="px-6 max-w-2xl mx-auto space-y-8">

        {/* 上层：追踪设置 */}
        <section className="space-y-6">
          <h2 className="text-xs font-semibold text-warm-gray/60 uppercase tracking-widest">追踪设置</h2>

          <ProfileField
            label="追踪主题"
            hint="你最关注的领域，用顿号分隔"
            value={profile.focus_areas}
            onChange={update('focus_areas')}
            placeholder="例如：护理与患者管理、肺康复、患者教育"
          />

          <ProfileField
            label="不想看的内容"
            hint="这些类型的论文会被自动过滤"
            value={profile.exclude_areas}
            onChange={update('exclude_areas')}
            placeholder="例如：纯动物实验、纯分子机制、药代动力学"
          />

          <TrackingDaysPicker
            value={profile.tracking_days}
            onChange={val => { setProfile(prev => ({ ...prev, tracking_days: val })); setSaved(false) }}
          />

          <div>
            <label className="text-sm font-medium text-navy mb-2 block">当前目标</label>
            <p className="text-xs text-warm-gray mb-3">这会影响推荐文献的角度</p>
            <div className="flex flex-wrap gap-2">
              {['写综述', '找课题方向', '准备组会', '日常追踪', '写论文'].map(goal => (
                <button
                  key={goal}
                  onClick={() => { setProfile(prev => ({ ...prev, current_goal: goal })); setSaved(false) }}
                  className={`px-4 py-2 rounded-full text-sm transition-all duration-200 ${
                    profile.current_goal === goal
                      ? 'bg-navy/90 text-warm-white shadow-sm'
                      : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
                  }`}
                >
                  {goal}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 分隔线 */}
        <div className="h-px bg-cream-dark/60" />

        {/* 下层：研究背景 */}
        <section className="space-y-6">
          <h2 className="text-xs font-semibold text-warm-gray/60 uppercase tracking-widest">关于我</h2>

          <DisciplineInput
            value={profile.discipline}
            onChange={val => { setProfile(prev => ({ ...prev, discipline: val })); setSaved(false) }}
          />

          <ProfileField
            label="研究经历"
            hint="自由描述你的背景，越详细推荐越准"
            value={profile.background}
            onChange={update('background')}
            placeholder="例如：硕士研究方向为慢阻肺患者的居家管理和依从性研究，关注护理干预在慢病管理中的作用..."
            multiline
          />
        </section>

        <button
          onClick={handleSave}
          className={`w-full py-3.5 rounded-2xl font-medium text-sm transition-all duration-300 flex items-center justify-center gap-2 ${
            saved
              ? 'bg-mint/20 text-navy'
              : 'bg-navy text-warm-white hover:bg-navy-light shadow-sm'
          }`}
        >
          {saved ? (
            <>
              <Sparkles size={16} />
              已保存，我记住你了
            </>
          ) : (
            <>
              <Save size={16} />
              保存画像
            </>
          )}
        </button>
      </main>

      <Navbar />
    </div>
  )
}

function ProfileField({ label, hint, value, onChange, placeholder, multiline }) {
  const inputClass = `w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy
    border border-cream-dark/50 outline-none
    focus:border-coral/40 focus:ring-2 focus:ring-coral/10
    transition-all duration-200 placeholder:text-warm-gray/50`

  return (
    <div>
      <label className="text-sm font-medium text-navy mb-2 block">{label}</label>
      {hint && <p className="text-xs text-warm-gray mb-3">{hint}</p>}
      {multiline ? (
        <textarea value={value} onChange={onChange} placeholder={placeholder} rows={4} className={`${inputClass} resize-none`} />
      ) : (
        <input type="text" value={value} onChange={onChange} placeholder={placeholder} className={inputClass} />
      )}
    </div>
  )
}

function DisciplineInput({ value, onChange }) {
  const [input, setInput] = useState('')
  const tags = value ? value.split(',').map(t => t.trim()).filter(Boolean) : []

  const addTag = () => {
    const tag = input.trim()
    if (!tag || tags.includes(tag)) { setInput(''); return }
    onChange([...tags, tag].join(', '))
    setInput('')
  }

  const removeTag = (tag) => {
    onChange(tags.filter(t => t !== tag).join(', '))
  }

  return (
    <div>
      <label className="text-sm font-medium text-navy mb-2 block">学科领域</label>
      <p className="text-xs text-warm-gray mb-3">输入后按回车添加标签</p>
      <div className="flex flex-wrap gap-2 mb-2">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-cream-dark/50 text-navy text-xs">
            {tag}
            <button onClick={() => removeTag(tag)} className="text-warm-gray hover:text-coral transition-colors">
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
        placeholder="例如：护理学、公共卫生"
        className="w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200 placeholder:text-warm-gray/50"
      />
    </div>
  )
}

function TrackingDaysPicker({ value, onChange }) {
  const options = [
    { label: '近 7 天', value: '7' },
    { label: '近 14 天', value: '14' },
    { label: '近 30 天', value: '30' },
  ]
  return (
    <div>
      <label className="text-sm font-medium text-navy mb-2 block">追踪周期</label>
      <p className="text-xs text-warm-gray mb-3">抓取多远之内的新论文</p>
      <div className="flex gap-2">
        {options.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-4 py-2 rounded-full text-sm transition-all duration-200 ${
              value === opt.value
                ? 'bg-navy/90 text-warm-white shadow-sm'
                : 'bg-warm-white text-warm-gray border border-cream-dark hover:border-navy/20 hover:text-navy'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
