import { NextResponse } from 'next/server';
import { backendGet, OFFLINE_HEALTH } from '@/lib/backend-client';

/**
 * GET /api/health — System health status.
 * Proxies to backend: /api/health
 */
export async function GET() {
  const { data, ok, offline } = await backendGet('/api/health');

  if (offline) {
    return NextResponse.json(OFFLINE_HEALTH);
  }

  if (!ok) {
    return NextResponse.json(OFFLINE_HEALTH, { status: 502 });
  }

  return NextResponse.json(data);
}
