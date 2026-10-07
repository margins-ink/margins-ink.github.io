import json,re,subprocess,numpy as np
al=json.load(open('out/eleven/eleven_george.align.json'))
ch=al['characters'];s=al['character_start_times_seconds'];e=al['character_end_times_seconds']
# words with tags removed
words=[];cur="";cs=None
inside=False
for c,a,b in zip(ch,s,e):
    if c=='[': inside=True
    if inside:
        if c==']': inside=False
        continue
    if c.isspace():
        if cur: words.append((cur,cs,pe)); cur=""
    else:
        if not cur: cs=a
        cur+=c; pe=b
if cur: words.append((cur,cs,pe))
w=json.load(open('out/eleven/eleven_george.words.json'))
print(len(words),len(w))
d=[abs(x[1]-y[1]) for x,y in zip(words,w)]
d=np.array(d); print("start err vs ElevenLabs own char timings: median",np.median(d),"p95",np.percentile(d,95),"max",d.max())
