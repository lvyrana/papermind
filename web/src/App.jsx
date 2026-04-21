import { useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import Profile from './pages/Profile'
import PaperRead from './pages/PaperRead'
import Settings from './pages/Settings'
import Library from './pages/Library'
import LibraryDetail from './pages/LibraryDetail'
import { setUserId } from './api'

const CACHE_KEY_PREFIXES = ['paper-notes-', 'paper-chat-', 'paper-bookmark-']
const CACHE_KEY_EXACT = [
  'cached-papers',
  'cached-papers-time',
  'cached-search-debug',
  'cached-total',
  'cached-remaining',
  'cached-all-explored',
  'cached-can-go-back',
  'last-reading',
]

function clearLocalAccountCache() {
  try {
    // 精确 key
    CACHE_KEY_EXACT.forEach(k => localStorage.removeItem(k))
    // 所有 paper-* 动态 key
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && CACHE_KEY_PREFIXES.some(p => k.startsWith(p))) toRemove.push(k)
    }
    toRemove.forEach(k => localStorage.removeItem(k))
  } catch {}
}

function UidHandler() {
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const uid = params.get('uid')
    if (uid && /^[0-9a-f-]{36}$/i.test(uid)) {
      clearLocalAccountCache()
      setUserId(uid)
      navigate('/', { replace: true })
    }
  }, [])
  return null
}

function App() {
  return (
    <div className="min-h-screen bg-cream bg-flowing">
      <UidHandler />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/paper/:id" element={<PaperRead />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/library" element={<Library />} />
        <Route path="/library/:id" element={<LibraryDetail />} />
      </Routes>
    </div>
  )
}

export default App
