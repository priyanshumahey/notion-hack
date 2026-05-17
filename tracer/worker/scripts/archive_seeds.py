"""Archive the externally-created sandbox/function rows that seed.ts made,
so the seed syncs can populate the canonical sync-tracked rows without
visible duplicates."""

import json, os, ssl, urllib.request

token = os.environ["NOTION_API_TOKEN"]
ctx = ssl.create_default_context()
try:
    import certifi
    ctx.load_verify_locations(certifi.where())
except Exception:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE


def post(url, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.load(r)


def patch(url, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.load(r)


SANDBOXES = "362296db-34e0-8135-a6a7-fdee8d9a23ec"
FUNCTIONS = "362296db-34e0-8107-b97c-df725b80163e"


def archive_all(db):
    d = post(
        f"https://api.notion.com/v1/databases/{db}/query",
        {"page_size": 100},
    )
    for p in d["results"]:
        pid = p["id"]
        try:
            patch(
                f"https://api.notion.com/v1/pages/{pid}",
                {"archived": True},
            )
            print(f"  archived {pid}")
        except Exception as e:
            print(f"  FAILED {pid}: {e}")


print("Sandboxes:")
archive_all(SANDBOXES)
print("Functions:")
archive_all(FUNCTIONS)
