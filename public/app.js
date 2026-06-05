const $ = (id) => document.getElementById(id);

const columns = [
  ["symbol", "Symbol", "text"],
  ["pancake", "Range", "button"],
  ["marketCap", "MCap", "number"],
  ["bscLiquidityUsd", "Liquidity", "number"],
  ["bscLiquidityBand", "Band", "text"],
  ["bscLiquidityToMcap", "Liq/MCap", "ratio"],
  ["bscVolume24h", "24h Flow", "number"],
  ["fundingRate", "Rate", "rate"],
  ["changePct", "Position Chg", "pct"],
  ["valueChangePct", "Value Chg", "pct"],
  ["startOpenInterest", "Start Pos", "compact"],
  ["endOpenInterest", "Current Pos", "compact"],
  ["endTime", "Window", "time"],
];

const controls = {
  period: $("period"),
  points: $("points"),
  threshold: $("threshold"),
  maxSymbols: $("maxSymbols"),
  liqMin: $("liqMin"),
  liqMax: $("liqMax"),
};

const els = {
  refreshBtn: $("refreshBtn"),
  liquidityScanBtn: $("liquidityScanBtn"),
  clearLiquidityBtn: $("clearLiquidityBtn"),
  status: $("status"),
  alertCount: $("alertCount"),
  scanned: $("scanned"),
  updated: $("updated"),
  alertsHead: $("alertsHead"),
  alertsBody: $("alertsBody"),
  topHead: $("topHead"),
  topBody: $("topBody"),
  liquidityDialog: $("liquidityDialog"),
  liqTitle: $("liqTitle"),
  liqMeta: $("liqMeta"),
  liqChart: $("liqChart"),
  liqStatus: $("liqStatus"),
  closeDialog: $("closeDialog"),
};

let liquidityFilterEnabled = false;
let latestRows = { alerts: [], top: [] };
let sortState = {
  alerts: { key: "changePct", dir: "desc" },
  top: { key: "changePct", dir: "desc" },
};

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(4)}%`;
}

function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000_000_000) return `$${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}

function fmtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtTime(ms) {
  if (!ms) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function cellValue(row, key, type) {
  if (type === "button") return `<button class="miniBtn" data-liquidity-symbol="${row.symbol}" type="button">Chart</button>`;
  if (type === "number") return fmtUsd(row[key]);
  if (type === "ratio") return fmtRatio(row[key]);
  if (type === "rate") return fmtRate(row[key]);
  if (type === "pct") return fmtPct(row[key]);
  if (type === "compact") return fmtCompact(row[key]);
  if (type === "time") return `${fmtTime(row.startTime)} → ${fmtTime(row.endTime)}`;
  return row[key] || "-";
}

function renderHead(target, tableName) {
  target.innerHTML = `<tr>${columns
    .map(([key, label, type]) => {
      if (type === "button") return `<th>${label}</th>`;
      return `<th><button class="sortBtn" data-table="${tableName}" data-sort="${key}">${label}</button></th>`;
    })
    .join("")}</tr>`;
}

function renderRows(tbody, rows, emptyText) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="${columns.length}">${emptyText}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((row) => `<tr>${columns.map(([key, , type]) => {
      const cls =
        key === "changePct" || key === "valueChangePct" || key === "fundingRate"
          ? Number(row[key]) >= 0
            ? "positive"
            : "negative"
          : "";
      return `<td class="${key === "symbol" ? "symbol" : cls}">${cellValue(row, key, type)}</td>`;
    }).join("")}</tr>`)
    .join("");
}

function sortedRows(tableName) {
  const { key, dir } = sortState[tableName];
  const sign = dir === "asc" ? 1 : -1;
  return [...latestRows[tableName]].sort((a, b) => {
    if (key === "symbol" || key === "bscLiquidityBand") {
      return String(a[key] || "").localeCompare(String(b[key] || "")) * sign;
    }
    const av = Number(a[key]);
    const bv = Number(b[key]);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return (av - bv) * sign;
  });
}

function updateSortButtons() {
  document.querySelectorAll(".sortBtn").forEach((button) => {
    const state = sortState[button.dataset.table];
    const active = state?.key === button.dataset.sort;
    button.classList.toggle("active", active);
    button.dataset.dir = active ? (state.dir === "asc" ? "↑" : "↓") : "";
  });
}

function rerenderTables() {
  renderRows(els.alertsBody, sortedRows("alerts"), "No rows match the current signal filters");
  renderRows(els.topBody, sortedRows("top"), "No rows match the current filters");
  updateSortButtons();
}

function shortPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

