import os
os.makedirs('data/dash', exist_ok=True)
import json, numpy as np, pandas as pd
pd.set_option('future.infer_string', False)
S = pd.read_pickle('data/scan.pkl'); D = json.load(open('data/deep.json')); Rp = json.load(open('data/replies.json'))
r4 = lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), 4)
def scan(outcome, feature, level):
    r = S[(S.outcome == outcome) & (S.feature == feature) & (S.level == str(level))].iloc[0]
    return r
def joint(model, term):
    return next(t for t in D[model]['terms'] if t['term'] == term)
facts = []
def add(key, section, outcome, label, r=None, j=None, n=None, k=None, rate=None, rest=None, orr=None, lo=None, hi=None, p=None, check=None, basis=None):
    if r is not None:
        n, k, rate, rest, check = int(r.n), int(r.k), r.rate, r.rest_rate, r.replication
        if j is None and r.mh: orr, lo, hi, p, basis = r.mh['or_'], r.mh['lo'], r.mh['hi'], r.q_mh, 'within campaign'
    if j is not None:
        orr, lo, hi, p, basis = j['or_'], j['lo'], j['hi'], j['p'], 'joint model, within campaign'
    facts.append(dict(key=key, section=section, outcome=outcome, label=label, n=n, k=k, rate=r4(rate), rest_rate=r4(rest), odds_ratio=r4(orr), lo=r4(lo), hi=r4(hi), p=r4(p), check=check, basis=basis))
# who accepts / replies
add('young_co_accept', 'company', 'Accepted within 14 days', 'Company founded 0-2 years ago', scan('accept_14d', 'company_age', '0-2 yrs'), joint('joint_accept14', 'co_age[T.0-2 yrs]'))
add('young_co_reply', 'company', 'Replied within 21 days', 'Company founded 0-2 years ago', scan('reply_21d', 'company_age', '0-2 yrs'), joint('joint_reply21', 'co_age[T.0-2 yrs]'))
add('small_co_reply', 'company', 'Replied within 21 days', 'Company with 2-10 employees', scan('reply_21d', 'company_size', '2-10'), joint('joint_reply21', 'co_size[T.2-10]'))
add('small_co_accept', 'company', 'Accepted within 14 days', 'Company with 2-10 employees', scan('accept_14d', 'company_size', '2-10'), joint('joint_accept14', 'co_size[T.2-10]'))
add('us_accept', 'company', 'Accepted within 14 days', 'Company based in the US', scan('accept_14d', 'company_region', 'US'))
add('us_reply', 'company', 'Replied within 21 days', 'Company based in the US', scan('reply_21d', 'company_region', 'US'))
add('eu_accept', 'company', 'Accepted within 14 days', 'Company based in Europe (not UK)', scan('accept_14d', 'company_region', 'Europe (ex-UK)'), joint('joint_accept14', 'region[T.Europe (ex-UK)]'))
add('uk_accept', 'company', 'Accepted within 14 days', 'Company based in the UK', scan('accept_14d', 'company_region', 'UK'), joint('joint_accept14', 'region[T.UK]'))
add('ca_accept', 'company', 'Accepted within 14 days', 'Company based in Canada', scan('accept_14d', 'company_region', 'Canada'), joint('joint_accept14', 'region[T.Canada]'))
add('hosp_reply', 'company', 'Replied within 21 days', 'Hospital & health care industry', scan('reply_21d', 'industry', 'Hospital & health care'), joint('joint_reply21', 'ind[T.Hospital & health care]'))
add('long_hl_accept', 'person', 'Accepted within 14 days', 'Headline over 140 characters', scan('accept_14d', 'headline_len_bucket', '141+'), joint('joint_accept14', 'hl_len[T.141+]'))
add('short_hl_accept', 'person', 'Accepted within 14 days', 'Headline of 40 characters or less', scan('accept_14d', 'headline_len_bucket', '1-40'), joint('joint_accept14', 'hl_len[T.1-40]'))
add('pipe_accept', 'person', 'Accepted within 14 days', 'Headline split with "|"', scan('accept_14d', 'headline_has_pipe', 'True'), joint('joint_accept14', 'pipe'))
add('pipe_reply', 'person', 'Replied within 21 days', 'Headline split with "|"', scan('reply_21d', 'headline_has_pipe', 'True'), joint('joint_reply21', 'pipe'))
add('under30_accept', 'person', 'Accepted within 14 days', 'Inferred age under 30', scan('accept_14d', 'age_inferred', '<30'), joint('joint_accept14', 'age[T.<30]'))
add('age60_accept', 'person', 'Accepted within 14 days', 'Inferred age 60 or over', scan('accept_14d', 'age_inferred', '60+'), joint('joint_accept14', 'age[T.60+]'))
add('age40_accept', 'person', 'Accepted within 14 days', 'Inferred age 40-49', scan('accept_14d', 'age_inferred', '40-49'), joint('joint_accept14', 'age[T.40-49]'))
# substantive replies per accepted lead
sub = {(r['feature'], r['level']): r for r in Rp['substantive_given_accept']}
def adds(key, label, f, l, check):
    r = sub[(f, l)]
    add(key, 'conversation', 'Substantive reply (P2/P3) after accepting', label, n=r['n'], k=r['k'], rate=r['rate'], rest=r['rest_rate'],
        orr=r['mh']['or_'], lo=r['mh']['lo'], hi=r['mh']['hi'], p=r['mh']['p'], check=check, basis='within campaign')
