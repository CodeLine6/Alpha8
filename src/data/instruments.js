import { createLogger } from '../lib/logger.js';
import { cacheSet, cacheGet } from '../lib/redis.js';

const log = createLogger('instruments');

/**
 * NSE/BSE Instrument Manager.
 *
 * Fetches, caches, and provides lookup for all tradeable instruments.
 * Instruments are cached in Redis for the full trading day (refreshed daily).
 *
 * @module instruments
 */

/**
 * @typedef {Object} Instrument
 * @property {number} instrumentToken - Kite instrument token
 * @property {string} tradingSymbol - e.g. 'RELIANCE'
 * @property {string} name - Full company/instrument name
 * @property {string} exchange - NSE, BSE, NFO
 * @property {string} segment - NSE, BSE, NFO-FUT, NFO-OPT
 * @property {string} instrumentType - EQ, FUT, CE, PE
 * @property {number} lotSize - Lot size for F&O
 * @property {number} tickSize - Minimum price movement
 * @property {string} expiry - Expiry date for derivatives
 */

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
   * Should be called once at startup (pre-market).
   * @param {string[]} [exchanges=['NSE', 'BSE']] - Exchanges to load
   * @returns {Promise<number>} Count of instruments loaded
   */
  async load(exchanges = ['NSE', 'BSE']) {
    const cacheKey = `instruments:${exchanges.join(',')}`;

    // Try cache first (instruments refresh daily)
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

    // Fetch from broker
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

      // Cache for 24 hours (instruments don't change intraday)
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

  /**
   * Normalize a raw Kite instrument to our standard shape.
   * @private
   */
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
   * @private
   * @param {Instrument[]} instruments
   */
  _buildMaps(instruments) {
    this._bySymbol.clear();
    this._byToken.clear();
    this._byExchange.clear();

    instruments.forEach((inst) => {
      const key = `${inst.exchange}:${inst.tradingSymbol}`;
      this._bySymbol.set(key, inst);
      this._bySymbol.set(inst.tradingSymbol, inst); // Also map by symbol alone (last wins for dupes)
      this._byToken.set(inst.instrumentToken, inst);

      if (!this._byExchange.has(inst.exchange)) {
        this._byExchange.set(inst.exchange, []);
      }
      this._byExchange.get(inst.exchange).push(inst);
    });

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
   * @param {number} token - Kite instrument token
   * @returns {Instrument|null}
   */
  getByToken(token) {
    return this._byToken.get(token) || null;
  }

  /**
   * Get the instrument token for a symbol.
   * @param {string} symbol
   * @returns {number|null}
   */
  getToken(symbol) {
    const inst = this.getBySymbol(symbol);
    return inst ? inst.instrumentToken : null;
  }

  /**
   * Search instruments by partial name/symbol match.
   * @param {string} query - Search query
   * @param {string} [exchange] - Optional exchange filter
   * @param {number} [limit=20] - Max results
   * @returns {Instrument[]}
   */
  search(query, exchange, limit = 20) {
    const q = query.toUpperCase();
    let results = [];

    const source = exchange
      ? this._byExchange.get(exchange) || []
      : [...this._bySymbol.values()];

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
   * Get all equity instruments (instrumentType = 'EQ') for an exchange.
   * @param {string} [exchange='NSE']
   * @returns {Instrument[]}
   */
  getEquities(exchange = 'NSE') {
    const instruments = this._byExchange.get(exchange) || [];
    return instruments.filter((i) => i.instrumentType === 'EQ');
  }

  /**
   * Build a symbol→token map for a list of symbols. Useful for TickFeed.
   * @param {string[]} symbols - e.g. ['RELIANCE', 'TCS', 'INFY']
   * @returns {{ tokens: number[], symbolMap: Record<number, string> }}
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

  /**
   * Get loader status.
   * @returns {{ loaded: boolean, symbolCount: number, tokenCount: number, exchanges: string[] }}
   */
  getStatus() {
    return {
      loaded: this._loaded,
      symbolCount: this._bySymbol.size,
      tokenCount: this._byToken.size,
      exchanges: [...this._byExchange.keys()],
    };
  }
}
