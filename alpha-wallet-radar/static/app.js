const state = {
  alerts: [],
  universe: [],
  labels: [],
  severity: "",
  alertQuery: "",
  universeQuery: "",
  includeQuiet: false,
  activeView: "alerts",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const severityLabels = {
  critical: "强异动",
  high: "高关注",
  watch: "观察",
  quiet: "常态",
  warming: "数据预热",
};
const directionLabels = {
  risk_outflow: "关键钱包向外转移",
  accumulation: "关键钱包出现归集",
  pool_increase: "向已识别池地址转移",
  neutral: "暂无线性方向",
};
const roleLabels = {
  deployer: "部署方", operator: "庄家中转", quiet: "潜伏钱包", insider: "内幕分发",
  dumper: "分发中钱包", cex: "交易所", pool: "流动性池", router: "路由",
  treasury: "项目金库", other: "其他", unknown: "未标注",
};

function iconRefresh() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "服务返回了无法识别的数据" }));
  if (!response.ok) throw new Error(payload.error || payload.message || `请求失败 (${response.status})`);
  return payload;
}

function formatNumber(value, compact = true) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "--";
  if (compact && Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (compact && Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (compact && Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: number < 10 ? 3 : 0 }).format(number);
}

function formatUsd(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "$--";
  return `$${formatNumber(number)}`;
}

