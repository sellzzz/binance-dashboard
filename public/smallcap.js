import {
  columns,
  fmtCompact,
  fmtPct,
  fmtRate,
  fmtRatio,
  fmtTime,
  fmtUsd,
  renderLiquidityChart,
  shortPrice,
} from "/shared.js";

const $ = (id) => document.getElementById(id);

const controls = {
  period: $("period"),
  points: $("points"),
  smallCapMaxM: $("smallCapMaxM"),
  smallCapMinChange: $("smallCapMinChange"),
  maxSymbols: $("maxSymbols"),
  symbolSearch: $("symbolSearch"),
};

const els = {
  refreshBtn: $("refreshBtn"),
  smallCount: $("smallCount"),
  scanned: $("scanned"),
  updated: $("updated"),
  status: $("status"),
  smallHead: $("smallHead"),
  smallBody: $("smallBody"),
  liquidityDialog: $("liquidityDialog"),
  liqTitle: $("liqTitle"),
  liqMeta: $("liqMeta"),
  liqChart: $("liqChart"),
  liqStatus: $("liqStatus"),
  closeDialog: $("closeDialog"),
};

let rows = [];
let sortState = { key: "changePct", dir: "desc" };

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

function renderHead() {
  els.smallHead.innerHTML = `<tr>${columns
    .map(([key, label, type]) => {
      if (type === "button") return `<th>${label}</th>`;
      return `<th><button class="sortBtn" data-sort="${key}">${label}</button></th>`;
    })
    .join("")}</tr>`;
}

function sortedRows() {
  const query = controls.symbolSearch.value.trim().toUpperCase();
  const source = query ? rows.filter((row) => row.symbol.includes(query)) : rows;
  const sign = sortState.dir === "asc" ? 1 : -1;
  return [...source].sort((a, b) => {
    if (sortState.key === "symbol" || sortState.key === "bscLiquidityBand") {
      return String(a[sortState.key] || "").localeCompare(String(b[sortState.key] || "")) * sign;
    }
    const av = Number(a[sortState.key]);
    const bv = Number(b[sortState.key]);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return (av - bv) * sign;
  });
}

function renderRows() {
  const sorted = sortedRows();
  if (!sorted.length) {
    els.smallBody.innerHTML = `<tr><td class="empty" colspan="${columns.length}">No rows match the current filters</td></tr>`;
  } else {
    els.smallBody.innerHTML = sorted
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

  document.querySelectorAll(".sortBtn").forEach((button) => {
    const active = button.dataset.sort === sortState.key;
    button.classList.toggle("active", active);
    button.dataset.dir = active ? (sortState.dir === "asc" ? "↑" : "↓") : "";
  });
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
    renderLiquidityChart(data, els);
  } catch (error) {
    els.liqStatus.textContent = error.message;
  }
}

async function scan() {
  const params = new URLSearchParams({
    period: controls.period.value,
    points: controls.points.value,
    threshold: "0",
    maxSymbols: controls.maxSymbols.value,
    smallCapMaxUsd: String(Number(controls.smallCapMaxM.value || 100) * 1_000_000),
    smallCapMinChange: controls.smallCapMinChange.value || "0",
  });

  els.refreshBtn.disabled = true;
  els.status.textContent = "Scanning...";

  try {
    const response = await fetch(`/api/scan?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Scan failed");
    rows = data.smallCaps || [];
    els.smallCount.textContent = rows.length;
    els.scanned.textContent = data.scanned;
    els.updated.textContent = new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    els.status.textContent = `MCap ≤ ${fmtUsd(data.smallCap.maxUsd)} · Change ≥ ${data.smallCap.minChangePct}% · ${data.period} × ${data.points}`;
    renderRows();
  } catch (error) {
    els.status.textContent = error.message;
  } finally {
    els.refreshBtn.disabled = false;
  }
}

renderHead();
els.refreshBtn.addEventListener("click", scan);
els.closeDialog.addEventListener("click", () => els.liquidityDialog.close());
document.addEventListener("click", (event) => {
  const liquidityButton = event.target.closest("[data-liquidity-symbol]");
  if (liquidityButton) {
    openLiquidityRange(liquidityButton.dataset.liquiditySymbol);
    return;
  }
  const sortButton = event.target.closest("[data-sort]");
  if (!sortButton) return;
  const key = sortButton.dataset.sort;
  if (sortState.key === key) {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  } else {
    sortState = { key, dir: key === "symbol" || key === "bscLiquidityBand" ? "asc" : "desc" };
  }
  renderRows();
});
Object.values(controls).forEach((control) => control.addEventListener("change", scan));
controls.symbolSearch.addEventListener("input", renderRows);

scan();
setInterval(scan, 60_000);
