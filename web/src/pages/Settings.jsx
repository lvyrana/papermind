import { createElement, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Star, FileText, Link2, Check, Download, MessageCircle, Shield,
  Save, Sparkles, Mic, X, Cpu, Loader2, ListFilter,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { getUserId, API_BASE, apiGet, apiPost, apiDelete } from '../api'

/* ─────────────────────────────────────────────────────────────
   SETTINGS — 加上「研究偏好」section（从 Profile 搬来）
   ─────────────────────────────────────────────────────────────
   设计原则：
   1. 完整保留原 Settings 的全部 section（AI 服务、数据管理、偏好、反馈）
   2. 顶部新增「研究偏好」section：focus_areas / method_interests /
      exclude_areas / discipline / background / tracking_days
   3. 后端契约和老版 Profile.jsx 完全一致：POST /profile + GET /profile
   4. URL hash `#research-prefs` 锚到这个 section（给 Profile-slim 上的链接用）
   ───────────────────────────────────────────────────────────── */

const BROAD_EXCLUDE_TERMS = ['研究', '文章', '论文', '综述', '文献', '期刊', '论著', '报告', '资料']
const RANGE_OPTIONS = [
  { label: '近 1 个月', value: '30' },
  { label: '近 3 个月', value: '90' },
  { label: '近 6 个月', value: '180' },
]
const DEFAULT_PROFILE = {
  focus_areas: '', exclude_areas: '', method_interests: '',
  current_goal: '', background: '', discipline: '',
  tracking_days: '90',
}

function detectBroadTerms(exclude_areas) {
  if (!exclude_areas) return []
  return exclude_areas.split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean)
    .filter(t => BROAD_EXCLUDE_TERMS.includes(t))
}

