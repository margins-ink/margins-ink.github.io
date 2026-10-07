import sys,json,numpy as np,soundfile as sf
# ground truth paragraph starts = ends of exact-zero pad runs
a,sr=sf.read(sys.argv[1]); z=(a==0); runs=[];i=0
while i<len(z):
    if z[i]:
        j=i
        while j<len(z) and z[j]: j+=1
        if (j-i)/sr>=0.35: runs.append(round(j/sr,3))
        i=j
    else: i+=1
print("true para starts (after pad):",[0.0]+runs[:-1] if runs else runs)
