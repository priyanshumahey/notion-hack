"""
Quick inspector for the event-driven runtime. Prints:
  - Last 10 rows in `Functions · Events` (any status)
  - Last 10 rows in `Functions · Runs` (most-recent first)
  - For each run: status, cursor, current step, sleep/wait fields

Resolves DB ids via Notion search to survive redeploys.

  NOTION_API_TOKEN=... python3 scripts/inspect_runtime.py
  NOTION_API_TOKEN=... python3 scripts/inspect_runtime.py <run-id>
"""

import json
import os
import ssl
import sys
import urllib.request

TOKEN = os.environ["NOTION_API_TOKEN"]
CTX = ssl.create_default_context()
try:
    import certifi

    CTX.load_verify_locations(certifi.where())
except Exception:
    CTX.check_hostname = False
    CTX.verify_mode = ssl.CERT_NONE


def api(method, path, body=None):
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
    with urllib.request.urlopen(req, context=CTX) as r:
        return json.load(r)


def find_db(title, required=True):
    res = api(
        "POST",
        "/search",
        {"query": title, "filter": {"property": "object", "value": "database"}},
    )
    for r in res["results"]:
        if r["object"] != "database":
            continue
        actual = "".join(t.get("plain_text", "") for t in r.get("title", []))
        if actual == title:
            return r["id"]
    if required:
        raise SystemExit(f"could not find database {title!r}")
    return None


def rt(props, name):
    p = props.get(name) or {}
    return "".join(x.get("plain_text", "") for x in p.get("rich_text", []))


def title(props, name="Name"):
    p = props.get(name) or {}
    return "".join(x.get("plain_text", "") for x in p.get("title", []))


def select(props, name):
    p = props.get(name) or {}
    s = p.get("select")
    return s["name"] if s else None


def number(props, name):
    p = props.get(name) or {}
    return p.get("number")


def date(props, name):
    p = props.get(name) or {}
    d = p.get("date")
    return d.get("start") if d else None


events_db = find_db("Functions · Events", required=False)
runs_db = find_db("Functions · Runs")

if len(sys.argv) > 1:
    run_id = sys.argv[1]
    res = api(
        "POST",
        f"/databases/{runs_db}/query",
        {"filter": {"property": "Run ID", "rich_text": {"equals": run_id}}},
    )
    if not res["results"]:
        print(f"no row for run_id={run_id}")
        sys.exit(1)
    p = res["results"][0]
    props = p["properties"]
    print(f"Run ID:        {run_id}")
    print(f"Page ID:       {p['id']}")
    print(f"Title:         {title(props)!r}")
    print(f"Status:        {select(props, 'Status')}")
    print(f"Step Cursor:   {number(props, 'Step Cursor')}")
    print(f"Step Count:    {number(props, 'Step Count')}")
    print(f"Current Step:  {rt(props, 'Current Step')!r}")
    print(f"Attempt:       {number(props, 'Attempt')}")
    print(f"Sleep Until:   {date(props, 'Sleep Until')}")
    print(f"Wake At:       {date(props, 'Wake At')}")
    print(f"Waiting For:   {rt(props, 'Waiting For Event')!r}")
    print(f"Source Event:  {rt(props, 'Source Event ID')!r}")
    print(f"Started At:    {date(props, 'Started At')}")
    print(f"Ended At:      {date(props, 'Ended At')}")
    print()
    print("Input:")
    print(rt(props, "Input"))
    print()
    print("Run State:")
    print(rt(props, "Run State"))
    print()
    print("Output:")
    print(rt(props, "Output"))
    err = rt(props, "Error")
    if err:
        print()
        print("Error:")
        print(err)
    sys.exit(0)

print("=" * 78)
print("Functions · Events  (most-recent first)")
print("=" * 78)
if events_db is None:
    print("  (events DB not yet shared with this integration — skipping)")
else:
    res = api(
        "POST",
        f"/databases/{events_db}/query",
        {
            "page_size": 10,
            "sorts": [{"timestamp": "created_time", "direction": "descending"}],
        },
    )
    if not res["results"]:
        print("  (no rows — events are archived after fan-out; this is normal)")
    for p in res["results"]:
        props = p["properties"]
        print(
            f"  {date(props, 'Received At')!s:25s} {rt(props, 'Event ID'):20s} "
            f"name={rt(props, 'Event Name')!r:25s} archived={p.get('archived', False)}"
        )

print()
print("=" * 78)
print("Functions · Runs  (most-recent first)")
print("=" * 78)
res = api(
    "POST",
    f"/databases/{runs_db}/query",
    {
        "page_size": 10,
        "sorts": [{"timestamp": "created_time", "direction": "descending"}],
    },
)
for p in res["results"]:
    props = p["properties"]
    rid = rt(props, "Run ID")
    cursor = number(props, "Step Cursor")
    step_count = number(props, "Step Count")
    cur = rt(props, "Current Step") or "-"
    extras = []
    if select(props, "Status") == "sleeping":
        extras.append(f"sleep_until={date(props, 'Sleep Until')}")
    if select(props, "Status") == "waiting":
        extras.append(f"waiting_for={rt(props, 'Waiting For Event')!r}")
        extras.append(f"wake_at={date(props, 'Wake At')}")
    src = rt(props, "Source Event ID")
    if src:
        extras.append(f"src_evt={src}")
    print(
        f"  {rid:32s} status={select(props, 'Status') or '-':10s} "
        f"step={cursor}/{step_count} cur={cur!r:18s} "
        + " ".join(extras)
    )