function IconBlock({ icon, color = 'coral' }) {
  const styles = {
    coral: 'bg-coral/12 text-coral',
    navy: 'bg-navy/8 text-navy/70',
    gray: 'bg-warm-gray/10 text-warm-gray',
    mint: 'bg-mint/20 text-mint',
  }
  return (
    <div className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${styles[color]}`}>
      {createElement(icon, { size: 20, strokeWidth: 1.6 })}
    </div>
  )
}

function UsageCell({ label, used, limit }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  return (
    <div className="bg-[rgba(247,240,232,0.65)] rounded-xl p-3.5">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs text-navy/55">{label}</span>
        <span className="text-xs font-semibold text-navy tabular-nums">
          {used}<span className="font-normal text-warm-gray">/{limit}次</span>
        </span>
      </div>
      <div className="h-1.5 bg-cream-dark rounded-full overflow-hidden">
        <div className="h-full bg-mint rounded-full transition-all duration-700" style={{ width: `${pct}%` }}/>
      </div>
    </div>
  )
}
function StatCell({ value, label }) {
  return (
    <div className="bg-[rgba(247,240,232,0.65)] rounded-xl py-4 text-center">
      <div className="text-2xl font-bold text-navy">{value ?? '–'}</div>
      <div className="text-xs text-warm-gray mt-1">{label}</div>
    </div>
  )
}
function SectionLabel({ children }) {
  return (
    <p className="text-[10px] uppercase tracking-[0.15em] text-warm-gray/85 font-medium px-1 pt-3 pb-1">{children}</p>
  )
}
function Toggle({ on, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-navy' : 'bg-cream-dark'}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-warm-white rounded-full shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}

const FEEDBACK_TYPES = [
  { value: 'bug',   label: '发现问题',
    bg: 'rgba(232,135,122,0.1)',  activeBg: 'rgba(232,135,122,0.18)', activeColor: '#c0614f',
    placeholder: '描述一下你遇到的问题，复现步骤也很有帮助…' },
  { value: 'idea',  label: '功能建议',
    bg: 'rgba(168,213,186,0.1)',  activeBg: 'rgba(168,213,186,0.22)', activeColor: '#4d9a6f',
    placeholder: '说说你希望有什么功能，或者现有功能可以怎么改进…' },
  { value: 'other', label: '其他',
    bg: 'rgba(237,228,216,0.5)',  activeBg: 'rgba(237,228,216,0.9)',  activeColor: '#1E3A5F',
    placeholder: '随便说点什么，我们都想听…' },
]

// ═════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════
export default function Settings() {
  // ── research prefs (NEW) ──
  const [profile, setProfile] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem('cached-profile') || 'null')
      return cached ? { ...DEFAULT_PROFILE, ...cached, tracking_days: cached.tracking_days || '90' } : DEFAULT_PROFILE
    } catch { return DEFAULT_PROFILE }
  })
  const [profileSaved, setProfileSaved] = useState(false)
  const [profileSaveError, setProfileSaveError] = useState('')
  const [broadWarn, setBroadWarn] = useState('')

  useEffect(() => {
    apiGet('/profile').then(data => {
      setProfile(prev => {
        const next = { ...prev, ...data, tracking_days: data.tracking_days || '90' }
        localStorage.setItem('cached-profile', JSON.stringify(next))
        return next
      })
    }).catch(() => {})
  }, [])

  // scroll-to-anchor when hash is #research-prefs (from Profile-slim)
  useEffect(() => {
    if (window.location.hash === '#research-prefs') {
      const el = document.getElementById('research-prefs')
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200)
    }
  }, [])

  const patchProfile = (partial) => {
    setProfile(prev => {
      const next = { ...prev, ...partial }
      localStorage.setItem('cached-profile', JSON.stringify(next))
      return next
    })
    setProfileSaved(false)
    setProfileSaveError('')
  }

  const handleSaveProfile = async () => {
    const broad = detectBroadTerms(profile.exclude_areas)
    if (broad.length > 0) {
      setBroadWarn(`「${broad.join('、')}」过于宽泛，可能屏蔽掉所有论文。建议改成更具体的词，例如「动物模型」「基础实验」。`)
      setTimeout(() => setBroadWarn(''), 6000)
      return
    }
    try {
      await apiPost('/profile', profile)
      setProfileSaveError('')
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2200)
      // trigger fresh recommendations on next /home visit
      sessionStorage.setItem('pm-auto-fetch', '1')
    } catch {
      setProfileSaved(false)
      setProfileSaveError('保存失败，请稍后再试')
    }
  }

  // ── existing state ──
  const [linkCopied, setLinkCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [uid, setUid] = useState('')
  const [uidUnavailable, setUidUnavailable] = useState(false)
  const [usage, setUsage] = useState(null)
  const [stats, setStats] = useState(null)
  const [anonymousData, setAnonymousData] = useState(() => {
    try { return localStorage.getItem('pm-anonymous-data') !== 'false' } catch { return true }
  })
  const [feedbackType, setFeedbackType] = useState('')
  const [feedbackContent, setFeedbackContent] = useState('')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackSent, setFeedbackSent] = useState(false)

  useEffect(() => {
    try { setUid(getUserId()); setUidUnavailable(false) }
    catch { setUid(''); setUidUnavailable(true) }
  }, [])
  useEffect(() => {
    apiGet('/usage').then(setUsage).catch(() => {})
    apiGet('/stats').then(setStats).catch(() => {})
  }, [])

  const handleToggleAnonymous = (val) => {
    setAnonymousData(val)
    try { localStorage.setItem('pm-anonymous-data', val ? 'true' : 'false') } catch { /* ignore */ }
  }
  const handleCopyLink = () => {
    if (!uid) return
    const link = `${window.location.origin}/?uid=${uid}`
    navigator.clipboard?.writeText(link).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    }).catch(() => alert(`复制失败，请手动复制：\n${link}`))
  }
  const handleExport = async () => {
    if (!uid) { alert('当前环境暂时无法读取设备 ID，暂时无法导出笔记。'); return }
    setExporting(true)
    try {
      const res = await fetch(`${API_BASE}/export/notes-markdown`, { headers: { 'X-User-ID': uid } })
      if (!res.ok) {
        let message = '导出失败，请稍后重试'
        try { const data = await res.json(); if (data?.error) message = data.error }
        catch { const t = await res.text(); if (t) message = t }
        throw new Error(message)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = `papermind-notes-${new Date().toISOString().slice(0, 10)}.md`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (error) { alert(error.message || '导出失败，请稍后重试') }
    finally { setExporting(false) }
  }
  const handleClearData = () => {
    if (!confirm('确定要清除所有本地数据吗？\n\n这将清除设备 ID，你将无法再访问当前账号的收藏与笔记，且不可撤销。')) return
    try { localStorage.clear(); alert('本地数据已清除，页面即将刷新。'); window.location.reload() }
    catch { alert('清除失败，请检查浏览器权限。') }
  }
  const handleSendFeedback = async () => {
    if (!feedbackContent.trim()) return
    setFeedbackSending(true)
    try {
      await apiPost('/feedback', { type: feedbackType, content: feedbackContent.trim() })
      setFeedbackSent(true); setFeedbackContent('')
      setTimeout(() => setFeedbackSent(false), 3000)
    } catch { alert('发送失败，请稍后重试。') }
    finally { setFeedbackSending(false) }
  }

  return (
    <div className="min-h-screen pb-24 lg:pb-12">
      <Navbar />

      <header className="px-6 pt-20 lg:pt-24 pb-4 max-w-2xl lg:max-w-[860px] mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors lg:hidden">
          <ArrowLeft size={16} /> <span>返回</span>
        </Link>
        <h1 className="pm-page-title text-[30px] lg:text-[34px] text-navy leading-tight">设置</h1>
        <p className="text-sm text-warm-gray mt-1">管理你的研究偏好、AI 服务、数据与隐私</p>
      </header>

      <main className="px-6 max-w-2xl lg:max-w-[860px] mx-auto space-y-1.5">

        {/* ─── 研究偏好 (NEW · 顶部) ─── */}
        <SectionLabel>研究偏好</SectionLabel>
        <ResearchPrefsCard
          profile={profile}
          patchProfile={patchProfile}
          onSave={handleSaveProfile}
          saved={profileSaved}
          saveError={profileSaveError}
        />

        {/* ─── AI 服务 ─── */}
        <SectionLabel>AI 服务</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          <div className="flex items-center gap-3 mb-5">
            <IconBlock icon={Star} color="coral" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-navy font-semibold text-sm">AI 服务</h2>
                <span className="text-[10px] bg-coral/10 text-coral px-2 py-0.5 rounded-full font-medium">测试版</span>
              </div>
              <p className="text-xs text-warm-gray mt-0.5">由系统统一提供，无需配置</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-mint flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-mint inline-block" />运行正常
            </div>
          </div>

          {usage ? (
            <div className="grid grid-cols-3 gap-2.5 mb-5">
              <UsageCell label="推荐批次" used={usage.recommend.used} limit={usage.recommend.limit} />
              <UsageCell label="AI 对话"  used={usage.chat.used}      limit={usage.chat.limit} />
              <UsageCell label="翻译次数" used={usage.translate.used}  limit={usage.translate.limit} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2.5 mb-5">
              {['推荐批次', 'AI 对话', '翻译次数'].map(l => (
                <div key={l} className="bg-cream rounded-xl p-3.5 animate-pulse">
                  <div className="h-3 bg-cream-dark rounded mb-3" />
                  <div className="h-1.5 bg-cream-dark rounded-full" />
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5 text-xs text-warm-gray">
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-mint mt-1 flex-shrink-0" />
              <span>AI 论文解读、翻译、对话均已可用</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-mint mt-1 flex-shrink-0" />
              <span>每人每天最多获取 {usage ? usage.recommend.limit : '—'} 批推荐结果、{usage ? usage.chat.limit : '—'} 次 AI 对话、{usage ? usage.translate.limit : '—'} 次翻译次数</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-mint mt-1 flex-shrink-0" />
              <span>可在下方配置自己的 API，优先于内置通道使用，失败时自动回退</span>
            </div>
          </div>
        </div>

        {/* ─── 自定义 AI 模型 ─── */}
        <CustomLLMCard />

        {/* ─── 数据管理 ─── */}
        <SectionLabel>数据管理</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          <div className="flex items-center gap-3 mb-4">
            <IconBlock icon={FileText} color="navy" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">数据导出</h2>
              <p className="text-xs text-warm-gray mt-0.5">将所有笔记导出为 Markdown 文件，可在任何编辑器中打开</p>
            </div>
            <button onClick={handleExport} disabled={exporting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-navy text-warm-white text-xs font-medium hover:bg-navy-light transition-colors disabled:opacity-50 flex-shrink-0">
              <Download size={13} /> {exporting ? '导出中…' : '导出全部笔记'}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <StatCell value={stats?.papers} label="篇论文" />
            <StatCell value={stats?.notes}  label="份笔记" />
            <StatCell value={stats?.chats}  label="次对话" />
          </div>
        </div>

        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          <div className="flex items-center gap-3 mb-3">
            <IconBlock icon={Link2} color="gray" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">多端同步</h2>
              <p className="text-xs text-warm-gray mt-0.5">
                {uidUnavailable
                  ? '当前浏览器暂时无法读取设备 ID，建议刷新或切换常规浏览模式。'
                  : '复制专属链接，在手机或其他浏览器中打开即可同步数据。'}
              </p>
            </div>
          </div>
          <button onClick={handleCopyLink} disabled={!uid}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-coral text-warm-white text-xs font-medium hover:bg-coral-light transition-colors disabled:opacity-40">
            {linkCopied ? <Check size={13} /> : <Link2 size={13} />}
            {linkCopied ? '链接已复制！' : '复制我的专属链接'}
          </button>
        </div>

        {/* ─── 偏好设置（隐私）─── */}
        <SectionLabel>隐私与安全</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          <div className="flex items-center gap-3 mb-5">
            <IconBlock icon={Shield} color="gray" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">隐私与安全</h2>
              <p className="text-xs text-warm-gray mt-0.5">数据仅存储在你的设备上</p>
            </div>
          </div>
          <div className="flex items-start justify-between gap-4 py-3 border-t border-cream-dark/60">
            <div>
              <p className="text-sm font-medium text-navy">匿名使用数据</p>
              <p className="text-xs text-warm-gray mt-0.5">帮助我们改进产品，不含任何个人内容</p>
            </div>
            <Toggle on={anonymousData} onChange={handleToggleAnonymous} />
          </div>
          <div className="flex items-start justify-between gap-4 py-3 border-t border-cream-dark/60">
            <div>
              <p className="text-sm font-medium text-navy">清除所有数据</p>
              <p className="text-xs text-warm-gray mt-0.5">删除本地所有收藏与笔记，不可撤销</p>
            </div>
            <button onClick={handleClearData}
              className="flex-shrink-0 px-4 py-1.5 rounded-xl border border-coral/40 text-coral text-xs hover:bg-coral/5 transition-colors">
              清除数据
            </button>
          </div>
        </div>

        {/* ─── 用户反馈 ─── */}
        <SectionLabel>用户反馈</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          <div className="flex items-center gap-3 mb-4">
            <IconBlock icon={MessageCircle} color="gray" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">用户反馈</h2>
              <p className="text-xs text-warm-gray mt-0.5">遇到问题或有好想法，直接告诉我们</p>
            </div>
          </div>
          <div className="flex gap-2 mb-4">
            {FEEDBACK_TYPES.map(({ value, label, bg, activeBg, activeColor }) => {
              const active = feedbackType === value
              return (
                <button key={value} onClick={() => setFeedbackType(value)}
                  style={{
                    background: active ? activeBg : bg,
                    color: active ? activeColor : '#8E8A85',
                    fontWeight: active ? 500 : 400,
                  }}
                  className="px-3.5 py-1.5 rounded-lg text-xs transition-all border-0">
                  {label}
                </button>
              )
            })}
          </div>
          <textarea value={feedbackContent} onChange={e => setFeedbackContent(e.target.value)}
            placeholder={FEEDBACK_TYPES.find(t => t.value === feedbackType)?.placeholder ?? '随便说点什么，我们都想听…'}
            maxLength={1000} rows={5}
            className="w-full rounded-xl px-4 py-3 text-sm text-navy placeholder:text-warm-gray/50 resize-none focus:outline-none transition-colors"
            style={{ background: 'rgba(247,240,232,0.65)', border: '1px solid rgba(237,228,216,0.8)' }}
            onFocus={e => e.target.style.borderColor = 'rgba(232,135,122,0.35)'}
            onBlur={e => e.target.style.borderColor = 'rgba(237,228,216,0.8)'}/>
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs" style={{ color: '#B8A798' }}>
              {feedbackContent.length > 0 ? `${feedbackContent.length} 字` : '匿名发送，不包含任何个人信息'}
            </span>
            <button onClick={handleSendFeedback} disabled={feedbackSending || !feedbackContent.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all"
              style={{
                background: feedbackSent ? 'rgba(168,213,186,0.25)' : feedbackContent.trim() ? '#1E3A5F' : 'rgba(237,228,216,0.6)',
                color: feedbackSent ? '#4d9a6f' : feedbackContent.trim() ? '#FFFDF9' : '#B8A798',
                boxShadow: feedbackContent.trim() && !feedbackSent ? '0 2px 10px rgba(30,58,95,0.18)' : 'none',
              }}>
              {feedbackSent ? <Check size={13} /> : <MessageCircle size={13} />}
              {feedbackSending ? '发送中…' : feedbackSent ? '已发送，谢谢！' : '发送反馈'}
            </button>
          </div>
        </div>

      </main>

      {/* broad term banner */}
      {broadWarn && (
        <div className="fixed bottom-24 left-4 right-4 z-50 max-w-lg mx-auto">
          <div className="bg-[#7C5A2A] text-[#FFF8EE] text-xs px-4 py-3 rounded-2xl shadow-lg leading-relaxed">⚠️ {broadWarn}</div>
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// RESEARCH PREFS — the new section
// ═════════════════════════════════════════════════════════════
function ResearchPrefsCard({ profile, patchProfile, onSave, saved, saveError }) {
  return (
    <section id="research-prefs"
      className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl border border-cream-dark/[0.7] overflow-hidden scroll-mt-24">
      <header className="px-5 py-5 flex items-center gap-3 border-b border-cream-dark/40">
        <IconBlock icon={Sparkles} color="coral"/>
        <div className="flex-1 min-w-0">
          <h2 className="text-navy font-semibold text-sm">研究偏好</h2>
          <p className="text-xs text-warm-gray mt-0.5">这些字段决定 papermind 给你推荐什么 · 改完点保存</p>
        </div>
        <span className="text-[10px] uppercase tracking-[0.22em] font-mono text-warm-gray hidden sm:block">manual</span>
      </header>

      <TaggedField label="研究方向"     value={profile.focus_areas}      onChange={v => patchProfile({ focus_areas: v })}      placeholder="例如：肺癌、术后康复"/>
      <TaggedField label="方法兴趣"     value={profile.method_interests} onChange={v => patchProfile({ method_interests: v })} placeholder="例如：系统综述、RCT" hint="会和研究方向一起生成检索词"/>
      <TaggedField label="不想看的内容" value={profile.exclude_areas}    onChange={v => patchProfile({ exclude_areas: v })}    placeholder="例如：动物模型、基础实验"/>
      <TaggedField label="学科领域"     value={profile.discipline}       onChange={v => patchProfile({ discipline: v })}       placeholder="例如：护理学、公共卫生" hint="只影响解读语气，不参与检索"/>

      <div className="px-5 py-5 border-t border-cream-dark/40">
        <VoiceTextarea label="自由描述" value={profile.background} onChange={v => patchProfile({ background: v })}
          placeholder="用日常的话说就行，AI 会理解并生成检索词"/>
      </div>

      <div className="px-5 py-5 border-t border-cream-dark/40">
        <p className="text-[10px] uppercase tracking-[0.2em] font-mono text-warm-gray mb-3">检索时间范围</p>
        <RangePicker value={profile.tracking_days} onChange={v => patchProfile({ tracking_days: v })}/>
      </div>

      {/* footer: save bar */}
      <footer className="px-5 py-4 bg-cream/40 border-t border-cream-dark/40 flex items-center justify-between gap-3">
        <p className="text-[11px] text-warm-gray m-0">
          {saved ? '已保存，下次推荐会按更新的偏好' : saveError ? saveError : '改完点保存才生效。也可以随时再回来调。'}
        </p>
        <button onClick={onSave}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all ${
            saved
              ? 'bg-mint/20 text-mint'
              : 'bg-coral text-warm-white hover:bg-coral-light shadow-[0_2px_10px_rgba(232,135,122,0.28)]'
          }`}>
          {saved ? <><Check size={13}/> 已保存</> : <><Save size={13}/> 保存</>}
        </button>
      </footer>
    </section>
  )
}