function renderLiquidityChart(data) {
  els.liqTitle.textContent = `${data.symbol} Liquidity Range`;
  if (!data.hasPancakeV3Pool) {
    els.liqMeta.textContent = "";
    els.liqChart.innerHTML = "";
    els.liqStatus.textContent = data.message || "No supported liquidity pool found";
    return;
  }

  const maxLiquidity = Math.max(...data.bins.map((b) => Number(b.liquidity) || 0), 1);
  els.liqMeta.textContent = `Current ${shortPrice(data.currentPrice)} ${data.quoteSymbol} per ${data.baseSymbol} · tick ${data.currentTick} · liquidity ${fmtUsd(data.liquidityUsd)}`;
  els.liqChart.innerHTML = data.bins
    .map((bin, index) => {
      const height = Math.max(4, (Number(bin.liquidity) / maxLiquidity) * 100);
      const showLabel = index % 6 === 0 || bin.active;
      return `<div class="liqBar ${bin.active ? "active" : ""}" style="height:${height}%" data-price="${showLabel ? shortPrice(bin.price) : ""}" title="${shortPrice(bin.price)} · L ${fmtCompact(bin.liquidity)}"></div>`;
    })
    .join("");
  els.liqStatus.textContent = "Cyan bars show range liquidity. Pink marks the current price range.";
}

async function openLiquidityRange(symbol) {
  els.liqTitle.textContent = `${symbol} Liquidity Range`;
  els.liqMeta.textContent = "";
  els.liqChart.innerHTML = "";
  els.liqStatus.textContent = "Loading liquidity range...";
  els.liquidityDialog.showModal();

  try {
    const response = await fetch(`/api/liquidity-range?symbol=${encodeURIComponent(symbol)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Load failed");
    renderLiquidityChart(data);
  } catch (error) {
    els.liqStatus.textContent = error.message;
  }
}

async function scan() {
  const params = new URLSearchParams({
    period: controls.period.value,
    points: controls.points.value,
    threshold: controls.threshold.value,
    maxSymbols: controls.maxSymbols.value,
  });
  if (liquidityFilterEnabled) {
    if (controls.liqMin.value !== "") params.set("liqMin", controls.liqMin.value);
    if (controls.liqMax.value !== "") params.set("liqMax", controls.liqMax.value);
  }

  els.refreshBtn.disabled = true;
  els.liquidityScanBtn.disabled = true;
  els.status.textContent = "Scanning...";

  try {
    const response = await fetch(`/api/scan?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Scan failed");

    els.alertCount.textContent = data.alerts.length;
    els.scanned.textContent = data.scanned;
    els.updated.textContent = new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const liqText = data.liquidityRange
      ? ` · Liq/MCap ${data.liquidityRange.minPct ?? 0}% - ${data.liquidityRange.maxPct ?? "∞"}%`
      : "";
    els.status.textContent = `Threshold ${data.threshold}% · ${data.period} × ${data.points}${liqText}`;

    latestRows = { alerts: data.alerts, top: data.topRisers };
    rerenderTables();
  } catch (error) {
    els.status.textContent = error.message;
    renderRows(els.alertsBody, [], "Scan failed. Try again later.");
  } finally {
    els.refreshBtn.disabled = false;
    els.liquidityScanBtn.disabled = false;
  }
}

renderHead(els.alertsHead, "alerts");
renderHead(els.topHead, "top");

els.refreshBtn.addEventListener("click", scan);
els.liquidityScanBtn.addEventListener("click", () => {
  liquidityFilterEnabled = true;
  scan();
});
els.clearLiquidityBtn.addEventListener("click", () => {
  liquidityFilterEnabled = false;
  controls.liqMin.value = "";
  controls.liqMax.value = "";
  scan();
});
els.closeDialog.addEventListener("click", () => els.liquidityDialog.close());
document.addEventListener("click", (event) => {
  const liquidityButton = event.target.closest("[data-liquidity-symbol]");
  if (liquidityButton) {
    openLiquidityRange(liquidityButton.dataset.liquiditySymbol);
    return;
  }
  const sortButton = event.target.closest("[data-sort]");
  if (!sortButton) return;
  const table = sortButton.dataset.table;
  const key = sortButton.dataset.sort;
  if (sortState[table].key === key) {
    sortState[table].dir = sortState[table].dir === "asc" ? "desc" : "asc";
  } else {
    sortState[table] = { key, dir: key === "symbol" || key === "bscLiquidityBand" ? "asc" : "desc" };
  }
  rerenderTables();
});
Object.entries(controls).forEach(([key, control]) => {
  control.addEventListener("change", () => {
    if (key === "liqMin" || key === "liqMax") return;
    scan();
  });
});

scan();
setInterval(scan, 60_000);
