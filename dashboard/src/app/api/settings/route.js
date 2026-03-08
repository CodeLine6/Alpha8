import { NextResponse } from 'next/server';
import { backendGet, OFFLINE_SETTINGS } from '@/lib/backend-client';

/**
 * GET /api/settings — Current application settings.
 * Proxies to backend: /api/settings
 */
export async function GET() {
  const { data, ok, offline } = await backendGet('/api/settings');

  if (offline) {
    return NextResponse.json(OFFLINE_SETTINGS);
  }

  if (!ok) {
    return NextResponse.json(OFFLINE_SETTINGS, { status: 502 });
  }

  return NextResponse.json(data);
}
