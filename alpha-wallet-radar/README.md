# Alpha 链上异动雷达

一个本地运行的 Binance Alpha BSC 链上钱包异动监控面板。它会拉取公开 Alpha 市场列表、公开 BSC ERC-20 Transfer 日志和 DexScreener 池子数据，用 24H / 48H 钱包活跃、转账节奏、池子方向和价格快照来识别短线异常。

> 本项目只使用公开数据源，不读取 Binance 账户 API，不需要 HMAC 密钥，不查询账户资产，也不会下单。

## 功能

- 首页异动榜：按 24H 活跃钱包、转账笔数、转账金额、最近 6H 加速比和关键流向评分。
- 24H 价格变化：首页展示每个标的的 24H 涨跌幅和当前价格。
- 单币详情：查看 48H 链上节奏、大额转账、数据覆盖状态和钱包活跃度 K 线。
- 活跃度 K 线：单币页面把小时级价格 OHLC 和活跃钱包柱状图同步展示。
- 噪声过滤：排除明显来自 Ondo 链的 TradeFi 美股类代币，例如 `AAPLON`。
- 异动过滤：默认只展示近 24H 活跃钱包数达到 `100` 以上的信号。
- 本地标签：可以手动标注部署方、庄家中转、潜伏钱包、交易所、池子、金库等钱包角色。

## 数据源

- Binance Alpha 公开网页接口：币种列表、价格、成交额、流动性、持币地址数。
- BSC public JSON-RPC：ERC-20 `Transfer` 日志。
- DexScreener public API：池子地址、主池流动性、交易量。
- 本地 SQLite：缓存扫描状态、转账事件、池子标签、钱包标签和异动快照。

运行产生的数据库位于 `data/radar.sqlite3`，默认不会提交到 Git。

## 启动

需要 Python 3.10+，项目仅依赖标准库。

```powershell
cd C:\Users\Admin\Documents\Codex\2026-06-05\right\alpha_wallet_radar
python app.py --host 127.0.0.1 --port 8810
```

或者在 Windows 上双击：

```text
start_alpha_wallet_radar.bat
```

打开：

```text
http://127.0.0.1:8810/
```

## 配置

可以通过环境变量覆盖默认配置：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ALPHA_WALLET_RADAR_HOST` | `127.0.0.1` | 本地服务监听地址 |
| `ALPHA_WALLET_RADAR_PORT` | `8810` | 本地服务端口 |
| `ALPHA_WALLET_RADAR_INTERVAL_SECONDS` | `3600` | 扫描间隔 |
| `ALPHA_WALLET_RADAR_HISTORY_HOURS` | `48` | 异动比较窗口 |
| `ALPHA_WALLET_RADAR_RETAIN_HOURS` | `56` | 原始转账保留时间 |
| `ALPHA_WALLET_RADAR_BOOTSTRAP_PER_CYCLE` | `16` | 每轮补扫历史的代币数 |
| `ALPHA_WALLET_RADAR_RPC_URLS` | 内置公开 BSC RPC | 逗号分隔的 RPC 列表 |
| `ALPHA_WALLET_RADAR_RPC_WORKERS` | `4` | RPC 并发数 |
| `ALPHA_WALLET_RADAR_DB` | `data/radar.sqlite3` | SQLite 数据库路径 |

示例：

```powershell
$env:ALPHA_WALLET_RADAR_PORT = "8810"
$env:ALPHA_WALLET_RADAR_RPC_URLS = "https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io"
python app.py
```

## 测试

```powershell
python -m unittest discover -s tests
```

也可以检查前端脚本语法：

```powershell
node --check static/app.js
```

## 发布注意

- `data/*.sqlite3` 已被忽略，避免把本地 48H 转账缓存和人工标签发布出去。
- `.env`、日志、虚拟环境、测试缓存和打包产物都已被忽略。
- 这个项目是链上监控工具，不构成投资建议；链上转账金额是按扫描时价格估算，不等同于真实成交金额。