function formatPrice(value) {
  const number = Number(value || 0);
  if (!number) return "$--";
  const digits = number >= 100 ? 2 : number >= 1 ? 4 : number >= .01 ? 6 : 8;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

function formatRatio(value) {
  const ratio = Number(value || 0);
  if (!Number.isFinite(ratio)) return "--";
  return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}×`;
}

function formatTime(timestamp) {
  if (!timestamp) return "--";
  return new Date(Number(timestamp) * 1000).toLocaleString("zh-CN", { hour12: false });
}

function shortAddress(address) {
  if (!address || address.length < 12) return address || "--";
  return `${address.slice(0, 7)}…${address.slice(-5)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function tokenIcon(token) {
  if (token.icon_url) {
    return `<img class="token-icon" src="${escapeHtml(token.icon_url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'token-icon token-fallback',textContent:'${escapeHtml(token.symbol.slice(0,2))}'}))">`;
  }
  return `<span class="token-icon token-fallback">${escapeHtml(token.symbol.slice(0, 2))}</span>`;
}

function showToast(message, error = false) {
  const toast = document.createElement("div");
  toast.className = `toast${error ? " error" : ""}`;
  toast.textContent = message;
  $("#toastRegion").appendChild(toast);
  setTimeout(() => toast.remove(), 3600);
}

async function loadStatus() {
  try {
    const payload = await api("/api/status");
    const scanner = payload.scanner;
    $("#serviceState").className = `service-state ${scanner.stage === "error" ? "error" : "online"}`;
    $("#serviceStateText").textContent = scanner.running ? "扫描运行中" : "服务在线";
    $("#runtimeMessage").textContent = scanner.message || "等待下一周期";
    const latest = scanner.latest_run;
    $("#runtimeTime").textContent = latest?.completed_at
      ? `最近完成 ${formatTime(latest.completed_at)} · 下次约 ${Math.ceil(scanner.next_scan_seconds / 60)} 分钟后`
      : "等待首次扫描完成";
    const current = Number(scanner.progress_current || 0);
    const total = Number(scanner.progress_total || 0);
    $("#progressFill").style.width = scanner.running && total ? `${Math.min(100, current / total * 100)}%` : scanner.running ? "8%" : "0%";
    $("#coverageText").textContent = `${scanner.coverage.complete} / ${scanner.coverage.total}`;
    $("#criticalCount").textContent = payload.severity_counts.critical || 0;
    $("#highCount").textContent = payload.severity_counts.high || 0;
    $("#watchCount").textContent = payload.severity_counts.watch || 0;
    $("#warmingCount").textContent = payload.severity_counts.warming || 0;
    $("#scanButton").disabled = Boolean(scanner.running);
  } catch (error) {
    $("#serviceState").className = "service-state error";
    $("#serviceStateText").textContent = "服务未连接";
    $("#runtimeMessage").textContent = error.message;
  }
}

async function loadAlerts() {
  try {
    const path = state.severity
      ? `/api/alerts?severity=${encodeURIComponent(state.severity)}`
      : `/api/alerts?include_quiet=${state.includeQuiet ? 1 : 0}`;
    const payload = await api(path);
    state.alerts = payload.rows;
    renderAlerts();
  } catch (error) {
    showToast(error.message, true);
  }
}

function filteredAlerts() {
  const query = state.alertQuery.toLowerCase();
  return state.alerts.filter((item) => {
    if (state.severity && item.severity !== state.severity) return false;
    if (!query) return true;
    return item.token.symbol.toLowerCase().includes(query)
      || item.token.name.toLowerCase().includes(query)
      || item.token.address.toLowerCase().includes(query);
  });
}

function renderAlerts() {
  const rows = filteredAlerts();
  $("#alertsEmpty").classList.toggle("hidden", rows.length > 0);
  $("#alertsBody").innerHTML = rows.map((item, index) => {
    const current = item.current_24h;
    const previous = item.previous_24h;
    const score = item.score == null ? "--" : item.score.toFixed(1);
    const priceChange = Number(item.token.price_change_24h || 0);
    const priceClass = priceChange >= 0 ? "positive" : "negative";
    const ratioClass = (ratio) => Number(ratio) >= 1.5 ? "ratio-up" : "ratio-flat";
    return `<tr data-address="${escapeHtml(item.token.address)}">
      <td class="rank-col">${String(index + 1).padStart(2, "0")}</td>
      <td><div class="token-cell">${tokenIcon(item.token)}<div class="token-copy"><strong>${escapeHtml(item.token.symbol)}</strong><span>${escapeHtml(item.token.name)}</span></div></div></td>
      <td><div class="signal-cell"><span class="signal-pill ${item.severity}">${severityLabels[item.severity]}</span></div></td>
      <td class="number-col"><span class="score-value ${item.severity}">${score}</span></td>
      <td class="number-col mono"><span class="metric-main ${priceClass}">${formatSignedPct(priceChange)}</span><span class="metric-sub">${formatPrice(item.token.price)}</span></td>
      <td class="number-col"><span class="metric-main">${formatNumber(current.unique_wallets, false)}</span><span class="metric-sub">此前 ${formatNumber(previous.unique_wallets, false)}</span></td>
      <td class="number-col"><span class="${ratioClass(item.ratios.unique_wallets)}">${formatRatio(item.ratios.unique_wallets)}</span></td>
      <td class="number-col"><span class="metric-main">${formatNumber(current.transfer_count, false)}</span><span class="metric-sub">此前 ${formatNumber(previous.transfer_count, false)}</span></td>
      <td class="number-col"><span class="${ratioClass(item.ratios.transfer_count)}">${formatRatio(item.ratios.transfer_count)}</span></td>
      <td class="number-col"><span class="${ratioClass(item.ratios.latest_6h_speed)}">${formatRatio(item.ratios.latest_6h_speed)}</span></td>
      <td><span class="direction-copy ${item.direction}">${directionLabels[item.direction]}</span></td>
      <td><button class="row-open" type="button" title="查看明细" aria-label="查看明细"><i data-lucide="chevron-right"></i></button></td>
    </tr>`;
  }).join("");
  $$("#alertsBody tr").forEach((row) => row.addEventListener("click", () => openDetail(row.dataset.address)));
  iconRefresh();
}

async function loadUniverse() {
  if (state.universe.length) return renderUniverse();
  try {
    const payload = await api("/api/universe");
    state.universe = payload.rows;
    renderUniverse();
  } catch (error) { showToast(error.message, true); }
}

function renderUniverse() {
  const query = state.universeQuery.toLowerCase();
  const rows = state.universe.filter((token) => !query || token.symbol.toLowerCase().includes(query) || token.name.toLowerCase().includes(query) || token.address.includes(query));
  $("#universeMeta").textContent = `${rows.length} 个项目`;
  $("#universeBody").innerHTML = rows.map((token) => `<tr>
    <td><div class="token-cell">${tokenIcon(token)}<div class="token-copy"><strong>${escapeHtml(token.symbol)}</strong><span>${escapeHtml(token.name)}</span></div></div></td>
    <td><div class="address-copy"><code>${escapeHtml(token.address)}</code><button class="copy-button" data-copy="${escapeHtml(token.address)}" title="复制地址"><i data-lucide="copy"></i></button></div></td>
    <td class="number-col mono">${formatPrice(token.price)}</td>
    <td class="number-col mono ${Number(token.price_change_24h) >= 0 ? "positive" : "negative"}">${Number(token.price_change_24h).toFixed(2)}%</td>
    <td class="number-col mono">${formatUsd(token.volume_24h)}</td>
    <td class="number-col mono">${formatUsd(token.liquidity)}</td>
    <td class="number-col mono">${formatNumber(token.holders)}</td>
    <td><button class="row-open token-scan" data-address="${escapeHtml(token.address)}" title="查看或补扫" aria-label="查看或补扫"><i data-lucide="scan-search"></i></button></td>
  </tr>`).join("");
  $$("[data-copy]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(button.dataset.copy);
    showToast("合约地址已复制");
  }));
  $$(".token-scan").forEach((button) => button.addEventListener("click", async () => {
    const address = button.dataset.address;
    try { await openDetail(address); }
    catch { await triggerTokenScan(address); }
  }));
  iconRefresh();
}

function formatSignedPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(Math.abs(number) >= 10 ? 1 : 2)}%`;
}

function formatKlineTime(timestamp) {
  if (!timestamp) return "--";
  return new Date(Number(timestamp) * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function renderActivityKline(kline) {
  const rows = (kline?.rows || []).filter((row) => Number(row?.hour));
  if (!rows.length) {
    return `<section class="detail-section activity-kline-section"><h3>钱包活跃度 K 线</h3><div class="kline-empty">暂无可绘制的小时数据</div></section>`;
  }
  const summary = kline.summary || {};
  const width = 660;
  const height = 228;
  const left = 58;
  const right = 12;
  const priceTop = 12;
  const priceHeight = 116;
  const activityTop = 152;
  const activityHeight = 42;
  const innerWidth = width - left - right;
  const priceValues = rows.flatMap((row) => [row.open, row.high, row.low, row.close].map(Number).filter((value) => Number.isFinite(value) && value > 0));
  const hasPrice = priceValues.length > 0;
  let priceMin = hasPrice ? Math.min(...priceValues) : 0;
  let priceMax = hasPrice ? Math.max(...priceValues) : 1;
  if (priceMin === priceMax) {
    const pad = Math.max(Math.abs(priceMax) * 0.01, 0.000001);
    priceMin -= pad;
    priceMax += pad;
  }
  const priceRange = priceMax - priceMin || 1;
  const priceY = (value) => priceTop + (priceMax - Number(value || priceMin)) / priceRange * priceHeight;
  const walletMax = Math.max(1, ...rows.map((row) => Number(row.unique_wallets || 0)));
  const step = innerWidth / rows.length;
  const candleWidth = Math.max(2, Math.min(9, step * 0.48));
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = priceTop + ratio * priceHeight;
    return `<line class="kline-grid-line" x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}"></line>`;
  }).join("");
  const labels = [priceMax, (priceMax + priceMin) / 2, priceMin].map((value, index) => {
    const y = priceTop + index * priceHeight / 2 + 4;
    return `<text class="kline-price-label" x="8" y="${y.toFixed(1)}">${escapeHtml(formatPrice(value))}</text>`;
  }).join("");
  const candles = hasPrice ? rows.map((row, index) => {
    const x = left + index * step + step / 2;
    const open = Number(row.open || 0);
    const close = Number(row.close || 0);
    const high = Number(row.high || 0);
    const low = Number(row.low || 0);
    const className = close > open ? "up" : close < open ? "down" : "flat";
    const wickTop = priceY(high || Math.max(open, close));
    const wickBottom = priceY(low || Math.min(open, close));
    const bodyTop = Math.min(priceY(open), priceY(close));
    const bodyHeight = Math.max(2, Math.abs(priceY(open) - priceY(close)));
    const tip = `${formatKlineTime(row.hour)} · O ${formatPrice(open)} H ${formatPrice(high)} L ${formatPrice(low)} C ${formatPrice(close)} · 钱包 ${formatNumber(row.unique_wallets, false)} · 转账 ${formatNumber(row.transfer_count, false)} · 估值 ${formatUsd(row.transfer_usd_est)}`;
    return `<g class="kline-candle ${className}"><title>${escapeHtml(tip)}</title><line x1="${x.toFixed(1)}" y1="${wickTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${wickBottom.toFixed(1)}"></line><rect x="${(x - candleWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleWidth.toFixed(1)}" height="${bodyHeight.toFixed(1)}"></rect></g>`;
  }).join("") : "";
  const activityBars = rows.map((row, index) => {
    const wallets = Number(row.unique_wallets || 0);
    const barHeight = wallets > 0 ? Math.max(2, wallets / walletMax * activityHeight) : 0;
    const x = left + index * step + Math.max(1, step * 0.18);
    const y = activityTop + activityHeight - barHeight;
    const barWidth = Math.max(2, step * 0.64);
    const className = index >= rows.length - 6 ? "current" : "";
    const tip = `${formatKlineTime(row.hour)} · 活跃钱包 ${formatNumber(wallets, false)} · 转账 ${formatNumber(row.transfer_count, false)}`;
    return `<rect class="kline-activity-bar ${className}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"><title>${escapeHtml(tip)}</title></rect>`;
  }).join("");
  const firstLabel = formatKlineTime(rows[0].hour);
  const lastLabel = formatKlineTime(rows[rows.length - 1].hour);
  const priceClass = Number(summary.price_change_pct || 0) >= 0 ? "positive" : "negative";
  return `<section class="detail-section activity-kline-section">
    <div class="detail-section-title"><h3>钱包活跃度 K 线</h3><span>${rows.length}H · 小时同步</span></div>
    <div class="kline-summary">
      <span><em>价格变化</em><strong class="${priceClass}">${summary.price_change_pct == null ? "--" : formatSignedPct(summary.price_change_pct)}</strong></span>
      <span><em>总钱包</em><strong>${formatNumber(summary.total_unique_wallets, false)}</strong></span>
      <span><em>峰值小时钱包</em><strong>${formatNumber(summary.peak_unique_wallets, false)}</strong></span>
      <span><em>转账笔数</em><strong>${formatNumber(summary.total_transfer_count, false)}</strong></span>
      <span><em>转移估值</em><strong>${formatUsd(summary.total_transfer_usd_est)}</strong></span>
    </div>
    <div class="activity-kline" role="img" aria-label="价格K线与钱包活跃度同步图">
      <svg class="kline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <rect class="kline-bg" x="0" y="0" width="${width}" height="${height}"></rect>
        <g>${grid}</g>
        <g>${labels}</g>
        <line class="kline-split" x1="${left}" y1="${activityTop - 12}" x2="${width - right}" y2="${activityTop - 12}"></line>
        <text class="kline-axis-label" x="8" y="${activityTop + 8}">钱包</text>
        <g>${candles}</g>
        <g>${activityBars}</g>
        <text class="kline-time-label" x="${left}" y="${height - 6}">${escapeHtml(firstLabel)}</text>
        <text class="kline-time-label end" x="${width - right}" y="${height - 6}">${escapeHtml(lastLabel)}</text>
      </svg>
    </div>
    <div class="chart-legend"><span>蜡烛为小时价格</span><span>下方柱为同小时活跃钱包</span><span>深色为最近 6 小时</span></div>
  </section>`;
}

