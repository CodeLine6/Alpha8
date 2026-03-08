import { NextResponse } from 'next/server';
import { backendPost, backendGet } from '@/lib/backend-client';

/**
 * GET /api/killswitch — Get kill switch status.
 * POST /api/killswitch — Engage or reset kill switch.
 * Proxies to backend: /api/killswitch
 */
export async function GET() {
  const { data, ok, offline } = await backendGet('/api/killswitch');

  if (offline || !ok) {
    return NextResponse.json({ engaged: false, reason: null, _offline: offline });
  }

  return NextResponse.json(data);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { data, ok, offline } = await backendPost('/api/killswitch', body);

    if (offline) {
      return NextResponse.json({ error: 'Backend offline' }, { status: 503 });
    }

    if (!ok) {
      return NextResponse.json({ error: 'Failed to update kill switch' }, { status: 502 });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
