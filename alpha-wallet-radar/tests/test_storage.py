from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from storage import RadarStore  # noqa: E402
from token_filters import is_ondo_tradefi_token  # noqa: E402


class StorageTests(unittest.TestCase):
    def test_event_ingest_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RadarStore(Path(directory) / "radar.sqlite3")
            row = {
                "tx_hash": "0xabc",
                "log_index": 1,
                "token_address": "0x1111111111111111111111111111111111111111",
                "block_number": 100,
                "event_ts": 1_900_000_000,
                "from_address": "0x2222222222222222222222222222222222222222",
                "to_address": "0x3333333333333333333333333333333333333333",
                "amount_token": 10,
                "amount_usd": 20,
            }
            self.assertEqual(store.insert_events([row]), 1)
            self.assertEqual(store.insert_events([row]), 0)

    def test_manual_label_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RadarStore(Path(directory) / "radar.sqlite3")
            address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            store.upsert_label(address, "潜伏钱包 A", "quiet")
            labels = store.labels()
            self.assertEqual(labels[0]["address"], address)
            self.assertEqual(labels[0]["role"], "quiet")
            store.delete_label(address)
            self.assertEqual(store.labels(), [])

    def test_ondo_tradefi_filter_is_conservative(self) -> None:
        self.assertTrue(is_ondo_tradefi_token({"symbol": "AAPLON", "name": "Apple (Ondo)"}))
        self.assertFalse(is_ondo_tradefi_token({"symbol": "AEON", "name": "AEON"}))
        with tempfile.TemporaryDirectory() as directory:
            store = RadarStore(Path(directory) / "radar.sqlite3")
            base = {
                "address": "0x1111111111111111111111111111111111111111",
                "symbol": "AEON",
                "name": "AEON",
                "icon_url": "",
                "decimals": 18,
                "price": 1,
                "price_change_24h": 0,
                "volume_24h": 1,
                "liquidity": 1,
                "market_cap": 1,
                "fdv": 1,
                "holders": 1,
                "alpha_count_24h": 1,
                "listing_time": 0,
                "alpha_id": "",
            }
            blocked = dict(base, address="0x2222222222222222222222222222222222222222", symbol="AAPLON", name="Apple (Ondo)")
            store.upsert_tokens([base, blocked], captured_at=2_000_000_000)
            self.assertEqual([row["symbol"] for row in store.active_tokens()], ["AEON"])

    def test_activity_kline_aligns_wallets_and_price(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = RadarStore(Path(directory) / "radar.sqlite3")
            address = "0x1111111111111111111111111111111111111111"
            base_hour = 2_000_001_600
            token = {
                "address": address,
                "symbol": "TEST",
                "name": "Test Token",
                "icon_url": "",
                "decimals": 18,
                "price": 1.0,
                "price_change_24h": 0,
                "volume_24h": 1,
                "liquidity": 1,
                "market_cap": 1,
                "fdv": 1,
                "holders": 1,
                "alpha_count_24h": 1,
                "listing_time": 0,
                "alpha_id": "",
            }
            store.upsert_tokens([dict(token, price=1.0)], captured_at=base_hour - 2 * 3600)
            store.upsert_tokens([dict(token, price=2.0)], captured_at=base_hour - 3600)
            store.insert_events([
                {
                    "tx_hash": "0xabc",
                    "log_index": 1,
                    "token_address": address,
                    "block_number": 100,
                    "event_ts": base_hour - 3600 + 30,
                    "from_address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "to_address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "amount_token": 10,
                    "amount_usd": 20,
                }
            ])
            payload = store.activity_kline(address, hours=3, bucket_seconds=3600, now=base_hour + 30)
            self.assertIsNotNone(payload)
            rows = payload["rows"]
            self.assertEqual(len(rows), 3)
            active = [row for row in rows if row["transfer_count"] == 1][0]
            self.assertEqual(active["unique_wallets"], 2)
            self.assertEqual(active["close"], 2.0)

if __name__ == "__main__":
    unittest.main()
