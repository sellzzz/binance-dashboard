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
```

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
- CoinGecko API
- DexScreener API
- BSC JSON-RPC
