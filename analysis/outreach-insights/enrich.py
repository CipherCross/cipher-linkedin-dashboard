import json, re, urllib.parse, collections
import pandas as pd
D='data/'
def slug(u):
    if not isinstance(u,str): return None
    u=urllib.parse.unquote(u.strip()).lower()
    m=re.search(r'linkedin\.com/(?:in|pub)/([^/?#\s]+)',u)
    return m.group(1).strip('/') if m else None
def cslug(u):
    if not isinstance(u,str): return None
    u=urllib.parse.unquote(u.strip()).lower()
    m=re.search(r'linkedin\.com/(?:company|school|showcase)/([^/?#\s]+)',u)
    return m.group(1).strip('/') if m else None
def dom(u):
    if not isinstance(u,str) or not u.strip(): return None
    u=u.strip().lower(); u=re.sub(r'^https?://','',u); u=re.sub(r'^www\.','',u)
    return u.split('/')[0] or None
leads=pd.DataFrame(json.load(open(D+'leads.json')))
leads['slug']=leads.profile_url.map(slug)
contacts=json.load(open(D+'airtable_contacts.json'))
companies={r['id']:r['fields'] for r in json.load(open(D+'airtable_companies.json'))}
crow=[]
for r in contacts:
    f=r['fields']; comp=(f.get('Company') or [None])[0]; cf=companies.get(comp,{})
    crow.append(dict(slug=slug(f.get('Persona LinkedIn')), at_title=f.get('Title'), technicality=f.get('Technicality'), readiness=f.get('Readiness status'),
      has_hooks=bool(f.get('hook_1')), hook_manual=bool(f.get('hook_1_manual')), at_campaign=(f.get('Campaign Name (from Outreach)') or [None])[0],
      company_rec=comp, co_country=cf.get('HQ country'), co_employees=cf.get('Employees'), co_industry=cf.get('Industry'), co_founded=cf.get('Founded year'),
      co_niche=cf.get('AI Niche'), co_keywords=cf.get('Keywords'), co_webapp=cf.get('Web App Link'), co_hyp=cf.get('Hypothesis'), co_added_role=cf.get('Added by role'), co_approve=cf.get('Approve Status')))
C=pd.DataFrame(crow)
print('contacts with slug', C.slug.notna().sum(), 'distinct', C.slug.nunique())
C=C.dropna(subset=['slug']).drop_duplicates('slug')
m=leads.merge(C,on='slug',how='left',indicator=True)
inv=m[m.invited_at.notna()]
print('lead rows matched', (m._merge=='both').sum(), 'of', len(m), f"({(m._merge=='both').mean():.1%})")
print('invited matched', (inv._merge=='both').sum(), 'of', len(inv))
print(m.groupby('instance_id')._merge.apply(lambda s:(s=='both').mean()).round(3).to_dict())
print(m.groupby('campaign_id')._merge.apply(lambda s:f"{(s=='both').sum()}/{len(s)}").to_dict())
for col in ['co_country','co_employees','co_industry','co_founded','co_niche','technicality']:
    print(col, m[col].notna().sum())
print(m.co_country.value_counts().head(12).to_dict())
print(m.co_industry.value_counts().head(15).to_dict())
print(m.technicality.value_counts().to_dict())
print(m.co_employees.describe().to_dict() if m.co_employees.dtype!=object else m.co_employees.head())
m.drop(columns=['_merge']).to_pickle(D+'leads_enriched.pkl')
