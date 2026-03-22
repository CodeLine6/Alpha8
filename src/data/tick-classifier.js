/**
 * @fileoverview Tick Classifier for Alpha8
 *
 * Classifies each tick from Kite's binary feed as buyer-initiated,
 * seller-initiated, or neutral using the Lee-Ready algorithm adapted
 * for NSE intraday data.
 *
 * Lee-Ready Rule:
 *   - If last_traded_price >= best_ask at time of trade → buyer lifted the ask → BUY
 *   - If last_traded_price <= best_bid at time of trade → seller hit the bid  → SELL
 *   - If price is between bid and ask → use tick rule:
 *       price > prev_price → BUY  (uptick)
 *       price < prev_price → SELL (downtick)
 *       price = prev_price → inherit previous classification
 *
 * Why this matters:
 *   Buyer-initiated trades signal aggressive buying — someone willing to
 *   pay the ask immediately. Seller-initiated trades signal aggressive
 *   selling. The ratio of buyer vs seller volume is a leading indicator
 *   of price direction, not a lagging one like RSI.
 */

export const TICK_SIDE = {
    BUY: 'BUY',
    SELL: 'SELL',
    NEUTRAL: 'NEUTRAL',
};

/**
 * @typedef {Object} RawTick
 * @property {number} last_price          - Last traded price
 * @property {number} last_quantity       - Quantity traded in this tick
 * @property {number} best_bid_price      - Best bid at time of tick
 * @property {number} best_ask_price      - Best ask at time of tick
 * @property {number} [volume]            - Cumulative volume (optional)
 * @property {number} [timestamp]         - Epoch ms (optional)
 */

/**
 * @typedef {Object} ClassifiedTick
 * @property {string}  side      - 'BUY' | 'SELL' | 'NEUTRAL'
 * @property {number}  price     - Last traded price
 * @property {number}  quantity  - Quantity of this tick
 * @property {number}  timestamp - Epoch ms when tick arrived
 */

export class TickClassifier {
    /**
     * @param {Object} [options]
     * @param {number} [options.bidAskSpreadMaxPct=0.5]
     *   If bid-ask spread > this % of mid-price, treat as wide spread
     *   and rely more on tick rule. NSE liquid stocks typically < 0.05%.
     */
    constructor(options = {}) {
        this._spreadMaxPct = options.bidAskSpreadMaxPct ?? 0.5;

        // Per-symbol state: last classified tick for tick rule fallback
        this._lastTick = new Map();  // symbol → { price, side }
    }

    /**
     * Classify a single tick.
     *
     * @param {string}   symbol
     * @param {RawTick}  tick
     * @returns {ClassifiedTick}
     */
    classify(symbol, tick) {
        const {
            last_price: price,
            last_quantity: quantity = 1,
            best_bid_price: bid,
            best_ask_price: ask,
        } = tick;

        const timestamp = tick.timestamp || Date.now();
        const prev = this._lastTick.get(symbol);

        let side = TICK_SIDE.NEUTRAL;

        // Validate bid/ask are usable
        const hasBidAsk = bid > 0 && ask > 0 && ask >= bid;
        const spread = hasBidAsk ? ask - bid : 0;
        const midPrice = hasBidAsk ? (bid + ask) / 2 : price;
        const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 999;

        if (hasBidAsk && spreadPct <= this._spreadMaxPct) {
            // Tight spread — bid-ask rule is reliable
            if (price >= ask) {
                side = TICK_SIDE.BUY;    // buyer lifted the ask
            } else if (price <= bid) {
                side = TICK_SIDE.SELL;   // seller hit the bid
            } else {
                // Price between bid and ask → tick rule
                side = this._tickRule(price, prev);
            }
        } else {
            // Wide spread or no bid-ask data → tick rule only
            side = this._tickRule(price, prev);
        }

        const classified = { side, price, quantity, timestamp };
        this._lastTick.set(symbol, { price, side });
        return classified;
    }

    /**
     * Reset state for a symbol (call at market open).
     * @param {string} symbol
     */
    reset(symbol) {
        this._lastTick.delete(symbol);
    }

    /**
     * Reset all symbols (call at session start).
     */
    resetAll() {
        this._lastTick.clear();
    }

    // ── Private ─────────────────────────────────────────────────────────────

    _tickRule(price, prev) {
        if (!prev) return TICK_SIDE.NEUTRAL;
        if (price > prev.price) return TICK_SIDE.BUY;
        if (price < prev.price) return TICK_SIDE.SELL;
        // Price unchanged → inherit previous side (Lee-Ready continuation)
        return prev.side ?? TICK_SIDE.NEUTRAL;
    }
}