async function openDetail(address) {
  const [payload, klinePayload] = await Promise.all([
    api(`/api/token/${address}`),
    api(`/api/token/${address}/activity-kline`).catch((error) => ({ ok: false, error: error.message, data: null })),
  ]);
  const item = payload.data;
  const klineSection = renderActivityKline(klinePayload.data);
  $("#detailHeading").innerHTML = `<div class="drawer-token">${tokenIcon(item.token)}<div><strong>${escapeHtml(item.token.symbol)} · ${escapeHtml(item.token.name)}</strong><span>${escapeHtml(item.token.address)}</span></div></div>`;
  const score = item.score == null ? "--" : item.score.toFixed(1);
  const hourly = item.hourly || [];
  const maxBar = Math.max(1, ...hourly.map((row) => Number(row.transfer_count || 0)));
  const bars = hourly.map((row, index) => {
    const height = Math.max(2, row.transfer_count / maxBar * 100);
    return `<span class="hour-bar ${index >= hourly.length - 6 ? "current" : ""}" style="--bar-height:${height}%" data-tip="${new Date(row.hour * 1000).getHours()}:00 · ${row.transfer_count} 笔"></span>`;
  }).join("");
  const topRows = (item.top_transfers || []).slice(0, 12).map((row) => `<tr>
    <td>${formatTime(row.event_ts).slice(5)}</td>
    <td><div class="wallet-endpoint"><code title="${escapeHtml(row.from_address)}">${shortAddress(row.from_address)}</code>${row.from_role !== "unknown" ? `<span class="wallet-role">${roleLabels[row.from_role] || row.from_role}</span>` : ""}</div></td>
    <td><div class="wallet-endpoint"><code title="${escapeHtml(row.to_address)}">${shortAddress(row.to_address)}</code>${row.to_role !== "unknown" ? `<span class="wallet-role">${roleLabels[row.to_role] || row.to_role}</span>` : ""}</div></td>
    <td class="number-col mono">${formatUsd(row.amount_usd_est)}</td>
  </tr>`).join("") || `<tr><td colspan="4">当前窗口没有可展示的转账记录</td></tr>`;
  const dataNotes = [...(item.data_notes || []), ...(klinePayload.data?.data_notes || [])];
  $("#detailContent").innerHTML = `
    <section class="detail-summary">
      <div class="detail-score"><strong class="${item.severity}">${score}</strong><span>${severityLabels[item.severity]}</span></div>
      ${detailMetric("24H 活跃钱包", formatNumber(item.current_24h.unique_wallets, false), `此前 ${formatNumber(item.previous_24h.unique_wallets, false)} · ${formatRatio(item.ratios.unique_wallets)}`)}
      ${detailMetric("24H 转账笔数", formatNumber(item.current_24h.transfer_count, false), `此前 ${formatNumber(item.previous_24h.transfer_count, false)} · ${formatRatio(item.ratios.transfer_count)}`)}
      ${detailMetric("转移金额估算", formatUsd(item.current_24h.transfer_usd_est), `此前 ${formatUsd(item.previous_24h.transfer_usd_est)}`)}
      ${detailMetric("历史覆盖", `${item.coverage.hours.toFixed(1)}H`, item.coverage.comparable ? "可进行周期比较" : "仍在补齐数据")}
    </section>
    <section class="detail-section"><h3>异动结论</h3><div class="reason-list">${item.reasons.map((reason) => `<div class="reason-row">${escapeHtml(reason)}</div>`).join("")}</div></section>
    ${klineSection}
    <section class="detail-section"><h3>48H 链上节奏</h3><div class="hour-chart">${bars}</div><div class="chart-legend"><span>48 小时前</span><span>最近 6 小时加深显示</span><span>现在</span></div></section>
    <section class="detail-section"><h3>大额转移记录</h3><div class="table-shell"><table class="transfer-table"><thead><tr><th>时间</th><th>从</th><th>到</th><th class="number-col">当前价估值</th></tr></thead><tbody>${topRows}</tbody></table></div></section>
    <section class="detail-section"><h3>数据口径</h3>${dataNotes.map((note) => `<div class="data-note">${escapeHtml(note)}</div>`).join("")}
      <div class="detail-actions"><button class="secondary-command" id="tokenRescanButton" type="button"><i data-lucide="scan-search"></i><span>补扫该币 48H</span></button><button class="secondary-command" data-copy="${escapeHtml(item.token.address)}" type="button"><i data-lucide="copy"></i><span>复制 CA</span></button></div>
    </section>`;
  $("#detailDrawer").classList.add("open");
  $("#detailDrawer").setAttribute("aria-hidden", "false");
  $("#tokenRescanButton").addEventListener("click", () => triggerTokenScan(item.token.address));
  const copyButton = $("#detailContent [data-copy]");
  if (copyButton) copyButton.addEventListener("click", async () => { await navigator.clipboard.writeText(item.token.address); showToast("合约地址已复制"); });
  iconRefresh();
}

