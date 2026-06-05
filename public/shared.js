export const columns = [
  ["symbol", "合约", "text"],
  ["pancake", "Pancake区间", "button"],
  ["marketCap", "市值", "number"],
  ["bscLiquidityUsd", "BSC流动性", "number"],
  ["bscLiquidityBand", "流动性区间", "text"],
  ["bscLiquidityToMcap", "池/市值", "ratio"],
  ["bscVolume24h", "24h DEX量", "number"],
  ["fundingRate", "资金费率", "rate"],
  ["changePct", "持仓变化", "pct"],
  ["valueChangePct", "名义价值变化", "pct"],
  ["startOpenInterest", "起始 OI", "compact"],
  ["endOpenInterest", "当前 OI", "compact"],
  ["endTime", "区间", "time"],
];

export function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function fmtRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(4)}%`;
}

export function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

export function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000_000_000) return `$${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}

export function fmtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

export function fmtTime(ms) {
  if (!ms) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function shortPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

export function renderLiquidityChart(data, els) {
  els.liqTitle.textContent = `${data.symbol} Pancake V3 流动性区间`;
  if (!data.hasPancakeV3Pool) {
    els.liqMeta.textContent = "";
    els.liqChart.innerHTML = "";
    els.liqStatus.textContent = data.message || "没有找到 Pancake V3 池子";
    return;
  }

  const maxLiquidity = Math.max(...data.bins.map((b) => Number(b.liquidity) || 0), 1);
  els.liqMeta.textContent = `当前价格 ${shortPrice(data.currentPrice)} ${data.quoteSymbol} per ${data.baseSymbol} · tick ${data.currentTick} · 池流动性 ${fmtUsd(data.liquidityUsd)}`;
  els.liqChart.innerHTML = data.bins
    .map((bin, index) => {
      const height = Math.max(4, (Number(bin.liquidity) / maxLiquidity) * 100);
      const showLabel = index % 6 === 0 || bin.active;
      return `<div class="liqBar ${bin.active ? "active" : ""}" style="height:${height}%" data-price="${showLabel ? shortPrice(bin.price) : ""}" title="${shortPrice(bin.price)} · L ${fmtCompact(bin.liquidity)}"></div>`;
    })
    .join("");
  els.liqStatus.textContent = "青色为价格区间流动性，粉色为当前价格所在区间。";
}
