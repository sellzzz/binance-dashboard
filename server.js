import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { Interface } from "ethers";

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = join(process.cwd(), "public");
const BINANCE_FAPI = "https://fapi.binance.com";
const COINGECKO_API = "https://api.coingecko.com/api/v3";
const DEXSCREENER_API = "https://api.dexscreener.com";
const BSC_RPC = process.env.BSC_RPC || "https://bsc-dataseed.binance.org";
const CACHE_MS = 30_000;
const MACRO_CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SCAN_CACHE = 60;
const REVERSAL_CACHE_MS = 5 * 60_000;
const FRED_API = "https://api.stlouisfed.org/fred/series/observations";
const CME_FEDWATCH_API = process.env.CME_FEDWATCH_API_URL || "https://markets.api.cmegroup.com/fedwatch/v1";
const CONCURRENCY = 12;

let symbolsCache = { at: 0, data: [] };
let marketCapCache = { at: 0, data: new Map() };
let fundingCache = { at: 0, data: new Map() };
let bscContractCache = { at: 0, data: new Map() };
let bscPoolCache = new Map();
let pancakeV3PoolCache = new Map();
let scanCache = new Map();
let pancakeRangeCache = new Map();
let reversalCache = new Map();
let vixCache = { at: 0, data: null };
let dxyCache = { at: 0, data: null };

const POOL_IFACE = new Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
]);
const ERC20_IFACE = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(payload));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseInteger(value, fallback, min, max) {
  return Math.round(parseNumber(value, fallback, min, max));
}

async function binance(path) {
  const response = await fetchWithTimeout(`${BINANCE_FAPI}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Binance ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function coingecko(path) {
  const response = await fetchWithTimeout(`${COINGECKO_API}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CoinGecko ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function dexscreener(path) {
  const response = await fetchWithTimeout(`${DEXSCREENER_API}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DexScreener ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function yahooChart(symbol, params) {
  const query = new URLSearchParams(params);
  const response = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, {
    headers: { "user-agent": "market-data-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Yahoo ${response.status}: ${text.slice(0, 180)}`);
  }
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description || "Yahoo chart data unavailable");
  return result;
}

const reversalPresets = new Map([
  ["1810.HK", { symbol: "1810.HK", name: "小米集团", market: "港股", source: "yahoo", sourceSymbol: "1810.HK" }],
  ["0700.HK", { symbol: "0700.HK", name: "腾讯控股", market: "港股", source: "yahoo", sourceSymbol: "0700.HK" }],
  ["9988.HK", { symbol: "9988.HK", name: "阿里巴巴", market: "港股", source: "yahoo", sourceSymbol: "9988.HK" }],
  ["3690.HK", { symbol: "3690.HK", name: "美团", market: "港股", source: "yahoo", sourceSymbol: "3690.HK" }],
  ["9618.HK", { symbol: "9618.HK", name: "京东集团", market: "港股", source: "yahoo", sourceSymbol: "9618.HK" }],
  ["9999.HK", { symbol: "9999.HK", name: "网易", market: "港股", source: "yahoo", sourceSymbol: "9999.HK" }],
  ["2318.HK", { symbol: "2318.HK", name: "中国平安", market: "港股", source: "yahoo", sourceSymbol: "2318.HK" }],
  ["0941.HK", { symbol: "0941.HK", name: "中国移动", market: "港股", source: "yahoo", sourceSymbol: "0941.HK" }],
  ["0388.HK", { symbol: "0388.HK", name: "香港交易所", market: "港股", source: "yahoo", sourceSymbol: "0388.HK" }],
  ["0005.HK", { symbol: "0005.HK", name: "汇丰控股", market: "港股", source: "yahoo", sourceSymbol: "0005.HK" }],
  ["XAUUSD", { symbol: "XAUUSD", name: "黄金", market: "贵金属", source: "yahoo", sourceSymbol: "GC=F" }],
  ["XAGUSD", { symbol: "XAGUSD", name: "白银", market: "贵金属", source: "yahoo", sourceSymbol: "SI=F" }],
  ["BTCUSDT", { symbol: "BTCUSDT", name: "Bitcoin", market: "加密资产", source: "binance", sourceSymbol: "BTCUSDT" }],
  ["ETHUSDT", { symbol: "ETHUSDT", name: "Ethereum", market: "加密资产", source: "binance", sourceSymbol: "ETHUSDT" }],
  ["BNBUSDT", { symbol: "BNBUSDT", name: "BNB", market: "加密资产", source: "binance", sourceSymbol: "BNBUSDT" }],
  ["SOLUSDT", { symbol: "SOLUSDT", name: "Solana", market: "加密资产", source: "binance", sourceSymbol: "SOLUSDT" }],
  ["XRPUSDT", { symbol: "XRPUSDT", name: "XRP", market: "加密资产", source: "binance", sourceSymbol: "XRPUSDT" }],
  ["DOGEUSDT", { symbol: "DOGEUSDT", name: "Dogecoin", market: "加密资产", source: "binance", sourceSymbol: "DOGEUSDT" }],
  ["ADAUSDT", { symbol: "ADAUSDT", name: "Cardano", market: "加密资产", source: "binance", sourceSymbol: "ADAUSDT" }],
  ["SUIUSDT", { symbol: "SUIUSDT", name: "Sui", market: "加密资产", source: "binance", sourceSymbol: "SUIUSDT" }],
  ["AVAXUSDT", { symbol: "AVAXUSDT", name: "Avalanche", market: "加密资产", source: "binance", sourceSymbol: "AVAXUSDT" }],
  ["LINKUSDT", { symbol: "LINKUSDT", name: "Chainlink", market: "加密资产", source: "binance", sourceSymbol: "LINKUSDT" }],
  ["TRXUSDT", { symbol: "TRXUSDT", name: "TRON", market: "加密资产", source: "binance", sourceSymbol: "TRXUSDT" }],
  ["LTCUSDT", { symbol: "LTCUSDT", name: "Litecoin", market: "加密资产", source: "binance", sourceSymbol: "LTCUSDT" }],
  ["AAVEUSDT", { symbol: "AAVEUSDT", name: "Aave", market: "加密资产", source: "binance", sourceSymbol: "AAVEUSDT" }],
  ["ARBUSDT", { symbol: "ARBUSDT", name: "Arbitrum", market: "加密资产", source: "binance", sourceSymbol: "ARBUSDT" }],
  ["OPUSDT", { symbol: "OPUSDT", name: "Optimism", market: "加密资产", source: "binance", sourceSymbol: "OPUSDT" }],
  ["WIFUSDT", { symbol: "WIFUSDT", name: "dogwifhat", market: "加密资产", source: "binance", sourceSymbol: "WIFUSDT" }],
  ["BCHUSDT", { symbol: "BCHUSDT", name: "Bitcoin Cash", market: "加密资产", source: "binance", sourceSymbol: "BCHUSDT" }],
  ["ETCUSDT", { symbol: "ETCUSDT", name: "Ethereum Classic", market: "加密资产", source: "binance", sourceSymbol: "ETCUSDT" }],
  ["ATOMUSDT", { symbol: "ATOMUSDT", name: "Cosmos", market: "加密资产", source: "binance", sourceSymbol: "ATOMUSDT" }],
  ["DOTUSDT", { symbol: "DOTUSDT", name: "Polkadot", market: "加密资产", source: "binance", sourceSymbol: "DOTUSDT" }],
  ["CRVUSDT", { symbol: "CRVUSDT", name: "Curve", market: "加密资产", source: "binance", sourceSymbol: "CRVUSDT" }],
  ["RUNEUSDT", { symbol: "RUNEUSDT", name: "THORChain", market: "加密资产", source: "binance", sourceSymbol: "RUNEUSDT" }],
  ["EGLDUSDT", { symbol: "EGLDUSDT", name: "MultiversX", market: "加密资产", source: "binance", sourceSymbol: "EGLDUSDT" }],
  ["UNIUSDT", { symbol: "UNIUSDT", name: "Uniswap", market: "加密资产", source: "binance", sourceSymbol: "UNIUSDT" }],
  ["NEARUSDT", { symbol: "NEARUSDT", name: "NEAR Protocol", market: "加密资产", source: "binance", sourceSymbol: "NEARUSDT" }],
  ["FILUSDT", { symbol: "FILUSDT", name: "Filecoin", market: "加密资产", source: "binance", sourceSymbol: "FILUSDT" }],
  ["IMXUSDT", { symbol: "IMXUSDT", name: "Immutable", market: "加密资产", source: "binance", sourceSymbol: "IMXUSDT" }],
  ["INJUSDT", { symbol: "INJUSDT", name: "Injective", market: "加密资产", source: "binance", sourceSymbol: "INJUSDT" }],
  ["APTUSDT", { symbol: "APTUSDT", name: "Aptos", market: "加密资产", source: "binance", sourceSymbol: "APTUSDT" }],
  ["STXUSDT", { symbol: "STXUSDT", name: "Stacks", market: "加密资产", source: "binance", sourceSymbol: "STXUSDT" }],
  ["SEIUSDT", { symbol: "SEIUSDT", name: "Sei", market: "加密资产", source: "binance", sourceSymbol: "SEIUSDT" }],
  ["TIAUSDT", { symbol: "TIAUSDT", name: "Celestia", market: "加密资产", source: "binance", sourceSymbol: "TIAUSDT" }],
  ["KASUSDT", { symbol: "KASUSDT", name: "Kaspa", market: "加密资产", source: "binance", sourceSymbol: "KASUSDT" }],
  ["JUPUSDT", { symbol: "JUPUSDT", name: "Jupiter", market: "加密资产", source: "binance", sourceSymbol: "JUPUSDT" }],
  ["TAOUSDT", { symbol: "TAOUSDT", name: "Bittensor", market: "加密资产", source: "binance", sourceSymbol: "TAOUSDT" }],
  ["POLUSDT", { symbol: "POLUSDT", name: "Polygon", market: "加密资产", source: "binance", sourceSymbol: "POLUSDT" }],
  ["PENGUUSDT", { symbol: "PENGUUSDT", name: "PENGU", market: "加密资产", source: "binance", sourceSymbol: "PENGUUSDT" }],
  ["BUSDT", { symbol: "BUSDT", name: "B", market: "加密资产", source: "binance", sourceSymbol: "BUSDT" }],
]);

