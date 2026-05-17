import os, json, sys, ssl, urllib.request

token = os.environ["NOTION_API_TOKEN"]
db = "362296db-34e0-8154-99ea-d91a01a58125"
ctx = ssl.create_default_context()
try:
    import certifi
    ctx.load_verify_locations(certifi.where())
except Exception:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
req = urllib.request.Request(
    f"https://api.notion.com/v1/databases/{db}/query",
    data=json.dumps(
        {
            "page_size": 25,
            "sorts": [
                {"timestamp": "created_time", "direction": "descending"}
            ],
        }
    ).encode(),
    headers={
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(req, context=ctx) as r:
    d = json.load(r)

for p in d["results"]:
    title = "".join(
        x.get("plain_text", "")
        for x in p["properties"].get("Name", {}).get("title", [])
    )
    status_obj = p["properties"].get("Status", {}).get("select")
    status = status_obj["name"] if status_obj else "?"
    cursor = p["properties"].get("Step Cursor", {}).get("number")
    fnrel = p["properties"].get("Function", {}).get("relation", [])
    rid = "".join(
        x.get("plain_text", "")
        for x in p["properties"].get("Run ID", {}).get("rich_text", [])
    )
    print(
        f"{p['id']} title={title!r:42s} runId={rid:24s} "
        f"status={status:9s} cursor={cursor} fn={len(fnrel)}"
    )
