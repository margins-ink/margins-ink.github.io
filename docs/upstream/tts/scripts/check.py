import sys,json,re,numpy as np,soundfile as sf
name,wav=sys.argv[1],sys.argv[2]
a,sr=sf.read(wav); a=a if a.ndim==1 else a.mean(1)
z=(a==0);runs=[];i=0
while i<len(z):
    if z[i]:
        j=i
        while j<len(z) and z[j]: j+=1
        if (j-i)/sr>=0.35: runs.append(j)
        i=j
    else:i+=1
st=[0]+runs[:-1]
on=[round(float(next(k for k in range(s,len(a)) if abs(a[k])>0.02)/sr),3) for s in st]
w=json.load(open(wav.replace('.wav','.words.json')))
text=open('/Volumes/Projects/andrewgazelka/site/docs/upstream/tts/excerpt.txt').read()
paras=[p for p in text.split("\n\n") if p.strip()];idx=0;al=[]
for p in paras: al.append(w[idx][1]); idx+=len(p.split())
err=[round(x-y,2) for x,y in zip(al,on)]
print(name,"onset(true)",on,"\n aligner",al,"\n err",err)
