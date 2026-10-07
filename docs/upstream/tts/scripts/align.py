import sys,json,re,numpy as np,soundfile as sf,stable_whisper,time,subprocess
audio,textf,outjson=sys.argv[1:4]
text=re.sub(r"\[[a-z ]+\]\s*","",open(textf).read())
paras=[p.strip() for p in text.split("\n\n") if p.strip()]
flat=" ".join(" ".join(paras).split())
m=stable_whisper.load_model("small.en",device="cpu")
t=time.time(); r=m.align(audio,flat,language="en"); dt=time.time()-t
words=[(w.word.strip(),round(w.start,3),round(w.end,3)) for s in r.segments for w in s.words]
json.dump(words,open(outjson,"w"))
print("align s",round(dt,1),"words",len(words),"script words",len(flat.split()))
# paragraph-start check against first-word time
idx=0;starts=[]
for p in paras: starts.append(idx); idx+=len(p.split())
al=[words[i][1] for i in starts if i<len(words)]
print("para first-word starts (aligner):",al)
