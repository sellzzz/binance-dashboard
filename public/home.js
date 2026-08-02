const $ = (id) => document.getElementById(id);

const els = {
  signals: $("homeSignals"),
  scanned: $("homeScanned"),
  updated: $("homeUpdated"),
  status: $("homeStatus"),
  list: $("homeSignalList"),
};

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(4)}%`;
}

function fmtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderSignals(rows) {
  if (!rows.length) {
    els.list.innerHTML = '<div class="emptySignal">当前没有达到阈值的信号</div>';
    return;
  }

  els.list.innerHTML = rows
    .slice(0, 8)
    .map(
      (row) => `
        <a class="signalItem" href="/position.html">
          <div>
            <strong>${row.symbol || "-"}</strong>
            <span>${fmtTime(row.startTime)} - ${fmtTime(row.endTime)}</span>
          </div>
          <div>
            <b>${fmtPct(row.changePct)}</b>
            <span>Value ${fmtPct(row.valueChangePct)}</span>
          </div>
          <div>
            <span>MCap ${fmtUsd(row.marketCap)}</span>
            <span>Rate ${fmtRate(row.fundingRate)}</span>
          </div>
          <div>
            <span>Liq/MCap ${fmtRatio(row.bscLiquidityToMcap)}</span>
          </div>
        </a>
      `
    )
    .join("");
}

async function loadHome() {
  try {
    const response = await fetch("/api/scan?period=4h&points=5&threshold=30&maxSymbols=260");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Load failed");

    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    els.signals.textContent = alerts.length;
    els.scanned.textContent = data.scanned ?? "-";
    els.updated.textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString("zh-CN") : "-";
    els.status.textContent = `4h x 5 | threshold ${data.threshold}% | ${fmtTime(data.generatedAt)}`;
    renderSignals(alerts);
  } catch (error) {
    els.status.textContent = error.message;
    els.signals.textContent = "-";
    els.scanned.textContent = "-";
    els.updated.textContent = "-";
    els.list.innerHTML = '<div class="emptySignal">信号读取失败</div>';
  }
}

loadHome();
setInterval(loadHome, 60_000);
