"""
One-shot cleanup: archive duplicate rows in Functions · Runs that share a
Run ID (the side effect of the idempotency race surfaced by scripts/stress.ts).

Strategy:
  - Query all active rows (pending/running/sleeping/waiting).
  - Group by Run ID.
  - For each group with > 1 row, KEEP the most-advanced one
    (highest Step Cursor; tie-break by earliest created_time so any
    sync-tracked row beats externally-created clones).
  - pages.update({archived: true}) on the losers.

Dry-run by default. Pass `--apply` to actually archive.

Usage:
  set -a && source .env.local && set +a
  python3 scripts/dedupe_runs.py            # report what would be archived
  python3 scripts/dedupe_runs.py --apply    # actually archive

Safe to re-run; archived rows are filtered out of the next sweep.
"""

import json
import os
import ssl
import sys
import urllib.request
from collections import defaultdict
from typing import Any

APPLY = "--apply" in sys.argv

TOKEN = os.environ["NOTION_API_TOKEN"]
RUNS_DB = "362296db-34e0-8154-99ea-d91a01a58125"  # Functions · Runs

ctx = ssl.create_default_context()
try:
    import certifi

    ctx.load_verify_locations(certifi.where())
except Exception:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE


def api(method: str, path: str, body: Any = None) -> Any:
    req = urllib.request.Request(
        f"https://api.notion.com/v1{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.load(r)


def rt(props: dict, key: str) -> str:
    return "".join(
        x.get("plain_text", "") for x in props.get(key, {}).get("rich_text", [])
    )


def num(props: dict, key: str) -> int:
    n = props.get(key, {}).get("number")
    return int(n) if n is not None else 0


# Page through all active rows.
rows: list[dict] = []
cursor: str | None = None
while True:
    body = {
        "page_size": 100,
        "filter": {
            "or": [
                {"property": "Status", "select": {"equals": "pending"}},
                {"property": "Status", "select": {"equals": "running"}},
                {"property": "Status", "select": {"equals": "sleeping"}},
                {"property": "Status", "select": {"equals": "waiting"}},
            ]
        },
        "sorts": [{"timestamp": "created_time", "direction": "ascending"}],
    }
    if cursor:
        body["start_cursor"] = cursor
    page = api("POST", f"/databases/{RUNS_DB}/query", body)
    rows.extend(page["results"])
    if not page.get("has_more"):
        break
    cursor = page.get("next_cursor")

print(f"Scanned {len(rows)} active rows.")

groups: dict[str, list[dict]] = defaultdict(list)
for row in rows:
    p = row["properties"]
    rid = rt(p, "Run ID")
    if not rid:
        continue
    groups[rid].append(row)

dupes = {rid: gs for rid, gs in groups.items() if len(gs) > 1}
if not dupes:
    print("No duplicate Run IDs found. Nothing to do.")
    sys.exit(0)

print(f"Found {len(dupes)} Run ID(s) with duplicate rows:\n")
to_archive: list[tuple[str, str]] = []  # (page_id, run_id)
for rid, gs in sorted(dupes.items(), key=lambda kv: -len(kv[1])):
    # Pick the winner: highest Step Cursor first, then earliest created_time.
    def key(r: dict) -> tuple:
        p = r["properties"]
        return (-num(p, "Step Cursor"), r["created_time"])

    sorted_g = sorted(gs, key=key)
    winner = sorted_g[0]
    losers = sorted_g[1:]
    wp = winner["properties"]
    print(
        f"  {rid}  (×{len(gs)})\n"
        f"     keep   {winner['id']}  cursor={num(wp,'Step Cursor')}  "
        f"status={(wp.get('Status',{}).get('select') or {}).get('name','?')}  "
        f"created={winner['created_time'][:19]}"
    )
    for loser in losers:
        lp = loser["properties"]
        print(
            f"     archive {loser['id']}  cursor={num(lp,'Step Cursor')}  "
            f"status={(lp.get('Status',{}).get('select') or {}).get('name','?')}  "
            f"created={loser['created_time'][:19]}"
        )
        to_archive.append((loser["id"], rid))

print(f"\nTotal rows to archive: {len(to_archive)}")
if not APPLY:
    print("Dry-run. Pass --apply to archive.")
    sys.exit(0)

# Archive the losers. pages.update({archived: True}) is allowed on managed
# DBs (it's the one mutation external clients can do).
archived = 0
errors = 0
for page_id, rid in to_archive:
    try:
        api("PATCH", f"/pages/{page_id}", {"archived": True})
        archived += 1
    except Exception as e:
        print(f"  ✗ archive failed for {page_id} ({rid}): {e}")
        errors += 1

print(f"\nArchived {archived}/{len(to_archive)} rows. ({errors} errors)")
