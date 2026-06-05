# Binance Futures OI Dashboard

一个本地/服务器可运行的 Binance USDT-M 永续合约看板。

## 功能

- 合约持仓量异常增仓扫描
- 小市值合约雷达
- 资金费率
- 市值显示，优先使用 Binance `CMCCirculatingSupply` 推导，缺失时用 CoinGecko
- BSC 池子流动性、池/市值、24h DEX 量
- PancakeSwap V3 tick 流动性区间图
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
git clone <你的 GitHub 仓库地址> binance-dashboard
cd binance-dashboard
npm install --omit=dev
PORT=8787 npm start
```

后台运行可用 `pm2`：

```bash
npm install -g pm2
PORT=8787 pm2 start server.js --name binance-dashboard
pm2 save
```

访问：

```text
http://服务器IP:8787/
http://服务器IP:8787/smallcap.html
```

## 环境变量

- `PORT`: 服务端口，默认 `8787`
- `BSC_RPC`: BSC RPC，默认 `https://bsc-dataseed.binance.org`
- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`: 如服务器需要代理访问外部接口，可设置代理

## 数据源

- Binance Futures REST API
- CoinGecko API
- DexScreener API
- BSC JSON-RPC
