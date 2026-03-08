/**
 * Backend HTTP client for the dashboard.
 * 
 * Proxies requests from Next.js API routes to the Quant8 backend
 * running at BACKEND_URL (default: http://localhost:3000).
 * 
 * Falls back to offline-safe defaults when the backend is unreachable.
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const TIMEOUT_MS = 5000;

/**
 * Fetch data from the backend with timeout and error handling.
 * 
 * @param {string} path - API path (e.g., '/api/summary')
 * @param {Object} [options] - Fetch options
 * @returns {Promise<{ data: any, ok: boolean, offline: boolean }>}
 */
export async function backendFetch(path, options = {}) {
  const url = `${BACKEND_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errorBody = await res.text();
      return { data: null, ok: false, offline: false, error: errorBody };
    }

    const data = await res.json();
    return { data, ok: true, offline: false };
  } catch (err) {
    clearTimeout(timeout);

    // Backend is not reachable
    if (
      err.name === 'AbortError' ||
      err.cause?.code === 'ECONNREFUSED' ||
      err.cause?.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED'
    ) {
      return { data: null, ok: false, offline: true, error: 'Backend offline' };
    }

    return { data: null, ok: false, offline: false, error: err.message };
  }
}

/**
 * GET request to backend.
 */
export async function backendGet(path) {
  return backendFetch(path, { method: 'GET' });
}

/**
 * POST request to backend.
 */
export async function backendPost(path, body) {
  return backendFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─── Offline fallback data ───────────────────────────────

export const OFFLINE_SUMMARY = {
  pnl: 0,
  pnlPct: 0,
  tradeCount: 0,
  winCount: 0,
  lossCount: 0,
  filled: 0,
  rejected: 0,
  drawdownPct: 0,
  capital: 0,
  paperMode: true,
  killSwitchEngaged: false,
  killSwitchReason: null,
  _offline: true,
};

export const OFFLINE_HEALTH = {
  broker: false,
  redis: false,
  db: false,
  dataFeed: false,
  telegram: false,
  lastCheck: new Date().toISOString(),
  _offline: true,
};

export const OFFLINE_SETTINGS = {
  paperMode: true,
  capital: 0,
  maxDailyLossPct: 2,
  perTradeStopLossPct: 1,
  maxPositionCount: 5,
  killSwitchDrawdownPct: 5,
  killSwitchEngaged: false,
  watchlist: [],
  telegram: { enabled: false, totalSent: 0, totalFailed: 0, queueLength: 0 },
  _offline: true,
};
