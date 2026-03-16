import { createLogger } from '../lib/logger.js';
import { cacheSet, cacheGet } from '../lib/redis.js';

const log = createLogger('instruments');

/**
 * NSE/BSE Instrument Manager.
 *
 * FIX: _buildMaps() now prefers NSE over BSE when the same tradingsymbol
 *      exists on both exchanges. Previously BSE overwrote NSE in the bare
 *      symbol map because BSE is loaded second, meaning getToken('RELIANCE')
 *      returned the BSE instrument token. All Alpha8 orders are placed on NSE
 *      so bare symbol lookups must resolve to NSE tokens.
 *
 * @module instruments
 */

/**
 * @typedef {Object} Instrument
 * @property {number} instrumentToken
 * @property {string} tradingSymbol
 * @property {string} name
 * @property {string} exchange
 * @property {string} segment
 * @property {string} instrumentType
 * @property {number} lotSize
 * @property {number} tickSize
 * @property {string} expiry
 */

// Exchange preference order for bare symbol lookup (first match wins)
const EXCHANGE_PREFERENCE = ['NSE', 'NFO', 'BSE'];

export class InstrumentManager {
  /**
   * @param {Object} broker - BrokerManager or KiteClient instance
   */
  constructor(broker) {
    this.broker = broker;

    /** @type {Map<string, Instrument>} symbol → instrument */
    this._bySymbol = new Map();

    /** @type {Map<number, Instrument>} token → instrument */
    this._byToken = new Map();

    /** @type {Map<string, Instrument[]>} exchange → instruments */
    this._byExchange = new Map();

    this._loaded = false;
  }

  /**
   * Load instruments from broker API or Redis cache.
   * @param {string[]} [exchanges=['NSE', 'BSE']]
   * @returns {Promise<number>} Count of instruments loaded
   */
  async load(exchanges = ['NSE', 'BSE']) {
    const cacheKey = `instruments:${exchanges.join(',')}`;

    try {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        this._buildMaps(cached);
        log.info({ count: cached.length, source: 'cache' }, 'Instruments loaded from cache');
        return cached.length;
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Cache read failed for instruments');
    }

    let allInstruments = [];
    for (const exchange of exchanges) {
      try {
        log.info({ exchange }, 'Fetching instruments from broker');
        const instruments = await this.broker.getInstruments(exchange);
        allInstruments = allInstruments.concat(
          instruments.map((inst) => this._normalizeInstrument(inst, exchange))
        );
      } catch (err) {
        log.error({ exchange, err: err.message }, 'Failed to fetch instruments');
      }
    }

    if (allInstruments.length > 0) {
      this._buildMaps(allInstruments);
      try {
        await cacheSet(cacheKey, allInstruments, 86400);
        log.info({ count: allInstruments.length }, 'Instruments cached for 24h');
      } catch (err) {
        log.warn({ err: err.message }, 'Failed to cache instruments');
      }
    }

    this._loaded = true;
    log.info({ count: allInstruments.length, exchanges }, 'Instruments loaded');
    return allInstruments.length;
  }

  /** @private */
  _normalizeInstrument(raw, exchange) {
    return {
      instrumentToken: raw.instrument_token || raw.instrumentToken,
      tradingSymbol: raw.tradingsymbol || raw.trading_symbol || raw.tradingSymbol,
      name: raw.name || '',
      exchange: raw.exchange || exchange,
      segment: raw.segment || exchange,
      instrumentType: raw.instrument_type || raw.instrumentType || 'EQ',
      lotSize: raw.lot_size || raw.lotSize || 1,
      tickSize: raw.tick_size || raw.tickSize || 0.05,
      expiry: raw.expiry || null,
    };
  }

