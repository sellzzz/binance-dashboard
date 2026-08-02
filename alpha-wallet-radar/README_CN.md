# Alpha 链上异动雷达

这是一个与现有量化工作台完全分离的本地项目，用于监控 Binance Alpha BSC 币种在最近 24H / 48H 内的钱包移动变化。

## 当前数据源

- Alpha 币种名单与市场快照：Binance 公开网页接口，不使用账户 API。
- ERC-20 Transfer 日志：公开 BSC JSON-RPC。
- 池地址与池规模标签：DexScreener 公开接口。
- 钱包角色：本地人工标签；也可以后续导入 HertzFlow 生成的监控钱包文件。

程序不会读取 Binance HMAC 密钥，不会查询账户，也不会下单。

## 异动口径

- 当前 24H 与前一段 24H 比较：转账笔数、独立钱包数、转移金额估算。
- 最近 6H 与此前 18H 比较：识别活动突然加速。
- 关键钱包方向：只有明确标注为部署方、庄家中转、潜伏钱包、内幕分发或分发中钱包时才判断风险流出或归集。
- 未补齐 48H 历史的币种只显示“数据预热”，不会产生正式异动分数。
- 转移金额使用扫描时的 Alpha 现价估算，只代表链上移动规模，不代表成交金额。

## 启动

双击 `start_alpha_wallet_radar.bat`，或执行：

```powershell
C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe app.py --host 127.0.0.1 --port 8810
```

打开 `http://127.0.0.1:8810/`。

## 扫描节奏

- 每小时更新一次 Alpha 全量市场快照和新区块转账。
- 首次运行优先补扫重点与高成交项目的 48H 历史，其余项目按队列逐轮补齐。
- 池地址每天刷新一次。
- 原始转账保留 56 小时，覆盖 48H 比较窗口并留出 8 小时延迟缓冲；SQLite 自动去重并定期清理。

## 环境参数

可通过环境变量覆盖：

- `ALPHA_WALLET_RADAR_PORT`
- `ALPHA_WALLET_RADAR_INTERVAL_SECONDS`
- `ALPHA_WALLET_RADAR_BOOTSTRAP_PER_CYCLE`
- `ALPHA_WALLET_RADAR_RPC_URLS`
- `ALPHA_WALLET_RADAR_RPC_WORKERS`
- `ALPHA_WALLET_RADAR_DB`
