from __future__ import annotations

import math
import statistics
import time
from collections import defaultdict
from typing import Any


ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
DEAD_ADDRESSES = {
    ZERO_ADDRESS,
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000001",
}
RISK_ROLES = {"deployer", "operator", "quiet", "insider", "dumper"}


def _ratio(current: float, previous: float, smoothing: float) -> float:
    return (current + smoothing) / (previous + smoothing)


def _finite(value: float) -> float:
    return value if math.isfinite(value) else 0.0


def _metrics(events: list[dict[str, Any]], start: int, end: int, labels: dict[str, dict[str, Any]], pools: set[str]) -> dict[str, Any]:
    selected = [event for event in events if start <= int(event["event_ts"]) < end]
    wallets: set[str] = set()
    senders: set[str] = set()
    receivers: set[str] = set()
    total_usd = 0.0
    risk_outflow_usd = 0.0
    risk_inflow_usd = 0.0
    pool_in_usd = 0.0
    pool_out_usd = 0.0
    mint_count = 0
    burn_count = 0
    for event in selected:
        sender = str(event["from_address"]).lower()
        receiver = str(event["to_address"]).lower()
        amount_usd = max(0.0, _finite(float(event.get("amount_usd") or 0)))
        total_usd += amount_usd
        if sender not in DEAD_ADDRESSES:
            wallets.add(sender)
            senders.add(sender)
        if receiver not in DEAD_ADDRESSES:
            wallets.add(receiver)
            receivers.add(receiver)
        if sender == ZERO_ADDRESS:
            mint_count += 1
        if receiver in DEAD_ADDRESSES:
            burn_count += 1
        if str(labels.get(sender, {}).get("role", "")).lower() in RISK_ROLES:
            risk_outflow_usd += amount_usd
        if str(labels.get(receiver, {}).get("role", "")).lower() in RISK_ROLES:
            risk_inflow_usd += amount_usd
        if receiver in pools:
            pool_in_usd += amount_usd
        if sender in pools:
            pool_out_usd += amount_usd
    return {
        "transfer_count": len(selected),
        "unique_wallets": len(wallets),
        "unique_senders": len(senders),
        "unique_receivers": len(receivers),
        "transfer_usd_est": total_usd,
        "risk_wallet_outflow_usd_est": risk_outflow_usd,
        "risk_wallet_inflow_usd_est": risk_inflow_usd,
        "pool_in_usd_est": pool_in_usd,
        "pool_out_usd_est": pool_out_usd,
        "mint_count": mint_count,
        "burn_count": burn_count,
    }


def _hourly_series(events: list[dict[str, Any]], now: int) -> list[dict[str, Any]]:
    start = now - 48 * 3600
    buckets: dict[int, dict[str, Any]] = defaultdict(lambda: {"count": 0, "wallets": set(), "usd": 0.0})
    for event in events:
        ts = int(event["event_ts"])
        if ts < start:
            continue
        hour = ts - ts % 3600
        bucket = buckets[hour]
        bucket["count"] += 1
        sender = str(event["from_address"]).lower()
        receiver = str(event["to_address"]).lower()
        if sender not in DEAD_ADDRESSES:
            bucket["wallets"].add(sender)
        if receiver not in DEAD_ADDRESSES:
            bucket["wallets"].add(receiver)
        bucket["usd"] += max(0.0, _finite(float(event.get("amount_usd") or 0)))
    return [
        {
            "hour": hour,
            "transfer_count": int(buckets[hour]["count"]),
            "unique_wallets": len(buckets[hour]["wallets"]),
            "transfer_usd_est": buckets[hour]["usd"],
        }
        for hour in range(start - start % 3600, now - now % 3600 + 1, 3600)
    ]


