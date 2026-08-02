from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from typing import Any, Iterable

from token_filters import is_ondo_tradefi_token


ALPHA_LIST_URL = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list"
DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/bsc/{addresses}"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


class DataSourceError(RuntimeError):
    pass


def _request_json(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
    attempts: int = 3,
) -> Any:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "AlphaWalletRadar/1.0 (+local research tool)",
    }
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.7 * (2**attempt) + random.random() * 0.3)
    raise DataSourceError(f"request failed: {url}: {last_error}")


def fetch_alpha_tokens(chain_id: str = "56") -> list[dict[str, Any]]:
    payload = _request_json(ALPHA_LIST_URL, timeout=25)
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise DataSourceError("Binance Alpha list returned an unexpected payload")

    tokens: list[dict[str, Any]] = []
    for row in rows:
        address = str(row.get("contractAddress") or "").lower()
        if str(row.get("chainId")) != chain_id or len(address) != 42:
            continue
        if row.get("fullyDelisted") or row.get("offline"):
            continue
        if is_ondo_tradefi_token(row):
            continue
        tokens.append(
            {
                "address": address,
                "symbol": str(row.get("symbol") or "?").upper(),
                "name": str(row.get("name") or row.get("symbol") or "Unknown"),
                "icon_url": str(row.get("iconUrl") or ""),
                "decimals": int(row.get("decimals") or 18),
                "price": _safe_float(row.get("price")),
                "price_change_24h": _safe_float(row.get("percentChange24h")),
                "volume_24h": _safe_float(row.get("volume24h")),
                "liquidity": _safe_float(row.get("liquidity")),
                "market_cap": _safe_float(row.get("marketCap")),
                "fdv": _safe_float(row.get("fdv")),
                "holders": int(_safe_float(row.get("holders"))),
                "alpha_count_24h": int(_safe_float(row.get("count24h"))),
                "listing_time": int(_safe_float(row.get("listingTime"))),
                "alpha_id": str(row.get("alphaId") or ""),
            }
        )
    return tokens


def fetch_dexscreener_pools(addresses: Iterable[str]) -> list[dict[str, Any]]:
    clean = [str(address).lower() for address in addresses if len(str(address)) == 42]
    if not clean:
        return []
    payload = _request_json(DEXSCREENER_TOKENS_URL.format(addresses=",".join(clean)), timeout=25)
    rows = payload if isinstance(payload, list) else []
    pools: list[dict[str, Any]] = []
    address_set = set(clean)
    for row in rows:
        base = str((row.get("baseToken") or {}).get("address") or "").lower()
        quote = str((row.get("quoteToken") or {}).get("address") or "").lower()
        token_address = base if base in address_set else quote if quote in address_set else ""
        pair_address = str(row.get("pairAddress") or "").lower()
        if not token_address or not pair_address:
            continue
        pools.append(
            {
                "token_address": token_address,
                "pool_address": pair_address,
                "dex_id": str(row.get("dexId") or ""),
                "pair_label": f"{(row.get('baseToken') or {}).get('symbol', '?')}/{(row.get('quoteToken') or {}).get('symbol', '?')}",
                "liquidity_usd": _safe_float((row.get("liquidity") or {}).get("usd")),
                "volume_24h": _safe_float((row.get("volume") or {}).get("h24")),
            }
        )
    return pools


class BscRpcClient:
    def __init__(self, urls: tuple[str, ...], timeout: int = 35) -> None:
        self.urls = urls
        self.timeout = timeout
        self._cursor = 0

    def _rpc(self, method: str, params: list[Any]) -> Any:
        errors: list[str] = []
        for offset in range(len(self.urls)):
            index = (self._cursor + offset) % len(self.urls)
            url = self.urls[index]
            try:
                payload = _request_json(
                    url,
                    payload={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                    timeout=self.timeout,
                    attempts=2,
                )
                if isinstance(payload, dict) and payload.get("error"):
                    raise DataSourceError(str(payload["error"]))
                if not isinstance(payload, dict) or "result" not in payload:
                    raise DataSourceError("RPC response missing result")
                self._cursor = index
                return payload["result"]
            except Exception as exc:  # each configured public RPC is an independent fallback
                errors.append(f"{url}: {exc}")
        raise DataSourceError("all BSC RPC endpoints failed: " + " | ".join(errors))

    def head(self) -> tuple[int, int]:
        block_hex = self._rpc("eth_blockNumber", [])
        block_number = int(block_hex, 16)
        block = self._rpc("eth_getBlockByNumber", [hex(block_number), False])
        return block_number, int(block["timestamp"], 16)

    def block_timestamp(self, block_number: int) -> int:
        block = self._rpc("eth_getBlockByNumber", [hex(max(1, block_number)), False])
        if not block:
            raise DataSourceError(f"block {block_number} was not returned by RPC")
        return int(block["timestamp"], 16)

    def block_at_or_after_timestamp(self, target_ts: int, head_block: int, head_ts: int) -> int:
        if target_ts >= head_ts:
            return head_block
        span = 250_000
        low = max(1, head_block - span)
        low_ts = self.block_timestamp(low)
        while low > 1 and low_ts > target_ts:
            span *= 2
            low = max(1, head_block - span)
            low_ts = self.block_timestamp(low)
        high = head_block
        while low + 1 < high:
            middle = (low + high) // 2
            middle_ts = self.block_timestamp(middle)
            if middle_ts < target_ts:
                low = middle
            else:
                high = middle
        return high

    def transfer_logs(self, addresses: list[str], from_block: int, to_block: int) -> list[dict[str, Any]]:
        if not addresses or from_block > to_block:
            return []
        query = {
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
            "address": addresses if len(addresses) > 1 else addresses[0],
            "topics": [TRANSFER_TOPIC],
        }
        rows = self._rpc("eth_getLogs", [query])
        if not isinstance(rows, list):
            raise DataSourceError("eth_getLogs returned a non-list result")
        return rows


def _safe_float(value: Any) -> float:
    try:
        number = float(value or 0)
        return number if number == number and abs(number) != float("inf") else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0
