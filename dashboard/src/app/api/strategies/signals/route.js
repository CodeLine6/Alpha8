import { NextResponse } from 'next/server';
import { backendGet } from '@/lib/backend-client';

/**
 * GET /api/strategies/signals — Recent strategy signals.
 * Proxies to backend: /api/strategies/signals?limit=50
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get('limit') || '50';

  const { data, ok, offline } = await backendGet(`/api/strategies/signals?limit=${limit}`);

  if (offline || !ok) {
    return NextResponse.json({ signals: [], _offline: offline });
  }

  return NextResponse.json(data);
}