// ═════════════════════════════════════════════════════════════
// Form atoms (从原 Profile.jsx 搬来)
// ═════════════════════════════════════════════════════════════
function TaggedField({ label, value, onChange, placeholder, hint }) {
  return (
    <div className="px-5 py-4 border-t border-cream-dark/40 first:border-t-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-medium text-navy/65 m-0">{label}</h3>
        {hint && <p className="text-[11px] text-warm-gray/65 m-0 text-right">{hint}</p>}
      </div>
      <TagInputCompact value={value} onChange={onChange} placeholder={placeholder}/>
    </div>
  )
}

function TagInputCompact({ value, onChange, placeholder }) {
  const [input, setInput] = useState('')
  const tags = (value || '').split(/[，,]/).map(t => t.trim()).filter(Boolean)
  const addTag = () => {
    const tag = input.trim()
    if (!tag || tags.includes(tag)) { setInput(''); return }
    onChange([...tags, tag].join(', '))
    setInput('')
  }
  const removeTag = (tag) => onChange(tags.filter(t => t !== tag).join(', '))
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] bg-cream-dark/55 text-navy/82">
            {tag}
            <button type="button" onClick={() => removeTag(tag)} className="opacity-60 hover:opacity-100">
              <X size={11}/>
            </button>
          </span>
        ))}
      </div>
      <input type="text" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === '，' || e.key === ',') { e.preventDefault(); addTag() } }}
        onBlur={addTag}
        placeholder={placeholder}
        className="w-full bg-warm-white rounded-xl px-3.5 py-2 text-[13px] text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all duration-200 placeholder:text-warm-gray/50"/>
    </div>
  )
}

