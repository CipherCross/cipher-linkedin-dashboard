# Broad scan: every feature level vs the rest, raw and within-campaign (Mantel-Haenszel),
# with Benjamini-Hochberg correction and a time-split replication check.
import json, warnings
import numpy as np, pandas as pd
from scipy import stats
from statsmodels.stats.contingency_tables import StratifiedTable
from statsmodels.stats.multitest import multipletests
warnings.filterwarnings('ignore')
pd.set_option('future.infer_string', False)

SNAP = pd.Timestamp('2026-10-13', tz='UTC')
SPLIT = pd.Timestamp('2026-07-01', tz='UTC')
df = pd.read_pickle('data/features.pkl')
first = df[df.first_touch_for_person].copy()

# replied within 21 days of connecting, among accepted with 21 days observed after connecting
first['obs_rc'] = first.accepted & ((SNAP - first.connected_at).dt.total_seconds() / 86400 >= 21)
first['replied_after_accept_21d'] = first.replied & ((first.replied_at - first.connected_at).dt.total_seconds() / 86400 <= 21)

OUTCOMES = {
    'accept_14d': ('obs_accept14', 'accepted_14d', 'accepted within 14 days of the invite'),
    'reply_21d': ('obs_reply21', 'replied_21d', 'replied within 21 days of the invite'),
    'reply_given_accept': ('obs_rc', 'replied_after_accept_21d', 'replied within 21 days of accepting'),
}
CATEG = ['gender_inferred', 'age_inferred', 'company_size', 'company_age', 'company_region', 'industry',
         'airtable_persona', 'headline_len_bucket', 'invite_dow', 'invite_hour_utc', 'daily_volume', 'campaign_week_bucket']
BOOL = [c for c in df.columns if c.startswith('hl_') or c.startswith('topic_')] + \
       ['headline_has_pipe', 'headline_has_emoji', 'headline_helping', 'has_web_app', 'ai_hooks', 'company_seen_before', 'invite_weekend']
CAMPAIGN_LEVEL = ['account', 'wave', 'offer', 'campaign_persona', 'invite_month']

def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)

def mh(sub, x, y, strata='campaign_id'):
    tables = []
    for _, g in sub.groupby(strata):
        a = int((g[x] & g[y]).sum()); b = int((g[x] & ~g[y]).sum())
        c = int((~g[x] & g[y]).sum()); d = int((~g[x] & ~g[y]).sum())
        if (a + b) == 0 or (c + d) == 0 or (a + c) == 0: continue
        tables.append(np.array([[a, b], [c, d]], dtype=float))
    if len(tables) < 1: return None
    st = StratifiedTable(tables)
    try:
        lo, hi = st.oddsratio_pooled_confint()
        return dict(or_=float(st.oddsratio_pooled), lo=float(lo), hi=float(hi), p=float(st.test_null_odds().pvalue), strata=len(tables),
                    n_x=int(sum(t[0].sum() for t in tables)))
    except Exception:
        return None

def tests_for(sub, y, name, values):
    rows = []
    for feat, lvl, mask in values:
        x = mask
        n1, k1 = int(x.sum()), int((x & sub[y]).sum()); n0, k0 = int((~x).sum()), int((~x & sub[y]).sum())
        if n1 < 30 or n0 < 30: continue
        tab = [[k1, n1 - k1], [k0, n0 - k0]]
        p_raw = stats.fisher_exact(tab)[1] if min(k1, k0) < 10 else stats.chi2_contingency(tab)[1]
        s = sub.assign(_x=x.values)
        m = mh(s, '_x', y)
        early, late = s[s.invited_at < SPLIT], s[s.invited_at >= SPLIT]
        me, ml = mh(early, '_x', y), mh(late, '_x', y)
        rows.append(dict(outcome=name, feature=feat, level=str(lvl), n=n1, k=k1, rate=k1 / n1, ci=wilson(k1, n1),
                         rest_n=n0, rest_rate=k0 / n0 if n0 else np.nan, lift=(k1 / n1) / (k0 / n0) if k0 else np.nan, p_raw=p_raw,
                         mh=m, mh_early=me, mh_late=ml))
    return rows

all_rows = []
for oname, (obs, y, _) in OUTCOMES.items():
    sub = first[first[obs]].copy()
    sub[y] = sub[y].astype(bool)
    vals = []
    for f in CATEG:
        for lvl in sub[f].dropna().unique():
            vals.append((f, lvl, (sub[f] == lvl)))
    for f in BOOL:
        col = sub[f].fillna(False).astype(bool)
        vals.append((f, True, col))
    all_rows += tests_for(sub, y, oname, vals)

R = pd.DataFrame(all_rows)
R['p_mh'] = R.mh.map(lambda m: m['p'] if m else np.nan)
for o in OUTCOMES:
    for col, out in (('p_raw', 'q_raw'), ('p_mh', 'q_mh')):
        idx = R.index[(R.outcome == o) & R[col].notna()]
        R.loc[idx, out] = multipletests(R.loc[idx, col], method='fdr_bh')[1]

def replicate(r):
    e, l, m = r.mh_early, r.mh_late, r.mh
    if not m: return 'n/a'
    sign = np.sign(np.log(m['or_'])) if m['or_'] > 0 else 0
    if not e or not l: return 'one period only'
    se, sl = np.sign(np.log(e['or_'])) if e['or_'] > 0 else 0, np.sign(np.log(l['or_'])) if l['or_'] > 0 else 0
    if se == sl == sign and e['p'] < 0.05 and l['p'] < 0.05: return 'replicated'
    if se == sl == sign: return 'same direction'
    return 'flips'
R['replication'] = R.apply(replicate, axis=1)
R.to_pickle('data/scan.pkl')

def show(o):
    s = R[R.outcome == o].copy()
    s['mh_or'] = s.mh.map(lambda m: round(m['or_'], 2) if m else None)
    s['mh_ci'] = s.mh.map(lambda m: f"{m['lo']:.2f}-{m['hi']:.2f}" if m else None)
    s = s.sort_values('q_mh')
    cols = ['feature', 'level', 'n', 'rate', 'rest_rate', 'lift', 'q_raw', 'mh_or', 'mh_ci', 'q_mh', 'replication']
    print(f'\n===== {o} =====')
    print(s[cols].head(40).to_string(index=False, float_format=lambda v: f'{v:.3f}'))
for o in OUTCOMES: show(o)

# campaign-level descriptives (cannot be controlled for campaign; shown with Wilson CIs)
desc = {}
for oname, (obs, y, _) in OUTCOMES.items():
    sub = first[first[obs]]
    for f in CAMPAIGN_LEVEL:
        g = sub.groupby(f)[y].agg(['count', 'sum'])
        desc[(oname, f)] = [(str(i), int(r['count']), int(r['sum']), r['sum'] / r['count'], wilson(r['sum'], r['count'])) for i, r in g.iterrows()]
json.dump({f'{k[0]}|{k[1]}': v for k, v in desc.items()}, open('data/campaign_level.json', 'w'), default=float)
print('\nbaselines:', {o: round(first[first[obs]][y].mean(), 4) for o, (obs, y, _) in OUTCOMES.items()},
      {o: int(first[obs].sum()) for o, (obs, y, _) in OUTCOMES.items()})
