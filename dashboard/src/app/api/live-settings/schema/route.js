import { NextResponse } from 'next/server';
import { backendGet } from '@/lib/backend-client';

/**
 * GET /api/live-settings/schema
 * Returns the full schema of all settable parameters — labels, descriptions,
 * min/max/step/default/category. Used by the live-params dashboard page to
 * build the settings UI dynamically without hardcoding anything client-side.
 * Proxies to backend: GET /api/live-settings/schema
 */
export async function GET() {
    const { data, ok, offline } = await backendGet('/api/live-settings/schema');

    if (offline || !ok) {
        return NextResponse.json(
            { schema: {}, categories: {}, _offline: offline },
        );
    }

    return NextResponse.json(data);
}