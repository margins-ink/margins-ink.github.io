# Sources (fetched 2026-10-07 UTC, by agent; licence rows read from model-card metadata + repo LICENSE head, status "read" unless noted)

| Item | URL | Rev / version | Licence | Status |
|---|---|---|---|---|
| Qwen3-TTS-12Hz-1.7B-CustomVoice | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | HF sha 0c0e3051f131929182e2c023b9537f8b1c68adfe | apache-2.0 (card metadata); QwenLM/Qwen3-TTS LICENSE = Apache 2.0 text | read |
| MLX port used | https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 | snapshot 52f4770fd9726457eae3d3b6aa92047a25a10776 | follows base (Apache 2.0) | metadata read, port licence text not read |
| Kokoro-82M | https://huggingface.co/hexgrad/Kokoro-82M ; MLX: mlx-community/Kokoro-82M-bf16 | sha f3ff3571791e39611d31c381e3a41a3af07b4987 | apache-2.0 (metadata). misaki pulls espeak-ng (GPL-3, runtime phonemizer fallback) | read / espeak licence from memory (unverified) |
| mlx-audio | https://github.com/Blaizzy/mlx-audio (PyPI) | 0.5.8 | PyPI licence field empty; repo licence not read | unverified |
| stable-ts (forced alignment) | PyPI stable-ts | 2.19.1 | MIT (PyPI) | read |
| Whisper small.en weights | openai/whisper | via stable-ts | MIT | reported |
| mlx-whisper | PyPI | 0.4.3 | MIT (PyPI) | read, not used for result |
| Chatterbox (not run) | https://huggingface.co/ResembleAI/chatterbox | sha 5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18 | mit (metadata) | read |
| Orpheus 3B ft (not run) | canopylabs/orpheus-3b-0.1-ft | 4206a56e | apache-2.0 (metadata) | read |
| Dia 1.6B-0626 (not run) | nari-labs/Dia-1.6B-0626 | ef2795fc | apache-2.0 | read |
| Sesame CSM-1B (not run) | sesame/csm-1b | c92a71e1 | apache-2.0 | read |
| VibeVoice-1.5B (not run) | microsoft/VibeVoice-1.5B | c00898d2 | mit (metadata; card carries misuse/research-use caveats, not read in full) | partly read |
| Fish Audio S2 Pro (REJECT) | fishaudio/s2-pro | 1de9996b | fish-audio-research-license ("other"; research licence, commercial needs separate deal) | metadata read, text not read |
| F5-TTS weights (REJECT) | SWivid/F5-TTS | 84e5a410 | cc-by-nc-4.0 | read |
| ElevenLabs API pricing | https://elevenlabs.io/pricing/api | 2026-10-07 | v3 $0.08/1k chars; Flash $0.04/1k | read (page); a 2026-06 third-party page says $0.10 |
| ElevenLabs terms | https://elevenlabs.io/terms-of-use | 2026-10-07 | Free plan non-commercial only; paid keeps output rights; voice cloning needs your own voice or authorization | read (summary by fetch tool) |
| OpenAI pricing | https://developers.openai.com/api/docs/pricing | 2026-10-07 | gpt-4o-mini-tts $0.60/1M text tok + $12/1M audio tok (about $0.015/min, third-party estimate); tts-1 $15/1M chars; tts-1-hd $30/1M | read / estimate reported |
| Cartesia pricing | https://cartesia.ai/pricing | 2026-10-07 | 1 credit = 1 char (~750-800 credits/min); Pro $5/100k credits; commercial from Pro; instant clone Pro+ | read |
| Google Cloud TTS, Hume Octave | cloud.google.com/text-to-speech/pricing, hume.ai/pricing | | prices not extracted | unverified |

Question answered: which TTS gives expressive long-form explainer narration, generated at build time, with word timings, on this Mac.
Environment: M5 Max, 128 GB, background load average 14-24 during runs (shared machine, 17 sessions).
Samples are model output (Apache-2.0 models). The ElevenLabs sample is NOT stored here (free/paid tier of the key unknown; output licence depends on plan); it is at /Volumes/Projects/tmp/tts/out/eleven/.
