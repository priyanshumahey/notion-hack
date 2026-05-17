"""Inspect Functions · Catalog to see what each function is configured for."""

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


def title(props, name="Name"):
    p = props.get(name) or {}
    return "".join(x.get("plain_text", "") for x in p.get("title", []))


def select(props, name):
    p = props.get(name) or {}
    s = p.get("select")
    return s["name"] if s else None


def checkbox(props, name):
    p = props.get(name) or {}
    return p.get("checkbox")


res = api("POST", "/search", {
    "query": "Functions · Catalog",
    "filter": {"property": "object", "value": "database"}
})
db_id = None
for r in res["results"]:
    if r["object"] != "database":
        continue
    actual = "".join(t.get("plain_text", "") for t in r.get("title", []))
    if actual == "Functions · Catalog":
        db_id = r["id"]
        break

if not db_id:
    raise SystemExit("Functions · Catalog not found")

print(f"Functions · Catalog ({db_id})")
print("=" * 78)

res = api("POST", f"/databases/{db_id}/query", {"page_size": 50})
for p in res["results"]:
    props = p["properties"]
    print(f"  {title(props)!r}")
    print(f"    Function Key: {rt(props, 'Function Key')!r}")
    print(f"    Trigger:      {select(props, 'Trigger')!r}")
    print(f"    Event Name:   {rt(props, 'Event Name')!r}")
    print(f"    Enabled:      {checkbox(props, 'Enabled')}")
    defn = rt(props, "Definition")
    print(f"    Definition:   {defn[:120]}{'...' if len(defn) > 120 else ''}")
    print()
