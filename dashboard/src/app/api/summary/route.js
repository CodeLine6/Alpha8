import { NextResponse } from 'next/server';
import { backendGet, OFFLINE_SUMMARY } from '@/lib/backend-client';

/**
 * GET /api/summary — Today's daily summary.
 * Proxies to backend: /api/summary
 */
export async function GET() {
  const { data, ok, offline } = await backendGet('/api/summary');

  if (offline) {
    return NextResponse.json(OFFLINE_SUMMARY);
  }

  if (!ok) {
    return NextResponse.json(OFFLINE_SUMMARY, { status: 502 });
  }

  return NextResponse.json(data);
}
