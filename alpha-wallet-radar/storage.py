from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable

from token_filters import is_ondo_tradefi_token


KLINE_DEAD_ADDRESSES = {
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000001",
}


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    icon_url TEXT NOT NULL DEFAULT '',
    decimals INTEGER NOT NULL DEFAULT 18,
    price REAL NOT NULL DEFAULT 0,
    price_change_24h REAL NOT NULL DEFAULT 0,
    volume_24h REAL NOT NULL DEFAULT 0,
    liquidity REAL NOT NULL DEFAULT 0,
    market_cap REAL NOT NULL DEFAULT 0,
    fdv REAL NOT NULL DEFAULT 0,
    holders INTEGER NOT NULL DEFAULT 0,
    alpha_count_24h INTEGER NOT NULL DEFAULT 0,
    listing_time INTEGER NOT NULL DEFAULT 0,
    alpha_id TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_snapshots (
    token_address TEXT NOT NULL,
    captured_hour INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    price_change_24h REAL NOT NULL DEFAULT 0,
    volume_24h REAL NOT NULL DEFAULT 0,
    liquidity REAL NOT NULL DEFAULT 0,
    holders INTEGER NOT NULL DEFAULT 0,
    alpha_count_24h INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token_address, captured_hour)
);

CREATE TABLE IF NOT EXISTS transfer_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    event_ts INTEGER NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount_token REAL NOT NULL DEFAULT 0,
    amount_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (tx_hash, log_index, token_address)
);
CREATE INDEX IF NOT EXISTS idx_events_token_time ON transfer_events(token_address, event_ts);
CREATE INDEX IF NOT EXISTS idx_events_time ON transfer_events(event_ts);

CREATE TABLE IF NOT EXISTS token_pools (
    token_address TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    dex_id TEXT NOT NULL DEFAULT '',
    pair_label TEXT NOT NULL DEFAULT '',
    liquidity_usd REAL NOT NULL DEFAULT 0,
    volume_24h REAL NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (token_address, pool_address)
);
CREATE INDEX IF NOT EXISTS idx_pool_address ON token_pools(pool_address);

