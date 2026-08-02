from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anomaly import analyze_token  # noqa: E402


NOW = 2_000_000_000
TOKEN = {
    "address": "0x1111111111111111111111111111111111111111",
    "symbol": "TEST",
    "name": "Test Token",
    "icon_url": "",
    "price": 1.0,
    "price_change_24h": 0,
    "volume_24h": 1_000_000,
    "liquidity": 500_000,
    "market_cap": 10_000_000,
    "holders": 1000,
}


def event(index: int, timestamp: int, sender: str | None = None, receiver: str | None = None, amount: float = 1000) -> dict:
    return {
        "tx_hash": f"0x{index:064x}",
        "log_index": 0,
        "token_address": TOKEN["address"],
        "block_number": index,
        "event_ts": timestamp,
        "from_address": sender or f"0x{index:040x}",
        "to_address": receiver or f"0x{index + 10000:040x}",
        "amount_token": amount,
        "amount_usd": amount,
    }


class AnomalyTests(unittest.TestCase):
    def test_strong_activity_change_is_distinguishable(self) -> None:
        events = [event(1, NOW - 48 * 3600)]
        events.extend(event(10 + i, NOW - 40 * 3600 + i * 1800) for i in range(24))
        events.extend(event(100 + i, NOW - 20 * 3600 + i * 600) for i in range(120))
        payload = analyze_token(TOKEN, events, [], [], [], now=NOW, bootstrap_complete=True)
        self.assertTrue(payload["coverage"]["comparable"])
        self.assertGreaterEqual(payload["score"], 65)
        self.assertIn(payload["severity"], {"high", "critical"})
        self.assertGreater(payload["ratios"]["transfer_count"], 2)
        self.assertGreater(payload["ratios"]["unique_wallets"], 2)

    def test_partial_history_never_emits_false_alert(self) -> None:
        events = [event(i, NOW - i * 60) for i in range(1, 200)]
        payload = analyze_token(TOKEN, events, [], [], [], now=NOW, bootstrap_complete=False)
        self.assertEqual(payload["severity"], "warming")
        self.assertIsNone(payload["score"])
        self.assertFalse(payload["coverage"]["comparable"])

    def test_labelled_operator_outflow_controls_direction(self) -> None:
        operator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        events = [event(1, NOW - 48 * 3600)]
        events.extend(event(10 + i, NOW - 36 * 3600 + i * 3600) for i in range(20))
        events.extend(event(100 + i, NOW - 12 * 3600 + i * 300, sender=operator, amount=5000) for i in range(30))
        labels = [{"address": operator, "label": "项目中转钱包", "role": "operator"}]
        payload = analyze_token(TOKEN, events, [], labels, [], now=NOW, bootstrap_complete=True)
        self.assertEqual(payload["direction"], "risk_outflow")
        self.assertGreater(payload["current_24h"]["risk_wallet_outflow_usd_est"], 100_000)

    def test_transfer_and_wallet_confirmation_reaches_watch_threshold(self) -> None:
        events = [event(1, NOW - 48 * 3600)]
        events.extend(event(10 + i, NOW - 40 * 3600 + i * 1200) for i in range(48))
        events.extend(event(100 + i, NOW - 20 * 3600 + i * 400) for i in range(162))
        payload = analyze_token(TOKEN, events, [], [], [], now=NOW, bootstrap_complete=True)
        self.assertGreater(payload["ratios"]["transfer_count"], 2)
        self.assertGreater(payload["ratios"]["unique_wallets"], 1.5)
        self.assertIn(payload["severity"], {"watch", "high", "critical"})


if __name__ == "__main__":
    unittest.main()
