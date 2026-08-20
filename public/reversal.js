const $ = (id) => document.getElementById(id);

const els = {
  symbols: $("symbols"),
  refreshBtn: $("refreshBtn"),
  signalCount: $("signalCount"),
  watchCount: $("watchCount"),
  updated: $("updated"),
  status: $("status"),
  signalList: $("signalList"),
  watchBody: $("watchBody"),
  historyBody: $("historyBody"),
  historyStatus: $("historyStatus"),
  statsBtn: $("statsBtn"), statsSymbol: $("statsSymbol"), statsHorizon: $("statsHorizon"), statsTarget: $("statsTarget"), statsStatus: $("statsStatus"), statsSummary: $("statsSummary"),
};

let controller = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toPrecision(5);
}

function fmtDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function fmtDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function renderHistory(records) {
  if (!records.length) {
    els.historyBody.innerHTML = '<tr><td class="empty" colspan="5">暂时没有已记录信号</td></tr>';
    return;
  }
  els.historyBody.innerHTML = records.map((record) => {
    const support = record.type === "support-touch";
    const approaching = record.status === "approaching";
    return `<tr>
      <td>${fmtDateTime(record.recordedAt)}</td>
      <td class="symbol">${escapeHtml(record.symbol)}<small>${escapeHtml(record.market)}</small></td>
      <td class="positive">${approaching ? "接近预警" : "第二次触及"}</td>
      <td>${support ? "支撑 · 潜在反弹" : "阻力 · 潜在回落"}</td>
      <td><b>${fmtPrice(record.current?.price)}</b><small>${fmtPrice(record.zoneLow)} - ${fmtPrice(record.zoneHigh)}</small></td>
    </tr>`;
  }).join("");
}

async function loadHistory() {
  try {
    const response = await fetch("/api/reversal/history?limit=100", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取记录失败");
    renderHistory(data.records || []);
    els.historyStatus.textContent = `${data.records.length} 条记录`;
  } catch (error) {
    els.historyStatus.textContent = error.message;
    renderHistory([]);
  }
}

async function loadStats() {
  els.statsBtn.disabled = true;
  els.statsStatus.textContent = "计算中";
  try {
    const query = new URLSearchParams({ symbol: els.statsSymbol.value.trim(), horizon: els.statsHorizon.value, targetPct: els.statsTarget.value });
    const response = await fetch(`/api/reversal/stats?${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "统计失败");
    const pct = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "-";
    const num = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : "-";
    els.statsStatus.textContent = `${data.samples} 个样本`;
    els.statsSummary.innerHTML = [["成功", data.successful], ["失效", data.invalidated], ["未完成", data.timeout], ["胜率", pct(data.winRate)], ["平均最大有利波动", num(data.averageMaxFavorablePct)], ["平均最大不利波动", num(data.averageMaxAdversePct)]]
      .map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  } catch (error) {
    els.statsStatus.textContent = "失败";
    els.statsSummary.innerHTML = `<div class="emptySignal">${escapeHtml(error.message)}</div>`;
  } finally { els.statsBtn.disabled = false; }
}

function renderSignals(signals) {
  if (!signals.length) {
    els.signalList.innerHTML = '<div class="emptySignal">当前没有新的关键区域信号</div>';
    return;
  }
  els.signalList.innerHTML = signals.map((signal) => {
    const support = signal.type === "support-touch";
    const approaching = signal.isSecondApproach && !signal.isSecondTouch;
    return `<article class="reversalSignal ${support ? "isSupport" : "isResistance"}">
      <div class="signalState">${approaching ? "\u63a5\u8fd1\u9884\u8b66" : "\u7b2c\u4e8c\u6b21\u89e6\u53ca"}</div>
      <div class="reversalSignalTop"><span class="signalBadge">${support ? "支撑 · 潜在反弹" : "阻力 · 潜在回落"}</span><strong>${escapeHtml(signal.symbol)}</strong><span class="signalMarket">${escapeHtml(signal.market)}</span></div>
      <div class="reversalSignalGrid">
        <div><span>当前价格</span><b>${fmtPrice(signal.current?.price)}</b></div>
        <div><span>关键区域</span><b>${fmtPrice(signal.zoneLow)} - ${fmtPrice(signal.zoneHigh)}</b></div>
        <div><span>区域年龄</span><b>${signal.ageBars} 根日线</b></div>
        <div><span>首次触及</span><b>${fmtDate(signal.touchTime)}</b></div>
      </div>
      <div class="reversalSignalFoot">区域起点 ${fmtDate(signal.originTime)} · 距离区域 ${Number(signal.distancePct).toFixed(2)}% · 仅提醒，不自动交易</div>
    </article>`;
  }).join("");
}

function renderWatch(rows) {
  if (!rows.length) {
    els.watchBody.innerHTML = '<tr><td class="empty" colspan="7">没有观察标的</td></tr>';
    return;
  }
  els.watchBody.innerHTML = rows.map((row) => {
    const firstTouch = row.status === "second-touch" || row.status === "approaching";
    const zone = row.zones?.[0];
    return `<tr>
      <td class="symbol">${escapeHtml(row.symbol)}</td>
      <td>${escapeHtml(row.market)}</td>
      <td class="${firstTouch ? "positive" : ""}">${firstTouch ? (row.status === "approaching" ? "接近预警" : "第二次触及") : row.status === "error" ? "读取失败" : "观察中"}</td>
      <td>${fmtPrice(row.current?.price)}</td>
      <td>${zone ? `${fmtPrice(zone.zoneLow)} - ${fmtPrice(zone.zoneHigh)}` : "-"}</td>
      <td>${zone ? `${zone.ageBars} 根` : "-"}</td>
      <td>${escapeHtml(row.error || "-")}</td>
    </tr>`;
  }).join("");
}

async function scan() {
  controller?.abort();
  controller = new AbortController();
  els.refreshBtn.disabled = true;
  els.status.textContent = "正在扫描…";
  const symbols = encodeURIComponent(els.symbols.value.trim());
  try {
    const response = await fetch(`/api/reversal/scan?symbols=${symbols}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "扫描失败");
    els.signalCount.textContent = data.signals.length;
    els.watchCount.textContent = data.rows.length;
    els.updated.textContent = new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    els.status.textContent = `${data.selectionMode === "24h-quote-volume" ? "24h成交额自动选取" : "手动观察池"} / 1D / ${data.minimumAgeText} / second revisit + ${data.proximityPct}% proximity warning`;
    renderSignals(data.signals);
    renderWatch(data.rows);
    await loadHistory();
  } catch (error) {
    if (error.name === "AbortError") return;
    els.status.textContent = error.message;
    els.signalList.innerHTML = '<div class="emptySignal">扫描失败，请稍后重试</div>';
    renderWatch([]);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

els.refreshBtn.addEventListener("click", scan);
els.statsBtn.addEventListener("click", loadStats);
els.symbols.addEventListener("keydown", (event) => {
  if (event.key === "Enter") scan();
});
scan();
setInterval(scan, 2 * 60 * 60_000);
