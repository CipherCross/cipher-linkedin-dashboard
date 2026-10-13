# Joint model, time-to-accept curve, sequence touches, re-invites, Sep grid, account comparison.
import json, warnings
import numpy as np, pandas as pd
import statsmodels.formula.api as smf
from scipy import stats
from statsmodels.stats.contingency_tables import StratifiedTable
warnings.filterwarnings('ignore')
pd.set_option('future.infer_string', False)
SNAP = pd.Timestamp('2026-10-13', tz='UTC')
df = pd.read_pickle('data/features.pkl')
first = df[df.first_touch_for_person].copy()
out = {}

def wilson(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [c - h, c + h]

# ---------- 1. joint logistic model with campaign fixed effects
def joint(sub, y):
    s = sub.copy()
    s['y'] = s[y].astype(int)
    ok = s.groupby('campaign_id').y.transform('sum') > 0
    s = s[ok]
    s['pipe'] = s.headline_has_pipe.astype(int)
    s['hl_len'] = pd.Categorical(s.headline_len_bucket, categories=['41-80', 'empty', '1-40', '81-140', '141+'])
    s['co_age'] = pd.Categorical(s.company_age, categories=['6-10 yrs', '0-2 yrs', '3-5 yrs', '11+ yrs', 'unknown'])
    s['co_size'] = pd.Categorical(s.company_size, categories=['11-50', '0-1', '2-10', '51-200', '201+', 'unknown'])
    s['region'] = pd.Categorical(s.company_region, categories=['US', 'UK', 'Canada', 'Europe (ex-UK)', 'AU/NZ', 'Israel', 'Other', 'unknown'])
    s['ind'] = pd.Categorical(s.industry, categories=['Health, wellness & fitness', 'Hospital & health care', 'Mental health care', 'Medical / pharma / devices', 'IT & software', 'Other', 'unknown'])
    s['age'] = pd.Categorical(s.age_inferred, categories=['30-39', '<30', '40-49', '50-59', '60+', 'no signal'])
    s['clin'] = s['hl_clinician (MD/PhD/physician)'].astype(int)
    s['gender'] = pd.Categorical(s.gender_inferred, categories=['male', 'female', 'unknown/none'])
    m = smf.logit('y ~ pipe + hl_len + co_age + co_size + region + ind + age + clin + gender + C(campaign_id)', data=s).fit(disp=0, maxiter=200, method='bfgs')
    rows = []
    for k in m.params.index:
        if k.startswith('C(campaign_id)') or k == 'Intercept': continue
        lo, hi = m.conf_int().loc[k]
        rows.append(dict(term=k, or_=float(np.exp(m.params[k])), lo=float(np.exp(lo)), hi=float(np.exp(hi)), p=float(m.pvalues[k])))
    return dict(n=int(len(s)), events=int(s.y.sum()), terms=rows)

out['joint_accept14'] = joint(first[first.obs_accept14], 'accepted_14d')
out['joint_reply21'] = joint(first[first.obs_reply21], 'replied_21d')
for k in ('joint_accept14', 'joint_reply21'):
    print(f'\n== {k} n={out[k]["n"]} events={out[k]["events"]}')
    for r in out[k]['terms']:
        flag = '*' if r['p'] < 0.05 else ' '
        print(f"{flag} {r['term']:45s} OR {r['or_']:.2f} [{r['lo']:.2f}-{r['hi']:.2f}] p={r['p']:.4f}")

# ---------- 2. time-to-accept (Kaplan-Meier, first-touch invites, censored at snapshot)
t = first.copy()
t['dur'] = np.where(t.accepted, t.days_to_accept, t.followup_days).clip(min=0)
t['ev'] = t.accepted.astype(int)
times = np.sort(t.loc[t.ev == 1, 'dur'].unique())
surv, s_ = [], 1.0
at = t.dur.values; evv = t.ev.values
km = {}
for d in times:
    n_risk = (at >= d).sum(); d_ev = ((at == d) & (evv == 1)).sum()
    s_ *= 1 - d_ev / n_risk
    km[float(d)] = 1 - s_
def km_at(day):
    ks = [k for k in km if k <= day]
    return km[max(ks)] if ks else 0.0
out['km_accept'] = {d: km_at(d) for d in [1, 2, 3, 7, 14, 21, 30, 45, 60, 90, 120]}
print('\nKM cumulative acceptance:', {d: round(v, 3) for d, v in out['km_accept'].items()})
# conditional: still pending at day X -> eventually accepts by day 120
for X in (7, 14, 30):
    out[f'km_pending_{X}_accept_by_120'] = (km_at(120) - km_at(X)) / (1 - km_at(X))
print('pending at 7/14/30 -> accepts by 120:', [round(out[f'km_pending_{X}_accept_by_120'], 3) for X in (7, 14, 30)])

# ---------- 3. sequence touches (outbound messages before first reply), first-touch accepted leads
msgs = pd.DataFrame(json.load(open('data/messages.json')))
msgs['sent_at'] = pd.to_datetime(msgs.sent_at, utc=True, format='ISO8601')
ob = msgs[msgs.direction == 'out'].copy()
ob['nb'] = ob.body.fillna('').str.lower().str.replace(r'\s+', ' ', regex=True)
ob = ob.sort_values('sent_at').drop_duplicates(['instance_id', 'profile_url', 'nb'])
acc = first[first.accepted & ((SNAP - first.connected_at).dt.days >= 45)].copy()
key = lambda d: d.instance_id + '|' + d.profile_url
acc['k'] = key(acc)
ob['k'] = key(ob)
obg = ob.groupby('k').sent_at.apply(list).to_dict()
touch_rows = []
for _, r in acc.iterrows():
    sends = [s for s in obg.get(r.k, []) if s >= r.connected_at - pd.Timedelta(days=1)]
    if r.replied and pd.notna(r.replied_at):
        before = sum(1 for s in sends if s < r.replied_at)
        touch_rows.append(dict(replied=True, touches_before=before, total_sent=len(sends)))
    else:
        touch_rows.append(dict(replied=False, touches_before=None, total_sent=len(sends)))
T = pd.DataFrame(touch_rows)
haz = []
maxk = 8
for k in range(0, maxk + 1):
    # at risk after k touches: not replied before touch k+1... define: received >=k touches and no reply before k-th touch completed
    at_risk = ((T.total_sent >= k) & (~T.replied | (T.touches_before >= k))).sum()
    replied_here = (T.replied & (T.touches_before == k)).sum()
    haz.append(dict(after_touch=k, at_risk=int(at_risk), replied=int(replied_here), rate=replied_here / at_risk if at_risk else np.nan))
out['touch_hazard'] = haz
out['touch_population'] = dict(accepted_leads=int(len(T)), replied=int(T.replied.sum()))
print('\nreply hazard by touches already sent (accepted leads, >=45d since accept):')
for h in haz: print(f"  after {h['after_touch']} msgs: {h['replied']}/{h['at_risk']} = {h['rate']:.3f}")

# ---------- 4. re-invites: same person, two different accounts
d2 = df.sort_values('invited_at')
multi = d2.groupby('slug').filter(lambda g: g.account.nunique() > 1 and len(g) >= 2)
pairs = []
for s, g in multi.groupby('slug'):
    g = g.sort_values('invited_at')
    a, b = g.iloc[0], g[g.account != g.iloc[0].account].iloc[0]
    if (SNAP - b.invited_at).days < 14: continue
    a_acc = bool(a.accepted and (a.connected_at < b.invited_at))
    b_acc = bool(b.accepted and b.days_to_accept <= 14 and (not a_acc))
    pairs.append(dict(first_acc_before_second=a_acc, second_acc14=b_acc, b_campaign=b.campaign_id, gap=(b.invited_at - a.invited_at).days, a_acc_ever=bool(a.accepted)))
P = pd.DataFrame(pairs)
eligible = P[~P.first_acc_before_second]
out['reinvite'] = dict(pairs=int(len(P)), first_accepted_before_second=int(P.first_acc_before_second.sum()),
                      second_eligible=int(len(eligible)), second_accepted14=int(eligible.second_acc14.sum()), median_gap=float(P.gap.median()))
# compare to fresh first-touch invites in the same campaigns (MH across second-sender campaigns)
tabs = []
fresh = first[first.obs_accept14]
for cid, g in eligible.groupby('b_campaign'):
    f = fresh[fresh.campaign_id == cid]
    if len(f) < 10: continue
    a_, b_ = int(g.second_acc14.sum()), int((~g.second_acc14).sum())
    c_, d_ = int(f.accepted_14d.sum()), int((~f.accepted_14d).sum())
    tabs.append(np.array([[a_, b_], [c_, d_]], dtype=float))
st = StratifiedTable(tabs)
lo, hi = st.oddsratio_pooled_confint()
fresh_rate = sum(t_[1, 0] for t_ in tabs) / sum(t_[1].sum() for t_ in tabs)
re_rate = sum(t_[0, 0] for t_ in tabs) / sum(t_[0].sum() for t_ in tabs)
out['reinvite_vs_fresh'] = dict(reinvited_n=int(sum(t_[0].sum() for t_ in tabs)), reinvited_rate=re_rate, fresh_n=int(sum(t_[1].sum() for t_ in tabs)),
                               fresh_rate=fresh_rate, mh_or=float(st.oddsratio_pooled), lo=float(lo), hi=float(hi), p=float(st.test_null_odds().pvalue), strata=len(tabs))
print('\nre-invites:', out['reinvite']); print('re-invited vs fresh in same campaigns:', {k: (round(v, 3) if isinstance(v, float) else v) for k, v in out['reinvite_vs_fresh'].items()})

# ---------- 5. Sep grid persona x offer (acceptance 14d)
g = first[first.sept_grid & first.obs_accept14]
tab = g.groupby(['campaign_persona', 'offer']).accepted_14d.agg(['count', 'sum'])
tab['rate'] = tab['sum'] / tab['count']
out['grid'] = [dict(persona=i[0], offer=i[1], n=int(r['count']), k=int(r['sum']), rate=float(r['rate']), ci=wilson(r['sum'], r['count'])) for i, r in tab.iterrows()]
print('\nSep grid acceptance (14d):\n', tab.round(3).to_string())
gp = g.groupby('campaign_persona').accepted_14d.agg(['count', 'sum']); gp['rate'] = gp['sum'] / gp['count']
print(gp.round(3).to_string())
out['grid_persona'] = {i: dict(n=int(r['count']), k=int(r['sum']), rate=float(r['rate']), ci=wilson(r['sum'], r['count'])) for i, r in gp.iterrows()}
chi = stats.chi2_contingency(np.array([[r['sum'], r['count'] - r['sum']] for _, r in gp.iterrows()]))
out['grid_persona_p'] = float(chi[1])
print('persona chi2 p', round(chi[1], 4))

# ---------- 6. accounts compared within the same persona x offer cell (Sep grid)
g['cell'] = g.campaign_persona.fillna('') + '|' + g.offer.fillna('')
acc_rates = {}
for a in sorted(g.account.unique()):
    tabs = []
    for c, gg in g.groupby('cell'):
        x = gg.account == a
        if x.sum() == 0 or (~x).sum() == 0: continue
        tabs.append(np.array([[(x & gg.accepted_14d).sum(), (x & ~gg.accepted_14d).sum()], [(~x & gg.accepted_14d).sum(), (~x & ~gg.accepted_14d).sum()]], dtype=float))
    if not tabs: continue
    st = StratifiedTable(tabs); lo, hi = st.oddsratio_pooled_confint()
    sub = g[g.account == a]
    acc_rates[a] = dict(n=int(len(sub)), rate=float(sub.accepted_14d.mean()), mh_or_vs_others=float(st.oddsratio_pooled), lo=float(lo), hi=float(hi), p=float(st.test_null_odds().pvalue))
out['grid_accounts'] = acc_rates
print('\naccounts within grid cells:', {a: {k: round(v, 3) if isinstance(v, float) else v for k, v in r.items()} for a, r in acc_rates.items()})

# ---------- 7. all-time account rates on mature first-touch invites
m = first[first.obs_accept14]
out['account_accept14'] = {a: dict(n=int(len(s)), rate=float(s.accepted_14d.mean()), ci=wilson(s.accepted_14d.sum(), len(s))) for a, s in m.groupby('account')}
m = first[first.obs_reply21]
out['account_reply21'] = {a: dict(n=int(len(s)), rate=float(s.replied_21d.mean()), ci=wilson(s.replied_21d.sum(), len(s))) for a, s in m.groupby('account')}
print('account accept14', {a: round(v['rate'], 3) for a, v in out['account_accept14'].items()}, 'reply21', {a: round(v['rate'], 3) for a, v in out['account_reply21'].items()})

json.dump(out, open('data/deep.json', 'w'), default=float, indent=1)
