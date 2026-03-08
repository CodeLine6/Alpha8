import { NextResponse } from 'next/server';
import { backendPost } from '@/lib/backend-client';

/**
 * POST /api/settings/watchlist — Add/remove symbols from watchlist.
 * Proxies to backend: POST /api/settings/watchlist
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { data, ok, offline } = await backendPost('/api/settings/watchlist', body);

    if (offline) {
      return NextResponse.json({ error: 'Backend offline' }, { status: 503 });
    }

    if (!ok) {
      return NextResponse.json({ error: 'Failed to update watchlist' }, { status: 502 });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