def _top_transfers(events: list[dict[str, Any]], labels: dict[str, dict[str, Any]], pools: set[str], limit: int = 20) -> list[dict[str, Any]]:
    ranked = sorted(events, key=lambda item: float(item.get("amount_usd") or 0), reverse=True)
    result: list[dict[str, Any]] = []
    for event in ranked[:limit]:
        sender = str(event["from_address"]).lower()
        receiver = str(event["to_address"]).lower()
        sender_meta = labels.get(sender, {})
        receiver_meta = labels.get(receiver, {})
        result.append(
            {
                "tx_hash": event["tx_hash"],
                "event_ts": event["event_ts"],
                "from_address": sender,
                "to_address": receiver,
                "from_label": sender_meta.get("label") or ("已识别池子" if sender in pools else ""),
                "from_role": sender_meta.get("role") or ("pool" if sender in pools else "unknown"),
                "to_label": receiver_meta.get("label") or ("已识别池子" if receiver in pools else ""),
                "to_role": receiver_meta.get("role") or ("pool" if receiver in pools else "unknown"),
                "amount_token": event.get("amount_token", 0),
                "amount_usd_est": event.get("amount_usd", 0),
            }
        )
    return result


def _score_component(ratio: float, floor: float, ceiling: float, weight: float) -> float:
    if ratio <= floor:
        return 0.0
    normalized = math.log(max(ratio, 1.0) / floor + 1, 2) / math.log(ceiling / floor + 1, 2)
    return min(weight, max(0.0, normalized * weight))


