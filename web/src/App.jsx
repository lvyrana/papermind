import { useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import Onboarding from './pages/Onboarding'
import Profile from './pages/Profile'
import PaperRead from './pages/PaperRead'
import Settings from './pages/Settings'
import Library from './pages/Library'
import LibraryDetail from './pages/LibraryDetail'
import { setUserId, consumeUidSwitchFlag } from './api'

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
    CACHE_KEY_EXACT.forEach(key => localStorage.removeItem(key))
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && CACHE_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) toRemove.push(key)
    }
    toRemove.forEach(key => localStorage.removeItem(key))
  } catch {
    // localStorage may be unavailable in privacy-restricted browsers.
  }
}

function UidHandler() {
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const uid = params.get('uid')
    if (!uid || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid)) return
    if (consumeUidSwitchFlag()) clearLocalAccountCache()
    setUserId(uid)
    params.delete('uid')
    const search = params.toString()
    navigate(`${location.pathname}${search ? `?${search}` : ''}${location.hash}`, { replace: true })
  }, [location.search, location.pathname, location.hash, navigate])
  return null
}

function App() {
  return (
    <div className="min-h-screen bg-cream bg-flowing">
      <UidHandler />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<Onboarding />} />
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