CREATE TABLE IF NOT EXISTS wallet_labels (
    address TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    role TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    token_address TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_scan_state (
    token_address TEXT PRIMARY KEY,
    bootstrap_complete INTEGER NOT NULL DEFAULT 0,
    bootstrap_started_at INTEGER,
    bootstrap_completed_at INTEGER,
    earliest_event_ts INTEGER,
    last_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS anomaly_snapshots (
    token_address TEXT PRIMARY KEY,
    score REAL,
    severity TEXT NOT NULL,
    direction TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anomaly_score ON anomaly_snapshots(score DESC);

CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '',
    universe_count INTEGER NOT NULL DEFAULT 0,
    log_count INTEGER NOT NULL DEFAULT 0,
    new_event_count INTEGER NOT NULL DEFAULT 0,
    bootstrap_count INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class RadarStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(SCHEMA)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=45, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=45000")
        return connection

    def set_state(self, key: str, value: Any) -> None:
        encoded = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, encoded),
            )

    def get_state(self, key: str, default: Any = None, *, json_value: bool = False) -> Any:
        with self.connect() as connection:
            row = connection.execute("SELECT value FROM app_state WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        if json_value:
            try:
                return json.loads(row["value"])
            except json.JSONDecodeError:
                return default
        return row["value"]

    def upsert_tokens(self, tokens: list[dict[str, Any]], captured_at: int | None = None) -> None:
        tokens = [item for item in tokens if not is_ondo_tradefi_token(item)]
        now = int(captured_at or time.time())
        hour = now - now % 3600
        addresses = [item["address"] for item in tokens]
        with self.connect() as connection:
            connection.execute("UPDATE tokens SET active=0")
            connection.executemany(
                """
                INSERT INTO tokens(
                    address,symbol,name,icon_url,decimals,price,price_change_24h,volume_24h,
                    liquidity,market_cap,fdv,holders,alpha_count_24h,listing_time,alpha_id,active,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(address) DO UPDATE SET
                    symbol=excluded.symbol,name=excluded.name,icon_url=excluded.icon_url,
                    decimals=excluded.decimals,price=excluded.price,
                    price_change_24h=excluded.price_change_24h,volume_24h=excluded.volume_24h,
                    liquidity=excluded.liquidity,market_cap=excluded.market_cap,fdv=excluded.fdv,
                    holders=excluded.holders,alpha_count_24h=excluded.alpha_count_24h,
                    listing_time=excluded.listing_time,alpha_id=excluded.alpha_id,active=1,updated_at=excluded.updated_at
                """,
                [
                    (
                        item["address"], item["symbol"], item["name"], item["icon_url"], item["decimals"],
                        item["price"], item["price_change_24h"], item["volume_24h"], item["liquidity"],
                        item["market_cap"], item["fdv"], item["holders"], item["alpha_count_24h"],
                        item["listing_time"], item["alpha_id"], 1, now,
                    )
                    for item in tokens
                ],
            )
            connection.executemany(
                """
                INSERT INTO token_snapshots(
                    token_address,captured_hour,price,price_change_24h,volume_24h,liquidity,holders,alpha_count_24h
                ) VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(token_address,captured_hour) DO UPDATE SET
                    price=excluded.price,price_change_24h=excluded.price_change_24h,
                    volume_24h=excluded.volume_24h,liquidity=excluded.liquidity,
                    holders=excluded.holders,alpha_count_24h=excluded.alpha_count_24h
                """,
                [
                    (
                        item["address"], hour, item["price"], item["price_change_24h"], item["volume_24h"],
                        item["liquidity"], item["holders"], item["alpha_count_24h"],
                    )
                    for item in tokens
                ],
            )
            connection.executemany(
                "INSERT OR IGNORE INTO token_scan_state(token_address) VALUES(?)",
                [(address,) for address in addresses],
            )

    def active_tokens(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM tokens WHERE active=1 ORDER BY volume_24h DESC").fetchall()
        tokens = [dict(row) for row in rows]
        return [token for token in tokens if not is_ondo_tradefi_token(token)]

    def token(self, address: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM tokens WHERE address=?", (address.lower(),)).fetchone()
        if not row:
            return None
        token = dict(row)
        return None if is_ondo_tradefi_token(token) else token

    def bootstrap_candidates(self, limit: int, priority_symbols: tuple[str, ...]) -> list[dict[str, Any]]:
        placeholders = ",".join("?" for _ in priority_symbols) or "''"
        sql = f"""
            SELECT t.* FROM tokens t
            JOIN token_scan_state s ON s.token_address=t.address
            WHERE t.active=1 AND s.bootstrap_complete=0
            ORDER BY CASE WHEN t.symbol IN ({placeholders}) THEN 0 ELSE 1 END,
                     t.volume_24h DESC, t.alpha_count_24h DESC
            LIMIT ?
        """
        with self.connect() as connection:
            rows = connection.execute(sql, (*priority_symbols, limit)).fetchall()
        return [dict(row) for row in rows]

    def mark_bootstrap(self, addresses: Iterable[str], *, success: bool, error: str = "") -> None:
        now = int(time.time())
        with self.connect() as connection:
            for address in addresses:
                if success:
                    earliest = connection.execute(
                        "SELECT MIN(event_ts) AS ts FROM transfer_events WHERE token_address=?", (address,)
                    ).fetchone()["ts"]
                    connection.execute(
                        """UPDATE token_scan_state SET bootstrap_complete=1,bootstrap_completed_at=?,
                           earliest_event_ts=?,last_error='' WHERE token_address=?""",
                        (now, earliest, address),
                    )
                else:
                    connection.execute(
                        "UPDATE token_scan_state SET bootstrap_started_at=?,last_error=? WHERE token_address=?",
                        (now, error[:500], address),
                    )

    def scan_coverage(self) -> dict[str, int]:
        tokens = self.active_tokens()
        if not tokens:
            return {"total": 0, "complete": 0}
        addresses = [token["address"] for token in tokens]
        placeholders = ",".join("?" for _ in addresses)
        with self.connect() as connection:
            row = connection.execute(
                f"""SELECT SUM(CASE WHEN bootstrap_complete=1 THEN 1 ELSE 0 END) AS complete
                    FROM token_scan_state WHERE token_address IN ({placeholders})""",
                addresses,
            ).fetchone()
        return {"total": len(addresses), "complete": int(row["complete"] or 0)}

    def upsert_pools(self, pools: list[dict[str, Any]]) -> None:
        now = int(time.time())
        grouped: dict[str, list[dict[str, Any]]] = {}
        for pool in pools:
            grouped.setdefault(pool["token_address"], []).append(pool)
        with self.connect() as connection:
            for token_address, token_pools in grouped.items():
                connection.execute("DELETE FROM token_pools WHERE token_address=?", (token_address,))
                token_pools.sort(key=lambda item: item["liquidity_usd"], reverse=True)
                connection.executemany(
                    """INSERT INTO token_pools(
                        token_address,pool_address,dex_id,pair_label,liquidity_usd,volume_24h,is_primary,updated_at
                    ) VALUES(?,?,?,?,?,?,?,?)""",
                    [
                        (
                            token_address, item["pool_address"], item["dex_id"], item["pair_label"],
                            item["liquidity_usd"], item["volume_24h"], 1 if index == 0 else 0, now,
                        )
                        for index, item in enumerate(token_pools)
                    ],
                )

    def pools_for_token(self, token_address: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM token_pools WHERE token_address=? ORDER BY is_primary DESC,liquidity_usd DESC",
                (token_address.lower(),),
            ).fetchall()
        return [dict(row) for row in rows]

    def all_pool_addresses(self) -> set[str]:
        with self.connect() as connection:
            rows = connection.execute("SELECT DISTINCT pool_address FROM token_pools").fetchall()
        return {str(row["pool_address"]).lower() for row in rows}

    def insert_events(self, events: list[dict[str, Any]]) -> int:
        if not events:
            return 0
        with self.connect() as connection:
            before = connection.total_changes
            connection.executemany(
                """INSERT OR IGNORE INTO transfer_events(
                    tx_hash,log_index,token_address,block_number,event_ts,from_address,to_address,amount_token,amount_usd
                ) VALUES(?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        event["tx_hash"], event["log_index"], event["token_address"], event["block_number"],
                        event["event_ts"], event["from_address"], event["to_address"], event["amount_token"],
                        event["amount_usd"],
                    )
                    for event in events
                ],
            )
            return connection.total_changes - before

    def events_since(self, token_address: str, since_ts: int) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM transfer_events WHERE token_address=? AND event_ts>=? ORDER BY event_ts DESC",
                (token_address.lower(), since_ts),
            ).fetchall()
        return [dict(row) for row in rows]

    def token_snapshots_since(self, token_address: str, since_ts: int) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM token_snapshots WHERE token_address=? AND captured_hour>=? ORDER BY captured_hour",
                (token_address.lower(), since_ts),
            ).fetchall()
        return [dict(row) for row in rows]

    def activity_kline(
        self,
        token_address: str,
        *,
        hours: int = 48,
        bucket_seconds: int = 3600,
        now: int | None = None,
    ) -> dict[str, Any] | None:
        token = self.token(token_address)
        if not token:
            return None
        hours = max(1, min(168, int(hours or 48)))
        bucket_seconds = max(300, int(bucket_seconds or 3600))
        current_time = int(now or time.time())
        end_hour = current_time - current_time % bucket_seconds
        start_hour = end_hour - (hours - 1) * bucket_seconds
        event_end = min(current_time + 1, end_hour + bucket_seconds)
        token_address = str(token["address"]).lower()

        with self.connect() as connection:
            event_rows = connection.execute(
                "SELECT event_ts,from_address,to_address,amount_token,amount_usd "
                "FROM transfer_events "
                "WHERE token_address=? AND event_ts>=? AND event_ts<? "
                "ORDER BY event_ts",
                (token_address, start_hour, event_end),
            ).fetchall()
            snapshot_rows = connection.execute(
                "SELECT captured_hour,price,price_change_24h,volume_24h,liquidity,holders,alpha_count_24h "
                "FROM token_snapshots "
                "WHERE token_address=? AND captured_hour>=? AND captured_hour<=? "
                "ORDER BY captured_hour",
                (token_address, start_hour - bucket_seconds, end_hour),
            ).fetchall()

        def finite(value: Any) -> float:
            try:
                number = float(value or 0)
                return number if number == number and abs(number) != float("inf") else 0.0
            except (TypeError, ValueError, OverflowError):
                return 0.0

        buckets: dict[int, dict[str, Any]] = {
            hour: {
                "transfer_count": 0,
                "transfer_usd_est": 0.0,
                "amount_token": 0.0,
                "wallets": set(),
                "senders": set(),
                "receivers": set(),
            }
            for hour in range(start_hour, end_hour + bucket_seconds, bucket_seconds)
        }
        overall_wallets: set[str] = set()
        for row in event_rows:
            ts = int(row["event_ts"])
            hour = ts - ts % bucket_seconds
            bucket = buckets.get(hour)
            if bucket is None:
                continue
            sender = str(row["from_address"]).lower()
            receiver = str(row["to_address"]).lower()
            amount_usd = max(0.0, finite(row["amount_usd"]))
            amount_token = max(0.0, finite(row["amount_token"]))
            bucket["transfer_count"] += 1
            bucket["transfer_usd_est"] += amount_usd
            bucket["amount_token"] += amount_token
            if sender not in KLINE_DEAD_ADDRESSES:
                bucket["wallets"].add(sender)
                bucket["senders"].add(sender)
                overall_wallets.add(sender)
            if receiver not in KLINE_DEAD_ADDRESSES:
                bucket["wallets"].add(receiver)
                bucket["receivers"].add(receiver)
                overall_wallets.add(receiver)

        snapshots = [dict(row) for row in snapshot_rows]
        snapshot_by_hour = {int(row["captured_hour"]): row for row in snapshots if int(row["captured_hour"]) >= start_hour}
        previous_close = 0.0
        for row in snapshots:
            captured_hour = int(row["captured_hour"])
            price = finite(row.get("price"))
            if captured_hour < start_hour and price > 0:
                previous_close = price
        current_price = finite(token.get("price"))
        last_close = previous_close
        rows: list[dict[str, Any]] = []
        for hour in range(start_hour, end_hour + bucket_seconds, bucket_seconds):
            snapshot = snapshot_by_hour.get(hour)
            snapshot_price = finite(snapshot.get("price")) if snapshot else 0.0
            open_price = last_close or snapshot_price or current_price
            if snapshot_price > 0:
                close_price = snapshot_price
                price_source = "snapshot"
            else:
                close_price = open_price
                price_source = "carry_forward" if last_close or snapshot_price else "current_token"
            high_price = max(open_price, close_price) if open_price or close_price else 0.0
            low_price = min(open_price, close_price) if open_price and close_price else high_price
            if close_price > 0:
                last_close = close_price
            stats = buckets[hour]
            rows.append(
                {
                    "hour": hour,
                    "open": open_price,
                    "high": high_price,
                    "low": low_price,
                    "close": close_price,
                    "price_source": price_source,
                    "transfer_count": int(stats["transfer_count"]),
                    "unique_wallets": len(stats["wallets"]),
                    "unique_senders": len(stats["senders"]),
                    "unique_receivers": len(stats["receivers"]),
                    "transfer_usd_est": stats["transfer_usd_est"],
                    "amount_token": stats["amount_token"],
                    "volume_24h": finite(snapshot.get("volume_24h")) if snapshot else 0.0,
                    "liquidity": finite(snapshot.get("liquidity")) if snapshot else 0.0,
                    "holders": int(finite(snapshot.get("holders"))) if snapshot else 0,
                }
            )

        priced_rows = [row for row in rows if row["open"] > 0 and row["close"] > 0]
        first_price = priced_rows[0]["open"] if priced_rows else 0.0
        last_price = priced_rows[-1]["close"] if priced_rows else 0.0
        price_change_pct = ((last_price - first_price) / first_price * 100) if first_price else None
        summary = {
            "start_hour": start_hour,
            "end_hour": end_hour,
            "total_transfer_count": sum(row["transfer_count"] for row in rows),
            "total_unique_wallets": len(overall_wallets),
            "total_transfer_usd_est": sum(row["transfer_usd_est"] for row in rows),
            "active_hours": sum(1 for row in rows if row["transfer_count"] > 0),
            "peak_transfer_count": max((row["transfer_count"] for row in rows), default=0),
            "peak_unique_wallets": max((row["unique_wallets"] for row in rows), default=0),
            "first_price": first_price,
            "last_price": last_price,
            "price_change_pct": round(price_change_pct, 4) if price_change_pct is not None else None,
        }
        return {
            "token": {
                "address": token["address"],
                "symbol": token["symbol"],
                "name": token["name"],
                "price": token.get("price", 0),
            },
            "bucket_seconds": bucket_seconds,
            "hours": hours,
            "rows": rows,
            "summary": summary,
            "data_notes": [
                "价格 K 线按本地小时级 Alpha 快照生成；同小时缺失价格时沿用上一小时或当前价格。",
                "钱包活跃柱与 K 线使用同一个小时桶，钱包数按转出与转入地址合并去重。",
            ],
        }

    def labels(self, token_address: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM wallet_labels"
        params: tuple[Any, ...] = ()
        if token_address:
            sql += " WHERE token_address='' OR token_address=?"
            params = (token_address.lower(),)
        sql += " ORDER BY role,label"
        with self.connect() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def upsert_label(self, address: str, label: str, role: str, token_address: str = "", source: str = "manual") -> None:
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO wallet_labels(address,label,role,source,token_address,updated_at)
                   VALUES(?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET
                   label=excluded.label,role=excluded.role,source=excluded.source,
                   token_address=excluded.token_address,updated_at=excluded.updated_at""",
                (address.lower(), label.strip(), role, source, token_address.lower(), int(time.time())),
            )

    def delete_label(self, address: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM wallet_labels WHERE address=?", (address.lower(),))

    def upsert_anomaly(self, payload: dict[str, Any]) -> None:
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO anomaly_snapshots(token_address,score,severity,direction,payload_json,computed_at)
                   VALUES(?,?,?,?,?,?) ON CONFLICT(token_address) DO UPDATE SET
                   score=excluded.score,severity=excluded.severity,direction=excluded.direction,
                   payload_json=excluded.payload_json,computed_at=excluded.computed_at""",
                (
                    payload["token"]["address"], payload.get("score"), payload["severity"], payload["direction"],
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")), int(time.time()),
                ),
            )

    def anomalies(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM anomaly_snapshots ORDER BY COALESCE(score,-1) DESC,computed_at DESC"
            ).fetchall()
        payloads = [json.loads(row["payload_json"]) for row in rows]
        return [payload for payload in payloads if not is_ondo_tradefi_token(payload.get("token"))]

    def anomaly(self, token_address: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM anomaly_snapshots WHERE token_address=?", (token_address.lower(),)
            ).fetchone()
        if not row:
            return None
        payload = json.loads(row["payload_json"])
        return None if is_ondo_tradefi_token(payload.get("token")) else payload

    def start_run(self) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO scan_runs(started_at,status,stage) VALUES(?,?,?)",
                (int(time.time()), "running", "starting"),
            )
            return int(cursor.lastrowid)

    def update_run(self, run_id: int, **fields: Any) -> None:
        allowed = {
            "completed_at", "status", "stage", "universe_count", "log_count", "new_event_count",
            "bootstrap_count", "error",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return
        clause = ",".join(f"{key}=?" for key in updates)
        with self.connect() as connection:
            connection.execute(f"UPDATE scan_runs SET {clause} WHERE id=?", (*updates.values(), run_id))

    def latest_run(self) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").fetchone()
        return dict(row) if row else None

    def prune(self, before_ts: int) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM transfer_events WHERE event_ts<?", (before_ts,))
            connection.execute("DELETE FROM token_snapshots WHERE captured_hour<?", (before_ts,))
