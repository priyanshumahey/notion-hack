"""List all databases visible to the integration."""
import os, requests
tok = os.environ['NOTION_API_TOKEN']
h = {
    'Authorization': f'Bearer {tok}',
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
}
r = requests.post(
    'https://api.notion.com/v1/search',
    json={'filter': {'value': 'database', 'property': 'object'}, 'page_size': 100},
    headers=h, timeout=30,
)
results = r.json().get('results', [])
print(f'Total: {len(results)}')
for x in results:
    title_parts = x.get('title') or []
    title = ''.join((t.get('plain_text', '') for t in title_parts))
    print(f'  {x["id"]}  {title!r}')
