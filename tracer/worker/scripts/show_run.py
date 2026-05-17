"""Pretty-print a single run row's Output + Run State."""
import json, os, ssl, sys, urllib.request

token = os.environ["NOTION_API_TOKEN"]
ctx = ssl.create_default_context()
try:
    import certifi
    ctx.load_verify_locations(certifi.where())
except Exception:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

run_id = sys.argv[1] if len(sys.argv) > 1 else "run_5fe6c5189f3ba536"
db = "362296db-34e0-8154-99ea-d91a01a58125"
req = urllib.request.Request(
    f"https://api.notion.com/v1/databases/{db}/query",
    data=json.dumps(
        {"filter": {"property": "Run ID", "rich_text": {"equals": run_id}}}
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

if not d["results"]:
    print(f"no row for {run_id}")
    sys.exit(1)
p = d["results"][0]
props = p["properties"]


def rt(name):
    return "".join(
        x.get("plain_text", "") for x in props.get(name, {}).get("rich_text", [])
    )


print(f"Run ID:       {run_id}")
print(f"Page ID:      {p['id']}")
print(f"Status:       {props['Status']['select']['name']}")
print(f"Step Cursor:  {props['Step Cursor']['number']}")
print(f"Step Count:   {props['Step Count']['number']}")
print(f"Started At:   {props['Started At']['date']}")
print(f"Ended At:     {props['Ended At']['date']}")
print(f"Function rel: {[r['id'] for r in props['Function']['relation']]}")
print(f"Sandbox rel:  {[r['id'] for r in props['Sandbox']['relation']]}")
print()
print("Output:")
print(rt("Output"))
print()
print("Run State:")
print(rt("Run State"))
print()
print("Error:")
print(rt("Error"))
