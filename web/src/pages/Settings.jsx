import { useState } from 'react'
import { ArrowLeft, Sparkles, Copy, Check, Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { getUserId, API_BASE } from '../api'

export default function Settings() {
  const uid = getUserId()
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(uid)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleExport = async () => {
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
      <header className="px-6 pt-12 pb-6 max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
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
              <span>每人每天最多 20 次论文推荐、30 次 AI 对话、50 次翻译</span>
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

        {/* 设备 ID */}
        <div className="bg-warm-white rounded-2xl p-5 shadow-sm border border-cream-dark/50">
          <p className="text-xs font-medium text-navy/50 mb-2">设备 ID</p>
          <p className="text-xs text-warm-gray mb-2">你的数据与此设备绑定，换设备或清除浏览器数据后将重新开始。</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-navy/60 bg-cream-dark/30 rounded-lg px-3 py-2 break-all font-mono">
              {uid}
            </code>
            <button onClick={handleCopy}
              className="p-2 rounded-lg hover:bg-cream-dark/50 transition-colors text-warm-gray hover:text-navy flex-shrink-0">
              {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </main>

      <Navbar />
    </div>
  )
}
