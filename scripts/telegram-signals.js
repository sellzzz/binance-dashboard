const DEFAULT_SCAN_URL =
  "http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=30&maxSymbols=500";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const scanUrl = process.env.SIGNAL_SCAN_URL || DEFAULT_SCAN_URL;
const intervalMs = Number(process.env.SIGNAL_INTERVAL_MS || DEFAULT_INTERVAL_MS);
const once = process.argv.includes("--once");

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtPct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(4)}%`;
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function buildMessage(data) {
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];
  const generatedAt = data.generatedAt ? fmtTime(data.generatedAt) : fmtTime(Date.now());
  const header = [
    "<b>Position Change Signals</b>",
    `Time: ${htmlEscape(generatedAt)}`,
    `Scan: ${htmlEscape(data.scanned ?? "-")} | Signals: ${alerts.length}`,
    `Window: ${htmlEscape(data.period ?? "-")} x ${htmlEscape(data.points ?? "-")} | Threshold: ${htmlEscape(data.threshold ?? "-")}%`,
  ].join("\n");

  if (!alerts.length) {
    return `${header}\n\nNo signals reached the threshold.`;
  }

  const rows = alerts
    .slice()
    .sort((a, b) => Number(b.changePct || 0) - Number(a.changePct || 0))
    .slice(0, 15)
    .map((row, index) => {
      const symbol = htmlEscape(row.symbol || "-");
      return [
        `${index + 1}. <b>${symbol}</b> ${fmtPct(row.changePct)}`,
        `Value ${fmtPct(row.valueChangePct)} | MCap ${fmtUsd(row.marketCap)} | Rate ${fmtRate(row.fundingRate)}`,
        `Liq/MCap ${fmtRatio(row.bscLiquidityToMcap)} | ${fmtTime(row.startTime)} - ${fmtTime(row.endTime)}`,
      ].join("\n");
    });

  return `${header}\n\n${rows.join("\n\n")}`;
}

async function sendTelegram(text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.description || `Telegram ${response.status}`);
  }
}

async function run() {
  const response = await fetch(scanUrl);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Scan ${response.status}`);
  await sendTelegram(buildMessage(data));
  console.log(`[${new Date().toISOString()}] sent ${Array.isArray(data.alerts) ? data.alerts.length : 0} signals`);
}

async function loop() {
  while (true) {
    try {
      await run();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`);
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(intervalMs) ? intervalMs : DEFAULT_INTERVAL_MS));
  }
}

loop();
