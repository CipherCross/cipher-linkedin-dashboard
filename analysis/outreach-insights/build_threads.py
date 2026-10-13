import json, os, pandas as pd
msgs=pd.DataFrame(json.load(open('data/messages.json')))
msgs['sent_at']=pd.to_datetime(msgs.sent_at,utc=True,format='ISO8601')
msgs=msgs[msgs.body.notna() & (msgs.body.str.strip()!='')]
# drop exact duplicates (manual vs synced copies): same thread, direction, normalized body
msgs['nb']=msgs.body.str.lower().str.replace(r'\s+',' ',regex=True).str.strip()
msgs=msgs.sort_values('sent_at').drop_duplicates(['instance_id','profile_url','direction','nb'])
threads=[]
for (inst,url),g in msgs.groupby(['instance_id','profile_url']):
    if not (g.direction=='in').any(): continue
    g=g.sort_values('sent_at')
    lines=[]; n_in=0
    for _,r in g.iterrows():
        if r.direction=='in':
            n_in+=1
            if n_in>10: continue
            lines.append(f"[THEM {r.sent_at:%Y-%m-%d}] {r.body.strip()[:1500]}")
        else:
            lines.append(f"[US {r.sent_at:%Y-%m-%d}] {r.body.strip()[:400]}")
    # keep transcript bounded: at most 24 lines
    if len(lines)>24: lines=lines[:24]+[f"... ({len(lines)-24} more messages omitted)"]
    threads.append({'thread_id':f'{inst}|{url}','transcript':'\n'.join(lines)})
print('threads', len(threads), 'chars', sum(len(t['transcript']) for t in threads))
N=8; size=-(-len(threads)//N)
os.makedirs('data/labels', exist_ok=True)
for i in range(N):
    with open(f'data/labels/batch_{i:02d}.jsonl','w') as f:
        for t in threads[i*size:(i+1)*size]: f.write(json.dumps(t,ensure_ascii=False)+'\n')
    print(i, len(threads[i*size:(i+1)*size]))
