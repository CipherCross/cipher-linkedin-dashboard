# Read-only pull of the Airtable base the server token can see (GET only).
import json, os, time, urllib.request, urllib.parse
ENV = os.path.join(os.path.dirname(__file__), '../../frontend/.env.local')
env = {}
for line in open(ENV):
    if '=' in line and not line.startswith('#'):
        k, v = line.rstrip('\n').split('=', 1); env[k] = v.strip().strip('"').strip("'")
h = {'Authorization': f"Bearer {env['AIRTABLE_TOKEN']}"}
get = lambda url: json.load(urllib.request.urlopen(urllib.request.Request(url, headers=h)))
# .env.local from `vercel env pull` holds a redacted AIRTABLE_BASE_ID; the token is scoped to one base.
base = get('https://api.airtable.com/v0/meta/bases')['bases'][0]['id']
tables = {'db': 'tblEYOgRDRg0aYfzI', 'companies': 'tblDk8o4Nb4mFAEa8', 'contacts': 'tbl87CQnAjpKigu7i', 'outreach': 'tbltqZUe1sAbVZVk1',
          'lh': 'tbldAOWOLIwAOFVU8', 'campaigns': 'tblUdKPVJZumPVacj', 'imported': 'tbliF7zmj11tGWaWr'}
os.makedirs('data', exist_ok=True)
for name, tid in tables.items():
    out, offset = [], None
    while True:
        q = {'pageSize': '100', **({'offset': offset} if offset else {})}
        d = get(f'https://api.airtable.com/v0/{base}/{tid}?' + urllib.parse.urlencode(q))
        out += d.get('records', []); offset = d.get('offset')
        if not offset: break
        time.sleep(0.21)
    json.dump(out, open(f'data/airtable_{name}.json', 'w'))
    print(name, len(out))