adds('small_co_subst', 'Company with 2-10 employees', 'company_size', '2-10', 'survives correction')
adds('mid_co_subst', 'Company with 11-50 employees', 'company_size', '11-50', 'survives correction')
adds('hosp_subst', 'Hospital & health care industry', 'industry', 'Hospital & health care', 'survives correction')
adds('male_subst', 'Inferred male', 'gender_inferred', 'male', 'borderline after correction')
adds('young_co_subst', 'Company founded 0-2 years ago', 'company_age', '0-2 yrs', 'does not survive correction')
# re-invites
rv = D['reinvite_vs_fresh']
add('reinvite', 'sender', 'Accepted within 14 days', 'Re-invited by a second account after ignoring the first', n=rv['reinvited_n'], k=round(rv['reinvited_rate'] * rv['reinvited_n']),
    rate=rv['reinvited_rate'], rest=rv['fresh_rate'], orr=rv['mh_or'], lo=rv['lo'], hi=rv['hi'], p=rv['p'], check=f"{rv['strata']} campaigns", basis='within campaign')
pd.DataFrame(facts).to_json('data/dash/facts.json', orient='records', indent=0)

# ---- chart series (one dataset, a chart column)
rows = []
F = Rp['funnel45']
for i, (stage, n) in enumerate([('Invited', F['invited']), ('Accepted', F['accepted']), ('Replied', F['replied']), ('Substantive reply (P2/P3)', F['substantive']), ('Buying intent (P3)', F['p3']), ('Agreed to a call', F['call_agreed'])]):
    rows.append(dict(chart='funnel', x=stage, order=i, n=n, value=n / F['invited']))
for d, v in D['km_accept'].items():
    rows.append(dict(chart='accept_curve', x=str(d), order=int(float(d)), value=r4(v)))
for X in (7, 14, 30):
    rows.append(dict(chart='pending', x=str(X), order=X, value=r4(D[f'km_pending_{X}_accept_by_120'])))
for h in D['touch_hazard'][:6]:
    rows.append(dict(chart='touch_hazard', x=str(h['after_touch']), order=h['after_touch'], n=h['at_risk'], k=h['replied'], value=r4(h['rate'])))
order = {'0 (reply to connect note)': 0, '1': 1, '2': 2, '3': 3, '4+': 4}
for t in Rp['touch_quality']:
    rows.append(dict(chart='reply_quality', x=t['tb'], order=order[t['tb']], n=t['n'], k=t['rejection'], value=r4(t['rej_rate']), value2=r4(t['subst_rate'])))
fg = {'engaged': 0, 'polite / small talk': 1, 'rejection': 2, 'pitch-back': 3}
for g in Rp['first_group_to_outcome']:
    rows.append(dict(chart='first_reply', x=g['first_group'], order=fg[g['first_group']], n=g['n'], k=g['subst'], value=r4(g['subst'] / g['n']), value2=g['calls']))
