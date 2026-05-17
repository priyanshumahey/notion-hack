"""
Tail the latest traces + their spans + LLM Calls. Pure-stdlib so no pip needed.

Run from worker dir with .env.local sourced:
  set -a && source .env.local && set +a
  python3 scripts/inspect_traces.py

If TRACES_DB_ID / SPANS_DB_ID / LLM_CALLS_DB_ID env vars are unset, falls
back to a search by title.
"""

import json
import os
import ssl
import sys
import urllib.parse
import urllib.request

TOKEN = os.environ["NOTION_API_TOKEN"]
NOTION_VERSION = "2022-06-28"

ctx = ssl.create_default_context()
try:
    import certifi

    ctx.load_verify_locations(certifi.where())
except Exception:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE


def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"https://api.notion.com/v1{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.load(r)


_DB_CACHE: dict[str, str] = {}


def _find_db(title):
    if not _DB_CACHE:
        res = _req("POST", "/search", {
            "query": "Tracer",
            "filter": {"property": "object", "value": "database"},
            "page_size": 50,
        })
        for r in res.get("results", []):
            plain = "".join(t.get("plain_text", "") for t in r.get("title", []))
            _DB_CACHE[plain.strip()] = r["id"]
    return _DB_CACHE.get(title)


def _db_id(env, title):
    return os.environ.get(env) or _find_db(title)


def _rich_text(prop):
    return "".join(t.get("plain_text", "") for t in prop.get("rich_text", []))


def _title(prop):
    return "".join(t.get("plain_text", "") for t in prop.get("title", []))


def _select(prop):
    s = prop.get("select")
    return s["name"] if s else None


def _number(prop):
    return prop.get("number")


def _date_start(prop):
    d = prop.get("date")
    return d.get("start") if d else None


traces_db = _db_id("TRACES_DB_ID", "Tracer · Traces")
spans_db = _db_id("SPANS_DB_ID", "Tracer · Spans")
llm_db = _db_id("LLM_CALLS_DB_ID", "Tracer · LLM Calls")
tool_db = _db_id("TOOL_CALLS_DB_ID", "Tracer · Tool Calls")
events_db = _db_id("EVENTS_DB_ID", "Tracer · Events")

if not traces_db or not spans_db:
    sys.exit("Could not find Traces / Spans DBs.")

limit = int(sys.argv[1]) if len(sys.argv) > 1 else 3
print(f"=== Latest {limit} trace(s) ===\n")

traces = _req(
    "POST",
    f"/databases/{traces_db}/query",
    {
        "page_size": limit,
        "sorts": [{"timestamp": "created_time", "direction": "descending"}],
    },
)["results"]

for t in traces:
    p = t["properties"]
    trace_id = _rich_text(p["Trace ID"])
    name = _title(p["Name"])
    status = _select(p["Status"])
    span_count = _number(p["Span Count"])
    err_count = _number(p["Error Count"])
    tokens = _number(p["Total Tokens"])
    cost = _number(p["Cost (USD)"])
    dur = _number(p["Duration (ms)"])
    print(f"--- {name}")
    print(
        f"    trace_id   = {trace_id}\n"
        f"    status     = {status}\n"
        f"    spans      = {span_count}  errors = {err_count}\n"
        f"    duration   = {dur} ms\n"
        f"    tokens     = {tokens}  cost (USD) = {cost}"
    )

    # Spans for this trace, ordered by Started At.
    spans = _req(
        "POST",
        f"/databases/{spans_db}/query",
        {
            "page_size": 100,
            "filter": {
                "property": "Trace ID",
                "rich_text": {"equals": trace_id},
            },
            "sorts": [{"property": "Started At", "direction": "ascending"}],
        },
    )["results"]
    if spans:
        print(f"    spans ({len(spans)}):")
        # Build parent → children map for a tree-ish print.
        by_id = {}
        for s in spans:
            sp = s["properties"]
            sid = _rich_text(sp["Span ID"])
            by_id[sid] = {
                "name": _title(sp["Name"]).split(" · ")[0],
                "kind": _select(sp["Kind"]),
                "status": _select(sp["Status"]),
                "dur": _number(sp["Duration (ms)"]),
                "parent": _rich_text(sp["Parent Span ID"]) or None,
                "children": [],
            }
        for sid, info in by_id.items():
            if info["parent"] and info["parent"] in by_id:
                by_id[info["parent"]]["children"].append(sid)
        roots = [sid for sid, info in by_id.items() if not info["parent"]]

        def _walk(sid, depth):
            info = by_id[sid]
            prefix = "      " + ("  " * depth) + ("└─ " if depth else "")
            marker = " (ERR)" if info["status"] == "error" else ""
            print(
                f"{prefix}{info['name']}  "
                f"[{info['kind']}, {info['dur']}ms]{marker}"
            )
            for c in info["children"]:
                _walk(c, depth + 1)

        for r in roots:
            _walk(r, 0)

    # LLM calls for this trace.
    if llm_db:
        llm_calls = _req(
            "POST",
            f"/databases/{llm_db}/query",
            {
                "filter": {
                    "property": "Trace ID",
                    "rich_text": {"equals": trace_id},
                },
                "page_size": 100,
            },
        )["results"]
        if llm_calls:
            print(f"    llm calls ({len(llm_calls)}):")
            for c in llm_calls:
                cp = c["properties"]
                model = _rich_text(cp["Model"]) or "?"
                pt = _number(cp["Prompt Tokens"]) or 0
                ct = _number(cp["Completion Tokens"]) or 0
                co = _number(cp["Cost (USD)"]) or 0
                lat = _number(cp["Latency (ms)"]) or 0
                print(
                    f"      - {model}  {pt}+{ct} tok  "
                    f"${co:.6f}  {lat}ms"
                )

    # Tool calls for this trace.
    if tool_db:
        tool_calls = _req(
            "POST",
            f"/databases/{tool_db}/query",
            {
                "filter": {
                    "property": "Trace ID",
                    "rich_text": {"equals": trace_id},
                },
                "page_size": 100,
            },
        )["results"]
        if tool_calls:
            print(f"    tool calls ({len(tool_calls)}):")
            for c in tool_calls:
                cp = c["properties"]
                tn = _rich_text(cp["Tool Name"])
                st = _select(cp["Status"])
                lat = _number(cp["Latency (ms)"]) or 0
                result = _rich_text(cp["Result"]) or "(none)"
                print(f"      - {tn}  [{st}, {lat}ms]  → {result[:80]}")

    # Error events for this trace.
    if events_db:
        evs = _req(
            "POST",
            f"/databases/{events_db}/query",
            {
                "filter": {
                    "property": "Trace ID",
                    "rich_text": {"equals": trace_id},
                },
                "page_size": 100,
            },
        )["results"]
        if evs:
            print(f"    events ({len(evs)}):")
            for ev in evs:
                ep = ev["properties"]
                evtype = _select(ep["Type"])
                sev = _select(ep["Severity"])
                cat = _rich_text(ep["Category"]) or "(uncat)"
                summary = _rich_text(ep["Summary"])
                print(f"      - [{evtype}/{sev}] {cat}: {summary[:90]}")

    print()
