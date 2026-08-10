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

function renderSignals(signals) {
  if (!signals.length) {
    els.signalList.innerHTML = '<div class="emptySignal">当前没有标的首次触及关键区域</div>';
    return;
  }
  els.signalList.innerHTML = signals.map((signal) => {
    const support = signal.type === "support-touch";
    return `<article class="reversalSignal ${support ? "isSupport" : "isResistance"}">
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
    const firstTouch = row.status === "first-touch";
    const zone = row.zones?.[0];
    return `<tr>
      <td class="symbol">${escapeHtml(row.symbol)}</td>
      <td>${escapeHtml(row.market)}</td>
      <td class="${firstTouch ? "positive" : ""}">${firstTouch ? "首次触及" : row.status === "error" ? "读取失败" : "观察中"}</td>
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
    els.status.textContent = `日线 · 最短 ${data.minimumAgeBars} 根 · 首次重返触发提醒`;
    renderSignals(data.signals);
    renderWatch(data.rows);
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
els.symbols.addEventListener("keydown", (event) => {
  if (event.key === "Enter") scan();
});
scan();
setInterval(scan, 5 * 60_000);
