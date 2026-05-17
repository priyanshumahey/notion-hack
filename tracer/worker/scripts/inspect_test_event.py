"""Query Functions · Runs for any row with Source Event ID = evt_test_classic_001, including archived."""

import json
import os
import ssl
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


def rt(props, name):
    p = props.get(name) or {}
    return "".join(x.get("plain_text", "") for x in p.get("rich_text", []))


def select(props, name):
    p = props.get(name) or {}
    s = p.get("select")
    return s["name"] if s else None


def date(props, name):
    p = props.get(name) or {}
    d = p.get("date")
    return d.get("start") if d else None


# Find Functions · Runs
res = api("POST", "/search", {
    "query": "Functions · Runs",
    "filter": {"property": "object", "value": "database"}
})
runs_db = None
for r in res["results"]:
    if r["object"] != "database":
        continue
    if "".join(t.get("plain_text", "") for t in r.get("title", [])) == "Functions · Runs":
        runs_db = r["id"]
        break

if not runs_db:
    raise SystemExit("Functions · Runs not found")

print(f"Functions · Runs ({runs_db})")
print("=" * 78)

# Query ALL rows from last day, sorted by created_time desc
res = api("POST", f"/databases/{runs_db}/query", {
    "page_size": 30,
    "sorts": [{"timestamp": "created_time", "direction": "descending"}],
})

print(f"\nTotal rows in last 30: {len(res['results'])}")
for p in res["results"]:
    props = p["properties"]
    rid = rt(props, "Run ID")
    src = rt(props, "Source Event ID")
    print(f"  {p['created_time']}  archived={p.get('archived', False)}  "
          f"runId={rid!r:50s}  status={select(props, 'Status')!r:12s}  src_evt={src!r}")

# Specifically look for our test event
print("\n--- Rows with Source Event ID = evt_test_classic_001 ---")
res = api("POST", f"/databases/{runs_db}/query", {
    "filter": {"property": "Source Event ID", "rich_text": {"equals": "evt_test_classic_001"}},
})
if not res["results"]:
    print("  (none)")
for p in res["results"]:
    props = p["properties"]
    print(f"  {p['id']}  archived={p.get('archived', False)}")
    print(f"    Run ID:       {rt(props, 'Run ID')!r}")
    print(f"    Status:       {select(props, 'Status')!r}")
    print(f"    Step Cursor:  {props.get('Step Cursor', {}).get('number')}")
    print(f"    Current Step: {rt(props, 'Current Step')!r}")
    print(f"    Error:        {rt(props, 'Error')!r}")

# Also look for Run ID = run_evt_evt_test_classic_001_welcome-flow
print("\n--- Rows with Run ID = run_evt_evt_test_classic_001_welcome-flow ---")
res = api("POST", f"/databases/{runs_db}/query", {
    "filter": {"property": "Run ID", "rich_text": {"equals": "run_evt_evt_test_classic_001_welcome-flow"}},
})
if not res["results"]:
    print("  (none)")
for p in res["results"]:
    props = p["properties"]
    print(f"  {p['id']}  archived={p.get('archived', False)}")
    print(f"    Status:       {select(props, 'Status')!r}")
    print(f"    Step Cursor:  {props.get('Step Cursor', {}).get('number')}")
