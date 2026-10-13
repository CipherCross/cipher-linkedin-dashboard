import json, warnings
import numpy as np, pandas as pd
from scipy import stats
from statsmodels.stats.contingency_tables import StratifiedTable
warnings.filterwarnings('ignore'); pd.set_option('future.infer_string', False)
SNAP = pd.Timestamp('2026-10-13', tz='UTC')
def wilson(k, n, z=1.96):
    if n == 0: return [np.nan, np.nan]
    p = k / n; d = 1 + z*z/n; c = (p + z*z/(2*n))/d; h = z*np.sqrt(p*(1-p)/n + z*z/(4*n*n))/d
    return [c-h, c+h]
Lb = pd.read_pickle('data/reply_labels.pkl')
grp = {'interested':'engaged','question':'engaged','polite':'polite / small talk','other':'polite / small talk',
       'not_interested':'rejection','has_solution':'rejection','not_now':'rejection','referral':'rejection','pitch_back':'pitch-back','auto_reply':'auto-reply'}
Lb['first_group'] = Lb.first_reply.map(grp)
Lb['substantive'] = Lb.best_intent.isin(['p2','p3'])
Lb['p3'] = Lb.best_intent.eq('p3')
df = pd.read_pickle('data/features.pkl')
df['thread_id'] = df.instance_id + '|' + df.profile_url
first = df[df.first_touch_for_person].copy()
f = first.merge(Lb, on='thread_id', how='left')
for c in ['substantive','p3','call_agreed']: f[c] = f[c].fillna(False).astype(bool)
out = {}
# funnel on first-touch invites with >=45 days since invite
pop = f[f.followup_days >= 45]
fun = dict(invited=len(pop), accepted=int(pop.accepted.sum()), replied=int(pop.replied.sum()), labelled=int(pop.first_reply.notna().sum()),
           substantive=int(pop.substantive.sum()), p3=int(pop.p3.sum()), call_agreed=int(pop.call_agreed.sum()))
out['funnel45'] = fun; print('funnel (first-touch, >=45d):', fun)
lab = Lb.copy()
out['first_reply_counts'] = lab.first_reply.value_counts().to_dict(); out['first_group_counts'] = lab.first_group.value_counts().to_dict()
out['intent_counts'] = lab.best_intent.value_counts().to_dict(); out['call_agreed'] = int(lab.call_agreed.sum()); out['threads'] = len(lab)
# conversion from first reply group to substantive
cg = lab.groupby('first_group').agg(n=('substantive','size'), subst=('substantive','sum'), p3=('p3','sum'), calls=('call_agreed','sum'))
out['first_group_to_outcome'] = cg.reset_index().to_dict('records'); print(cg)
# touches before reply vs substantive (accepted first-touch leads with label)
msgs = pd.DataFrame(json.load(open('data/messages.json'))); msgs['sent_at'] = pd.to_datetime(msgs.sent_at, utc=True, format='ISO8601')
ob = msgs[msgs.direction=='out'].copy(); ob['nb']=ob.body.fillna('').str.lower().str.replace(r'\s+',' ',regex=True)
ob = ob.sort_values('sent_at').drop_duplicates(['instance_id','profile_url','nb']); ob['thread_id']=ob.instance_id+'|'+ob.profile_url
inn = msgs[msgs.direction=='in'].copy(); inn['thread_id']=inn.instance_id+'|'+inn.profile_url
first_in = inn.groupby('thread_id').sent_at.min()
obg = ob.groupby('thread_id').sent_at.apply(list)
lab['first_in'] = lab.thread_id.map(first_in)
lab['touches_before'] = [sum(1 for s in obg.get(t, []) if s < fi) if pd.notna(fi) else np.nan for t, fi in zip(lab.thread_id, lab.first_in)]
lab['tb'] = pd.cut(lab.touches_before, [-1,0,1,2,3,100], labels=['0 (reply to connect note)','1','2','3','4+']).astype(str)
tb = lab.groupby('tb').agg(n=('substantive','size'), subst=('substantive','sum'), p3=('p3','sum'), rejection=('first_group', lambda s:(s=='rejection').sum()))
tb['subst_rate']=tb.subst/tb.n; tb['rej_rate']=tb.rejection/tb.n
out['touch_quality'] = tb.reset_index().to_dict('records'); print(tb.round(3))
# who gives substantive replies: among accepted first-touch leads with >=30d since accept
acc = f[f.accepted & ((SNAP - f.connected_at).dt.days >= 30)].copy()
out['accepted_base'] = dict(n=len(acc), subst=int(acc.substantive.sum()), rate=float(acc.substantive.mean()), p3=int(acc.p3.sum()))
print('accepted base', out['accepted_base'])
rows = []
feats = {'company_size':['2-10','11-50'], 'company_age':['0-2 yrs','3-5 yrs','6-10 yrs'], 'company_region':['US','UK','Europe (ex-UK)','Canada'],
         'industry':['Hospital & health care','Health, wellness & fitness','Mental health care','IT & software'], 'age_inferred':['<30','30-39','40-49','50-59'],
         'gender_inferred':['female','male'], 'headline_has_pipe':[True], 'headline_len_bucket':['1-40','141+'], 'wave':['Sep-2026 persona grid'], 'company_seen_before':[True]}
