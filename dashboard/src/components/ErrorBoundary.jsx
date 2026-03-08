'use client';

/**
 * Error boundary wrapper for dashboard widgets.
 * One failing widget shouldn't crash the whole page.
 */
import { Component } from 'react';

export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="card border-red-500/30 bg-red-500/5">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-red-400">⚠️</span>
                        <span className="text-red-400 text-sm font-semibold">Widget Error</span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)]">
                        {this.state.error?.message || 'Something went wrong'}
                    </p>
                    <button
                        className="btn mt-3 text-xs"
                        onClick={() => this.setState({ hasError: false, error: null })}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
