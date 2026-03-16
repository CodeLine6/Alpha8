import { NextResponse } from 'next/server';
import { backendGet, backendPost } from '@/lib/backend-client';

/**
 * GET /api/live-settings
 * Returns all active Redis parameter overrides merged with schema defaults.
 * Proxies to backend: GET /api/live-settings
 */
export async function GET() {
    const { data, ok, offline } = await backendGet('/api/live-settings');

    if (offline || !ok) {
        return NextResponse.json(
            { settings: {}, activeRiskParams: {}, baseRiskParams: {}, available: false, _offline: offline },
        );
    }

    return NextResponse.json(data);
}

/**
 * POST /api/live-settings
 * Set, reset, or resetAll a live parameter override.
 * Body: { key, value }     — set override
 *       { key, reset: true } — clear override
 *       { resetAll: true }  — clear all overrides
 * Proxies to backend: POST /api/live-settings
 */
export async function POST(request) {
    try {
        const body = await request.json();
        const { data, ok, offline } = await backendPost('/api/live-settings', body);

        if (offline) {
            return NextResponse.json({ error: 'Backend offline' }, { status: 503 });
        }
        if (!ok) {
            // Forward the backend validation error (e.g. out-of-range value) with its status
            return NextResponse.json(
                data || { error: 'Failed to update live setting' },
                { status: 400 }
            );
        }

        return NextResponse.json(data);
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}