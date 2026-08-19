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
  els.vixValue.classList.remove("skeleton", "skeletonNumber");
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
  els.dxyValue.classList.remove("skeleton", "skeletonNumber");
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

async function loadVix() {
  try {
    const response = await fetch("/api/macro/vix");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "VIX unavailable");
    renderVix(data);
  } catch (error) {
    els.vixValue.classList.remove("skeleton", "skeletonNumber");
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
    els.dxyValue.classList.remove("skeleton", "skeletonNumber");
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

function formatMacroValue(row) {
  if (row.value === null || row.value === undefined) return "暂无数据";
  if (row.unit === "percent" && Number.isFinite(Number(row.value))) return `${Number(row.value).toFixed(3)}%`;
  return Number.isFinite(Number(row.value)) ? fmtNumber(row.value) : escapeHtml(row.value);
}

function formatMacroChange(row) {
  const change = Number(row.change);
  if (!Number.isFinite(change)) return "暂无数据";
  if (row.unit === "percent") return `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}bp`;
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}`;
}

function renderMacroRows(rows) {
  els.macroRows.innerHTML = rows.map((row) => {
    const live = row.status === "live" && row.value !== null && row.value !== undefined;
    const change = Number(row.change);
    const value = live ? formatMacroValue(row) : "暂无数据";
    const changeText = Number.isFinite(change) ? formatMacroChange(row) : "暂无数据";
    const valueClass = live ? "macroValue" : "macroPending";
    const changeClass = change > 0 ? "positive" : change < 0 ? "negative" : "macroPending";
    return `<tr>
      <td class="macroName">${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.purpose)}</td>
      <td>${escapeHtml(row.source)}</td>
      <td class="${valueClass}">${value}</td>
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
    [els.signals, els.scanned, els.updated].forEach((element) => element.classList.remove("skeleton", "skeletonNumber"));
    els.status.textContent = `4h x 5 | threshold ${data.threshold}% | ${fmtTime(data.generatedAt)}`;
    renderSignals(alerts);
  } catch (error) {
    els.status.textContent = error.message;
    els.signals.textContent = "-";
    els.scanned.textContent = "-";
    els.updated.textContent = "-";
    [els.signals, els.scanned, els.updated].forEach((element) => element.classList.remove("skeleton", "skeletonNumber"));
    els.list.innerHTML = '<div class="emptySignal">信号读取失败</div>';
  }
}

loadHome();
loadVix();
loadDxy();
loadMacroOverview();
setInterval(loadHome, 60_000);
setInterval(loadMacroOverview, 60_000);
