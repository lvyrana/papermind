import { ArrowLeft, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'

export default function Settings() {
  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-12 pb-6 max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <h1 className="text-2xl font-bold text-navy font-serif">设置</h1>
      </header>

      <main className="px-6 max-w-2xl mx-auto">
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
              <span>每人每天最多 10 次论文推荐</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-coral/60" />
              <span>自定义 API 功能将在正式版开放</span>
            </div>
          </div>
        </div>
      </main>

      <Navbar />
    </div>
  )
}
