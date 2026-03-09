'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
    { href: '/', label: 'Dashboard', icon: '📊' },
    { href: '/history', label: 'History', icon: '📋' },
    { href: '/strategies', label: 'Strategies', icon: '🧠' },
    { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar() {
    const pathname = usePathname();

    return (
        <aside
            style={{ width: 'var(--sidebar-width)' }}
            className="fixed left-0 top-0 bottom-0 bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] flex flex-col z-40 overflow-hidden transition-[width] duration-200"
        >
            {/* Logo */}
            <div className="h-14 flex items-center gap-3 px-4 border-b border-[var(--border-subtle)] shrink-0">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                    Q
                </div>
                <span className="text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent whitespace-nowrap sidebar-label">
                    Alpha8
                </span>
            </div>

            {/* Navigation */}
            <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
                {NAV_ITEMS.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            title={item.label}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${isActive
                                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] border border-transparent'
                                }`}
                        >
                            <span className="text-lg shrink-0">{item.icon}</span>
                            <span className="whitespace-nowrap sidebar-label">{item.label}</span>
                            {isActive && (
                                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 sidebar-label" />
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-[var(--border-subtle)] shrink-0">
                <div className="text-xs text-[var(--text-muted)] sidebar-label whitespace-nowrap">
                    Alpha8 v1.0
                </div>
            </div>
        </aside>
    );
}
