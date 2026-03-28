import { useState, useEffect } from 'react'
import { ArrowLeft, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'

const API = '/api'

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', hint: '国内推荐，便宜好用' },
  { id: 'zhipu', name: '智谱 GLM', hint: '国内，有免费额度' },
  { id: 'moonshot', name: 'Moonshot', hint: '国内，月之暗面' },
  { id: 'openrouter', name: 'OpenRouter', hint: '海外聚合，多模型可选' },
  { id: 'openai', name: 'OpenAI', hint: '需要海外网络' },
  { id: 'custom', name: '自定义', hint: '任意 OpenAI 兼容接口' },
]

const MODEL_SUGGESTIONS = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  zhipu: ['glm-4-flash', 'glm-4-plus'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  custom: [],
}

export default function Settings() {
  const [provider, setProvider] = useState('deepseek')
  const [model, setModel] = useState('deepseek-chat')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [maskedKey, setMaskedKey] = useState('')
  const [testStatus, setTestStatus] = useState(null) // null | 'loading' | 'ok' | 'error'
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch(`${API}/settings`)
      .then(r => r.json())
      .then(data => {
        setProvider(data.provider || 'deepseek')
        setModel(data.model || 'deepseek-chat')
        setBaseUrl(data.base_url || '')
        setMaskedKey(data.api_key_masked || '')
      })
      .catch(() => {})
  }, [])

  const handleProviderChange = (id) => {
    setProvider(id)
    const suggestions = MODEL_SUGGESTIONS[id]
    if (suggestions?.length) setModel(suggestions[0])
    setBaseUrl('')
  }

  const handleSave = async () => {
    await fetch(`${API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, api_key: apiKey, base_url: baseUrl }),
    })
    setSaved(true)
    setMaskedKey(apiKey ? apiKey.slice(0, 4) + '****' + apiKey.slice(-4) : '')
    setApiKey('')
    setTimeout(() => setSaved(false), 2000)
  }

  const handleTest = async () => {
    setTestStatus('loading')
    try {
      const r = await fetch(`${API}/settings/test`, { method: 'POST' })
      const data = await r.json()
      setTestStatus(data.ok ? 'ok' : 'error')
    } catch {
      setTestStatus('error')
    }
    setTimeout(() => setTestStatus(null), 3000)
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="px-6 pt-12 pb-6 max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-warm-gray text-sm mb-6 hover:text-navy transition-colors">
          <ArrowLeft size={16} />
          <span>返回</span>
        </Link>
        <h1 className="text-2xl font-bold text-navy font-serif">API 设置</h1>
        <p className="text-warm-gray mt-2 text-sm">
          配置 AI 模型，让我能为你解读论文。
        </p>
      </header>

      <main className="px-6 max-w-2xl mx-auto space-y-6">
        {/* Provider selector */}
        <div>
          <label className="text-sm font-medium text-navy mb-3 block">选择 AI 服务商</label>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDERS.map(p => (
              <button
                key={p.id}
                onClick={() => handleProviderChange(p.id)}
                className={`text-left px-4 py-3 rounded-xl text-sm transition-all ${
                  provider === p.id
                    ? 'bg-navy text-warm-white shadow-sm'
                    : 'bg-warm-white text-navy border border-cream-dark hover:border-coral/30'
                }`}
              >
                <div className="font-medium">{p.name}</div>
                <div className={`text-xs mt-0.5 ${provider === p.id ? 'text-warm-white/70' : 'text-warm-gray'}`}>
                  {p.hint}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div>
          <label className="text-sm font-medium text-navy mb-2 block">模型</label>
          {MODEL_SUGGESTIONS[provider]?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {MODEL_SUGGESTIONS[provider].map(m => (
                <button
                  key={m}
                  onClick={() => setModel(m)}
                  className={`px-3 py-1 rounded-full text-xs transition-all ${
                    model === m
                      ? 'bg-coral text-warm-white'
                      : 'bg-cream-dark/50 text-warm-gray hover:text-navy'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all"
            placeholder="模型名称"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="text-sm font-medium text-navy mb-2 block">API Key</label>
          {maskedKey && (
            <p className="text-xs text-warm-gray mb-2">当前已保存：{maskedKey}</p>
          )}
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all"
            placeholder={maskedKey ? '输入新 Key 以更新' : '粘贴你的 API Key'}
          />
        </div>

        {/* Custom base URL */}
        {provider === 'custom' && (
          <div>
            <label className="text-sm font-medium text-navy mb-2 block">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              className="w-full bg-warm-white rounded-xl px-4 py-3 text-sm text-navy border border-cream-dark/50 outline-none focus:border-coral/40 focus:ring-2 focus:ring-coral/10 transition-all"
              placeholder="https://your-api.com/v1"
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            className={`flex-1 py-3 rounded-xl font-medium text-sm transition-all flex items-center justify-center gap-2 ${
              saved
                ? 'bg-mint/20 text-navy'
                : 'bg-navy text-warm-white hover:bg-navy-light'
            }`}
          >
            {saved ? 'Saved' : '保存'}
          </button>
          <button
            onClick={handleTest}
            disabled={testStatus === 'loading'}
            className="flex-1 py-3 rounded-xl font-medium text-sm border border-navy/20 text-navy hover:bg-navy/5 transition-all flex items-center justify-center gap-2"
          >
            {testStatus === 'loading' && <Loader2 size={14} className="animate-spin" />}
            {testStatus === 'ok' && <CheckCircle size={14} className="text-green-600" />}
            {testStatus === 'error' && <XCircle size={14} className="text-red-500" />}
            {testStatus === 'ok' ? '连接成功' : testStatus === 'error' ? '连接失败' : '测试连接'}
          </button>
        </div>
      </main>

      <Navbar />
    </div>
  )
}