function resolveReversalAsset(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  if (reversalPresets.has(raw)) return reversalPresets.get(raw);
  if (/\.HK$|=|\^|-USD$/.test(raw)) {
    return { symbol: raw, name: raw, market: "自定义行情", source: "yahoo", sourceSymbol: raw };
  }
  return { symbol: raw, name: raw, market: "币安合约", source: "binance", sourceSymbol: raw };
}

async function getTopReversalFutures(limit = 30) {
  const response = await fetchWithTimeout("https://fapi.binance.com/fapi/v1/ticker/24hr", { timeoutMs: 15_000 });
  if (!response.ok) throw new Error(`Binance 24h ticker ${response.status}`);
  const tickers = await response.json();
  return tickers
    .filter((ticker) => ticker.symbol?.endsWith("USDT") && !ticker.symbol.includes("_") && Number(ticker.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, limit)
    .map((ticker) => resolveReversalAsset(ticker.symbol));
}

async function getDefaultReversalAssets() {
  const fixedSymbols = ["1810.HK", "0700.HK", "9988.HK", "3690.HK", "9618.HK", "9999.HK", "2318.HK", "0941.HK", "0388.HK", "0005.HK", "XAUUSD", "XAGUSD"];
  const fixed = fixedSymbols.map(resolveReversalAsset).filter(Boolean);
  try {
    return [...fixed, ...(await getTopReversalFutures(28))].slice(0, 40);
  } catch {
    return fixed;
  }
}

async function getReversalCandles(asset) {
  if (asset.source === "yahoo") {
    const chart = await yahooChart(asset.sourceSymbol, { range: "1y", interval: "1d" });
    const timestamps = chart.timestamp || [];
    const quote = chart.indicators?.quote?.[0] || {};
    return timestamps.map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index]),
    })).filter((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite));
  }

  const rows = await binance(`/fapi/v1/klines?symbol=${encodeURIComponent(asset.sourceSymbol)}&interval=1d&limit=365`);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite));
}

function averageRange(candles, index) {
  const rows = candles.slice(Math.max(1, index - 13), index + 1);
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Math.max(0, row.high - row.low), 0) / rows.length;
}

function isPivot(candles, index, side) {
  const pivot = side === "support" ? candles[index].low : candles[index].high;
  for (let offset = -2; offset <= 2; offset += 1) {
    if (!offset) continue;
    const value = side === "support" ? candles[index + offset].low : candles[index + offset].high;
    if (side === "support" && value < pivot) return false;
    if (side === "resistance" && value > pivot) return false;
  }
  return true;
}

function touchesZone(candle, zone) {
  return candle.low <= zone.high && candle.high >= zone.low;
}

