const fetch = require('node-fetch');

// In-memory cache
let rainCache = { data: null, ts: 0 };
let enlvCache = { data: null, ts: 0 };

const RAIN_TTL = 30 * 1000; // 30s
const ENLV_TTL = 60 * 1000; // 60s

// RAIN token on Arbitrum — top-volume pool RAIN/WETH 0.01% on Uniswap V3.
// Pool: 0xd13040d4fe917ee704158cfcb3338dcd2838b245
const RAIN_POOL_URL =
  'https://api.geckoterminal.com/api/v2/networks/arbitrum/pools/0xd13040d4fe917ee704158cfcb3338dcd2838b245';

async function fetchRainPrice() {
  const now = Date.now();
  if (rainCache.data && now - rainCache.ts < RAIN_TTL) return rainCache.data;
  try {
    const r = await fetch(RAIN_POOL_URL, {
      headers: { Accept: 'application/json;version=20230302' },
      timeout: 10000,
    });
    if (!r.ok) throw new Error('gecko ' + r.status);
    const j = await r.json();
    const attr = j?.data?.attributes || {};
    const price = parseFloat(attr.base_token_price_usd || attr.price_usd || '0');
    const change24h = parseFloat(
      attr.price_change_percentage?.h24 ?? attr.price_change_percentage_h24 ?? '0'
    );
    const data = {
      symbol: 'RAIN',
      price_usd: price,
      change_24h_pct: change24h,
      source: 'geckoterminal',
      fetched_at: new Date().toISOString(),
    };
    rainCache = { data, ts: now };
    return data;
  } catch (e) {
    if (rainCache.data) return { ...rainCache.data, stale: true };
    return {
      symbol: 'RAIN',
      price_usd: 0,
      change_24h_pct: 0,
      source: 'geckoterminal',
      error: String(e.message || e),
      fetched_at: new Date().toISOString(),
    };
  }
}

async function fetchEnlvPrice() {
  const now = Date.now();
  if (enlvCache.data && now - enlvCache.ts < ENLV_TTL) return enlvCache.data;
  try {
    const url =
      'https://query1.finance.yahoo.com/v8/finance/chart/ENLV?interval=1d&range=5d';
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Stormfound/1.0',
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    if (!r.ok) throw new Error('yahoo ' + r.status);
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const meta = result?.meta || {};
    const price = parseFloat(meta.regularMarketPrice || 0);
    const prevClose =
      parseFloat(meta.chartPreviousClose || meta.previousClose || price) || price;
    const change24h = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const data = {
      symbol: 'ENLV',
      price_usd: price,
      change_24h_pct: change24h,
      source: 'yahoo',
      market_state: meta.marketState || 'UNKNOWN',
      fetched_at: new Date().toISOString(),
    };
    enlvCache = { data, ts: now };
    return data;
  } catch (e) {
    if (enlvCache.data) return { ...enlvCache.data, stale: true };
    return {
      symbol: 'ENLV',
      price_usd: 0,
      change_24h_pct: 0,
      source: 'yahoo',
      error: String(e.message || e),
      fetched_at: new Date().toISOString(),
    };
  }
}

async function fetchAll() {
  const [rain, enlv] = await Promise.all([fetchRainPrice(), fetchEnlvPrice()]);
  return { RAIN: rain, ENLV: enlv };
}

module.exports = { fetchAll, fetchRainPrice, fetchEnlvPrice };
