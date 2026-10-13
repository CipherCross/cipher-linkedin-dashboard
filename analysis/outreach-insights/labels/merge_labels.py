# Merge the classified batches (data/labels/out_*.jsonl) into data/reply_labels.pkl.
import glob, json, pandas as pd
lab = [json.loads(l) for f in sorted(glob.glob('data/labels/out_*.jsonl')) for l in open(f) if l.strip()]
inp = [json.loads(l) for f in sorted(glob.glob('data/labels/batch_*.jsonl')) for l in open(f) if l.strip()]
assert [x['thread_id'] for x in lab] == [x['thread_id'] for x in inp], 'labels do not line up with the batches'
pd.DataFrame(lab).to_pickle('data/reply_labels.pkl'); print(len(lab), 'threads')
