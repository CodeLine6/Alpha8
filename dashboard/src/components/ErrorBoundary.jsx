'use client';

import { Component } from 'react';

export default class ErrorBoundary extends Component {
    constructor(props) { super(props); this.state = { hasError: false, error: null }; }
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    render() {
        if (this.state.hasError) return (
            <div className="rounded-2xl border border-red-500/25 bg-red-500/5 p-5">
                <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-red-400">⚠️</span>
                    <span className="text-red-400 text-sm font-semibold">Widget Error</span>
                </div>
                <p className="text-xs text-slate-500">{this.state.error?.message || 'Something went wrong'}</p>
                <button onClick={() => this.setState({ hasError: false, error: null })}
                    className="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/10 transition">
                    Retry
                </button>
            </div>
        );
        return this.props.children;
    }
}