function buildReversalSignal(asset, candles) {
  if (candles.length < 20) return { status: "insufficient_data", current: null, signals: [], zones: [] };
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const currentIndex = candles.length - 1;
  const minAgeBars = asset.source === "binance" ? 14 : 10;
  const proximityPct = 1.2;
  const candidates = [];

  for (const side of ["support", "resistance"]) {
    for (let index = 2; index <= currentIndex - 3; index += 1) {
      if (!isPivot(candles, index, side) || currentIndex - index < minAgeBars) continue;
      const point = side === "support" ? candles[index].low : candles[index].high;
      const width = Math.max(point * 0.01, averageRange(candles, index) * 0.7);
      const zone = side === "support"
        ? { low: point - width * 0.35, high: point + width }
        : { low: point - width, high: point + width * 0.35 };
      const previousBars = candles.slice(index + 3, currentIndex);
      const priorTouchCount = previousBars.filter((candle) => touchesZone(candle, zone)).length;
      const hadPriorTouch = priorTouchCount > 0;
      const isTouching = touchesZone(current, zone);
      const distance = current.close < zone.low
        ? ((zone.low - current.close) / current.close) * 100
        : current.close > zone.high
          ? ((current.close - zone.high) / current.close) * 100
          : 0;
      const movingToward = side === "support"
        ? current.close < previous.close
        : current.close > previous.close;
      const isApproaching = !isTouching && movingToward && Math.abs(distance) <= proximityPct;
      candidates.push({
        type: side === "support" ? "support-touch" : "resistance-touch",
        label: side === "support" ? "支撑区第二次确认" : "阻力区第二次确认",
        direction: side === "support" ? "potential-rebound" : "potential-pullback",
        zoneLow: zone.low,
        zoneHigh: zone.high,
        point,
        originTime: candles[index].timestamp,
        touchTime: current.timestamp,
        ageBars: currentIndex - index,
        distancePct: Math.abs(distance),
        wickSize: side === "support" ? current.low : current.high,
        isTouching,
        isFirstTouch: isTouching && !hadPriorTouch,
        isSecondTouch: isTouching && priorTouchCount === 1,
        isApproaching,
        isFirstApproach: isApproaching && priorTouchCount === 0,
        isSecondApproach: isApproaching && priorTouchCount === 1,
        priorTouchCount,
        hadPriorTouch,
      });
    }
  }

  const signals = candidates
    .filter((candidate) => candidate.isSecondTouch || candidate.isSecondApproach)
    .sort((a, b) => a.distancePct - b.distancePct || b.ageBars - a.ageBars);
  const zones = candidates
    .slice()
    .sort((a, b) => a.distancePct - b.distancePct || b.ageBars - a.ageBars)
    .slice(0, 6);
  return {
    status: signals.length ? (signals.some((signal) => signal.isSecondTouch) ? "second-touch" : "approaching") : "waiting",
    current: { price: current.close, time: current.timestamp },
    signals: signals.slice(0, 2),
    zones,
  };
}

async function handleReversalScan(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const symbols = url.searchParams.get("symbols")?.trim();
  const requested = symbols
    ? symbols.split(",").map(resolveReversalAsset).filter(Boolean).slice(0, 40)
    : await getDefaultReversalAssets();
  const key = requested.map((asset) => asset.symbol).join(",");
  const cached = reversalCache.get(key);
  if (cached && Date.now() - cached.at < REVERSAL_CACHE_MS) return json(res, 200, cached.data);

  try {
    const rows = await mapLimit(requested, 4, async (asset) => {
      try {
        const candles = await getReversalCandles(asset);
        return { ...asset, ...buildReversalSignal(asset, candles), error: null };
      } catch (error) {
        return { ...asset, status: "error", current: null, signals: [], zones: [], error: error.message };
      }
    });
    const data = {
      generatedAt: new Date().toISOString(),
      timeframe: "1D",
      selectionMode: symbols ? "manual" : "24h-quote-volume",
      minimumAgeBars: { stocks: 10, crypto: 14 },
      proximityPct: 1.2,
      minimumAgeText: "股票 10 个交易日 / 加密资产 14 根日线",
      rows,
      signals: rows.flatMap((row) => row.signals.map((signal) => ({ ...signal, ...row }))),
    };
    reversalCache.set(key, { at: Date.now(), data });
    json(res, 200, data);
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function getVix() {
  if (vixCache.data && Date.now() - vixCache.at < MACRO_CACHE_MS) return vixCache.data;
  const chart = await yahooChart("^VIX", { range: "5d", interval: "1d" });
  const meta = chart.meta || {};
  const closes = (chart.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(Number(value)));
  const value = Number(meta.regularMarketPrice ?? closes.at(-1));
  const metaPreviousClose = Number(meta.previousClose);
  const previousClose = metaPreviousClose > 0 ? metaPreviousClose : Number(closes.at(-2));
  if (!Number.isFinite(value)) throw new Error("VIX value unavailable");
  const change = Number.isFinite(previousClose) ? value - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  const data = {
    symbol: "VIX",
    name: "CBOE Volatility Index",
    value,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change,
    changePct,
    dayHigh: Number.isFinite(Number(meta.regularMarketDayHigh)) ? Number(meta.regularMarketDayHigh) : null,
    dayLow: Number.isFinite(Number(meta.regularMarketDayLow)) ? Number(meta.regularMarketDayLow) : null,
    yearHigh: Number.isFinite(Number(meta.fiftyTwoWeekHigh)) ? Number(meta.fiftyTwoWeekHigh) : null,
    yearLow: Number.isFinite(Number(meta.fiftyTwoWeekLow)) ? Number(meta.fiftyTwoWeekLow) : null,
    asOf: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    source: "Yahoo Finance",
  };
  vixCache = { at: Date.now(), data };
  return data;
}

async function getDxy() {
  if (dxyCache.data && Date.now() - dxyCache.at < MACRO_CACHE_MS) return dxyCache.data;
  const chart = await yahooChart("DX-Y.NYB", { range: "5d", interval: "1d" });
  const meta = chart.meta || {};
  const closes = (chart.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(Number(value)));
  const value = Number(meta.regularMarketPrice ?? closes.at(-1));
  const metaPreviousClose = Number(meta.previousClose);
  const previousClose = metaPreviousClose > 0 ? metaPreviousClose : Number(closes.at(-2));
  if (!Number.isFinite(value)) throw new Error("DXY value unavailable");
  const change = Number.isFinite(previousClose) ? value - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  const data = {
    symbol: "DXY",
    name: "U.S. Dollar Index",
    value,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change,
    changePct,
    dayHigh: Number.isFinite(Number(meta.regularMarketDayHigh)) ? Number(meta.regularMarketDayHigh) : null,
    dayLow: Number.isFinite(Number(meta.regularMarketDayLow)) ? Number(meta.regularMarketDayLow) : null,
    yearHigh: Number.isFinite(Number(meta.fiftyTwoWeekHigh)) ? Number(meta.fiftyTwoWeekHigh) : null,
    yearLow: Number.isFinite(Number(meta.fiftyTwoWeekLow)) ? Number(meta.fiftyTwoWeekLow) : null,
    asOf: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    source: "Yahoo Finance",
  };
  dxyCache = { at: Date.now(), data };
  return data;
}

function unavailableMacro(definition, status = "unavailable") {
  return { ...definition, status, value: null, previousClose: null, change: null, changePct: null, asOf: null };
}

async function getFredMacro(definition) {
  if (!process.env.FRED_API_KEY) return unavailableMacro(definition);
  const url = new URL(FRED_API);
  url.search = new URLSearchParams({
    series_id: definition.fredSeries,
    api_key: process.env.FRED_API_KEY,
    file_type: "json",
    sort_order: "desc",
    limit: "2",
  });
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`FRED ${response.status}`);
    const payload = await response.json();
    const observations = (payload.observations || [])
      .filter((item) => item.value !== "." && Number.isFinite(Number(item.value)))
      .slice(0, 2);
    if (!observations.length) return unavailableMacro(definition);
    const value = Number(observations[0].value);
    const previousClose = observations[1] ? Number(observations[1].value) : null;
    const change = Number.isFinite(previousClose) ? value - previousClose : null;
    return { ...definition, status: "live", value, previousClose, change, changePct: null, asOf: observations[0].date };
  } catch (error) {
    console.warn(`${definition.fredSeries}: ${error.message}`);
    return unavailableMacro(definition);
  }
}