def analyze_token(
    token: dict[str, Any],
    events: list[dict[str, Any]],
    pools: list[dict[str, Any]],
    label_rows: list[dict[str, Any]],
    snapshots: list[dict[str, Any]],
    *,
    now: int | None = None,
    bootstrap_complete: bool = True,
) -> dict[str, Any]:
    current_time = int(now or time.time())
    labels = {str(row["address"]).lower(): row for row in label_rows}
    pool_addresses = {str(row["pool_address"]).lower() for row in pools if len(str(row["pool_address"])) == 42}
    current = _metrics(events, current_time - 24 * 3600, current_time + 1, labels, pool_addresses)
    previous = _metrics(events, current_time - 48 * 3600, current_time - 24 * 3600, labels, pool_addresses)
    latest_6h = _metrics(events, current_time - 6 * 3600, current_time + 1, labels, pool_addresses)
    previous_18h = _metrics(events, current_time - 24 * 3600, current_time - 6 * 3600, labels, pool_addresses)

    event_ratio = _ratio(current["transfer_count"], previous["transfer_count"], 20)
    wallet_ratio = _ratio(current["unique_wallets"], previous["unique_wallets"], 15)
    amount_ratio = _ratio(current["transfer_usd_est"], previous["transfer_usd_est"], 10_000)
    recent_hourly = latest_6h["transfer_count"] / 6
    prior_hourly = previous_18h["transfer_count"] / 18
    burst_ratio = _ratio(recent_hourly, prior_hourly, 3)

    coverage_start = min((int(event["event_ts"]) for event in events), default=current_time)
    coverage_hours = max(0.0, min(48.0, (current_time - coverage_start) / 3600))
    comparable = bootstrap_complete and coverage_hours >= 46

    activity_material = current["transfer_count"] >= 60 or current["unique_wallets"] >= 35
    score = 0.0
    score += _score_component(event_ratio, 1.35, 6.0, 26)
    score += _score_component(wallet_ratio, 1.3, 5.0, 28)
    score += _score_component(amount_ratio, 1.5, 8.0, 16)
    score += _score_component(burst_ratio, 1.5, 7.0, 15)
    if event_ratio >= 2 and wallet_ratio >= 2:
        score += 10
    elif event_ratio >= 2 and wallet_ratio >= 1.5:
        score += 8
    elif event_ratio >= 1.5 and wallet_ratio >= 1.5:
        score += 4
    if event_ratio >= 3 and wallet_ratio >= 3:
        score += 5
    labelled_total = current["risk_wallet_outflow_usd_est"] + current["risk_wallet_inflow_usd_est"]
    if labelled_total >= 25_000:
        score += min(15.0, 5.0 + math.log10(max(labelled_total, 1) / 25_000 + 1) * 8)
    if not activity_material:
        score *= 0.55
    score = round(min(100.0, score), 1)

    if not comparable:
        severity = "warming"
        score_value: float | None = None
    elif score >= 80:
        severity = "critical"
        score_value = score
    elif score >= 65:
        severity = "high"
        score_value = score
    elif score >= 48:
        severity = "watch"
        score_value = score
    else:
        severity = "quiet"
        score_value = score

    risk_out = current["risk_wallet_outflow_usd_est"]
    risk_in = current["risk_wallet_inflow_usd_est"]
    if risk_out >= max(25_000, risk_in * 1.5):
        direction = "risk_outflow"
    elif risk_in >= max(25_000, risk_out * 1.5):
        direction = "accumulation"
    elif current["pool_in_usd_est"] >= max(50_000, current["pool_out_usd_est"] * 1.8):
        direction = "pool_increase"
    else:
        direction = "neutral"

    reasons: list[str] = []
    if comparable:
        if event_ratio >= 1.5:
            reasons.append(f"24h 转账笔数为前一周期的 {event_ratio:.1f} 倍")
        if wallet_ratio >= 1.5:
            reasons.append(f"活跃钱包为前一周期的 {wallet_ratio:.1f} 倍")
        if burst_ratio >= 2:
            reasons.append(f"最近 6h 速度较此前加快 {burst_ratio:.1f} 倍")
        if labelled_total >= 25_000:
            reasons.append("已标注关键钱包发生可见转移")
        if not reasons:
            reasons.append("当前链上活动仍在常态区间")
    else:
        reasons.append(f"历史覆盖 {coverage_hours:.1f}h，补齐 48h 后开始比较")

    holder_change = None
    if len(snapshots) >= 2:
        first_holders = int(snapshots[0].get("holders") or 0)
        last_holders = int(snapshots[-1].get("holders") or 0)
        if first_holders:
            holder_change = (last_holders - first_holders) / first_holders * 100

    hourly = _hourly_series(events, current_time)
    nonzero_counts = [row["transfer_count"] for row in hourly[:-6] if row["transfer_count"] > 0]
    baseline_median_hour = statistics.median(nonzero_counts) if nonzero_counts else 0
    return {
        "token": {
            "address": token["address"],
            "symbol": token["symbol"],
            "name": token["name"],
            "icon_url": token.get("icon_url", ""),
            "price": token.get("price", 0),
            "price_change_24h": token.get("price_change_24h", 0),
            "volume_24h": token.get("volume_24h", 0),
            "liquidity": token.get("liquidity", 0),
            "market_cap": token.get("market_cap", 0),
            "holders": token.get("holders", 0),
        },
        "score": score_value,
        "severity": severity,
        "direction": direction,
        "reasons": reasons,
        "current_24h": current,
        "previous_24h": previous,
        "ratios": {
            "transfer_count": round(event_ratio, 3),
            "unique_wallets": round(wallet_ratio, 3),
            "transfer_usd": round(amount_ratio, 3),
            "latest_6h_speed": round(burst_ratio, 3),
        },
        "coverage": {
            "hours": round(coverage_hours, 1),
            "comparable": comparable,
            "bootstrap_complete": bootstrap_complete,
            "baseline_median_hour": baseline_median_hour,
            "method": "current_24h_vs_previous_24h_and_latest_6h_acceleration",
        },
        "holder_change_pct": holder_change,
        "hourly": hourly,
        "top_transfers": _top_transfers(events, labels, pool_addresses),
        "pools": pools[:8],
        "labels": label_rows,
        "computed_at": current_time,
        "data_notes": [
            "转移金额按扫描时 Alpha 现价估算，不等同于已成交金额。",
            "转入/转出池子只能证明代币移动，未结合 swap 事件时不直接判定买卖方向。",
            "未标注钱包只参与活跃度统计，不被擅自归类为庄家或散户。",
        ],
    }