for feat, lvls in feats.items():
    for lvl in lvls:
        x = acc[feat] == lvl
        n1, k1 = int(x.sum()), int((x & acc.substantive).sum()); n0, k0 = int((~x).sum()), int((~x & acc.substantive).sum())
        tabs = []
        for _, g in acc.assign(_x=x).groupby('campaign_id'):
            a=int((g._x&g.substantive).sum()); b=int((g._x&~g.substantive).sum()); c=int((~g._x&g.substantive).sum()); d=int((~g._x&~g.substantive).sum())
            if a+b==0 or c+d==0 or a+c==0: continue
            tabs.append(np.array([[a,b],[c,d]],dtype=float))
        mh = None
        if tabs:
            st = StratifiedTable(tabs); lo, hi = st.oddsratio_pooled_confint(); mh = dict(or_=float(st.oddsratio_pooled), lo=float(lo), hi=float(hi), p=float(st.test_null_odds().pvalue))
        p = stats.fisher_exact([[k1,n1-k1],[k0,n0-k0]])[1]
        rows.append(dict(feature=feat, level=str(lvl), n=n1, k=k1, rate=k1/n1 if n1 else np.nan, ci=wilson(k1,n1), rest_rate=k0/n0, p_raw=p, mh=mh))
R = pd.DataFrame(rows); out['substantive_given_accept'] = R.to_dict('records')
R['mh_or'] = R.mh.map(lambda m: round(m['or_'],2) if m else None); R['mh_p'] = R.mh.map(lambda m: round(m['p'],4) if m else None)
print(R[['feature','level','n','k','rate','rest_rate','p_raw','mh_or','mh_p']].to_string(float_format=lambda v: f'{v:.3f}'))
# rapport threads
out['rapport'] = dict(n=int(lab.rapport.sum()), subst=int(lab[lab.rapport].substantive.sum()))
# reply speed vs substantive
lab2 = lab.merge(f[['thread_id','connected_at']].dropna().drop_duplicates('thread_id'), on='thread_id', how='left')
lab2['days'] = (lab2.first_in - lab2.connected_at).dt.total_seconds()/86400
sp = lab2.dropna(subset=['days']); sp = sp[sp.days >= 0]
out['reply_speed'] = dict(subst_median_days=float(sp[sp.substantive].days.median()), other_median_days=float(sp[~sp.substantive].days.median()),
                          mw_p=float(stats.mannwhitneyu(sp[sp.substantive].days, sp[~sp.substantive].days).pvalue), n_subst=int(sp.substantive.sum()), n_other=int((~sp.substantive).sum()))
print('reply speed', out['reply_speed'])
json.dump(out, open('data/replies.json','w'), default=float, indent=1)
