import sys,time,numpy as np,soundfile as sf
from mlx_audio.tts.utils import load_model
text=open(sys.argv[1]).read(); out=sys.argv[2]; spk=sys.argv[3]
m=load_model("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16")
INS="Warm, curious science-explainer narrator, like a documentary host. Natural pacing, leaning into key words, genuine wonder, slightly slower than conversation."
t=time.time(); chunks=[]; sr=24000
paras=[p.strip() for p in text.split("\n\n") if p.strip()]
for i,p in enumerate(paras):
    t0=time.time(); n=0
    for r in m.generate(text=p,voice=spk,lang_code="en",instruct=INS,max_tokens=2000):
        chunks.append(np.array(r.audio).reshape(-1)); sr=r.sample_rate; n+=len(chunks[-1])
    print(i,"para dur",n/sr,"took",time.time()-t0,flush=True)
    chunks.append(np.zeros(int(sr*0.4),dtype=np.float32))
a=np.concatenate(chunks); dt=time.time()-t
sf.write(out,a,sr)
print("sr",sr,"dur",len(a)/sr,"gen",dt,"RTF",dt/(len(a)/sr))
