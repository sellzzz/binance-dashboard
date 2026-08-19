const $ = (id) => document.getElementById(id);
const els = { symbol: $("symbolInput"), scan: $("scanBtn"), title: $("resultTitle"), status: $("resultStatus"), state: $("poolState"), metrics: $("metrics"), meta: $("chartMeta"), chart: $("liqChart"), labels: $("chartLabels"), alertForm: $("alertForm"), alertList: $("alertList"), clearAlerts: $("clearAlertsBtn") };
const ALERTS_KEY = "market-monitor-onchain-alerts";
let alerts = [];

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function readAlerts() {
  return alerts;
}

async function loadAlerts() {
  try {
    const response = await fetch("/api/onchain/alerts", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取警报失败");
    alerts = Array.isArray(data.alerts) ? data.alerts : [];
    renderAlerts();
  } catch (error) {
    els.alertList.innerHTML = `<div class="emptySignal">${escapeHtml(error.message)}</div>`;
  }
}

function renderAlerts() {
  const alerts = readAlerts();
  els.alertList.innerHTML = alerts.length ? alerts.map((item, index) => `<article class="onchainAlertItem">
    <div><strong>${escapeHtml(item.address.slice(0, 8))}…${escapeHtml(item.address.slice(-6))}</strong><span>${escapeHtml(item.note || "未填写备注")}</span></div>
    <div><b>${escapeHtml(item.price)}</b><span>${item.mode === "below" ? "跌破" : item.mode === "above" ? "突破" : "进入区间"} · ±${escapeHtml(item.tolerance)}%</span></div>
    <div><span>总量 / 目标市值</span><b>${Number(item.supply).toLocaleString("en-US")}</b><span>${item.marketCap ? `$${Number(item.marketCap).toLocaleString("en-US")}` : "-"}</span></div>
    <button type="button" class="miniBtn" data-remove-alert="${index}">删除</button>
  </article>`).join("") : '<div class="emptySignal">还没有配置价格警报</div>';
}

async function saveAlert(event) {
  event.preventDefault();
  const form = new FormData(els.alertForm);
  const item = {
    address: String(form.get("address") || "").trim(),
    price: String(form.get("price") || "").trim(),
    supply: String(form.get("supply") || "1000000000").trim(),
    mode: String(form.get("mode") || "enter"),
    tolerance: String(form.get("tolerance") || "1"),
    interval: String(form.get("interval") || "300"),
    marketCap: String((Number(form.get("price")) * Number(form.get("supply"))) || "").trim(),
    note: String(form.get("note") || "").trim(),
    createdAt: Date.now(),
  };
  const response = await fetch("/api/onchain/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item) });
  const data = await response.json();
  if (!response.ok) { els.alertList.innerHTML = `<div class="emptySignal">${escapeHtml(data.error || "保存警报失败")}</div>`; return; }
  alerts = [data.alert, ...alerts.filter((alert) => alert.id !== data.alert.id)];
  els.alertForm.reset();
  $("alertTolerance").value = "1";
  $("alertInterval").value = "300";
  $("alertSupply").value = "1000000000";
  renderAlerts();
}

function updateMarketCapEstimate() {
  const value = Number($("alertPrice").value) * Number($("alertSupply").value);
  $("alertMarketCap").textContent = Number.isFinite(value) && value > 0 ? fmtUsd(value) : "-";
}

function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(4);
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `$${n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0)}`;
}

function render(data) {
  els.title.textContent = data.symbol;
  if (!data.hasPancakeV3Pool) {
    els.state.textContent = "无池子";
    els.status.textContent = data.message || "没有找到 PancakeSwap V3 BSC 池子";
    els.metrics.innerHTML = "";
    els.chart.innerHTML = "";
    els.labels.innerHTML = "";
    return;
  }
  els.state.textContent = "已连接";
  els.status.textContent = `${data.baseSymbol}/${data.quoteSymbol} · ${data.pool}`;
  els.metrics.innerHTML = [
    ["当前价格", `${fmt(data.currentPrice)} ${data.quoteSymbol}`],
    ["总供应量", data.totalSupply ? fmt(data.totalSupply) : "-"],
    ["市值（总量×价格）", fmtUsd(data.marketCapUsd)],
    ["池子流动性", fmtUsd(data.liquidityUsd)],
    ["当前 Tick", data.currentTick],
    ["Tick 间距", data.tickSpacing],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  if (data.query && /^0x[a-f0-9]{40}$/i.test(data.query)) $("alertAddress").value = data.query;
  if (!$("alertPrice").value && Number.isFinite(Number(data.currentPrice))) $("alertPrice").value = data.currentPrice;
  els.meta.textContent = `${data.baseSymbol} / ${data.quoteSymbol} · ${data.bins.length} 个区间`;
  const max = Math.max(...data.bins.map((bin) => Number(bin.liquidity) || 0), 1);
  els.chart.innerHTML = data.bins.map((bin) => `<div class="onchainBar ${bin.active ? "active" : ""}" style="height:${Math.max(5, Number(bin.liquidity) / max * 100)}%" title="${fmt(bin.price)} · ${fmt(bin.liquidity)}"></div>`).join("");
  const step = Math.max(1, Math.floor(data.bins.length / 6));
  els.labels.innerHTML = data.bins.map((bin, index) => index % step === 0 || bin.active ? `<span style="left:${index / (data.bins.length - 1) * 100}%">${fmt(bin.price)}</span>` : "").join("");
}

async function scan() {
  const symbol = els.symbol.value.trim().toUpperCase();
  if (!symbol) return;
  els.scan.disabled = true;
  els.state.textContent = "读取中";
  els.status.textContent = "正在读取 BSC 池子和流动性区间…";
  try {
    const response = await fetch(`/api/liquidity-range?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "链上读取失败");
    render(data);
  } catch (error) {
    els.state.textContent = "读取失败";
    els.status.textContent = error.message;
    els.metrics.innerHTML = "";
    els.chart.innerHTML = "";
    els.labels.innerHTML = "";
  } finally {
    els.scan.disabled = false;
  }
}

els.scan.addEventListener("click", scan);
els.symbol.addEventListener("keydown", (event) => { if (event.key === "Enter") scan(); });
els.alertForm.addEventListener("submit", saveAlert);
els.alertList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-alert]");
  if (!button) return;
  const item = readAlerts()[Number(button.dataset.removeAlert)];
  await fetch(`/api/onchain/alerts?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
  alerts = alerts.filter((alert) => alert.id !== item.id);
  renderAlerts();
});
els.clearAlerts.addEventListener("click", async () => {
  for (const item of [...alerts]) await fetch(`/api/onchain/alerts?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
  alerts = [];
  renderAlerts();
});
$("alertPrice").addEventListener("input", updateMarketCapEstimate);
$("alertSupply").addEventListener("input", updateMarketCapEstimate);
updateMarketCapEstimate();
loadAlerts();
