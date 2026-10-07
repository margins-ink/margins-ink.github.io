# Sources (fetched 2026-10-07 UTC, by agent; licence rows read from model-card metadata + repo LICENSE head, status "read" unless noted)

| Item | URL | Rev / version | Licence | Status |
|---|---|---|---|---|
| Qwen3-TTS-12Hz-1.7B-CustomVoice | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | HF sha 0c0e3051f131929182e2c023b9537f8b1c68adfe | apache-2.0 (card metadata); QwenLM/Qwen3-TTS LICENSE = Apache 2.0 text | read |
| MLX port used | https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 | snapshot 52f4770fd9726457eae3d3b6aa92047a25a10776 (fetched 2026-10-07 UTC) | apache-2.0: README front matter at that snapshot says `license: apache-2.0`; the repo has no LICENSE file (file list read via HF API); converted from Qwen/...-CustomVoice, which is Apache 2.0 | read (`licences/mlx-community-port.README.md`) |
| Qwen3-TTS code (licence text) | https://github.com/QwenLM/Qwen3-TTS | commit 022e286b98fbec7e1e916cb940cdf532cd9f488e (HEAD 2026-10-07; repo has no tags) | Apache License 2.0, full text, sha256 a44a6081c73a... | read (`licences/QwenLM-Qwen3-TTS.LICENSE`) |
| Qwen3-TTS weights (model card) | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | sha 0c0e3051f131929182e2c023b9537f8b1c68adfe, fetched 2026-10-07 UTC | card front matter `license: apache-2.0`; the HF repo has no separate LICENSE file; the 57 KB card has no other licence clause (only line 2 matches "licen") | read (`licences/Qwen-model-card.README.md`) |
| Kokoro-82M | https://huggingface.co/hexgrad/Kokoro-82M ; MLX: mlx-community/Kokoro-82M-bf16 | sha f3ff3571791e39611d31c381e3a41a3af07b4987 | apache-2.0 (metadata). misaki pulls espeak-ng (GPL-3, runtime phonemizer fallback) | read / espeak licence from memory (unverified) |
| mlx-audio | https://github.com/Blaizzy/mlx-audio (PyPI) | 0.5.8 = tag v0.5.8 commit 70f4add32911bab6f869b824864ad9f1e24dcb97, fetched 2026-10-07 UTC | MIT License (c) 2024 Prince Canuma, full text | read (`licences/mlx-audio-v0.5.8.LICENSE`) |
| stable-ts (forced alignment) | https://github.com/jianfch/stable-ts (PyPI) | 2.19.1; LICENSE read at commit e312072cc024ae9fceb25b057d7d18524873a02b (HEAD 2026-10-07); PyPI metadata also MIT | MIT License (c) 2022 jian, full text | read (`licences/stable-ts.LICENSE`) |
| Whisper code and small.en weights | https://github.com/openai/whisper | commit 86098128c0b4f24f0e2aa2994de830614b474227 (HEAD 2026-10-07); weights small.en.pt via openai-whisper 20250625 | MIT License (c) 2022 OpenAI; README line 160: "Whisper's code and model weights are released under the MIT License" | read (`licences/openai-whisper.LICENSE`; README sentence quoted here) |
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