function detailMetric(label, value, note) {
  return `<div class="detail-metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

async function triggerTokenScan(address) {
  try {
    const payload = await api("/api/token/scan", { method: "POST", body: JSON.stringify({ address }) });
    showToast(payload.message);
    await loadStatus();
  } catch (error) { showToast(error.message, true); }
}

function closeDetail() {
  $("#detailDrawer").classList.remove("open");
  $("#detailDrawer").setAttribute("aria-hidden", "true");
}

async function loadLabels() {
  try {
    const payload = await api("/api/labels");
    state.labels = payload.rows;
    $("#labelCount").textContent = `${state.labels.length} 个`;
    $("#labelList").innerHTML = state.labels.map((row) => `<div class="label-row">
      <strong>${escapeHtml(row.label)}</strong><span class="role-chip">${roleLabels[row.role] || row.role}</span><code title="${escapeHtml(row.address)}">${escapeHtml(row.address)}</code>
      <button class="delete-label" data-address="${escapeHtml(row.address)}" type="button" title="删除标签" aria-label="删除标签"><i data-lucide="trash-2"></i></button>
    </div>`).join("") || `<div class="empty-state"><i data-lucide="tags"></i><strong>还没有钱包标签</strong><span>保存首个标签后会显示在这里。</span></div>`;
    $$(".delete-label").forEach((button) => button.addEventListener("click", async () => {
      try { await api(`/api/labels/${button.dataset.address}`, { method: "DELETE" }); await loadLabels(); showToast("钱包标签已删除"); }
      catch (error) { showToast(error.message, true); }
    }));
    iconRefresh();
  } catch (error) { showToast(error.message, true); }
}

async function switchView(view) {
  state.activeView = view;
  $$(".view-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".workspace-view").forEach((section) => section.classList.toggle("active", section.id === `${view}View`));
  if (view === "universe") await loadUniverse();
  if (view === "labels") await loadLabels();
}

async function triggerScan() {
  try {
    const payload = await api("/api/scan", { method: "POST", body: "{}" });
    showToast(payload.message);
    $("#scanButton").disabled = true;
    setTimeout(loadStatus, 900);
  } catch (error) { showToast(error.message, true); }
}

function bindEvents() {
  $("#scanButton").addEventListener("click", triggerScan);
  $("#refreshButton").addEventListener("click", async () => { await Promise.all([loadStatus(), loadAlerts()]); showToast("面板已刷新"); });
  $$(".view-tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("#alertSearch").addEventListener("input", (event) => { state.alertQuery = event.target.value.trim(); renderAlerts(); });
  $("#universeSearch").addEventListener("input", (event) => { state.universeQuery = event.target.value.trim(); renderUniverse(); });
  $$("#severityFilter button").forEach((button) => button.addEventListener("click", async () => {
    state.severity = button.dataset.severity;
    $$("#severityFilter button").forEach((item) => item.classList.toggle("active", item === button));
    await loadAlerts();
  }));
  $("#showQuiet").addEventListener("change", async (event) => { state.includeQuiet = event.target.checked; await loadAlerts(); });
  $$('[data-close-drawer]').forEach((element) => element.addEventListener("click", closeDetail));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDetail(); });
  $("#labelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    try { await api("/api/labels", { method: "POST", body: JSON.stringify(body) }); event.target.reset(); await loadLabels(); showToast("钱包标签已保存"); }
    catch (error) { showToast(error.message, true); }
  });
}

async function init() {
  iconRefresh();
  bindEvents();
  await Promise.all([loadStatus(), loadAlerts()]);
  setInterval(loadStatus, 5000);
  setInterval(loadAlerts, 60000);
}

init();
