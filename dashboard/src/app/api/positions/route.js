import { NextResponse } from 'next/server';
import { backendGet } from '@/lib/backend-client';

/**
 * GET /api/positions — Current open positions.
 * Proxies to backend: /api/positions
 */
export async function GET() {
  const { data, ok, offline } = await backendGet('/api/positions');

  if (offline || !ok) {
    return NextResponse.json({ positions: [], _offline: offline });
  }

  return NextResponse.json(data);
}
