import sys,time,numpy as np,soundfile as sf
from mlx_audio.tts.utils import load_model
text=open(sys.argv[1]).read(); out=sys.argv[2]
m=load_model("mlx-community/Kokoro-82M-bf16")
t=time.time(); chunks=[]; sr=24000
paras=[p.strip() for p in text.split("\n\n") if p.strip()]
for p in paras:
    for r in m.generate(text=p,voice="af_heart",speed=0.95,lang_code="a"):
        chunks.append(np.array(r.audio).reshape(-1)); sr=r.sample_rate
    chunks.append(np.zeros(int(sr*0.45),dtype=np.float32))
a=np.concatenate(chunks); dt=time.time()-t
sf.write(out,a,sr)
print("sr",sr,"dur",len(a)/sr,"gen",dt,"RTF",dt/(len(a)/sr))
