# Build one row per invited lead (person x campaign) with features and outcomes.
import json, re
import numpy as np, pandas as pd
pd.set_option('future.infer_string', False)

SNAP = pd.Timestamp('2026-10-13', tz='UTC')
MATURE = pd.Timestamp('2026-09-08', tz='UTC')  # 35 days: >=90% of accepts and replies have landed

L = pd.read_pickle('data/leads_enriched.pkl')
for c in ['added_at', 'invited_at', 'connected_at', 'first_message_at', 'replied_at', 'photo_synced_at']:
    L[c] = pd.to_datetime(L[c], utc=True, format='ISO8601')
camp = pd.DataFrame(json.load(open('data/campaigns.json'))).set_index('id')

df = L[L.invited_at.notna()].copy()
df['pre_connected'] = df.connected_at.notna() & (df.connected_at < df.invited_at)
df = df[~df.pre_connected].copy()

# ---- outcomes
df['accepted'] = df.connected_at.notna()
df['replied'] = df.replied_at.notna()
df['days_to_accept'] = (df.connected_at - df.invited_at).dt.total_seconds() / 86400
df['followup_days'] = (SNAP - df.invited_at).dt.total_seconds() / 86400
df['mature'] = df.invited_at < MATURE
# standardized windows remove censoring: only invites with the full window observed count
df['obs_accept14'] = df.followup_days >= 14
df['accepted_14d'] = df.accepted & (df.days_to_accept <= 14)
df['obs_reply21'] = df.followup_days >= 21
df['replied_21d'] = df.replied & ((df.replied_at - df.invited_at).dt.total_seconds() / 86400 <= 21)

