"""Read-only SinoPac (Shioaji) bridge for the assets dashboard.

Keeps one logged-in Shioaji session and serves, on the compose network only:

  GET /health  200 while the process is up; reports whether a session exists
  GET /margin  {"accounts": [...]} — futures/options margin per account (權益數 etc.)

Credentials come from SJ_API_KEY / SJ_SEC_KEY. Use a key with 行情/資料 + 帳務 + 正式環境 and
*without* 交易, so a leaked key cannot place orders. No CA is needed for margin queries.
"""

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import shioaji as sj

log = logging.getLogger("sinopac")

MARGIN_FIELDS = (
    "equity",
    "equity_amount",
    "today_balance",
    "yesterday_balance",
    "deposit_withdrawal",
    "future_open_position",
    "option_open_position",
    "initial_margin",
    "maintenance_margin",
    "available_margin",
    "risk_indicator",
    "margin_call",
)


class Bridge:
    def __init__(self, api_key: str, secret_key: str):
        self._key = api_key
        self._secret = secret_key
        self._api: sj.Shioaji | None = None
        self._lock = threading.Lock()

    @property
    def logged_in(self) -> bool:
        return self._api is not None

    def _login(self) -> sj.Shioaji:
        api = sj.Shioaji()
        api.login(self._key, self._secret)
        log.info("logged in; futures accounts: %s", [a.account_id for a in self._futopt_accounts(api)])
        return api

    def _drop(self) -> None:
        if self._api is not None:
            try:
                self._api.logout()
            except Exception:  # noqa: BLE001 - the session is being discarded anyway
                pass
            self._api = None

    @staticmethod
    def _futopt_accounts(api: sj.Shioaji) -> list:
        def kind(a) -> str:
            t = getattr(a, "account_type", "")
            return str(getattr(t, "value", t))

        return [a for a in api.list_accounts() if kind(a) in ("F", "AccountType.Future")]

    def _query(self, api: sj.Shioaji) -> list[dict]:
        out = []
        for account in self._futopt_accounts(api):
            m = api.margin(account)
            row = {f: float(getattr(m, f, 0) or 0) for f in MARGIN_FIELDS}
            row.update(account_id=account.account_id, broker_id=account.broker_id)
            out.append(row)
        return out

    def margin(self) -> list[dict]:
        """One retry with a fresh session, since a long-lived session can silently go stale."""
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._api is None:
                        self._api = self._login()
                    return self._query(self._api)
                except Exception:
                    log.exception("margin query failed (attempt %d)", attempt)
                    self._drop()
                    if attempt == 2:
                        raise
                    time.sleep(1)
            raise AssertionError("unreachable")


def make_handler(bridge: Bridge | None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if self.path == "/health":
                self._send(200, {"status": "ok", "configured": bridge is not None,
                                 "logged_in": bool(bridge and bridge.logged_in)})
            elif self.path == "/margin":
                if bridge is None:
                    self._send(503, {"error": "SJ_API_KEY / SJ_SEC_KEY not set"})
                    return
                try:
                    self._send(200, {"accounts": bridge.margin(), "fetched_at": time.time()})
                except Exception as e:  # noqa: BLE001 - reported to the caller, details in the log
                    self._send(502, {"error": f"{type(e).__name__}: {e}"})
            else:
                self._send(404, {"error": "not found"})

        def log_message(self, fmt: str, *args) -> None:
            log.debug(fmt, *args)

    return Handler


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [sinopac] %(levelname)s %(message)s")
    key, secret = os.environ.get("SJ_API_KEY", ""), os.environ.get("SJ_SEC_KEY", "")
    bridge = Bridge(key, secret) if key and secret else None
    if bridge is None:
        log.warning("SJ_API_KEY / SJ_SEC_KEY not set; /margin will answer 503")
    # Not PORT: the shared image sets PORT=3000 for Next.js.
    port = int(os.environ.get("SINOPAC_PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(bridge))
    log.info("listening on :%d", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
