import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { Interface } from "ethers";

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = join(process.cwd(), "public");
const BINANCE_FAPI = "https://fapi.binance.com";
const COINGECKO_API = "https://api.coingecko.com/api/v3";
const DEXSCREENER_API = "https://api.dexscreener.com";
const BSC_RPC = process.env.BSC_RPC || "https://bsc-dataseed.binance.org";
const CACHE_MS = 30_000;
const CONCURRENCY = 12;

let symbolsCache = { at: 0, data: [] };
let marketCapCache = { at: 0, data: new Map() };
let fundingCache = { at: 0, data: new Map() };
let bscContractCache = { at: 0, data: new Map() };
let bscPoolCache = new Map();
let pancakeV3PoolCache = new Map();
let scanCache = new Map();

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
  });
  res.end(JSON.stringify(payload));
}

function parseNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function binance(path) {
  const response = await fetch(`${BINANCE_FAPI}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Binance ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function coingecko(path) {
  const response = await fetch(`${COINGECKO_API}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CoinGecko ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function dexscreener(path) {
  const response = await fetch(`${DEXSCREENER_API}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DexScreener ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function rpc(method, params) {
  const response = await fetch(BSC_RPC, {
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
  return {
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
}

async function getMarketCaps() {
  if (Date.now() - marketCapCache.at < 10 * 60_000 && marketCapCache.data.size) {
    return marketCapCache.data;
  }

  const pages = Array.from({ length: 10 }, (_, index) => index + 1);
  const rows = (
    await Promise.all(
      pages.map((page) =>
        coingecko(
          `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`
        )
      )
    )
  ).flat();

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
  const info = await binance("/fapi/v1/exchangeInfo");
  const symbols = info.symbols
    .filter((s) => s.contractType === "PERPETUAL")
    .filter((s) => s.quoteAsset === "USDT")
    .filter((s) => s.status === "TRADING")
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
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
  const points = parseNumber(url.searchParams.get("points"), 5, 2, 30);
  const threshold = parseNumber(url.searchParams.get("threshold"), 30, 0, 500);
  const maxSymbols = parseNumber(url.searchParams.get("maxSymbols"), 260, 20, 500);
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

  const key = `${period}:${points}:${threshold}:${maxSymbols}`;
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
    json(res, 200, payload);
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/liquidity-range")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
    if (!symbol) return json(res, 400, { error: "Missing symbol" });
    buildPancakeLiquidityRange(symbol)
      .then((payload) => json(res, 200, payload))
      .catch((error) => json(res, 502, { error: error.message }));
  } else if (req.url.startsWith("/api/scan")) {
    handleScan(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`OI dashboard running at http://localhost:${PORT}`);
});
