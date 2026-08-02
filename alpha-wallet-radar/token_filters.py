from __future__ import annotations

from typing import Any, Mapping


def is_ondo_tradefi_token(row: Mapping[str, Any] | None) -> bool:
    if not row:
        return False
    symbol = str(row.get("symbol") or "").upper().strip()
    name = str(row.get("name") or "").lower()
    return symbol.endswith("ON") and "ondo" in name