# substantive by company size (all buckets)
df = pd.read_pickle('data/features.pkl'); df['thread_id'] = df.instance_id + '|' + df.profile_url
Lb = pd.read_pickle('data/reply_labels.pkl'); Lb['substantive'] = Lb.best_intent.isin(['p2', 'p3'])
f = df[df.first_touch_for_person].merge(Lb[['thread_id', 'substantive']], on='thread_id', how='left'); f['substantive'] = f.substantive.fillna(False).astype(bool)
acc = f[f.accepted & ((pd.Timestamp('2026-10-13', tz='UTC') - f.connected_at).dt.days >= 30)]
def wil(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h
for i, s in enumerate(['0-1', '2-10', '11-50', '51-200']):
    g = acc[acc.company_size == s]
    if len(g) < 10: continue
    lo, hi = wil(g.substantive.sum(), len(g))
    rows.append(dict(chart='size_subst', x=s + ' employees', order=i, n=int(len(g)), k=int(g.substantive.sum()), value=r4(g.substantive.mean()), lo=r4(lo), hi=r4(hi)))
for a, v in D['account_accept14'].items():
    rows.append(dict(chart='account_accept', x=a, order=0, n=v['n'], value=r4(v['rate']), lo=r4(v['ci'][0]), hi=r4(v['ci'][1])))
for a, v in D['account_reply21'].items():
    rows.append(dict(chart='account_reply', x=a, order=0, n=v['n'], value=r4(v['rate']), lo=r4(v['ci'][0]), hi=r4(v['ci'][1])))
for p_, v in D['grid_persona'].items():
    rows.append(dict(chart='grid_persona', x=p_, order=0, n=v['n'], k=v['k'], value=r4(v['rate']), lo=r4(v['ci'][0]), hi=r4(v['ci'][1])))
rows.append(dict(chart='grid_persona_p', x='chi-square p', order=0, value=r4(D['grid_persona_p'])))
rs = Rp['reply_speed']
rows.append(dict(chart='reply_speed', x='Substantive replies', order=0, n=rs['n_subst'], value=r4(rs['subst_median_days'])))
rows.append(dict(chart='reply_speed', x='Other replies', order=1, n=rs['n_other'], value=r4(rs['other_median_days']), value2=r4(rs['mw_p'])))
for c in ('value', 'value2', 'lo', 'hi'):
    pass
pd.DataFrame(rows).to_json('data/dash/series.json', orient='records', indent=0)

# ---- checked, nothing there
nulls = []
def addn(label, outcome, feature, level):
    r = S[(S.outcome == outcome) & (S.feature == feature) & (S.level == str(level))].iloc[0]
    nulls.append(dict(label=label, outcome={'accept_14d': 'Accepted within 14 days', 'reply_21d': 'Replied within 21 days', 'reply_given_accept': 'Replied after accepting'}[outcome],
                      n=int(r.n), rate=r4(r.rate), rest_rate=r4(r.rest_rate), odds_ratio=r4(r.mh['or_']), lo=r4(r.mh['lo']), hi=r4(r.mh['hi']), q=r4(r.q_mh)))
addn('Invite sent on a Sunday', 'accept_14d', 'invite_dow', 'Sun')
addn('Invite sent on a weekend', 'accept_14d', 'invite_weekend', 'True')
addn('Invite sent 12:00-17:59 UTC', 'accept_14d', 'invite_hour_utc', '12-17')
addn('Account sent 31+ invites that day', 'accept_14d', 'daily_volume', '31+')
addn('Account sent 1-10 invites that day', 'accept_14d', 'daily_volume', '1-10')
addn('Another person at the company was invited earlier', 'accept_14d', 'company_seen_before', 'True')
addn('Another person at the company was invited earlier', 'reply_21d', 'company_seen_before', 'True')
addn('"Founder" in headline', 'accept_14d', 'hl_founder', 'True')
addn('"Founder" in headline', 'reply_21d', 'hl_founder', 'True')
addn('"CEO" in headline', 'accept_14d', 'hl_ceo', 'True')
addn('"CTO" in headline', 'accept_14d', 'hl_cto', 'True')
addn('"Product" in headline', 'accept_14d', 'hl_product', 'True')
addn('Inferred female', 'accept_14d', 'gender_inferred', 'female')
addn('Inferred female', 'reply_21d', 'gender_inferred', 'female')
addn('AI personalization hooks prepared', 'accept_14d', 'ai_hooks', 'True')
addn('AI personalization hooks prepared', 'reply_21d', 'ai_hooks', 'True')
addn('Company has a web app', 'accept_14d', 'has_web_app', 'True')
addn('Company has a web app', 'reply_21d', 'has_web_app', 'True')
addn('Mental or behavioral health niche', 'accept_14d', 'topic_mental/behavioral', 'True')
addn('AI niche', 'accept_14d', 'topic_AI', 'True')
addn('Telehealth niche', 'reply_21d', 'topic_telehealth/virtual care', 'True')
addn('Fitness or sport niche', 'reply_21d', 'topic_fitness/sport', 'True')
addn('First week of a campaign', 'accept_14d', 'campaign_week_bucket', 'week 1')
pd.DataFrame(nulls).to_json('data/dash/nulls.json', orient='records', indent=0)

# ---- method / coverage numbers
L = pd.read_pickle('data/leads_enriched.pkl')
inv = L[L.invited_at.notna()]
cov = [
    dict(key='lead_rows', value=int(len(L))),
    dict(key='invited_rows', value=int(len(inv))),
    dict(key='airtable_match', value=r4(inv.company_rec.notna().mean())),
    dict(key='first_touch_accept_pop', value=int(df[df.first_touch_for_person & df.obs_accept14].shape[0])),
    dict(key='first_touch_reply_pop', value=int(df[df.first_touch_for_person & df.obs_reply21].shape[0])),
    dict(key='accepted_subst_pop', value=int(len(acc))),
    dict(key='threads_labelled', value=int(len(Lb))),
    dict(key='blind_agree_substantive', value=20), dict(key='blind_sample', value=20), dict(key='blind_agree_intent', value=19),
    dict(key='replied_no_text', value=int(F['replied'] - F['labelled'])), dict(key='replied_45', value=int(F['replied'])),
    dict(key='pre_connected_excluded', value=int(((L.connected_at.notna()) & (pd.to_datetime(L.connected_at, utc=True, format='ISO8601') < pd.to_datetime(L.invited_at, utc=True, format='ISO8601'))).sum())),
    dict(key='repeat_invites_excluded', value=int((~df.first_touch_for_person).sum())),
    dict(key='calls_total', value=int(Lb.call_agreed.sum())),
]
pd.DataFrame(cov).to_json('data/dash/method.json', orient='records', indent=0)
for fn in ['facts', 'series', 'nulls', 'method']:
    d = json.load(open(f'data/dash/{fn}.json')); print(fn, len(d), 'rows')
print(json.dumps(facts[:2], indent=0)[:600])
