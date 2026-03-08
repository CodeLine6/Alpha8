import { NextResponse } from 'next/server';
import { backendGet } from '@/lib/backend-client';

/**
 * GET /api/trades — Trade history with filters.
 * Proxies to backend: /api/trades?startDate=...&endDate=...&strategy=...&symbol=...&side=...
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();
  const path = `/api/trades${query ? `?${query}` : ''}`;

  const { data, ok, offline } = await backendGet(path);

  if (offline || !ok) {
    return NextResponse.json({ trades: [], _offline: offline });
  }

  return NextResponse.json(data);
}
