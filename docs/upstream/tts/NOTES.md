# Narration TTS: findings and recommended pipeline (2026-10-07)

Verdict: local Qwen3-TTS-12Hz-1.7B-CustomVoice (Apache 2.0) via mlx-audio, forced alignment with stable-ts (MIT, Whisper small.en), per-paragraph chunks. ElevenLabs v3 is the quality-ceiling reference (about $0.56 per 7000-char article), not the default. Everything below on the objective side is "listening by metrics"; I cannot hear audio. Andrew must listen.

## Models surveyed (licence status in SOURCE.md)
Usable (permissive): Qwen3-TTS (Apache 2.0, instruction-controlled style, 10 languages), Kokoro-82M (Apache 2.0, tiny, flat), Chatterbox (MIT, has an exaggeration knob), Orpheus 3B (Apache 2.0, emotion tags), Dia 1.6B (Apache 2.0, dialogue-oriented), Sesame CSM-1B (Apache 2.0, conversational), VibeVoice 1.5B (MIT, long-form multi-speaker, research-use caveats).
Rejected: F5-TTS weights (CC-BY-NC), Fish Audio S2 Pro (research licence). XTTS/Coqui: CPML non-commercial (from memory, unverified). Kokoro's misaki can pull espeak-ng (GPL-3) as a phonemizer fallback: build-time only, nothing shipped, but it breaks the no-GPL rule in letter; Qwen3-TTS avoids it.
Hosted (cost for a 7000-char, about 8 min article): ElevenLabs v3 $0.08/1k chars = $0.56 (page 2026-10-07; a third-party page says $0.10); OpenAI gpt-4o-mini-tts about $0.015/min = $0.12 (estimate), steerable via an instructions prompt; Cartesia Sonic about $0.05/1k chars on Pro = $0.35; Google and Hume prices not verified. Voice cloning: ElevenLabs, Cartesia (Pro+ instant) and the local Qwen3-TTS Base model can all clone Andrew's own voice from a short reference; needs his explicit consent and a clean recording; not done. ElevenLabs free tier is non-commercial; the key found in the env (ELEVENLABS_API_KEY, lacks user_read so its plan is unknown) must be on a paid plan before the site ships its audio.

## Same 90 s excerpt (excerpt.txt, 210 words, 8 paragraphs), machine load average 14-24
| | Kokoro 82M bf16 (af_heart, speed 0.95) | Qwen3-TTS 1.7B CustomVoice bf16 (Aiden, one style instruct) | ElevenLabs v3 (George, 4 audio tags) |
|---|---|---|---|
| duration | 84.9 s | 84.6 s | 92.1 s |
| generation time / RTF | 6.9 s / 0.081 | 28.0 s / 0.33 | 25.5 s wall / 0.28 |
| loudness before norm | -25.2 LUFS, LRA 2.8 | -20.0, LRA 5.4 | -19.7, LRA 3.1 |
| f0 spread (std, semitones; pyin) | 2.8 | 6.1 | 4.4 |
| pauses >=0.3 s (count / total) | 32 / 21.1 s | 41 / 21.0 s | 34 / 26.0 s |
| clipping | none (peak -4.7 dBFS) | none (-1.8) | none (-2.4) |
Reading by metrics only: Kokoro is clean and fast but has the narrowest pitch range (likely the most monotone). Qwen has the widest range and the most variation in level (LRA 5.4); the range may include pitch-tracker octave errors, so it is a hint, not proof. Whether it sounds warm and curious, whether Aiden's instruct holds across paragraphs, and any mispronunciations are for Andrew's ears.

## Word timings (stable-ts forced align, small.en, CPU: 3 s for 85 s audio, all 210/210 words matched)
Error check: paragraph first-word start vs exact audio onset after the known zero-pad between chunks. Kokoro errors (s): +0.17 (para 1, leading breath), then -0.01 to +0.07, last +0.43. Qwen: +0.14, then 0.01 to 0.15, last +0.41. So within 0.15 s except the final paragraph (0.4 s, unresolved; probably a soft onset on "Functional"). For ElevenLabs, compared to its own character timestamps (ground truth): median 0.057 s, p95 0.59 s, max 1.23 s (large errors sit after [pause] tags, where ElevenLabs charges the pause to the next word). Good enough for karaoke-style word highlighting at 0.1-0.2 s tolerance; ElevenLabs' own character timings (with-timestamps endpoint) are the exact source if it is chosen.

## Recommended pipeline
1. Script format: markdown `narration.md` next to the article, front matter `voice: Aiden`, `style: "<instruct>"`. One paragraph = one TTS chunk (keep chunks under about 25 s; Qwen per-chunk times above were 1-6 s). Inline directives compiled by our code, since Qwen has no SSML: `{pause=600ms}` becomes inserted silence; a line starting `> style: wondering` overrides the instruct for that paragraph; `*word*` is only a hint (Qwen has no word-level emphasis; control is the per-chunk instruct plus punctuation and sentence length). Write numbers and symbols as spoken words (the excerpt does: "nineteen thirty-six"); keep a pronunciation map for names.
2. Synthesis: mlx-audio 0.5.8 in a uv venv, `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16`, pinned snapshot. Default pad 0.4 s between paragraphs, 0.8 s before a new section.
3. Cache key per chunk: sha256(model snapshot id + voice + instruct + chunk text + sampler params). Qwen sampling is stochastic (seed not tested), so commit the chunk wavs or opus (a few hundred KB per minute) to the content cache and never regenerate unless the key changes; regenerate only changed chunks.
4. Alignment: stable-ts `model.align(audio, script_text)` with Whisper small.en (MIT), output `[word, start, end]` JSON per article (about 5 KB per 90 s). Per-chunk offsets are exact (we know each chunk's duration), so align per chunk and add offsets if drift on 10-minute files appears (full-file align not tested beyond 92 s).
5. Encode: concatenate, two-pass loudnorm to -16 LUFS integrated, -1.5 dBTP (scripts/encode.sh; measured -16.1 to -16.3 LUFS after encode), mono. Ship two sources: Opus 40 kbps in ogg (about 5 KB/s of audio, 420 KB per 85 s) and AAC-LC 64 kbps m4a with faststart (Safari fallback; AAC overshoots, so use TP -2). Total for a 8 min article is about 2.5 MB opus.
6. Site: static `<audio>` plus the words JSON; no runtime service.

## What Andrew must listen to (about 4 minutes)
Open, in this order, in /Volumes/Projects/andrewgazelka/site/docs/upstream/tts/samples/:
1. qwen3tts_aiden.m4a (recommended) 2. kokoro.m4a (fast baseline) 3. /Volumes/Projects/tmp/tts/out/eleven/eleven_george.m4a (hosted ceiling; not in git).
Compare: the hook ("Not what it computes. When."), the emphasis on "Both of them!" and "Bookkeeping.", the pace over the long paragraph 3 and 4 (does it stay warm or turn monotone), any odd stress, and whether Aiden's voice is the one you want (alternatives: Ryan; other speakers via Qwen VoiceDesign or a cloned voice). Pick: is Qwen close enough to ElevenLabs to ship free and local, or do you want ElevenLabs at about $0.56 per article.

## Not tested / open
10-minute continuity (voice and style drift across 30+ chunks), seed reproducibility, Chatterbox/Orpheus/VibeVoice head to head, Google/Hume pricing, OpenAI gpt-4o-mini-tts (the OPENAI_API_KEY in the env points at OpenRouter, not OpenAI), and full MFA alignment. Scripts used are in scripts/ (paths hardcode /Volumes/Projects/tmp/tts).
