import { useEffect, useState } from 'react'
import { ArrowLeft, Star, FileText, Link2, Check, Download, MessageCircle, Shield } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { getUserId, API_BASE, apiGet, apiPost } from '../api'

// ── 圆角方形图标块 ─────────────────────────────────
function IconBlock({ icon: Icon, color = 'coral' }) {
  const styles = {
    coral: 'bg-coral/12 text-coral',
    navy:  'bg-navy/8 text-navy/70',
    gray:  'bg-warm-gray/10 text-warm-gray',
    mint:  'bg-mint/20 text-mint',
  }
  return (
    <div className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${styles[color]}`}>
      <Icon size={20} strokeWidth={1.6} />
    </div>
  )
}

// ── 横向用量进度条（单格） ─────────────────────────
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
        <div
          className="h-full bg-mint rounded-full transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── 数据统计格 ─────────────────────────────────────
function StatCell({ value, label }) {
  return (
    <div className="bg-[rgba(247,240,232,0.65)] rounded-xl py-4 text-center">
      <div className="text-2xl font-bold text-navy">{value ?? '–'}</div>
      <div className="text-xs text-warm-gray mt-1">{label}</div>
    </div>
  )
}

// ── 区块标题 ──────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <p className="text-[10px] uppercase tracking-[0.15em] text-warm-gray/85 font-medium px-1 pt-3 pb-1">
      {children}
    </p>
  )
}

// ── 反馈类型 ──────────────────────────────────────
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

// ── Toggle 开关 ────────────────────────────────────
function Toggle({ on, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-navy' : 'bg-cream-dark'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-warm-white rounded-full shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}

export default function Settings() {
  const [linkCopied, setLinkCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [uid, setUid] = useState('')
  const [uidUnavailable, setUidUnavailable] = useState(false)

  const [usage, setUsage] = useState(null)
  const [stats, setStats] = useState(null)

  const [anonymousData, setAnonymousData] = useState(() => {
    try { return localStorage.getItem('pm-anonymous-data') !== 'false' } catch { return true }
  })

  const handleToggleAnonymous = (val) => {
    setAnonymousData(val)
    try { localStorage.setItem('pm-anonymous-data', val ? 'true' : 'false') } catch {}
  }

  const [feedbackType, setFeedbackType] = useState('')
  const [feedbackContent, setFeedbackContent] = useState('')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackSent, setFeedbackSent] = useState(false)

  useEffect(() => {
    try {
      const nextUid = getUserId()
      setUid(nextUid)
      setUidUnavailable(false)
    } catch {
      setUid('')
      setUidUnavailable(true)
    }
  }, [])

  useEffect(() => {
    apiGet('/usage').then(setUsage).catch(() => {})
    apiGet('/stats').then(setStats).catch(() => {})
  }, [])

  const handleCopyLink = () => {
    if (!uid) return
    const link = `${window.location.origin}/?uid=${uid}`
    navigator.clipboard?.writeText(link).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    }).catch(() => {
      alert(`复制失败，请手动复制：\n${link}`)
    })
  }

  const handleExport = async () => {
    if (!uid) {
      alert('当前环境暂时无法读取设备 ID，暂时无法导出笔记。')
      return
    }
    setExporting(true)
    try {
      const res = await fetch(`${API_BASE}/export/notes-markdown`, {
        headers: { 'X-User-ID': uid },
      })
      if (!res.ok) {
        let message = '导出失败，请稍后重试'
        try {
          const data = await res.json()
          if (data?.error) message = data.error
        } catch {
          const text = await res.text()
          if (text) message = text
        }
        throw new Error(message)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `papermind-notes-${new Date().toISOString().slice(0, 10)}.md`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      alert(error.message || '导出失败，请稍后重试')
    } finally {
      setExporting(false)
    }
  }

  const handleClearData = () => {
    if (!confirm('确定要清除所有本地数据吗？\n\n这将清除设备 ID，你将无法再访问当前账号的收藏与笔记，且不可撤销。')) return
    try {
      localStorage.clear()
      alert('本地数据已清除，页面即将刷新。')
      window.location.reload()
    } catch {
      alert('清除失败，请检查浏览器权限。')
    }
  }

  const handleSendFeedback = async () => {
    if (!feedbackContent.trim()) return
    setFeedbackSending(true)
    try {
      await apiPost('/feedback', { type: feedbackType, content: feedbackContent.trim() })
      setFeedbackSent(true)
      setFeedbackContent('')
      setTimeout(() => setFeedbackSent(false), 3000)
    } catch {
      alert('发送失败，请稍后重试。')
    } finally {
      setFeedbackSending(false)
    }
  }

  return (
    <div className="min-h-screen pb-24 lg:pb-12">
      <Navbar />

      <header className="px-6 pt-20 lg:pt-24 pb-4 max-w-2xl lg:max-w-[860px] mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors lg:hidden">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <h1 className="pm-page-title text-[30px] lg:text-[34px] text-navy leading-tight">设置</h1>
        <p className="text-sm text-warm-gray mt-1">管理你的 AI 服务、数据与偏好</p>
      </header>

      <main className="px-6 max-w-2xl lg:max-w-[860px] mx-auto space-y-1.5">

        {/* ── AI 服务 ── */}
        <SectionLabel>AI 服务</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          {/* 卡片头 */}
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
              <span className="w-1.5 h-1.5 rounded-full bg-mint inline-block" />
              运行正常
            </div>
          </div>

          {/* 用量进度（3列） */}
          {usage ? (
            <div className="grid grid-cols-3 gap-2.5 mb-5">
              <UsageCell label="推荐批次" used={usage.recommend.used} limit={usage.recommend.limit} />
              <UsageCell label="AI 对话"  used={usage.chat.used}      limit={usage.chat.limit} />
              <UsageCell label="全文翻译" used={usage.translate.used}  limit={usage.translate.limit} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2.5 mb-5">
              {['推荐批次', 'AI 对话', '全文翻译'].map(l => (
                <div key={l} className="bg-cream rounded-xl p-3.5 animate-pulse">
                  <div className="h-3 bg-cream-dark rounded mb-3" />
                  <div className="h-1.5 bg-cream-dark rounded-full" />
                </div>
              ))}
            </div>
          )}

          {/* 说明条目 */}
          <div className="space-y-1.5 text-xs text-warm-gray">
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-mint mt-1 flex-shrink-0" />
              <span>AI 论文解读、翻译、对话均已可用</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-mint mt-1 flex-shrink-0" />
              <span>每人每天最多获取 5 批推荐结果、20 次 AI 对话、30 次翻译</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-coral/50 mt-1 flex-shrink-0" />
              <span>自定义 API 功能将在正式版开放</span>
            </div>
          </div>
        </div>

        {/* ── 数据管理 ── */}
        <SectionLabel>数据管理</SectionLabel>

        {/* 数据导出 */}
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          <div className="flex items-center gap-3 mb-4">
            <IconBlock icon={FileText} color="navy" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">数据导出</h2>
              <p className="text-xs text-warm-gray mt-0.5">将所有笔记导出为 Markdown 文件，可在任何编辑器中打开</p>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-navy text-warm-white text-xs font-medium hover:bg-navy-light transition-colors disabled:opacity-50 flex-shrink-0"
            >
              <Download size={13} />
              {exporting ? '导出中…' : '导出全部笔记'}
            </button>
          </div>

          {/* 数据统计 */}
          <div className="grid grid-cols-3 gap-2.5">
            <StatCell value={stats?.papers} label="篇论文" />
            <StatCell value={stats?.notes}  label="份笔记" />
            <StatCell value={stats?.chats}  label="次对话" />
          </div>
        </div>

        {/* 多端同步 */}
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
          <button
            onClick={handleCopyLink}
            disabled={!uid}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-coral text-warm-white text-xs font-medium hover:bg-coral-light transition-colors disabled:opacity-40"
          >
            {linkCopied ? <Check size={13} /> : <Link2 size={13} />}
            {linkCopied ? '链接已复制！' : '复制我的专属链接'}
          </button>
        </div>

        {/* ── 偏好设置 ── */}
        <SectionLabel>偏好设置</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          {/* 卡片头 */}
          <div className="flex items-center gap-3 mb-5">
            <IconBlock icon={Shield} color="gray" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">隐私与安全</h2>
              <p className="text-xs text-warm-gray mt-0.5">数据仅存储在你的设备上</p>
            </div>
          </div>

          {/* 匿名使用数据 */}
          <div className="flex items-start justify-between gap-4 py-3 border-t border-cream-dark/60">
            <div>
              <p className="text-sm font-medium text-navy">匿名使用数据</p>
              <p className="text-xs text-warm-gray mt-0.5">帮助我们改进产品，不含任何个人内容</p>
            </div>
            <Toggle on={anonymousData} onChange={handleToggleAnonymous} />
          </div>

          {/* 清除所有数据 */}
          <div className="flex items-start justify-between gap-4 py-3 border-t border-cream-dark/60">
            <div>
              <p className="text-sm font-medium text-navy">清除所有数据</p>
              <p className="text-xs text-warm-gray mt-0.5">删除本地所有收藏与笔记，不可撤销</p>
            </div>
            <button
              onClick={handleClearData}
              className="flex-shrink-0 px-4 py-1.5 rounded-xl border border-coral/40 text-coral text-xs hover:bg-coral/5 transition-colors"
            >
              清除数据
            </button>
          </div>
        </div>

        {/* ── 用户反馈 ── */}
        <SectionLabel>用户反馈</SectionLabel>
        <div className="bg-warm-white/[0.82] backdrop-blur-sm rounded-2xl p-5 border border-cream-dark/[0.7]">
          {/* 卡片头 */}
          <div className="flex items-center gap-3 mb-4">
            <IconBlock icon={MessageCircle} color="gray" />
            <div className="flex-1 min-w-0">
              <h2 className="text-navy font-semibold text-sm">用户反馈</h2>
              <p className="text-xs text-warm-gray mt-0.5">遇到问题或有好想法，直接告诉我们</p>
            </div>
          </div>

          {/* 类型选择 */}
          <div className="flex gap-2 mb-4">
            {FEEDBACK_TYPES.map(({ value, label, bg, activeBg, activeColor }) => {
              const active = feedbackType === value
              return (
                <button
                  key={value}
                  onClick={() => setFeedbackType(value)}
                  style={{
                    background: active ? activeBg : bg,
                    color: active ? activeColor : '#8E8A85',
                    fontWeight: active ? 500 : 400,
                  }}
                  className="px-3.5 py-1.5 rounded-lg text-xs transition-all border-0"
                >
                  {label}
                </button>
              )
            })}
          </div>

          <textarea
            value={feedbackContent}
            onChange={e => setFeedbackContent(e.target.value)}
            placeholder={
              FEEDBACK_TYPES.find(t => t.value === feedbackType)?.placeholder
              ?? '随便说点什么，我们都想听…'
            }
            maxLength={1000}
            rows={5}
            className="w-full rounded-xl px-4 py-3 text-sm text-navy placeholder:text-warm-gray/50 resize-none focus:outline-none transition-colors"
            style={{
              background: 'rgba(247,240,232,0.65)',
              border: '1px solid rgba(237,228,216,0.8)',
            }}
            onFocus={e => e.target.style.borderColor = 'rgba(232,135,122,0.35)'}
            onBlur={e => e.target.style.borderColor = 'rgba(237,228,216,0.8)'}
          />

          <div className="flex items-center justify-between mt-3">
            <span className="text-xs" style={{ color: '#B8A798' }}>
              {feedbackContent.length > 0 ? `${feedbackContent.length} 字` : '匿名发送，不包含任何个人信息'}
            </span>
            <button
              onClick={handleSendFeedback}
              disabled={feedbackSending || !feedbackContent.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all"
              style={{
                background: feedbackSent
                  ? 'rgba(168,213,186,0.25)'
                  : feedbackContent.trim() ? '#1E3A5F' : 'rgba(237,228,216,0.6)',
                color: feedbackSent
                  ? '#4d9a6f'
                  : feedbackContent.trim() ? '#FFFDF9' : '#B8A798',
                boxShadow: feedbackContent.trim() && !feedbackSent
                  ? '0 2px 10px rgba(30,58,95,0.18)' : 'none',
              }}
            >
              {feedbackSent ? <Check size={13} /> : <MessageCircle size={13} />}
              {feedbackSending ? '发送中…' : feedbackSent ? '已发送，谢谢！' : '发送反馈'}
            </button>
          </div>
        </div>

      </main>
    </div>
  )
}
