#!/usr/bin/env python3
"""Poll Functions · Runs and print queue depth + status counts every N seconds.

Env: NOTION_API_TOKEN
Args: [interval_seconds=15] [iterations=20]
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.request
from collections import Counter
from datetime import datetime

ctx = ssl.create_default_context()
try:
    import certifi  # type: ignore

    ctx.load_verify_locations(certifi.where())
except Exception:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

TOKEN = os.environ["NOTION_API_TOKEN"]
DB = "362296db-34e0-8154-99ea-d91a01a58125"
HDR = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
}


def query_active() -> list[dict]:
    rows: list[dict] = []
    cur: str | None = None
    while True:
        body: dict = {
            "page_size": 100,
            "filter": {
                "or": [
                    {"property": "Status", "select": {"equals": "pending"}},
                    {"property": "Status", "select": {"equals": "running"}},
                    {"property": "Status", "select": {"equals": "sleeping"}},
                    {"property": "Status", "select": {"equals": "waiting"}},
                ]
            },
        }
        if cur:
            body["start_cursor"] = cur
        req = urllib.request.Request(
            f"https://api.notion.com/v1/databases/{DB}/query",
            data=json.dumps(body).encode(),
            method="POST",
            headers=HDR,
        )
        r = json.loads(urllib.request.urlopen(req, context=ctx).read())
        rows += r["results"]
        if not r.get("has_more"):
            break
        cur = r["next_cursor"]
    return rows


def succeeded_count() -> int:
    body = {
        "page_size": 1,
        "filter": {"property": "Status", "select": {"equals": "succeeded"}},
    }
    req = urllib.request.Request(
        f"https://api.notion.com/v1/databases/{DB}/query",
        data=json.dumps(body).encode(),
        method="POST",
        headers=HDR,
    )
    r = json.loads(urllib.request.urlopen(req, context=ctx).read())
    # Notion doesn't give a total, so we page through to count.
    total = len(r["results"])
    cur = r.get("next_cursor")
    while r.get("has_more"):
        body2 = dict(body, page_size=100, start_cursor=cur)
        req = urllib.request.Request(
            f"https://api.notion.com/v1/databases/{DB}/query",
            data=json.dumps(body2).encode(),
            method="POST",
            headers=HDR,
        )
        r = json.loads(urllib.request.urlopen(req, context=ctx).read())
        total += len(r["results"])
        cur = r.get("next_cursor")
    return total


def main() -> None:
    interval = int(sys.argv[1]) if len(sys.argv) > 1 else 15
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    prev_active: int | None = None
    prev_done: int | None = None
    start = time.time()
    print(
        f"{'time':>8}  {'active':>6}  {'pend':>4}  {'run':>4}  {'slp':>4}  {'wait':>4}  {'ok':>4}  Δactive  Δok"
    )
    for i in range(iters):
        rows = query_active()
        c = Counter(
            p["properties"]["Status"]["select"]["name"]
            for p in rows
            if p["properties"]["Status"]["select"]
        )
        done = succeeded_count()
        active = len(rows)
        d_act = "" if prev_active is None else f"{active - prev_active:+d}"
        d_done = "" if prev_done is None else f"{done - prev_done:+d}"
        elapsed = int(time.time() - start)
        print(
            f"{elapsed:>6}s  {active:>6}  {c.get('pending',0):>4}  "
            f"{c.get('running',0):>4}  {c.get('sleeping',0):>4}  "
            f"{c.get('waiting',0):>4}  {done:>4}  {d_act:>7}  {d_done:>3}",
            flush=True,
        )
        prev_active, prev_done = active, done
        if active == 0:
            print("queue drained.")
            return
        if i < iters - 1:
            time.sleep(interval)


if __name__ == "__main__":
    main()
