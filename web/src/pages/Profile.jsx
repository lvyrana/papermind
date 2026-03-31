import { useState, useEffect } from 'react'
import { ArrowLeft, Save, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { apiGet, apiPost } from '../api'

export default function Profile() {
  const [profile, setProfile] = useState({
    focus_areas: '',
    exclude_areas: '',
    current_goal: '',
    background: '',
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    apiGet('/profile')
      .then(data => setProfile(data))
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    try {
      await apiPost('/profile', profile)
    } catch {}
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
          这不是一个表单，而是你的自我介绍。<br />
          我会根据这些信息，为你过滤和解读每一篇文献。
        </p>
      </header>

      <main className="px-6 max-w-2xl mx-auto space-y-6">
        <ProfileField
          label="我的研究方向"
          hint="你最关注的领域，用顿号分隔"
          value={profile.focus_areas}
          onChange={update('focus_areas')}
          placeholder="例如：护理与患者管理、肺康复、患者教育"
        />

        <ProfileField
          label="我的研究经历"
          hint="自由描述你的研究背景，我会记住它"
          value={profile.background}
          onChange={update('background')}
          placeholder="例如：硕士研究方向为慢阻肺患者的居家管理和依从性研究，关注护理干预在慢病管理中的作用..."
          multiline
        />

        <div>
          <label className="text-sm font-medium text-navy mb-2 block">当前目标</label>
          <p className="text-xs text-warm-gray mb-3">这会影响我推荐文献的角度</p>
          <div className="flex flex-wrap gap-2">
            {['写综述', '找课题方向', '准备组会', '日常追踪', '写论文'].map(goal => (
              <button
                key={goal}
                onClick={() => {
                  setProfile(prev => ({ ...prev, current_goal: goal }))
                  setSaved(false)
                }}
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

        <ProfileField
          label="我不想看的内容"
          hint="这些类型的论文会被自动过滤"
          value={profile.exclude_areas}
          onChange={update('exclude_areas')}
          placeholder="例如：纯动物实验、纯分子机制、药代动力学"
        />

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
