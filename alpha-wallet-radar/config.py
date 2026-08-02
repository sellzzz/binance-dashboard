from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class RadarConfig:
    base_dir: Path
    host: str = "127.0.0.1"
    port: int = 8810
    scan_interval_seconds: int = 3600
    chain_id: str = "56"
    block_seconds: float = 0.75
    incremental_lookback_blocks: int = 1600
    history_hours: int = 48
    retain_hours: int = 56
    bootstrap_tokens_per_cycle: int = 16
    address_batch_size: int = 24
    block_chunk_size: int = 1800
    rpc_workers: int = 4
    rpc_timeout_seconds: int = 35
    rpc_urls: tuple[str, ...] = (
        "https://bsc.rpc.blxrbdn.com",
        "https://bsc-dataseed.binance.org",
        "https://bsc-dataseed1.defibit.io",
    )

    @property
    def db_path(self) -> Path:
        override = os.environ.get("ALPHA_WALLET_RADAR_DB")
        return Path(override) if override else self.base_dir / "data" / "radar.sqlite3"

    @property
    def static_dir(self) -> Path:
        return self.base_dir / "static"

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> "RadarConfig":
        root = (base_dir or Path(__file__).resolve().parent).resolve()
        rpc_raw = os.environ.get("ALPHA_WALLET_RADAR_RPC_URLS", "").strip()
        rpc_urls = tuple(item.strip() for item in rpc_raw.split(",") if item.strip())
        defaults = cls(base_dir=root)
        return cls(
            base_dir=root,
            host=os.environ.get("ALPHA_WALLET_RADAR_HOST", defaults.host),
            port=_env_int("ALPHA_WALLET_RADAR_PORT", defaults.port),
            scan_interval_seconds=max(300, _env_int("ALPHA_WALLET_RADAR_INTERVAL_SECONDS", defaults.scan_interval_seconds)),
            history_hours=max(48, _env_int("ALPHA_WALLET_RADAR_HISTORY_HOURS", defaults.history_hours)),
            retain_hours=max(52, _env_int("ALPHA_WALLET_RADAR_RETAIN_HOURS", defaults.retain_hours)),
            bootstrap_tokens_per_cycle=max(1, _env_int("ALPHA_WALLET_RADAR_BOOTSTRAP_PER_CYCLE", defaults.bootstrap_tokens_per_cycle)),
            address_batch_size=max(1, _env_int("ALPHA_WALLET_RADAR_ADDRESS_BATCH", defaults.address_batch_size)),
            block_chunk_size=max(200, _env_int("ALPHA_WALLET_RADAR_BLOCK_CHUNK", defaults.block_chunk_size)),
            rpc_workers=max(1, min(8, _env_int("ALPHA_WALLET_RADAR_RPC_WORKERS", defaults.rpc_workers))),
            rpc_timeout_seconds=max(10, _env_int("ALPHA_WALLET_RADAR_RPC_TIMEOUT", defaults.rpc_timeout_seconds)),
            rpc_urls=rpc_urls or defaults.rpc_urls,
        )
