const $ = (id) => document.getElementById(id);

const els = {
  signals: $("homeSignals"),
  scanned: $("homeScanned"),
  updated: $("homeUpdated"),
  status: $("homeStatus"),
  list: $("homeSignalList"),
  vixCard: $("vixCard"),
  vixValue: $("vixValue"),
  vixChange: $("vixChange"),
  vixPrevious: $("vixPrevious"),
  vixRange: $("vixRange"),
  vixYearRange: $("vixYearRange"),
  vixStatus: $("vixStatus"),
  dxyCard: $("dxyCard"),
  dxyValue: $("dxyValue"),
  dxyChange: $("dxyChange"),
  dxyPrevious: $("dxyPrevious"),
  dxyRange: $("dxyRange"),
  dxyYearRange: $("dxyYearRange"),
  dxyStatus: $("dxyStatus"),
  macroRows: $("macroRows"),
  macroUpdated: $("macroUpdated"),
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

function fmtNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "-";
}

function renderVix(data) {
  const value = Number(data.value);
  const change = Number(data.change);
  const changePct = Number(data.changePct);
  els.vixValue.textContent = fmtNumber(value);
  els.vixPrevious.textContent = fmtNumber(data.previousClose);
  els.vixRange.textContent = `${fmtNumber(data.dayLow)} - ${fmtNumber(data.dayHigh)}`;
  els.vixYearRange.textContent = `${fmtNumber(data.yearLow)} - ${fmtNumber(data.yearHigh)}`;
  els.vixChange.textContent = Number.isFinite(change) && Number.isFinite(changePct)
    ? `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`
    : "-";
  els.vixChange.className = change > 0 ? "negative" : change < 0 ? "positive" : "";
  els.vixStatus.textContent = value >= 30 ? "高波动" : value >= 20 ? "风险升温" : "常态区间";
  els.vixCard.classList.toggle("vixElevated", value >= 20);
}

function renderDxy(data) {
  const value = Number(data.value);
  const change = Number(data.change);
  const changePct = Number(data.changePct);
  els.dxyValue.textContent = fmtNumber(value);
  els.dxyPrevious.textContent = fmtNumber(data.previousClose);
  els.dxyRange.textContent = `${fmtNumber(data.dayLow)} - ${fmtNumber(data.dayHigh)}`;
  els.dxyYearRange.textContent = `${fmtNumber(data.yearLow)} - ${fmtNumber(data.yearHigh)}`;
  els.dxyChange.textContent = Number.isFinite(change) && Number.isFinite(changePct)
    ? `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`
    : "-";
  els.dxyChange.className = change > 0 ? "positive" : change < 0 ? "negative" : "";
  els.dxyStatus.textContent = value >= 105 ? "美元偏强" : value <= 95 ? "美元偏弱" : "常态区间";
  els.dxyCard.classList.toggle("vixElevated", value >= 105);
}

function average(values, period, index) {
  if (index < period - 1) return null;
  const slice = values.slice(index - period + 1, index + 1);
  return slice.reduce((sum, current) => sum + current, 0) / period;
}

function drawVixChart(history) {
  if (!els.vixChart || history.length < 2) return;
  const canvas = els.vixChart;
  const width = Math.max(320, Math.floor(canvas.clientWidth));
  const height = Math.max(220, Math.floor(canvas.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const rows = history.slice(-260);
  const values = rows.map((row) => row.close);
  const min = Math.min(...values) - 1;
  const max = Math.max(...values) + 1;
  const pad = { top: 14, right: 44, bottom: 22, left: 8 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (index / (rows.length - 1)) * plotWidth;
  const y = (value) => pad.top + ((max - value) / (max - min)) * plotHeight;

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
  for (let step = 0; step <= 4; step += 1) {
    const value = min + ((max - min) * step) / 4;
    const lineY = y(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(width - pad.right, lineY);
    ctx.stroke();
    ctx.fillStyle = "#64748b";
    ctx.fillText(value.toFixed(0), width - pad.right + 8, lineY + 4);
  }

  const drawLine = (series, color, lineWidth) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    series.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      if (index === 0 || !Number.isFinite(series[index - 1])) ctx.moveTo(x(index), y(value));
      else ctx.lineTo(x(index), y(value));
    });
    ctx.stroke();
  };

  drawLine(values, "#111827", 1.4);
  drawLine(values.map((_, index) => average(values, 20, index)), "#ef4444", 1.1);
  drawLine(values.map((_, index) => average(values, 50, index)), "#2563eb", 1.1);

  const latest = values.at(-1);
  const latestY = y(latest);
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#2563eb";
  ctx.beginPath();
  ctx.moveTo(pad.left, latestY);
  ctx.lineTo(width - pad.right, latestY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(width - pad.right + 2, latestY - 9, 42, 18);
  ctx.fillStyle = "#fff";
  ctx.fillText(latest.toFixed(2), width - pad.right + 6, latestY + 4);
}

async function loadVix() {
  try {
    const response = await fetch("/api/macro/vix");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "VIX unavailable");
    renderVix(data);
  } catch (error) {
    els.vixStatus.textContent = "暂时无法读取";
    els.vixValue.textContent = "-";
    els.vixChange.textContent = error.message;
  }
}

async function loadDxy() {
  try {
    const response = await fetch("/api/macro/dxy");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "DXY unavailable");
    renderDxy(data);
  } catch (error) {
    els.dxyStatus.textContent = "暂时无法读取";
    els.dxyValue.textContent = "-";
    els.dxyChange.textContent = error.message;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMacroRows(rows) {
  els.macroRows.innerHTML = rows.map((row) => {
    const live = row.status === "live" && Number.isFinite(Number(row.value));
    const change = Number(row.change);
    const value = live ? fmtNumber(row.value) : "-";
    const changeText = Number.isFinite(change) && Number.isFinite(Number(row.changePct))
      ? `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${Number(row.changePct) >= 0 ? "+" : ""}${Number(row.changePct).toFixed(2)}%)`
      : row.status === "pending" ? "待接入" : "暂无数据";
    const valueClass = live ? "macroValue" : "macroPending";
    const changeClass = change > 0 ? "positive" : change < 0 ? "negative" : "macroPending";
    return `<tr>
      <td class="macroName">${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.purpose)}</td>
      <td>${escapeHtml(row.source)}</td>
      <td class="${valueClass}">${value}${row.status === "pending" ? '<span class="macroStatus">待接入</span>' : ""}</td>
      <td class="${changeClass}">${escapeHtml(changeText)}</td>
      <td>${escapeHtml(row.frequency)}</td>
    </tr>`;
  }).join("");
}

async function loadMacroOverview() {
  try {
    const response = await fetch("/api/macro/all");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Macro indicators unavailable");
    renderMacroRows(Array.isArray(data.rows) ? data.rows : []);
    els.macroUpdated.textContent = data.generatedAt ? `更新于 ${fmtTime(data.generatedAt)}` : "已更新";
  } catch (error) {
    els.macroUpdated.textContent = error.message;
    els.macroRows.innerHTML = '<tr><td colspan="6" class="empty">宏观指标读取失败</td></tr>';
  }
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
loadMacroOverview();
setInterval(loadHome, 60_000);
setInterval(loadMacroOverview, 60_000);
