import { Link, useLocation } from 'react-router-dom'
import { User, Home, Settings, BookOpen } from 'lucide-react'

export default function Navbar() {
  const location = useLocation()
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/')

  const now = new Date()
  const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
  const weekday = now.toLocaleDateString('zh-CN', { weekday: 'long' })

  return (
    <nav
      className="flex h-14 items-center px-4 sm:px-6 lg:px-10 xl:px-14 bg-[#F7F0E8]/86 backdrop-blur-xl border-b border-cream-dark/45 shadow-[0_1px_18px_rgba(30,58,95,0.025)]"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 80,
        display: 'flex',
      }}
    >
      <Link to="/" className="flex items-center gap-3 text-navy shrink-0">
        <img src="/icon-light.svg" alt="" className="h-8 w-8 rounded-xl shadow-[0_6px_18px_rgba(30,58,95,0.08)]" />
        <span className="hidden sm:inline font-serif text-[21px] font-semibold tracking-[0.08em] leading-none">papermind</span>
      </Link>
      <div className="flex-1 flex items-center justify-center gap-0.5 sm:gap-1.5 min-w-0">
        <DesktopNavItem to="/" icon={<Home size={15} />} label="首页" active={location.pathname === '/'} />
        <DesktopNavItem to="/library" icon={<BookOpen size={15} />} label="收藏" active={isActive('/library')} />
        <DesktopNavItem to="/profile" icon={<User size={15} />} label="画像" active={isActive('/profile')} />
        <DesktopNavItem to="/settings" icon={<Settings size={15} />} label="设置" active={isActive('/settings')} />
      </div>
      <div className="hidden lg:flex items-center gap-5 shrink-0">
        <span className="text-xs text-warm-gray/70 tracking-[0.12em]">{dateStr} · {weekday}</span>
      </div>
    </nav>
  )
}

function DesktopNavItem({ to, icon, label, active }) {
  return (
    <Link to={to}
      className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm transition-all duration-200 ${
        active
          ? 'bg-warm-white/70 text-navy font-semibold shadow-[0_8px_22px_rgba(30,58,95,0.055)]'
          : 'text-warm-gray/80 hover:text-navy hover:bg-warm-white/35'
      }`}>
      {icon}
      {label}
    </Link>
  )
}
