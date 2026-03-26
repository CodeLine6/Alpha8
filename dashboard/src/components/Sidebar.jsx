'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/utils';

const NAV = [
  { href: '/',            icon: '◈',  label: 'Dashboard'  },
  { href: '/history',     icon: '≡',  label: 'History'    },
  { href: '/screener',    icon: '◎',  label: 'Screener'   },
  { href: '/strategies',  icon: '⬡',  label: 'Strategies' },
  { href: '/live-params', icon: '⊞',  label: 'Live Params'},
  { href: '/settings',    icon: '⊙',  label: 'Settings'   },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen]     = useState(false);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        setHealth(r.ok ? 'ok' : 'err');
      } catch { setHealth('err'); }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      className="fixed left-0 top-0 bottom-0 z-50 flex flex-col overflow-hidden transition-[width] duration-200"
      style={{
        width: open ? '220px' : '60px',
        background: '#0f172a',
        borderRight: '1px solid rgba(100,116,139,0.25)',
      }}
    >
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-4 overflow-hidden"
           style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-white font-bold text-sm"
             style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
          α
        </div>
        <span className="sidebar-label whitespace-nowrap text-sm font-semibold text-white overflow-hidden transition-opacity duration-150"
              style={{ opacity: open ? 1 : 0 }}>
          Alpha8
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col gap-1 p-3 overflow-y-auto overflow-x-hidden">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              title={!open ? label : undefined}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium overflow-hidden transition-all duration-150"
              style={{
                color: active ? '#fff' : 'rgba(255,255,255,0.45)',
                background: active ? 'rgba(99,102,241,0.15)' : 'transparent',
                borderLeft: `2px solid ${active ? '#6366f1' : 'transparent'}`,
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}}
            >
              <span className="shrink-0 w-5 text-center font-mono text-base">{icon}</span>
              <span className="sidebar-label whitespace-nowrap transition-opacity duration-150"
                    style={{ opacity: open ? 1 : 0 }}>
                {label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Health dot */}
      <div className="flex items-center gap-2.5 px-4 py-3 overflow-hidden"
           style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <span className="shrink-0 w-2 h-2 rounded-full"
              style={{
                background: health === 'ok' ? '#22c55e' : health === 'err' ? '#ef4444' : '#4b5563',
                boxShadow: health === 'ok' ? '0 0 6px #22c55e' : health === 'err' ? '0 0 6px #ef4444' : 'none',
              }} />
        <span className="sidebar-label text-xs whitespace-nowrap transition-opacity duration-150"
              style={{ opacity: open ? 1 : 0, color: 'rgba(255,255,255,0.3)' }}>
          {health === 'ok' ? 'System Online' : health === 'err' ? 'Offline' : '…'}
        </span>
      </div>
    </aside>
  );
}