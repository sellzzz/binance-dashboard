from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from config import RadarConfig
from scanner import AlphaWalletScanner
from storage import RadarStore


ALLOWED_ROLES = {"deployer", "operator", "quiet", "insider", "dumper", "cex", "pool", "router", "treasury", "other"}
MIN_ALERT_UNIQUE_WALLETS_24H = 100


def enough_daily_wallet_activity(row: dict[str, Any]) -> bool:
    return int((row.get("current_24h") or {}).get("unique_wallets") or 0) >= MIN_ALERT_UNIQUE_WALLETS_24H


class RadarApplication:
    def __init__(self, config: RadarConfig) -> None:
        self.config = config
        self.store = RadarStore(config.db_path)
        self.scanner = AlphaWalletScanner(config, self.store)
        self.started_at = int(time.time())

    def status_payload(self) -> dict[str, Any]:
        anomalies = [item for item in self.store.anomalies() if enough_daily_wallet_activity(item)]
        counts = {key: 0 for key in ("critical", "high", "watch", "quiet", "warming")}
        for item in anomalies:
            counts[item.get("severity", "warming")] = counts.get(item.get("severity", "warming"), 0) + 1
        return {
            "ok": True,
            "service": "Alpha 链上异动雷达",
            "uptime_seconds": int(time.time()) - self.started_at,
            "scanner": self.scanner.status(),
            "severity_counts": counts,
            "data_source_policy": {
                "alpha_universe": "Binance public web endpoint",
                "onchain_transfers": "public BSC JSON-RPC",
                "pool_labels": "DexScreener public API",
                "binance_account_api_used": False,
            },
        }


def make_handler(application: RadarApplication) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "AlphaWalletRadar/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[{self.log_date_time_string()}] {fmt % args}")

        def _json(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _static(self, relative: str) -> None:
            name = "index.html" if relative in ("", "/") else relative.lstrip("/")
            target = (application.config.static_dir / name).resolve()
            if application.config.static_dir.resolve() not in target.parents and target != application.config.static_dir.resolve():
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = target.read_bytes()
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/status":
                self._json(application.status_payload())
                return
            if parsed.path == "/api/alerts":
                rows = application.store.anomalies()
                severity = str(params.get("severity", [""])[0]).lower()
                query = str(params.get("q", [""])[0]).lower().strip()
                include_quiet = str(params.get("include_quiet", ["0"])[0]) == "1"
                if severity:
                    rows = [row for row in rows if row.get("severity") == severity]
                elif not include_quiet:
                    rows = [row for row in rows if row.get("severity") in {"critical", "high", "watch"}]
                rows = [row for row in rows if enough_daily_wallet_activity(row)]
                if query:
                    rows = [
                        row for row in rows
                        if query in row["token"]["symbol"].lower()
                        or query in row["token"]["name"].lower()
                        or query in row["token"]["address"].lower()
                    ]
                self._json({"ok": True, "rows": rows, "count": len(rows)})
                return
            if parsed.path.startswith("/api/token/") and parsed.path.endswith("/activity-kline"):
                parts = parsed.path.strip("/").split("/")
                address = parts[2].lower() if len(parts) >= 4 else ""
                try:
                    hours = int(params.get("hours", ["48"])[0])
                except (TypeError, ValueError):
                    hours = 48
                payload = application.store.activity_kline(address, hours=hours, bucket_seconds=3600)
                if not payload:
                    self._json({"ok": False, "error": "未找到该币种或已被过滤"}, 404)
                    return
                self._json({"ok": True, "data": payload})
                return
            if parsed.path.startswith("/api/token/"):
                address = parsed.path.rsplit("/", 1)[-1].lower()
                payload = application.store.anomaly(address)
                if not payload:
                    self._json({"ok": False, "error": "未找到该币种或尚未完成首次计算"}, 404)
                    return
                self._json({"ok": True, "data": payload})
                return
            if parsed.path == "/api/universe":
                tokens = application.store.active_tokens()
                self._json({"ok": True, "rows": tokens, "count": len(tokens)})
                return
            if parsed.path == "/api/labels":
                token_address = str(params.get("token_address", [""])[0]).lower()
                self._json({"ok": True, "rows": application.store.labels(token_address or None)})
                return
            self._static(parsed.path)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            try:
                body = self._body()
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._json({"ok": False, "error": "请求不是有效 JSON"}, 400)
                return
            if parsed.path == "/api/scan":
                started = application.scanner.trigger()
                self._json({"ok": started, "message": "扫描已启动" if started else "扫描正在运行中，无需重复启动"}, 202 if started else 409)
                return
            if parsed.path == "/api/token/scan":
                address = str(body.get("address") or "").lower()
                started = application.scanner.trigger_token_bootstrap(address)
                self._json({"ok": started, "message": "单币 48h 补扫已启动" if started else "币种不存在或扫描器正忙"}, 202 if started else 409)
                return
            if parsed.path == "/api/labels":
                address = str(body.get("address") or "").lower()
                label = str(body.get("label") or "").strip()
                role = str(body.get("role") or "other").lower()
                token_address = str(body.get("token_address") or "").lower()
                if len(address) != 42 or not address.startswith("0x") or not label or role not in ALLOWED_ROLES:
                    self._json({"ok": False, "error": "钱包地址、名称或角色不合法"}, 400)
                    return
                application.store.upsert_label(address, label, role, token_address)
                self._json({"ok": True, "message": "钱包标签已保存，将在下一次评分时生效"})
                return
            self._json({"ok": False, "error": "接口不存在"}, 404)

        def do_DELETE(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/labels/"):
                address = parsed.path.rsplit("/", 1)[-1].lower()
                application.store.delete_label(address)
                self._json({"ok": True, "message": "钱包标签已删除"})
                return
            self._json({"ok": False, "error": "接口不存在"}, 404)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Alpha 链上异动雷达")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--no-background-scan", action="store_true")
    args = parser.parse_args()
    config = RadarConfig.from_env(Path(__file__).resolve().parent)
    if args.host or args.port:
        values = dict(config.__dict__)
        values["host"] = args.host or config.host
        values["port"] = args.port or config.port
        config = RadarConfig(**values)
    application = RadarApplication(config)
    if not args.no_background_scan:
        application.scanner.start()
    server = ThreadingHTTPServer((config.host, config.port), make_handler(application))
    print(f"Alpha 链上异动雷达已启动：http://{config.host}:{config.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        application.scanner.stop()
        server.server_close()


if __name__ == "__main__":
    main()
