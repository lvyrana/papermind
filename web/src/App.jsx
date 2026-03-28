import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Profile from './pages/Profile'
import PaperRead from './pages/PaperRead'
import Settings from './pages/Settings'
import Library from './pages/Library'
import LibraryDetail from './pages/LibraryDetail'

function App() {
  return (
    <div className="min-h-screen bg-cream">
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
