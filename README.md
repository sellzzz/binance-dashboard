# Market Data Dashboard

一个本地/服务器可运行的内部市场数据看板。

## 功能

- Position change signal scan
- Small cap monitor
- Rate data
- Market cap display, prioritizing exchange-provided circulating supply when available
- Liquidity, liquidity/market-cap ratio, and 24h flow
- V3 tick liquidity range chart
- 点击表头排序

## 本地启动

```bash
npm install
npm start
```

默认地址：

```text
http://localhost:8787/
http://localhost:8787/smallcap.html
http://localhost:8787/reversal.html
```

服务状态检查：

```text
http://localhost:8787/api/health
```

日线关键区域原型会扫描少量预设标的，也支持通过页面输入自定义标的。它在第二次触及区域或进入区域前 1.2% 内发出提醒，不自动交易。

指定端口：

```bash
PORT=8790 npm start
```

Windows PowerShell:

```powershell
$env:PORT=8790
npm start
```

## 服务器部署

服务器需要 Node.js 18+。

```bash
git clone <你的 GitHub 仓库地址> market-dashboard
cd market-dashboard
npm install --omit=dev
PORT=8787 npm start
```

后台运行可用 `pm2`：

```bash
npm install -g pm2
PORT=8787 pm2 start server.js --name market-dashboard
pm2 save
```

访问：

```text
http://服务器IP:8787/
http://服务器IP:8787/smallcap.html
```

## 环境变量

- `PORT`: 服务端口，默认 `8787`
- `BSC_RPC`: RPC endpoint，默认 `https://bsc-dataseed.binance.org`
- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`: 如服务器需要代理访问外部接口，可设置代理

## 数据源

- Exchange futures REST API

## 宏观指标 API 配置

宏观总览会优先读取官方 FRED 和 CME FedWatch 数据。启动前可在 PowerShell 设置服务端环境变量：

```powershell
$env:FRED_API_KEY = "你的 FRED API key"
$env:CME_FEDWATCH_OAUTH_TOKEN = "你的 CME FedWatch OAuth token"
npm start
```

未配置凭据、接口无订阅、超时或返回空结果时，主页显示“暂无数据”，不会填充模拟值。
- CoinGecko API
- DexScreener API
- BSC JSON-RPC

## Telegram Push

Create a Telegram bot with BotFather, then get your chat id. Keep both values only on the server.

Test one push:

```bash
cd /opt/binance-dashboard
export TELEGRAM_BOT_TOKEN='your_bot_token'
export TELEGRAM_CHAT_ID='your_chat_id'
npm run notify:telegram -- --once
```

Run hourly with pm2:

```bash
cd /opt/binance-dashboard
TELEGRAM_BOT_TOKEN='your_bot_token' \
TELEGRAM_CHAT_ID='your_chat_id' \
pm2 start npm --name market-signal-push -- run notify:telegram
pm2 save
```

Optional overrides:

```bash
SIGNAL_SCAN_URL='http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=30&maxSymbols=500'
SIGNAL_INTERVAL_MS=3600000
```