function VoiceTextarea({ label, value, onChange, placeholder, rows = 3 }) {
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef(null)
  const toggleVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    if (listening) { recognitionRef.current?.stop(); setListening(false); return }
    const recognition = new SR()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = false
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('')
      onChange((value ? value + '，' : '') + transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.start()
    recognitionRef.current = recognition
    setListening(true)
  }
  const supported = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-medium text-navy/65 m-0">{label}</h3>
        {supported && (
          <button type="button" onClick={toggleVoice}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] transition-all ${
              listening ? 'bg-coral/15 text-coral animate-pulse' : 'text-warm-gray hover:text-navy'
            }`}>
            <Mic size={10}/> {listening ? '听着…' : '语音'}
          </button>
        )}
      </div>
      <textarea value={value || ''} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} rows={rows}
        className="w-full bg-warm-white rounded-xl px-3.5 py-3 text-[13px] text-navy border border-cream-dark/60 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all resize-none leading-relaxed placeholder:text-warm-gray/50"/>
    </div>
  )
}

function RangePicker({ value, onChange }) {
  const presetValues = RANGE_OPTIONS.map(o => o.value)
  const isCustom = value && !presetValues.includes(value)
  const [customMode, setCustomMode] = useState(isCustom)
  const [customDraft, setCustomDraft] = useState(isCustom ? value : '')
  return (
    <div className="flex flex-wrap gap-1.5">
      {RANGE_OPTIONS.map(opt => (
        <button key={opt.value} type="button"
          onClick={() => { onChange(opt.value); setCustomMode(false) }}
          className={`px-3 py-1.5 rounded-full text-[12px] transition-all ${
            value === opt.value && !customMode
              ? 'bg-coral text-warm-white shadow-sm'
              : 'bg-warm-white text-navy/65 border border-cream-dark hover:border-coral/30'
          }`}>
          {opt.label}
        </button>
      ))}
      {customMode ? (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-warm-white border border-coral/30">
          <input type="number" min="1" max="365" value={customDraft}
            onChange={e => setCustomDraft(e.target.value)}
            onBlur={() => customDraft && onChange(customDraft)}
            placeholder="天"
            className="w-12 bg-transparent border-0 outline-none text-[12.5px] text-navy text-center"/>
          <span className="text-[11px] text-warm-gray">天</span>
          <button type="button" onClick={() => { setCustomMode(false); onChange('90') }}
            className="opacity-60 hover:opacity-100"><X size={11}/></button>
        </span>
      ) : (
        <button type="button" onClick={() => setCustomMode(true)}
          className="px-3 py-1.5 rounded-full text-[12px] text-warm-gray border border-dashed border-cream-dark hover:text-coral hover:border-coral transition">
          自定义
        </button>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// CUSTOM LLM — 自定义 AI 模型（v0.10）
// ═════════════════════════════════════════════════════════════
const LLM_PRESETS = [
  { key: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1',
    hint: '一个 key 用遍 Claude / GPT / Gemini / DeepSeek 等几乎所有模型（国外服务，走代理）' },
  { key: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com',
    hint: 'deepseek-chat / deepseek-reasoner，性价比高' },
  { key: 'glm', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4',
    hint: 'glm 系列，有免费档位' },
  { key: 'qwen', label: '阿里云通义', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    hint: 'qwen 系列——内置免费额度到期后可以换成自己的 key 续用' },
  { key: 'moonshot', label: 'Kimi', base: 'https://api.moonshot.cn/v1',
    hint: 'kimi 系列，长上下文' },
  { key: 'siliconflow', label: '硅基流动', base: 'https://api.siliconflow.cn/v1',
    hint: '聚合大量国产开源模型' },
  { key: 'custom', label: '自定义', base: '',
    hint: '任何 OpenAI 兼容接口都可以，填以 /v1 结尾的地址' },
]

function CustomLLMCard() {
  const [enabled, setEnabled] = useState(false)
  const [preset, setPreset] = useState('openrouter')
  const [baseUrl, setBaseUrl] = useState(LLM_PRESETS[0].base)
  const [apiKey, setApiKey] = useState('')          // 始终只存新输入；空 = 沿用已存
  const [keyMasked, setKeyMasked] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [model, setModel] = useState('')
  const [models, setModels] = useState([])
  const [modelFilter, setModelFilter] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // {ok, latency_ms, reply} | {ok:false, error}
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState('builtin')

  useEffect(() => {
    apiGet('/settings').then(data => {
      const c = data.custom
      if (!c) return
      setEnabled(!!c.enabled)
      if (c.preset) setPreset(c.preset)
      if (c.base_url) setBaseUrl(c.base_url)
      if (c.model) setModel(c.model)
      setKeyMasked(c.api_key_masked || '')
      setHasKey(!!c.has_key)
      setActive(data.active || 'builtin')
    }).catch(() => {})
  }, [])

  const pickPreset = (p) => {
    setPreset(p.key)
    if (p.base) setBaseUrl(p.base)
    else if (preset !== 'custom') setBaseUrl('')
    setModels([])
    setTestResult(null)
  }

  const presetDef = LLM_PRESETS.find(p => p.key === preset) || LLM_PRESETS[LLM_PRESETS.length - 1]

  const fetchModels = async () => {
    if (loadingModels) return
    setLoadingModels(true)
    setError('')
    try {
      const data = await apiPost('/settings/custom-llm/models', { base_url: baseUrl, api_key: apiKey })
      if (data.ok) { setModels(data.models); setModelFilter('') }
      else setError(data.error || '获取模型列表失败')
    } catch { setError('网络错误，请重试') }
    finally { setLoadingModels(false) }
  }

  const runTest = async () => {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      const data = await apiPost('/settings/custom-llm/test', { base_url: baseUrl, api_key: apiKey, model })
      setTestResult(data)
    } catch { setTestResult({ ok: false, error: '网络错误，请重试' }) }
    finally { setTesting(false) }
  }

  const save = async (nextEnabled) => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const data = await apiPost('/settings/custom-llm', {
        enabled: nextEnabled, preset, base_url: baseUrl, api_key: apiKey, model,
      })
      if (data.ok) {
        setEnabled(!!data.custom.enabled)
        setKeyMasked(data.custom.api_key_masked || '')
        setHasKey(!!data.custom.has_key)
        setApiKey('')
        setActive(data.custom.enabled && data.custom.has_key && data.custom.model ? 'custom' : 'builtin')
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
      } else setError(data.error || '保存失败')
    } catch { setError('网络错误，请重试') }
    finally { setSaving(false) }
  }

  const clearAll = async () => {
    try {
      await apiDelete('/settings/custom-llm')
      setEnabled(false); setApiKey(''); setKeyMasked(''); setHasKey(false)
      setModel(''); setModels([]); setTestResult(null); setActive('builtin')
    } catch { /* ignore */ }
  }

  const filteredModels = modelFilter
    ? models.filter(m => m.toLowerCase().includes(modelFilter.toLowerCase()))
    : models

  return (
    <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7] mt-2.5">
      <div className="flex items-center gap-3 mb-4">
        <IconBlock icon={Cpu} color="navy" />
        <div className="flex-1 min-w-0">
          <h2 className="text-navy font-semibold text-sm">自定义 AI 模型</h2>
          <p className="text-xs text-warm-gray mt-0.5">
            {active === 'custom'
              ? <>当前使用：<span className="text-navy font-medium">{model || '自定义模型'}</span>，失败时自动回退内置通道</>
              : '当前使用内置通道；配置后你的 API 将优先使用'}
          </p>
        </div>
        {hasKey && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-[11px] text-warm-gray">{enabled ? '已启用' : '已停用'}</span>
            <Toggle on={enabled} onChange={(v) => save(v)} />
          </div>
        )}
      </div>

      {/* 服务商选择 */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {LLM_PRESETS.map(p => (
          <button key={p.key} type="button" onClick={() => pickPreset(p)}
            className={`px-3 py-1.5 rounded-full text-[12px] transition ${
              preset === p.key
                ? 'bg-navy text-warm-white font-medium'
                : 'text-warm-gray border border-cream-dark hover:text-navy hover:border-navy/30'
            }`}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-[11.5px] text-warm-gray/80 mb-4 px-1">{presetDef.hint}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-[11px] text-warm-gray mb-1 px-1">API 地址</label>
          <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://…/v1"
            className="w-full bg-cream/60 rounded-xl px-3 py-2 text-[12.5px] text-navy border border-navy/10 outline-none focus:border-coral/40 font-mono"/>
        </div>
        <div>
          <label className="block text-[11px] text-warm-gray mb-1 px-1">API Key</label>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder={hasKey ? `已保存 ${keyMasked}（留空沿用）` : 'sk-…'}
            className="w-full bg-cream/60 rounded-xl px-3 py-2 text-[12.5px] text-navy border border-navy/10 outline-none focus:border-coral/40 font-mono"/>
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-[11px] text-warm-gray mb-1 px-1">模型</label>
        <div className="flex gap-2">
          <input type="text" value={model} onChange={e => setModel(e.target.value)}
            placeholder="手动填写，或点右侧按钮从你的账号拉取可用列表"
            className="flex-1 bg-cream/60 rounded-xl px-3 py-2 text-[12.5px] text-navy border border-navy/10 outline-none focus:border-coral/40 font-mono"/>
          <button type="button" onClick={fetchModels} disabled={loadingModels || !baseUrl || (!apiKey && !hasKey)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-navy/15 text-xs text-navy hover:border-navy/40 disabled:opacity-40 flex-shrink-0">
            {loadingModels ? <Loader2 size={12} className="animate-spin"/> : <ListFilter size={12}/>}
            获取可选模型
          </button>
        </div>

        {models.length > 0 && (
          <div className="mt-2 bg-cream/50 border border-cream-dark/60 rounded-xl p-2.5">
            <input type="text" value={modelFilter} onChange={e => setModelFilter(e.target.value)}
              placeholder={`共 ${models.length} 个模型，输入关键词筛选…`}
              className="w-full bg-warm-white rounded-lg px-2.5 py-1.5 text-[12px] text-navy border border-navy/10 outline-none mb-2"/>
            <div className="max-h-44 overflow-y-auto flex flex-wrap gap-1">
              {filteredModels.slice(0, 60).map(m => (
                <button key={m} type="button" onClick={() => { setModel(m); setTestResult(null) }}
                  className={`px-2 py-1 rounded-lg text-[11px] font-mono transition ${
                    model === m ? 'bg-navy text-warm-white' : 'bg-warm-white text-navy/70 hover:text-navy border border-cream-dark/70'
                  }`}>
                  {m}
                </button>
              ))}
              {filteredModels.length > 60 && (
                <span className="text-[11px] text-warm-gray px-2 py-1">…还有 {filteredModels.length - 60} 个，继续输入筛选</span>
              )}
              {filteredModels.length === 0 && (
                <span className="text-[11px] text-warm-gray px-2 py-1">没有匹配的模型</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 测试结果 / 错误 */}
      {testResult && (
        testResult.ok ? (
          <p className="text-[12px] text-mint-deep mb-3 px-1">
            ✓ 连接正常 · {testResult.latency_ms}ms · 模型回复「{testResult.reply}」
          </p>
        ) : (
          <p className="text-[12px] text-coral mb-3 px-1 break-all">✗ {testResult.error}</p>
        )
      )}
      {error && <p className="text-[12px] text-coral mb-3 px-1">{error}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={runTest} disabled={testing || !baseUrl || !model || (!apiKey && !hasKey)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-coral/35 text-coral text-xs font-medium hover:bg-coral/5 disabled:opacity-40">
          {testing ? <><Loader2 size={12} className="animate-spin"/> 测试中…</> : '测试连接'}
        </button>
        <button type="button" onClick={() => save(true)} disabled={saving || !baseUrl || !model || (!apiKey && !hasKey)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-navy text-warm-white text-xs font-medium hover:bg-navy-light disabled:opacity-40">
          {saving ? <Loader2 size={12} className="animate-spin"/> : savedFlash ? <><Check size={12}/> 已保存</> : '保存并启用'}
        </button>
        {hasKey && (
          <button type="button" onClick={clearAll}
            className="px-3 py-2 text-[11.5px] text-warm-gray hover:text-coral ml-auto">
            清除配置
          </button>
        )}
      </div>
    </div>
  )
}