async function getFedWatchMacros() {
  const definitions = macroDefinitions.filter((item) => item.fedField);
  if (!process.env.CME_FEDWATCH_OAUTH_TOKEN) return definitions.map((definition) => unavailableMacro(definition));
  try {
    const response = await fetchWithTimeout(`${CME_FEDWATCH_API.replace(/\/$/, "")}/forecasts`, {
      headers: {
        Authorization: `Bearer ${process.env.CME_FEDWATCH_OAUTH_TOKEN}`,
        Accept: "application/json",
        "CME-Application-Name": "binance-dashboard",
        "CME-Application-Vendor": "local",
        "CME-Application-Version": "1.0.0",
        "CME-Request-ID": `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        "User-Agent": "binance-dashboard/1.0",
      },
    });
    if (!response.ok) throw new Error(`CME ${response.status}`);
    const payload = await response.json();
    const meeting = payload.payload?.[0];
    if (!meeting) return definitions.map((definition) => unavailableMacro(definition));
    const ranges = (meeting.rateRange || []).filter((range) => Number.isFinite(Number(range.probability)));
    const topRange = ranges.slice().sort((a, b) => Number(b.probability) - Number(a.probability))[0];
    const probabilityText = ranges.length
      ? ranges.map((range) => `${Number(range.lowerRt) / 100}-${Number(range.upperRt) / 100}%: ${(Number(range.probability) * 100).toFixed(1)}%`).join(" / ")
      : null;
    return definitions.map((definition) => {
      if (definition.fedField === "meeting") return { ...definition, status: meeting.meetingDt ? "live" : "unavailable", value: meeting.meetingDt || null, change: null, changePct: null, asOf: meeting.reportingDt || null };
      if (definition.fedField === "range") return { ...definition, status: topRange ? "live" : "unavailable", value: topRange ? `${Number(topRange.lowerRt) / 100}-${Number(topRange.upperRt) / 100}%` : null, change: null, changePct: null, asOf: meeting.reportingDt || null };
      return { ...definition, status: probabilityText ? "live" : "unavailable", value: probabilityText, change: null, changePct: null, asOf: meeting.reportingDt || null };
    });
  } catch (error) {
    console.warn(`FedWatch: ${error.message}`);
    return definitions.map((definition) => unavailableMacro(definition));
  }
}

const macroDefinitions = [
  { id: "2y", label: "2Y 美债收益率", purpose: "观察短期利率与经济预期", source: "Yahoo Finance ^2YR", yahoo: "^2YR", frequency: "5 分钟" },
  { id: "5y", label: "5Y 美债收益率", purpose: "观察中短端利率变化", source: "Yahoo Finance ^5YR", yahoo: "^5YR", frequency: "5 分钟" },
  { id: "10y", label: "10Y 美债收益率", purpose: "观察市场核心无风险利率", source: "Yahoo Finance ^TNX", yahoo: "^TNX", scale: 0.1, frequency: "5 分钟" },
  { id: "30y", label: "30Y 美债收益率", purpose: "观察长期通胀与财政预期", source: "Yahoo Finance ^TYX", yahoo: "^TYX", scale: 0.1, frequency: "5 分钟" },
  { id: "gold", label: "黄金", purpose: "避险、通胀和美元压力参考", source: "Yahoo Finance GC=F", yahoo: "GC=F", frequency: "5 分钟" },
  { id: "silver", label: "白银", purpose: "贵金属需求和工业需求参考", source: "Yahoo Finance SI=F", yahoo: "SI=F", frequency: "5 分钟" },
  { id: "wti", label: "WTI 原油", purpose: "美国原油价格和通胀压力参考", source: "Yahoo Finance CL=F", yahoo: "CL=F", frequency: "5 分钟" },
  { id: "brent", label: "Brent 原油", purpose: "全球原油价格参考", source: "Yahoo Finance BZ=F", yahoo: "BZ=F", frequency: "5 分钟" },
  { id: "dxy", label: "DXY 美元指数", purpose: "判断美元整体强弱", source: "Yahoo Finance DX-Y.NYB", yahoo: "DX-Y.NYB", frequency: "5 分钟" },
  { id: "usdcny", label: "USD/CNY", purpose: "美元兑人民币汇率", source: "Yahoo Finance CNY=X", yahoo: "CNY=X", frequency: "5 分钟" },
  { id: "eurusd", label: "EUR/USD", purpose: "欧元兑美元，观察美元和欧洲市场变化", source: "Yahoo Finance EURUSD=X", yahoo: "EURUSD=X", frequency: "5 分钟" },
  { id: "usdjpy", label: "USD/JPY", purpose: "美元兑日元，观察避险和套息交易", source: "Yahoo Finance JPY=X", yahoo: "JPY=X", frequency: "5 分钟" },
  { id: "real10y", label: "10Y REAL", purpose: "10 年实际利率，衡量扣除通胀预期后的资金成本", source: "FRED DFII10", fredSeries: "DFII10", frequency: "每日" },
  { id: "be5y", label: "5Y BE", purpose: "未来 5 年的市场通胀预期", source: "FRED T5YIE", fredSeries: "T5YIE", frequency: "每日" },
  { id: "be10y", label: "10Y BE", purpose: "未来 10 年的市场通胀预期", source: "FRED T10YIE", fredSeries: "T10YIE", frequency: "每日" },
  { id: "fedMeeting", label: "Fed Futures 会议日期", purpose: "下一次美联储会议时间", source: "CME FedWatch API", fedField: "meeting", frequency: "工作日更新" },
  { id: "fedRange", label: "Fed Futures 目标利率区间", purpose: "市场对会议后利率区间的预期", source: "CME FedWatch API", fedField: "range", frequency: "工作日更新" },
  { id: "fedProbability", label: "Fed Futures 概率分布", purpose: "不同利率区间的市场定价概率", source: "CME FedWatch API", fedField: "probability", frequency: "工作日更新" },
  { id: "fedFunds", label: "Fed Funds Future 价格及隐含利率", purpose: "观察利率期货正在定价的平均利率", source: "Yahoo Finance / Investing", frequency: "1 小时" },
  { id: "vix", label: "VIX", purpose: "标普 500 短期期权波动率，常用恐慌指标", source: "Yahoo Finance ^VIX", yahoo: "^VIX", frequency: "5 分钟" },
  { id: "vvix", label: "VVIX", purpose: "VIX 自身的波动率，观察恐慌是否加剧", source: "Yahoo Finance ^VVIX", yahoo: "^VVIX", frequency: "5 分钟" },
  { id: "vix3m", label: "VIX3M", purpose: "三个月波动率，用于比较中期风险", source: "Yahoo Finance ^VIX3M", yahoo: "^VIX3M", frequency: "5 分钟" },
  { id: "es", label: "ES 标普期货", purpose: "观察标普 500 盘前和盘后方向", source: "Yahoo Finance ES=F", yahoo: "ES=F", frequency: "5 分钟" },
  { id: "nq", label: "NQ 纳指期货", purpose: "观察科技股和纳指方向", source: "Yahoo Finance NQ=F", yahoo: "NQ=F", frequency: "5 分钟" },
  { id: "rty", label: "RTY 罗素期货", purpose: "观察美国小盘股表现", source: "Yahoo Finance RTY=F", yahoo: "RTY=F", frequency: "5 分钟" },
];

let macroOverviewCache = { at: 0, data: null };

async function getMacroOverview() {
  if (macroOverviewCache.data && Date.now() - macroOverviewCache.at < MACRO_CACHE_MS) return macroOverviewCache.data;
  const rows = await mapLimit(macroDefinitions, 6, async (definition) => {
    if (definition.fredSeries) return getFredMacro(definition);
    if (definition.fedField) return unavailableMacro(definition);
    if (!definition.yahoo) return unavailableMacro(definition);
    try {
      const chart = await yahooChart(definition.yahoo, { range: "5d", interval: "1d" });
      const meta = chart.meta || {};
      const closes = (chart.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(Number(value)));
      const scale = definition.scale || 1;
      const value = Number(meta.regularMarketPrice ?? closes.at(-1)) * scale;
      const metaPreviousClose = Number(meta.previousClose);
      const previousClose = (metaPreviousClose > 0 ? metaPreviousClose : Number(closes.at(-2))) * scale;
      const change = Number.isFinite(previousClose) ? value - previousClose : null;
      return {
        ...definition,
        status: Number.isFinite(value) ? "live" : "unavailable",
        value: Number.isFinite(value) ? value : null,
        previousClose: Number.isFinite(previousClose) ? previousClose : null,
        change,
        changePct: Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null,
        asOf: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : null,
      };
    } catch {
      return { ...definition, status: "unavailable", value: null, change: null, changePct: null };
    }
  });
  const fedRows = await getFedWatchMacros();
  const fedByField = new Map(fedRows.map((row) => [row.fedField, row]));
  const data = {
    generatedAt: new Date().toISOString(),
    rows: rows.map((row) => row.fedField ? fedByField.get(row.fedField) || row : row),
  };
  macroOverviewCache = { at: Date.now(), data };
  return data;
}

async function rpc(method, params) {
  const response = await fetchWithTimeout(BSC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`BSC RPC ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "BSC RPC error");
  return payload.result;
}

async function contractCall(address, iface, fragment, args = []) {
  const data = iface.encodeFunctionData(fragment, args);
  const result = await rpc("eth_call", [{ to: address, data }, "latest"]);
  return iface.decodeFunctionResult(fragment, result);
}

function normalizeBaseAsset(baseAsset) {
  return baseAsset
    .replace(/^1000000/, "")
    .replace(/^1000/, "")
    .replace(/^1M/, "")
    .toUpperCase();
}

async function getBscContracts() {
  if (Date.now() - bscContractCache.at < 24 * 60 * 60_000 && bscContractCache.data.size) {
    return bscContractCache.data;
  }

  const rows = await coingecko("/coins/list?include_platform=true");
  const contracts = new Map();
  for (const coin of rows) {
    const symbol = String(coin.symbol || "").toUpperCase();
    const address = coin.platforms?.["binance-smart-chain"];
    if (!symbol || !address) continue;
    if (!contracts.has(symbol)) contracts.set(symbol, []);
    contracts.get(symbol).push({
      address,
      coinId: coin.id,
      coinName: coin.name,
    });
  }
  bscContractCache = { at: Date.now(), data: contracts };
  return contracts;
}

function liquidityBand(liquidityUsd, marketCap) {
  const liq = Number(liquidityUsd);
  const cap = Number(marketCap);
  if (!Number.isFinite(liq) || liq <= 0) return "无池子";

  if (Number.isFinite(cap) && cap > 0) {
    const ratio = liq / cap;
    if (ratio >= 0.02) return "深流动性";
    if (ratio >= 0.005) return "中等流动性";
    if (ratio >= 0.001) return "偏薄流动性";
    return "很薄";
  }

  if (liq >= 5_000_000) return "深流动性";
  if (liq >= 1_000_000) return "中等流动性";
  if (liq >= 250_000) return "偏薄流动性";
  return "很薄";
}

async function getBscPool(symbolInfo, marketCap) {
  const base = normalizeBaseAsset(symbolInfo.baseAsset);
  const contracts = await getBscContracts().catch(() => new Map());
  const candidates = contracts.get(base) || [];
  if (!candidates.length) {
    return {
      hasBscPool: false,
      bscLiquidityBand: "无BSC合约",
    };
  }

  const cacheKey = candidates.map((c) => c.address).join(",");
  const cached = bscPoolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    return cached.data;
  }

  let best = null;
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const pairs = await dexscreener(`/token-pairs/v1/bsc/${candidate.address}`);
      const bscPairs = Array.isArray(pairs) ? pairs.filter((p) => p.chainId === "bsc") : [];
      for (const pair of bscPairs) {
        const liquidityUsd = Number(pair.liquidity?.usd);
        if (!Number.isFinite(liquidityUsd)) continue;
        if (!best || liquidityUsd > Number(best.liquidity?.usd || 0)) {
          best = { ...pair, candidate };
        }
      }
    } catch {
      // Keep scanning other candidates when one token address fails.
    }
  }

  const data = best
    ? {
        hasBscPool: true,
        bscTokenAddress: best.candidate.address,
        bscPairAddress: best.pairAddress,
        bscDex: best.dexId,
        bscPairUrl: best.url,
        bscLiquidityUsd: Number(best.liquidity?.usd) || null,
        bscVolume24h: Number(best.volume?.h24) || null,
        bscPriceUsd: Number(best.priceUsd) || null,
        bscLiquidityToMcap:
          Number.isFinite(Number(marketCap)) && Number(marketCap) > 0
            ? (Number(best.liquidity?.usd) || 0) / Number(marketCap)
            : null,
        bscLiquidityBand: liquidityBand(best.liquidity?.usd, marketCap),
      }
    : {
        hasBscPool: false,
        bscTokenAddress: candidates[0].address,
        bscLiquidityBand: "无活跃池",
      };

  bscPoolCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function getBscPancakeV3Pool(symbolInfo) {
  const base = normalizeBaseAsset(symbolInfo.baseAsset);
  const contracts = await getBscContracts().catch(() => new Map());
  const candidates = contracts.get(base) || [];
  if (!candidates.length) return null;

  const cacheKey = `pcs-v3:${candidates.map((c) => c.address).join(",")}`;
  const cached = pancakeV3PoolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.data;

  let best = null;
  for (const candidate of candidates.slice(0, 4)) {
    try {
      const pairs = await dexscreener(`/token-pairs/v1/bsc/${candidate.address}`);
      const pcsPairs = Array.isArray(pairs)
        ? pairs.filter((p) => {
            const dex = String(p.dexId || "").toLowerCase();
            const labels = (p.labels || []).map((x) => String(x).toLowerCase());
            return p.chainId === "bsc" && dex.includes("pancake") && (dex.includes("v3") || labels.includes("v3"));
          })
        : [];
      for (const pair of pcsPairs) {
        const liquidityUsd = Number(pair.liquidity?.usd);
        if (!Number.isFinite(liquidityUsd)) continue;
        if (!best || liquidityUsd > Number(best.liquidity?.usd || 0)) {
          best = { ...pair, candidate };
        }
      }
    } catch {
      // Try the next CoinGecko contract candidate.
    }
  }

  const data = best
    ? {
        tokenAddress: best.candidate.address,
        pairAddress: best.pairAddress,
        dexId: best.dexId,
        url: best.url,
        liquidityUsd: Number(best.liquidity?.usd) || null,
        baseSymbol: best.baseToken?.symbol,
        quoteSymbol: best.quoteToken?.symbol,
      }
    : null;
  pancakeV3PoolCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function alignTick(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}

function wordPosition(compressedTick) {
  return Math.floor(compressedTick / 256);
}

async function buildPancakeLiquidityRange(symbol) {
  const cached = pancakeRangeCache.get(symbol);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.data;

  const symbols = await getUsdtPerpetualSymbols();
  const symbolInfo = symbols.find((s) => s.symbol === symbol);
  if (!symbolInfo) throw new Error("Unknown Binance futures symbol");

  const poolInfo = await getBscPancakeV3Pool(symbolInfo);
  if (!poolInfo?.pairAddress) {
    return { symbol, hasPancakeV3Pool: false, message: "未找到 PancakeSwap V3 BSC 池子" };
  }

  const pool = poolInfo.pairAddress;
  const [slot0, liquidityResult, spacingResult, token0Result, token1Result] = await Promise.all([
    contractCall(pool, POOL_IFACE, "slot0"),
    contractCall(pool, POOL_IFACE, "liquidity"),
    contractCall(pool, POOL_IFACE, "tickSpacing"),
    contractCall(pool, POOL_IFACE, "token0"),
    contractCall(pool, POOL_IFACE, "token1"),
  ]);

  const currentTick = Number(slot0.tick);
  const currentLiquidity = BigInt(liquidityResult[0].toString());
  const tickSpacing = Number(spacingResult[0]);
  const token0 = token0Result[0];
  const token1 = token1Result[0];

  const [symbol0Result, symbol1Result, decimals0Result, decimals1Result] = await Promise.all([
    contractCall(token0, ERC20_IFACE, "symbol").catch(() => ["TOKEN0"]),
    contractCall(token1, ERC20_IFACE, "symbol").catch(() => ["TOKEN1"]),
    contractCall(token0, ERC20_IFACE, "decimals").catch(() => [18]),
    contractCall(token1, ERC20_IFACE, "decimals").catch(() => [18]),
  ]);
  const symbol0 = symbol0Result[0];
  const symbol1 = symbol1Result[0];
  const decimals0 = Number(decimals0Result[0]);
  const decimals1 = Number(decimals1Result[0]);

  const compressed = Math.floor(currentTick / tickSpacing);
  const currentWord = wordPosition(compressed);
  const wordRadius = 8;
  const initializedTicks = [];
  for (let word = currentWord - wordRadius; word <= currentWord + wordRadius; word += 1) {
    const bitmapResult = await contractCall(pool, POOL_IFACE, "tickBitmap", [word]);
    const bitmap = BigInt(bitmapResult[0].toString());
    if (bitmap === 0n) continue;
    for (let bit = 0; bit < 256; bit += 1) {
      if (((bitmap >> BigInt(bit)) & 1n) === 1n) {
        initializedTicks.push((word * 256 + bit) * tickSpacing);
      }
    }
  }

  const tickRows = [];
  for (const tick of initializedTicks) {
    const result = await contractCall(pool, POOL_IFACE, "ticks", [tick]);
    tickRows.push({
      tick,
      liquidityNet: BigInt(result.liquidityNet.toString()),
    });
  }
  tickRows.sort((a, b) => a.tick - b.tick);

  const baseAddress = poolInfo.tokenAddress.toLowerCase();
  const baseIsToken0 = token0.toLowerCase() === baseAddress;
  const baseSymbol = baseIsToken0 ? symbol0 : symbol1;
  const quoteSymbol = baseIsToken0 ? symbol1 : symbol0;

  const binSize = tickSpacing * 24;
  const halfBins = 24;
  const startTick = alignTick(currentTick - binSize * halfBins, tickSpacing);
  const bins = [];

  function activeLiquidityAt(targetTick) {
    let active = currentLiquidity;
    if (targetTick >= currentTick) {
      for (const row of tickRows) {
        if (row.tick > currentTick && row.tick <= targetTick) active += row.liquidityNet;
      }
    } else {
      for (let i = tickRows.length - 1; i >= 0; i -= 1) {
        const row = tickRows[i];
        if (row.tick <= currentTick && row.tick > targetTick) active -= row.liquidityNet;
      }
    }
    return active > 0n ? active : 0n;
  }

  for (let i = 0; i < halfBins * 2 + 1; i += 1) {
    const lowerTick = startTick + i * binSize;
    const upperTick = lowerTick + binSize;
    const midTick = Math.floor((lowerTick + upperTick) / 2);
    const rawLiquidity = activeLiquidityAt(midTick);
    const price0 = tickToPrice(midTick, decimals0, decimals1);
    const orientedPrice = baseIsToken0 ? price0 : 1 / price0;
    bins.push({
      tick: midTick,
      price: orientedPrice,
      liquidity: Number(rawLiquidity / 1_000_000_000_000n),
      active: lowerTick <= currentTick && currentTick < upperTick,
    });
  }

  const currentPrice0 = tickToPrice(currentTick, decimals0, decimals1);
  const data = {
    symbol,
    hasPancakeV3Pool: true,
    pool,
    poolUrl: poolInfo.url,
    dexId: poolInfo.dexId,
    currentTick,
    tickSpacing,
    baseSymbol,
    quoteSymbol,
    currentPrice: baseIsToken0 ? currentPrice0 : 1 / currentPrice0,
    liquidityUsd: poolInfo.liquidityUsd,
    bins: bins.sort((a, b) => a.price - b.price),
  };
  pancakeRangeCache.set(symbol, { at: Date.now(), data });
  return data;
}

async function getMarketCaps() {
  if (Date.now() - marketCapCache.at < 10 * 60_000 && marketCapCache.data.size) {
    return marketCapCache.data;
  }

  const pages = Array.from({ length: 10 }, (_, index) => index + 1);
  const pageRows = await mapLimit(pages, 3, (page) =>
    coingecko(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`)
  );
  const rows = pageRows.flatMap((page) => (Array.isArray(page) ? page : []));

  const caps = new Map();
  for (const coin of rows) {
    const symbol = String(coin.symbol || "").toUpperCase();
    const marketCap = Number(coin.market_cap);
    if (!symbol || !Number.isFinite(marketCap)) continue;
    const existing = caps.get(symbol);
    if (!existing || marketCap > existing.marketCap) {
      caps.set(symbol, {
        marketCap,
        marketCapRank: Number(coin.market_cap_rank) || null,
        coinName: coin.name || symbol,
        coinId: coin.id || null,
      });
    }
  }

  marketCapCache = { at: Date.now(), data: caps };
  return caps;
}

async function getFundingRates() {
  if (Date.now() - fundingCache.at < 60_000 && fundingCache.data.size) {
    return fundingCache.data;
  }
  const rows = await binance("/fapi/v1/premiumIndex");
  const rates = new Map();
  for (const row of rows) {
    const rate = Number(row.lastFundingRate);
    rates.set(row.symbol, {
      fundingRate: Number.isFinite(rate) ? rate : null,
      nextFundingTime: Number(row.nextFundingTime) || null,
    });
  }
  fundingCache = { at: Date.now(), data: rates };
  return rates;
}

async function getUsdtPerpetualSymbols() {
  if (Date.now() - symbolsCache.at < 10 * 60_000 && symbolsCache.data.length) {
    return symbolsCache.data;
  }
  const [info, tickers] = await Promise.all([
    binance("/fapi/v1/exchangeInfo"),
    binance("/fapi/v1/ticker/24hr"),
  ]);
  const volumeBySymbol = new Map(
    (Array.isArray(tickers) ? tickers : []).map((ticker) => [ticker.symbol, Number(ticker.quoteVolume)])
  );
  const symbols = info.symbols
    .filter((s) => s.contractType === "PERPETUAL")
    .filter((s) => s.quoteAsset === "USDT")
    .filter((s) => s.status === "TRADING")
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      quoteVolume24h: Number.isFinite(volumeBySymbol.get(s.symbol)) ? volumeBySymbol.get(s.symbol) : null,
    }))
    .sort((a, b) => (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0) || a.symbol.localeCompare(b.symbol));
  symbolsCache = { at: Date.now(), data: symbols };
  return symbols;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      try {
        results.push(await worker(current));
      } catch (error) {
        results.push({ symbol: current.symbol, error: error.message });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function getOpenInterestChange(symbolInfo, period, points) {
  const params = new URLSearchParams({
    symbol: symbolInfo.symbol,
    period,
    limit: String(points),
  });
  const rows = await binance(`/futures/data/openInterestHist?${params}`);
  if (!Array.isArray(rows) || rows.length < 2) {
    return { symbol: symbolInfo.symbol, skipped: "not_enough_history" };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const startOi = Number(first.sumOpenInterest);
  const endOi = Number(last.sumOpenInterest);
  const startValue = Number(first.sumOpenInterestValue);
  const endValue = Number(last.sumOpenInterestValue);
  const circulatingSupply = Number(last.CMCCirculatingSupply);
  const impliedPrice = endOi > 0 && Number.isFinite(endValue) ? endValue / endOi : null;
  const cmcMarketCap =
    Number.isFinite(circulatingSupply) && circulatingSupply > 0 && Number.isFinite(impliedPrice)
      ? circulatingSupply * impliedPrice
      : null;
  if (!Number.isFinite(startOi) || !Number.isFinite(endOi) || startOi <= 0) {
    return { symbol: symbolInfo.symbol, skipped: "bad_open_interest" };
  }

  return {
    ...symbolInfo,
    startTime: Number(first.timestamp),
    endTime: Number(last.timestamp),
    startOpenInterest: startOi,
    endOpenInterest: endOi,
    changePct: ((endOi - startOi) / startOi) * 100,
    startOpenInterestValue: startValue,
    endOpenInterestValue: endValue,
    cmcCirculatingSupply: Number.isFinite(circulatingSupply) ? circulatingSupply : null,
    impliedPrice,
    cmcMarketCap,
    valueChangePct:
      Number.isFinite(startValue) && Number.isFinite(endValue) && startValue > 0
        ? ((endValue - startValue) / startValue) * 100
        : null,
  };
}

async function handleScan(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const period = url.searchParams.get("period") || "4h";
  const points = parseInteger(url.searchParams.get("points"), 5, 2, 30);
  const threshold = parseNumber(url.searchParams.get("threshold"), 30, 0, 500);
  const maxSymbols = parseInteger(url.searchParams.get("maxSymbols"), 260, 20, 500);
  const smallCapMaxUsd = parseNumber(url.searchParams.get("smallCapMaxUsd"), 100_000_000, 1_000_000, 5_000_000_000);
  const smallCapMinChange = parseNumber(url.searchParams.get("smallCapMinChange"), 0, -100, 500);
  const liqMinRaw = url.searchParams.get("liqMin");
  const liqMaxRaw = url.searchParams.get("liqMax");
  const liqMin = liqMinRaw === null || liqMinRaw === "" ? null : parseNumber(liqMinRaw, 0, 0, 100) / 100;
  const liqMax = liqMaxRaw === null || liqMaxRaw === "" ? null : parseNumber(liqMaxRaw, 100, 0, 100) / 100;
  const hasLiquidityRange = liqMin !== null || liqMax !== null;
  const allowedPeriods = new Set(["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"]);

  if (!allowedPeriods.has(period)) {
    return json(res, 400, { error: "Unsupported period" });
  }
  if (liqMin !== null && liqMax !== null && liqMin > liqMax) {
    return json(res, 400, { error: "Liquidity minimum cannot exceed maximum" });
  }

  const key = [
    period,
    points,
    threshold,
    maxSymbols,
    smallCapMaxUsd,
    smallCapMinChange,
    liqMin ?? "",
    liqMax ?? "",
  ].join(":");
  const cached = scanCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return json(res, 200, cached.data);
  }

  try {
    const [allSymbols, marketCaps, fundingRates] = await Promise.all([
      getUsdtPerpetualSymbols(),
      getMarketCaps().catch(() => new Map()),
      getFundingRates().catch(() => new Map()),
    ]);
    const symbols = allSymbols.slice(0, maxSymbols);
    const scanned = await mapLimit(symbols, CONCURRENCY, (s) => getOpenInterestChange(s, period, points));
    const valid = scanned
      .filter((row) => Number.isFinite(row.changePct))
      .map((row) => {
        const cap = marketCaps.get(normalizeBaseAsset(row.baseAsset));
        const funding = fundingRates.get(row.symbol);
        const binanceCap = Number.isFinite(Number(row.cmcMarketCap)) ? Number(row.cmcMarketCap) : null;
        return {
          ...row,
          marketCap: binanceCap ?? cap?.marketCap ?? null,
          marketCapRank: cap?.marketCapRank ?? null,
          coinName: cap?.coinName ?? null,
          marketCapSource: binanceCap ? "binance_cmc_supply" : cap ? "coingecko" : null,
          fundingRate: funding?.fundingRate ?? null,
          nextFundingTime: funding?.nextFundingTime ?? null,
        };
      });
    const baseSorted = valid.sort((a, b) => b.changePct - a.changePct);
    const alertsBase = baseSorted.filter((row) => row.changePct >= threshold);
    const topBase = baseSorted.slice(0, 30);
    const smallCapBase = baseSorted
      .filter((row) => Number.isFinite(Number(row.marketCap)))
      .filter((row) => Number(row.marketCap) > 0 && Number(row.marketCap) <= smallCapMaxUsd)
      .filter((row) => row.changePct >= smallCapMinChange)
      .slice(0, 120);
    const enrichTargets = hasLiquidityRange
      ? baseSorted
      : [...new Map([...alertsBase, ...topBase, ...smallCapBase].map((row) => [row.symbol, row])).values()];
    const enrichedRows = await mapLimit(enrichTargets, 6, async (row) => ({
      ...row,
      ...(await getBscPool(row, row.marketCap)),
    }));
    const enrichedBySymbol = new Map(enrichedRows.map((row) => [row.symbol, row]));
    const inLiquidityRange = (row) => {
      if (!hasLiquidityRange) return true;
      const ratio = Number(row.bscLiquidityToMcap);
      if (!Number.isFinite(ratio)) return false;
      if (liqMin !== null && ratio < liqMin) return false;
      if (liqMax !== null && ratio > liqMax) return false;
      return true;
    };
    const enrichedSorted = baseSorted.map((row) => enrichedBySymbol.get(row.symbol) || row);
    const alerts = enrichedSorted.filter((row) => row.changePct >= threshold).filter(inLiquidityRange);
    const topRisers = enrichedSorted.filter(inLiquidityRange).slice(0, 30);
    const smallCaps = smallCapBase.map((row) => enrichedBySymbol.get(row.symbol) || row).filter(inLiquidityRange).slice(0, 100);
    const payload = {
      exchange: "binance",
      market: "usdt_m_futures",
      period,
      points,
      threshold,
      smallCap: {
        maxUsd: smallCapMaxUsd,
        minChangePct: smallCapMinChange,
      },
      liquidityRange: hasLiquidityRange
        ? {
            minPct: liqMin === null ? null : liqMin * 100,
            maxPct: liqMax === null ? null : liqMax * 100,
          }
        : null,
      scanned: valid.length,
      errors: scanned.filter((row) => row.error).length,
      generatedAt: new Date().toISOString(),
      alerts,
      smallCaps,
      topRisers,
    };
    scanCache.set(key, { at: Date.now(), data: payload });
    while (scanCache.size > MAX_SCAN_CACHE) {
      const oldestKey = scanCache.keys().next().value;
      scanCache.delete(oldestKey);
    }
    json(res, 200, payload);
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleVix(req, res) {
  try {
    json(res, 200, await getVix());
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleDxy(req, res) {
  try {
    json(res, 200, await getDxy());
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleMacroOverview(req, res) {
  try {
    json(res, 200, await getMacroOverview());
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

function handleHealth(req, res) {
  json(res, 200, {
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    generatedAt: new Date().toISOString(),
    caches: {
      symbols: symbolsCache.data.length,
      marketCaps: marketCapCache.data.size,
      fundingRates: fundingCache.data.size,
      scans: scanCache.size,
    },
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(pathname).replace(/^[/\\]+/, "");
  const filePath = resolve(PUBLIC_DIR, safePath);
  if (filePath !== resolve(PUBLIC_DIR) && !filePath.startsWith(`${resolve(PUBLIC_DIR)}${sep}`)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": types[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/health" || req.url === "/healthz") {
    handleHealth(req, res);
  } else if (req.url.startsWith("/api/reversal/scan")) {
    handleReversalScan(req, res);
  } else if (req.url.startsWith("/api/liquidity-range")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
    if (!symbol) return json(res, 400, { error: "Missing symbol" });
    buildPancakeLiquidityRange(symbol)
      .then((payload) => json(res, 200, payload))
      .catch((error) => json(res, 502, { error: error.message }));
  } else if (req.url.startsWith("/api/scan")) {
    handleScan(req, res);
  } else if (req.url.startsWith("/api/macro/vix")) {
    handleVix(req, res);
  } else if (req.url.startsWith("/api/macro/dxy")) {
    handleDxy(req, res);
  } else if (req.url.startsWith("/api/macro/all")) {
    handleMacroOverview(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`OI dashboard running at http://localhost:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set PORT to another value or stop the existing service.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
