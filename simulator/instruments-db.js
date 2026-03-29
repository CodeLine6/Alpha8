/**
 * instruments-db.js
 *
 * Static map of NSE symbols → Kite-style instrument tokens for the simulator.
 * Tokens are synthetic but stable — same symbol always maps to the same token,
 * so Alpha8's symbolMap is consistent across simulator restarts.
 *
 * Also provides helpers to convert between symbol and token formats
 * that match what real Kite Connect returns.
 */

// Core NSE instruments (covers default WATCHLIST + common scout universe)
// Token range: 100000–999999 to avoid clashing with real Kite tokens
export const INSTRUMENTS = [
  // Nifty 50 & Index
  { symbol: 'NIFTY 50',      token: 256265, exchange: 'NSE', instrumentType: 'INDEX', lotSize: 1  },
  { symbol: 'NIFTY BANK',    token: 260105, exchange: 'NSE', instrumentType: 'INDEX', lotSize: 1  },

  // Nifty 50 constituents
  { symbol: 'RELIANCE',      token: 100001, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TCS',           token: 100002, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'INFY',          token: 100003, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'HDFCBANK',      token: 100004, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ICICIBANK',     token: 100005, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'WIPRO',         token: 100006, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'SBIN',          token: 100007, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BAJFINANCE',    token: 100008, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'AXISBANK',      token: 100009, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'HINDUNILVR',    token: 100010, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'MARUTI',        token: 100011, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'KOTAKBANK',     token: 100012, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'LT',            token: 100013, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ASIANPAINT',    token: 100014, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'SUNPHARMA',     token: 100015, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TITAN',         token: 100016, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ULTRACEMCO',    token: 100017, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'NESTLEIND',     token: 100018, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'POWERGRID',     token: 100019, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'NTPC',          token: 100020, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ONGC',          token: 100021, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'JSWSTEEL',      token: 100022, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TATAMOTORS',    token: 100023, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TATASTEEL',     token: 100024, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'HCLTECH',       token: 100025, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TECHM',         token: 100026, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'CIPLA',         token: 100027, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'DRREDDY',       token: 100028, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'DIVISLAB',      token: 100029, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BRITANNIA',     token: 100030, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'GRASIM',        token: 100031, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'HINDALCO',      token: 100032, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ADANIENT',      token: 100033, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ADANIPORTS',    token: 100034, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BAJAJFINSV',    token: 100035, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BAJAJ-AUTO',    token: 100036, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'EICHERMOT',     token: 100037, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'HEROMOTOCO',    token: 100038, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'INDUSINDBK',    token: 100039, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'WIPRO',         token: 100040, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'M&M',           token: 100041, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BHARTIARTL',    token: 100042, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'COALINDIA',     token: 100043, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BPCL',          token: 100044, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'IOC',           token: 100045, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'HDFCLIFE',      token: 100046, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'SBILIFE',       token: 100047, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TATACONSUM',    token: 100048, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'APOLLOHOSP',    token: 100049, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'UPL',           token: 100050, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },

  // Extended universe — scouted symbols + common ITC/midcap additions
  { symbol: 'ITC',           token: 100051, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'LUPIN',         token: 100052, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'NHPC',          token: 100053, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'WAAREEENER',    token: 100054, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TIINDIA',       token: 100055, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'ADANIPOWER',    token: 100056, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'POWERINDIA',    token: 100057, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'BSE',           token: 100058, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'PREMIERENE',    token: 100059, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'PERSISTENT',    token: 100060, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
  { symbol: 'TORNTPHARM',    token: 100061, exchange: 'NSE', instrumentType: 'EQ', lotSize: 1 },
];

// Build lookup maps
const _bySymbol = new Map(INSTRUMENTS.map(i => [i.symbol, i]));
const _byToken  = new Map(INSTRUMENTS.map(i => [i.token, i]));

/** @returns {Object|undefined} */
export function getBySymbol(symbol) {
  return _bySymbol.get(symbol);
}

/** @returns {Object|undefined} */
export function getByToken(token) {
  return _byToken.get(token);
}

/** @returns {number|undefined} */
export function symbolToToken(symbol) {
  return _bySymbol.get(symbol)?.token;
}

/** @returns {string|undefined} */
export function tokenToSymbol(token) {
  return _byToken.get(token)?.symbol;
}

/**
 * Returns the full instrument list in Kite CSV-dump shape.
 * Kite's /api/instruments returns an array of objects like:
 * { instrument_token, tradingsymbol, exchange, instrument_type, lot_size, ... }
 */
export function getKiteInstrumentList() {
  return INSTRUMENTS.map(i => ({
    instrument_token: i.token,
    exchange_token:   Math.floor(i.token / 256),
    tradingsymbol:    i.symbol,
    name:             i.symbol,
    last_price:       0,
    expiry:           '',
    strike:           0,
    tick_size:        0.05,
    lot_size:         i.lotSize,
    instrument_type:  i.instrumentType,
    segment:          i.exchange,
    exchange:         i.exchange,
  }));
}

/**
 * Map of token → symbol for use in TickFeed's symbolMap.
 * @returns {Object}
 */
export function buildSymbolMap() {
  const map = {};
  for (const [token, inst] of _byToken) {
    map[token] = inst.symbol;
  }
  return map;
}
