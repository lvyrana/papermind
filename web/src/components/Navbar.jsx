import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { User, Home, Settings, BookOpen } from 'lucide-react'

export default function Navbar() {
  const location = useLocation()
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/')
  const [visible, setVisible] = useState(true)
  const lastY = useRef(0)

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      if (y < 60) { setVisible(true); lastY.current = y; return }
      setVisible(y < lastY.current)
      lastY.current = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <nav className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${visible ? 'translate-y-0 opacity-100' : 'translate-y-24 opacity-0'}`}>
      <div className="flex items-center gap-1 px-5 py-3 bg-navy/90 backdrop-blur-lg rounded-full shadow-lg">
        <NavItem to="/" icon={<Home size={18} />} label="首页" active={location.pathname === '/'} />
        <NavItem to="/library" icon={<BookOpen size={18} />} label="收藏" active={isActive('/library')} />
        <NavItem to="/profile" icon={<User size={18} />} label="画像" active={isActive('/profile')} />
        <NavItem to="/settings" icon={<Settings size={18} />} label="设置" active={isActive('/settings')} />
      </div>
    </nav>
  )
}

function NavItem({ to, icon, label, active }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm transition-all duration-300 ${
        active
          ? 'nav-pill-active text-warm-white font-medium'
          : 'text-warm-white/50 hover:text-warm-white/80'
      }`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  )
}
