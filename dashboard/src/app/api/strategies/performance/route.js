import { NextResponse } from 'next/server';
import { backendGet } from '@/lib/backend-client';

/**
 * GET /api/strategies/performance — Per-strategy performance metrics.
 * Proxies to backend: /api/strategies/performance
 */
export async function GET() {
  const { data, ok, offline } = await backendGet('/api/strategies/performance');

  if (offline || !ok) {
    return NextResponse.json({ strategies: [], _offline: offline });
  }

  return NextResponse.json(data);
}