# ---- sender / campaign
df['account'] = df.instance_id
df['campaign_name'] = df.campaign_id.map(camp.name)
df['sept_grid'] = df.campaign_name.str.contains('→', na=False)
df['wave'] = np.where(df.sept_grid, 'Sep-2026 persona grid', 'Web2Mob / earlier')
df['invite_month'] = df.invited_at.dt.strftime('%Y-%m')
df['camp_first_invite'] = df.groupby('campaign_id').invited_at.transform('min')
df['campaign_week'] = ((df.invited_at - df.camp_first_invite).dt.days // 7).clip(upper=6)
df['campaign_week_bucket'] = pd.cut(df.campaign_week, [-1, 0, 1, 3, 99], labels=['week 1', 'week 2', 'weeks 3-4', 'week 5+']).astype(str)

def persona_from_campaign(n):
    n = n or ''
    if re.search(r'founder', n, re.I): return 'Founder'
    if re.search(r'\bCTO\b|technical(?! sequence)', n, re.I) and not re.search(r'non technical', n, re.I): return 'CTO / technical'
    if re.search(r'COO|Ops|Product', n): return 'Product / COO'
    if re.search(r'non technical', n, re.I): return 'Non-technical'
    return None
df['campaign_persona'] = df.campaign_name.map(persona_from_campaign)
def offer_from_campaign(n):
    n = n or ''
    if 'UX/UI' in n: return 'UX/UI'
    if re.search(r'QA', n): return 'QA'
    if re.search(r'Full.?Stack', n, re.I): return 'Full-stack'
    if re.search(r'Mobile Dev', n): return 'Mobile dev'
    if re.search(r'Outstaff', n, re.I): return 'Outstaff'
    if re.search(r'Moderni', n, re.I): return 'App modernization'
    if re.search(r'Web ?2 ?Mob|Standart|Predictor|Detective', n, re.I): return 'Web2Mob'
    return None
df['offer'] = df.campaign_name.map(offer_from_campaign)

# ---- who: headline
h = df.headline.fillna('').astype(object)
df['headline_len'] = h.str.len()
df['headline_len_bucket'] = pd.cut(df.headline_len, [-1, 0, 40, 80, 140, 10000], labels=['empty', '1-40', '41-80', '81-140', '141+']).astype(str)
df['headline_has_pipe'] = h.str.contains(r'\|')
df['headline_has_emoji'] = h.str.contains(r'[\U0001F300-\U0001FAFF☀-➿]')
df['headline_helping'] = h.str.contains(r'\bhelp(?:ing|s)?\b', case=False)
roles = {
    'founder': r'founder|co-founder|cofounder', 'ceo': r'\bceo\b|chief executive', 'cto': r'\bcto\b|chief technology',
    'coo': r'\bcoo\b|chief operating', 'cmo/growth': r'\bcmo\b|marketing|growth', 'product': r'\bproduct\b|\bcpo\b',
    'head/director/vp': r'head of|director|\bvp\b|vice president', 'owner/md/partner': r'\bowner\b|managing director|\bpartner\b',
    'engineer/developer': r'engineer|developer', 'clinician (MD/PhD/physician)': r'\bmd\b|\bphd\b|physician|doctor|\bdr\.?\b|clinical|psycholog|therap|nurse',
    'coach/consultant/advisor': r'coach|consult|advisor|adviser', 'investor/board': r'investor|board member|\bboard\b|angel',
    'speaker/author': r'speaker|author|keynote', 'mba': r'\bmba\b',
}
for k, p in roles.items():
    df['hl_' + k] = h.str.contains(p, case=False, regex=True)
df['n_roles'] = df[[c for c in df.columns if c.startswith('hl_')]].sum(axis=1)
df['airtable_persona'] = df.technicality

# ---- who: inferred demographics (labelled inferred everywhere downstream)
df['gender_inferred'] = df.gender.where(df.gender.isin(['male', 'female']), 'unknown/none')
mid = (df.birth_year_min + df.birth_year_max) / 2
df['age_inferred'] = pd.cut(2026 - mid, [0, 30, 40, 50, 60, 120], labels=['<30', '30-39', '40-49', '50-59', '60+']).astype(str).replace('nan', 'no signal')

# ---- company (Airtable)
df['company_size'] = pd.cut(df.co_employees, [-1, 1, 10, 50, 200, 1e9], labels=['0-1', '2-10', '11-50', '51-200', '201+']).astype(str).replace('nan', 'unknown')
fy = pd.to_numeric(df.co_founded, errors='coerce')
df['company_age'] = pd.cut(2026 - fy, [-1, 2, 5, 10, 200], labels=['0-2 yrs', '3-5 yrs', '6-10 yrs', '11+ yrs']).astype(str).replace('nan', 'unknown')
eu = {'France', 'Germany', 'Netherlands', 'Spain', 'Switzerland', 'Sweden', 'Belgium', 'Denmark', 'Norway', 'Finland', 'Ireland', 'Italy', 'Austria', 'Portugal', 'Poland', 'Estonia', 'Luxembourg', 'Czech Republic', 'Iceland', 'Lithuania', 'Latvia', 'Greece'}
def region(c):
    if not isinstance(c, str): return 'unknown'
    if c == 'United States': return 'US'
    if c == 'United Kingdom': return 'UK'
    if c == 'Canada': return 'Canada'
    if c in ('Australia', 'New Zealand'): return 'AU/NZ'
    if c in eu: return 'Europe (ex-UK)'
    if c == 'Israel': return 'Israel'
    return 'Other'
df['company_region'] = df.co_country.map(region)
ind = df.co_industry.fillna('').str.lower()
def industry(s):
    if not s: return 'unknown'
    if 'mental' in s: return 'Mental health care'
    if 'wellness' in s or 'fitness' in s: return 'Health, wellness & fitness'
    if 'hospital' in s or s == 'healthcare' or 'health care' in s: return 'Hospital & health care'
    if 'medical' in s or 'pharma' in s or 'biotech' in s: return 'Medical / pharma / devices'
    if 'information technology' in s or 'software' in s or 'internet' in s: return 'IT & software'
    return 'Other'
df['industry'] = ind.map(industry)
niche = df.co_niche.fillna('').astype(object).str.lower()
topics = {
    'mental/behavioral': r'mental|behavioral|therapy|psychiat|anxiety|depress|addiction|counsel',
    'women/maternal': r'women|maternal|pregnan|fertility|menopause|femtech|postpartum|ivf',
    'oncology': r'cancer|oncolog',
    'fitness/sport': r'fitness|\bgym|workout|sports?\b|athlet|yoga|pilates',
    'nutrition/weight': r'nutrition|diet|weight|obesity|food|meal',
    'longevity/aging': r'longevity|aging|ageing|older adult|senior',
    'telehealth/virtual care': r'telehealth|telemedicine|virtual care|remote monitoring',
    'AI': r'\bai\b|artificial intelligence|machine learning',
    'employer/corporate wellbeing': r'employee|workplace|corporate|employer',
    'clinical/provider software': r'\behr\b|practice management|clinician|providers?\b|hospitals?\b',
}
for k, p in topics.items():
    df['topic_' + k] = niche.str.contains(p, regex=True) & (niche.str.strip() != '')
df['has_web_app'] = df.co_webapp.notna()
df['ai_hooks'] = df.has_hooks.fillna(False).astype(bool)
df['in_airtable'] = df.company_rec.notna()

# ---- timing (UTC)
df['invite_dow'] = df.invited_at.dt.day_name().str[:3]
df['invite_weekend'] = df.invited_at.dt.dayofweek >= 5
df['invite_hour_utc'] = pd.cut(df.invited_at.dt.hour, [-1, 5, 11, 17, 23], labels=['00-05', '06-11', '12-17', '18-23']).astype(str)
day = df.invited_at.dt.floor('D')
df['account_invites_that_day'] = df.groupby(['account', day]).id.transform('count')
df['daily_volume'] = pd.cut(df.account_invites_that_day, [0, 10, 20, 30, 1000], labels=['1-10', '11-20', '21-30', '31+']).astype(str)

# ---- saturation: earlier invites to the same company / same person
ckey = df.company_rec.fillna(df.company.str.lower().str.strip())
df['_ckey'] = ckey
df = df.sort_values('invited_at')
df['company_prior_invites'] = df.groupby('_ckey').cumcount().where(df._ckey.notna(), 0)
df['company_seen_before'] = df.company_prior_invites > 0
df['person_prior_invites'] = df.groupby('slug').cumcount()
df['person_seen_before'] = df.person_prior_invites > 0
df['first_touch_for_person'] = ~df.person_seen_before

df['has_photo_flag'] = df.has_photo.where(df.photo_synced_at.notna())

df.to_pickle('data/features.pkl')
print('rows', len(df), 'mature', int(df.mature.sum()), 'accepted', int(df.accepted.sum()), 'replied', int(df.replied.sum()))
print(df[df.mature].groupby('wave')[['accepted', 'replied']].agg(['count', 'mean']).round(3))
print(df.offer.value_counts(dropna=False).to_dict())
print(df.campaign_persona.value_counts(dropna=False).to_dict())
print({k: int(df['topic_' + k].sum()) for k in topics})
print('company_seen_before', int(df.company_seen_before.sum()), 'person_seen_before', int(df.person_seen_before.sum()))
