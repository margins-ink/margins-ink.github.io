import os,sys,json,base64,time,urllib.request
text=open(sys.argv[1]).read().strip(); out=sys.argv[2]; voice=sys.argv[3]
body=json.dumps({"text":text,"model_id":"eleven_v3","voice_settings":{"stability":0.5}}).encode()
req=urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128",body,{"xi-api-key":os.environ["ELEVENLABS_API_KEY"],"content-type":"application/json"})
t=time.time(); d=json.load(urllib.request.urlopen(req,timeout=300)); dt=time.time()-t
open(out+".mp3","wb").write(base64.b64decode(d["audio_base64"]))
json.dump(d["alignment"],open(out+".align.json","w"))
print("gen",dt,"chars",len(text),"align end",d["alignment"]["character_end_times_seconds"][-1])
