import { useEffect, useState } from 'react'
import { ArrowLeft, Sparkles, Check, Download, Link2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { getUserId, API_BASE } from '../api'

export default function Settings() {
  const [linkCopied, setLinkCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [uid, setUid] = useState('')
  const [uidUnavailable, setUidUnavailable] = useState(false)
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

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-12 lg:pt-16 pb-6 max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors lg:hidden">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <h1 className="text-2xl font-bold text-navy font-serif">设置</h1>
      </header>

      <main className="px-6 max-w-2xl mx-auto space-y-4">
        {/* AI 服务说明 */}
        <div className="bg-warm-white rounded-2xl p-6 shadow-sm border border-cream-dark/50">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-coral/10 flex items-center justify-center">
              <Sparkles size={20} className="text-coral" />
            </div>
            <div>
              <h2 className="text-navy font-medium">AI 服务</h2>
              <p className="text-warm-gray text-xs">测试版</p>
            </div>
          </div>

          <p className="text-sm text-navy/80 leading-relaxed mb-4">
            当前为测试版，由系统统一提供 AI 服务，无需配置。
          </p>

          <div className="space-y-2 text-xs text-warm-gray">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span>AI 论文解读、翻译、对话均已可用</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span>每人每天最多获取 8 批推荐结果、20 次 AI 对话、30 次翻译</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-coral/60" />
              <span>自定义 API 功能将在正式版开放</span>
            </div>
          </div>
        </div>

        {/* 数据导出 */}
        <div className="bg-warm-white rounded-2xl p-5 shadow-sm border border-cream-dark/50">
          <p className="text-xs font-medium text-navy/50 mb-1">数据导出</p>
          <p className="text-xs text-warm-gray mb-3">将你所有有笔记的论文导出为 Markdown 文件，可在任何编辑器中打开。</p>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-navy/90 text-warm-white text-xs hover:bg-navy transition-colors disabled:opacity-50"
          >
            <Download size={13} />
            {exporting ? '导出中...' : '导出全部笔记'}
          </button>
        </div>

        {/* 专属链接 */}
        <div className="bg-warm-white rounded-2xl p-5 shadow-sm border border-cream-dark/50">
          <p className="text-xs font-medium text-navy/50 mb-1">多端同步</p>
          <p className="text-xs text-warm-gray mb-3">
            {uidUnavailable
              ? '当前浏览器暂时无法读取设备 ID，但不影响浏览。建议稍后刷新或切换到常规浏览模式。'
              : '你的数据存储在此设备。复制专属链接，在手机或其他浏览器中打开，即可访问同一份数据。'}
          </p>
          <button
            onClick={handleCopyLink}
            disabled={!uid}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-coral text-warm-white text-xs font-medium hover:bg-coral-light transition-colors disabled:opacity-40"
          >
            {linkCopied ? <Check size={13} /> : <Link2 size={13} />}
            {linkCopied ? '链接已复制！' : '复制我的专属链接'}
          </button>
        </div>
      </main>

      <Navbar />
    </div>
  )
}
