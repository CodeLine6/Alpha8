/**
 * Normalises a Redis URL for managed providers.
 * Upstash requires TLS (rediss://) but often provides redis:// URLs.
 * @param {string} url - Raw Redis URL from environment
 * @returns {string} Normalised URL (TLS-upgraded if needed)
 */
export function normalizeRedisUrl(url) {
    if (url.includes('upstash.io') && url.startsWith('redis://')) {
        return url.replace('redis://', 'rediss://');
    }
    return url;
}