  /**
   * Build lookup maps from instrument array.
   *
   * FIX: Bare symbol map (without exchange prefix) now uses EXCHANGE_PREFERENCE
   * order (NSE > NFO > BSE) instead of last-write-wins. This ensures that
   * getToken('RELIANCE') always returns the NSE token, not BSE, regardless of
   * the order instruments are loaded.
   *
   * Exchange-qualified lookups (e.g. 'BSE:RELIANCE') are always exact.
   *
   * @private
   * @param {Instrument[]} instruments
   */
  _buildMaps(instruments) {
    this._bySymbol.clear();
    this._byToken.clear();
    this._byExchange.clear();

    // First pass: build token map and exchange-qualified symbol map
    // These are always exact — no preference logic needed
    for (const inst of instruments) {
      // Always map by token (unique)
      this._byToken.set(inst.instrumentToken, inst);

      // Always map by exchange-qualified key (exact lookup)
      const qualifiedKey = `${inst.exchange}:${inst.tradingSymbol}`;
      this._bySymbol.set(qualifiedKey, inst);

      // Build exchange buckets
      if (!this._byExchange.has(inst.exchange)) {
        this._byExchange.set(inst.exchange, []);
      }
      this._byExchange.get(inst.exchange).push(inst);
    }

    // Second pass: build bare symbol map with exchange preference
    // Group instruments by tradingSymbol, then pick winner by EXCHANGE_PREFERENCE
    const byTradingSymbol = new Map();
    for (const inst of instruments) {
      const sym = inst.tradingSymbol;
      if (!byTradingSymbol.has(sym)) {
        byTradingSymbol.set(sym, []);
      }
      byTradingSymbol.get(sym).push(inst);
    }

    for (const [sym, candidates] of byTradingSymbol.entries()) {
      if (candidates.length === 1) {
        // Only one exchange — no preference needed
        this._bySymbol.set(sym, candidates[0]);
        continue;
      }

      // Multiple exchanges — pick by preference order
      let winner = null;
      for (const preferredExchange of EXCHANGE_PREFERENCE) {
        winner = candidates.find(c => c.exchange === preferredExchange) || null;
        if (winner) break;
      }

      // Fallback: first in list if none matched preference
      this._bySymbol.set(sym, winner || candidates[0]);

      log.debug({
        symbol: sym,
        exchanges: candidates.map(c => c.exchange),
        selected: (winner || candidates[0]).exchange,
      }, 'Bare symbol lookup resolved via exchange preference');
    }

    this._loaded = true;
  }

  /**
   * Look up an instrument by trading symbol.
   * @param {string} symbol - e.g. 'RELIANCE' or 'NSE:RELIANCE'
   * @returns {Instrument|null}
   */
  getBySymbol(symbol) {
    return this._bySymbol.get(symbol) || null;
  }

  /**
   * Look up an instrument by token.
   * @param {number} token
   * @returns {Instrument|null}
   */
  getByToken(token) {
    return this._byToken.get(token) || null;
  }

  /**
   * Get the instrument token for a symbol.
   * Always returns NSE token for bare symbols (e.g. 'RELIANCE').
   * Returns exchange-specific token for qualified symbols (e.g. 'BSE:RELIANCE').
   * @param {string} symbol
   * @returns {number|null}
   */
  getToken(symbol) {
    const inst = this.getBySymbol(symbol);
    return inst ? inst.instrumentToken : null;
  }

  /**
   * Search instruments by partial name/symbol match.
   */
  search(query, exchange, limit = 20) {
    const q = query.toUpperCase();
    let results = [];
    const source = exchange
      ? this._byExchange.get(exchange) || []
      : [...this._byToken.values()]; // use token map to avoid duplicates

    for (const inst of source) {
      if (
        inst.tradingSymbol?.toUpperCase().includes(q) ||
        inst.name?.toUpperCase().includes(q)
      ) {
        results.push(inst);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get all equity instruments for an exchange.
   */
  getEquities(exchange = 'NSE') {
    const instruments = this._byExchange.get(exchange) || [];
    return instruments.filter((i) => i.instrumentType === 'EQ');
  }

  /**
   * Build a symbol→token map for a list of symbols.
   * Bare symbols resolve to NSE tokens via exchange preference.
   */
  resolveSymbols(symbols) {
    const tokens = [];
    const symbolMap = {};

    for (const sym of symbols) {
      const inst = this.getBySymbol(sym);
      if (inst) {
        tokens.push(inst.instrumentToken);
        symbolMap[inst.instrumentToken] = inst.tradingSymbol;
      } else {
        log.warn({ symbol: sym }, 'Symbol not found in instruments');
      }
    }

    return { tokens, symbolMap };
  }

  getStatus() {
    return {
      loaded: this._loaded,
      symbolCount: this._bySymbol.size,
      tokenCount: this._byToken.size,
      exchanges: [...this._byExchange.keys()],
    };
  }
}