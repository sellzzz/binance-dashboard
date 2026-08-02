from __future__ import annotations

import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Iterable

from anomaly import analyze_token
from config import RadarConfig
from data_sources import BscRpcClient, DataSourceError, fetch_alpha_tokens, fetch_dexscreener_pools
from storage import RadarStore


PRIORITY_SYMBOLS = ("BEAT", "BSB", "BLESS", "MYX", "COAI", "LYN", "EVAA", "GENIUS", "ZEST")


def _chunks(items: list[Any], size: int) -> Iterable[list[Any]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


class AlphaWalletScanner:
    def __init__(self, config: RadarConfig, store: RadarStore) -> None:
        self.config = config
        self.store = store
        self.rpc = BscRpcClient(config.rpc_urls, timeout=config.rpc_timeout_seconds)
        latest_run = store.latest_run()
        has_completed_run = bool(latest_run and latest_run.get("status") == "completed")
        self._run_lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._status_lock = threading.Lock()
        self._status: dict[str, Any] = {
            "running": False,
            "stage": "waiting",
            "message": "等待下一周期" if has_completed_run else "等待首次扫描",
            "progress_current": 0,
            "progress_total": 0,
            "last_error": "",
        }

    def status(self) -> dict[str, Any]:
        with self._status_lock:
            status = dict(self._status)
        status["latest_run"] = self.store.latest_run()
        status["coverage"] = self.store.scan_coverage()
        status["next_scan_seconds"] = self._seconds_until_next_scan()
        status["interval_seconds"] = self.config.scan_interval_seconds
        return status

    def _set_status(self, **changes: Any) -> None:
        with self._status_lock:
            self._status.update(changes)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="alpha-wallet-scanner", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def trigger(self) -> bool:
        if self._run_lock.locked():
            return False
        self.store.set_state("manual_scan_requested_at", str(int(time.time())))
        self._wake.set()
        return True

    def trigger_token_bootstrap(self, token_address: str) -> bool:
        address = token_address.lower()
        if not self.store.token(address) or self._run_lock.locked():
            return False

        def run() -> None:
            if not self._run_lock.acquire(blocking=False):
                return
            try:
                head, head_ts = self.rpc.head()
                token = self.store.token(address)
                if token:
                    self._set_status(running=True, stage="token_history", message=f"正在补扫 {token['symbol']} 的 48h 历史")
                    self._scan_history([token], head, head_ts)
                    self._compute_anomaly(token, head_ts, True)
            except Exception as exc:
                self.store.mark_bootstrap([address], success=False, error=str(exc))
                self._set_status(last_error=str(exc))
            finally:
                self._set_status(running=False, stage="waiting", message="单币补扫完成")
                self._run_lock.release()

        threading.Thread(target=run, name=f"token-bootstrap-{address[-6:]}", daemon=True).start()
        return True

    def _seconds_until_next_scan(self) -> int:
        last = self.store.get_state("last_cycle_completed_at", "0")
        try:
            return max(0, self.config.scan_interval_seconds - (int(time.time()) - int(last)))
        except (TypeError, ValueError):
            return 0

    def _loop(self) -> None:
        self._wake.wait(timeout=2.5)
        while not self._stop.is_set():
            if self._seconds_until_next_scan() <= 0 or self._wake.is_set():
                self._wake.clear()
                self.run_cycle()
            self._wake.wait(timeout=min(30, max(2, self._seconds_until_next_scan())))

    def run_cycle(self) -> bool:
        if not self._run_lock.acquire(blocking=False):
            return False
        run_id = self.store.start_run()
        total_logs = 0
        total_new = 0
        bootstrap_count = 0
        try:
            self._set_status(running=True, stage="universe", message="正在更新 Binance Alpha 全量名单", last_error="")
            tokens = fetch_alpha_tokens(self.config.chain_id)
            now = int(time.time())
            self.store.upsert_tokens(tokens, captured_at=now)
            self.store.update_run(run_id, stage="universe", universe_count=len(tokens))

            if self._pools_due(now):
                self._set_status(stage="pools", message="正在更新公开池地址与主池标签")
                self._refresh_pools(tokens)
                self.store.set_state("last_pool_refresh_at", str(now))

            head, head_ts = self.rpc.head()
            self._set_status(stage="incremental", message="正在读取所有 Alpha 项目的新区块转账")
            logs, inserted = self._scan_incremental(tokens, head, head_ts)
            total_logs += logs
            total_new += inserted
            self.store.update_run(run_id, stage="incremental", log_count=total_logs, new_event_count=total_new)

            candidates = self.store.bootstrap_candidates(self.config.bootstrap_tokens_per_cycle, PRIORITY_SYMBOLS)
            if candidates:
                symbols = "、".join(item["symbol"] for item in candidates[:6])
                self._set_status(stage="history", message=f"正在补齐 48h 历史：{symbols}")
                logs, inserted = self._scan_history(candidates, head, head_ts)
                total_logs += logs
                total_new += inserted
                bootstrap_count = len(candidates)
                self.store.mark_bootstrap([item["address"] for item in candidates], success=True)

            self._set_status(stage="scoring", message="正在计算 24h/48h 异动分数")
            self._recompute_anomalies(head_ts)
            self.store.prune(head_ts - self.config.retain_hours * 3600)
            completed = int(time.time())
            self.store.set_state("last_cycle_completed_at", str(completed))
            self.store.set_state("last_head_block", str(head))
            self.store.update_run(
                run_id,
                completed_at=completed,
                status="completed",
                stage="completed",
                log_count=total_logs,
                new_event_count=total_new,
                bootstrap_count=bootstrap_count,
            )
            self._set_status(running=False, stage="waiting", message="扫描完成，等待下一周期", progress_current=0, progress_total=0)
            return True
        except Exception as exc:
            completed = int(time.time())
            self.store.update_run(run_id, completed_at=completed, status="failed", stage="failed", error=str(exc))
            self._set_status(running=False, stage="error", message="本轮扫描失败，服务将在下个周期自动重试", last_error=str(exc))
            return False
        finally:
            self._run_lock.release()

    def _pools_due(self, now: int) -> bool:
        try:
            last = int(self.store.get_state("last_pool_refresh_at", "0"))
        except (TypeError, ValueError):
            last = 0
        return now - last >= 24 * 3600

    def _refresh_pools(self, tokens: list[dict[str, Any]]) -> None:
        batches = list(_chunks([token["address"] for token in tokens], 30))
        self._set_status(progress_current=0, progress_total=len(batches))
        for index, batch in enumerate(batches, start=1):
            try:
                pools = fetch_dexscreener_pools(batch)
                self.store.upsert_pools(pools)
            except DataSourceError as exc:
                self._set_status(last_error=f"部分池地址更新失败：{exc}")
            self._set_status(progress_current=index)
            time.sleep(0.12)

    def _scan_incremental(self, tokens: list[dict[str, Any]], head: int, head_ts: int) -> tuple[int, int]:
        try:
            previous_head = int(self.store.get_state("last_head_block", "0"))
        except (TypeError, ValueError):
            previous_head = 0
        from_block = (
            previous_head + 1
            if previous_head > 0
            else self.rpc.block_at_or_after_timestamp(head_ts - 4500, head, head_ts)
        )
        if from_block > head:
            return 0, 0
        return self._scan_ranges(tokens, from_block, head, head, head_ts)

    def _scan_history(self, tokens: list[dict[str, Any]], head: int, head_ts: int) -> tuple[int, int]:
        from_block = self.rpc.block_at_or_after_timestamp(
            head_ts - self.config.history_hours * 3600 - 300,
            head,
            head_ts,
        )
        return self._scan_ranges(tokens, from_block, head, head, head_ts)

    def _scan_ranges(
        self,
        tokens: list[dict[str, Any]],
        from_block: int,
        to_block: int,
        head_block: int,
        head_ts: int,
    ) -> tuple[int, int]:
        token_map = {token["address"].lower(): token for token in tokens}
        from_ts = self.rpc.block_timestamp(from_block)
        observed_block_seconds = (
            max(0.05, (head_ts - from_ts) / max(1, head_block - from_block))
            if head_block > from_block
            else self.config.block_seconds
        )
        self.store.set_state("observed_block_seconds", f"{observed_block_seconds:.6f}")
        address_batches = list(_chunks(list(token_map), self.config.address_batch_size))
        ranges = [
            (start, min(start + self.config.block_chunk_size - 1, to_block))
            for start in range(from_block, to_block + 1, self.config.block_chunk_size)
        ]
        jobs = [(addresses, start, end) for addresses in address_batches for start, end in ranges]
        total_logs = 0
        total_new = 0
        self._set_status(progress_current=0, progress_total=len(jobs))

        def fetch(job: tuple[list[str], int, int]) -> list[dict[str, Any]]:
            addresses, start, end = job
            client = BscRpcClient(self.config.rpc_urls, timeout=self.config.rpc_timeout_seconds)
            return client.transfer_logs(addresses, start, end)

        with ThreadPoolExecutor(max_workers=self.config.rpc_workers) as executor:
            futures = {executor.submit(fetch, job): job for job in jobs}
            for index, future in enumerate(as_completed(futures), start=1):
                job = futures[future]
                try:
                    raw_logs = future.result()
                except Exception as exc:
                    addresses, start, end = job
                    if len(addresses) > 1:
                        raw_logs = []
                        for address in addresses:
                            raw_logs.extend(BscRpcClient(self.config.rpc_urls, self.config.rpc_timeout_seconds).transfer_logs([address], start, end))
                    else:
                        raise DataSourceError(f"transfer log scan failed for {addresses[0]} blocks {start}-{end}: {exc}") from exc
                parsed = [
                    event
                    for row in raw_logs
                    if (event := self._parse_log(row, token_map, head_block, head_ts, observed_block_seconds)) is not None
                ]
                total_logs += len(raw_logs)
                total_new += self.store.insert_events(parsed)
                self._set_status(progress_current=index)
        return total_logs, total_new

    def _parse_log(
        self,
        row: dict[str, Any],
        token_map: dict[str, dict[str, Any]],
        head_block: int,
        head_ts: int,
        observed_block_seconds: float,
    ) -> dict[str, Any] | None:
        try:
            token_address = str(row["address"]).lower()
            token = token_map[token_address]
            topics = row.get("topics") or []
            if len(topics) < 3:
                return None
            sender = "0x" + str(topics[1])[-40:].lower()
            receiver = "0x" + str(topics[2])[-40:].lower()
            raw_hex = str(row.get("data") or "0x0")
            raw_amount = int(raw_hex, 16)
            amount_token = raw_amount / (10 ** int(token.get("decimals") or 18))
            if not math.isfinite(amount_token) or amount_token < 0:
                amount_token = 0.0
            block_number = int(row["blockNumber"], 16)
            event_ts = int(head_ts - max(0, head_block - block_number) * observed_block_seconds)
            return {
                "tx_hash": str(row["transactionHash"]).lower(),
                "log_index": int(row.get("logIndex", "0x0"), 16),
                "token_address": token_address,
                "block_number": block_number,
                "event_ts": event_ts,
                "from_address": sender,
                "to_address": receiver,
                "amount_token": amount_token,
                "amount_usd": amount_token * float(token.get("price") or 0),
            }
        except (KeyError, TypeError, ValueError, OverflowError):
            return None

    def _recompute_anomalies(self, now: int) -> None:
        tokens = self.store.active_tokens()
        self._set_status(progress_current=0, progress_total=len(tokens))
        for index, token in enumerate(tokens, start=1):
            state_complete = self._bootstrap_complete(token["address"])
            self._compute_anomaly(token, now, state_complete)
            if index % 10 == 0 or index == len(tokens):
                self._set_status(progress_current=index)

    def _bootstrap_complete(self, token_address: str) -> bool:
        with self.store.connect() as connection:
            row = connection.execute(
                "SELECT bootstrap_complete FROM token_scan_state WHERE token_address=?", (token_address,)
            ).fetchone()
        return bool(row and row["bootstrap_complete"])

    def _compute_anomaly(self, token: dict[str, Any], now: int, bootstrap_complete: bool) -> None:
        events = self.store.events_since(token["address"], now - self.config.history_hours * 3600 - 900)
        pools = self.store.pools_for_token(token["address"])
        labels = self.store.labels(token["address"])
        snapshots = self.store.token_snapshots_since(token["address"], now - self.config.history_hours * 3600)
        payload = analyze_token(
            token,
            events,
            pools,
            labels,
            snapshots,
            now=now,
            bootstrap_complete=bootstrap_complete,
        )
        self.store.upsert_anomaly(payload)
