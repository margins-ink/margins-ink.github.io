"""Narration audio pipeline for the narrated films: local, offline, free.

    uv run --project scripts/film python scripts/film/narrate.py <say.json> \
        [--out static/film/<slug>] [--check] [--only id,id] [--force]

Env: UV_PROJECT_ENVIRONMENT=/Volumes/Projects/tmp/tts/film-venv keeps the venv out of the tree.

say.json:
  {"slug": "models",
   "voice": {"engine": "qwen3-tts-mlx", "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
             "rev": "<hf snapshot sha>", "speaker": "Aiden", "instruct": "<style>"},
   "pronounce": {"Kleene": "Klay-nee"},          # optional, TTS text only (alignment keeps the real word)
   "lines": [{"id": "s1_a", "scene": "cold_open", "spoken": "Here's a function. [pause] Next.", "gap": 0.7}, ...]}

`gap` is silence authored BEFORE the line; start(line) = end(previous line) + gap(line).
`[pause]` inside `spoken` is an extra 0.35 s of silence (the line is synthesised in chunks);
`*word*` marks are stripped (Qwen has no word emphasis) and never reach TTS or alignment.

Per line: key = sha256(model rev, speaker, instruct, TTS text, sampler params). A hit in
/Volumes/Projects/tmp/film-cache/<key>.wav is never regenerated (sampling is stochastic).
Clips are aligned with stable-ts (Whisper small.en, CPU) on their own text, laid on one timeline,
two-pass loudnormed (-16 LUFS), encoded to voice.<hash8>.opus (40k) and voice.<hash8>.m4a (AAC-LC 64k),
and described by align.json + report.json (all verification metrics) in --out.

--check: recompute the keys and the hash from say.json; exit 1 if align.json is stale (prints ids).
--only a,b: synthesise + align just those lines (prints their durations), write nothing; --force retakes them.
Exit codes: 0 ok, 1 stale (--check), 2 verification failed (outputs and report are still written).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

SR = 24000
PAUSE_S = 0.35
SPLIT_S = 0.15  # silence between auto-split chunks of one very long sentence group
TAIL_S = 0.25  # silence after the last line so a decoder never cuts it off
MAX_CHUNK_WORDS = 55  # about 21 s at 2.6 words/s, under the 25 s cap
LEAD_KEEP_S = 0.05  # model silence kept before the first sample above TRIM_AMP
TAIL_KEEP_S = 0.10
TRIM_AMP = 0.005
ONSET_DB = -40.0
SAMPLER = {"temperature": 0.9, "top_k": 50, "top_p": 1.0, "repetition_penalty": 1.05, "max_tokens": 2000, "lang": "english"}
CACHE_DIR = Path("/Volumes/Projects/tmp/film-cache")
WORK_DIR = Path("/Volumes/Projects/tmp/film/work")
SITE_ROOT = Path(__file__).resolve().parents[2]

ONSET_TOL = 0.150
OFFSET_TOL = 0.250
MIN_WORD = 0.040
END_SLACK = 0.020
DUR_TOL = 0.025
LUFS_TOL = 0.7


# ---------------------------------------------------------------- text

def clean_spoken(spoken: str) -> str:
    """Authored text with emphasis marks removed; [pause] kept."""
    return re.sub(r"\s+", " ", spoken.replace("*", "")).strip()


def pause_parts(spoken: str) -> list[str]:
    return [p.strip() for p in re.split(r"\[pause\]", clean_spoken(spoken)) if p.strip()]


def split_long(part: str) -> list[str]:
    """Pack sentences greedily into chunks of at most MAX_CHUNK_WORDS words."""
    sentences = re.split(r"(?<=[.!?])\s+", part)
    out: list[str] = []
    cur: list[str] = []
    n = 0
    for s in sentences:
        w = len(s.split())
        if cur and n + w > MAX_CHUNK_WORDS:
            out.append(" ".join(cur))
            cur, n = [], 0
        cur.append(s)
        n += w
    if cur:
        out.append(" ".join(cur))
    return out


def chunk_plan(spoken: str) -> list[tuple[str, float]]:
    """[(text, silence_before_seconds)] for a line."""
    plan: list[tuple[str, float]] = []
    for pi, part in enumerate(pause_parts(spoken)):
        for ci, chunk in enumerate(split_long(part)):
            plan.append((chunk, 0.0 if not plan else (PAUSE_S if ci == 0 else SPLIT_S)))
    return plan


def align_words_text(spoken: str) -> list[str]:
    return " ".join(pause_parts(spoken)).split()


def tts_text(chunk: str, pronounce: dict[str, str]) -> str:
    for k, v in pronounce.items():
        chunk = re.sub(rf"\b{re.escape(k)}\b", v, chunk)
    return chunk


# ---------------------------------------------------------------- keys

def sha(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()


def line_key(voice: dict, spoken: str, pronounce: dict[str, str]) -> str:
    tts = "\x1e".join(tts_text(c, pronounce) + f"|{s}" for c, s in chunk_plan(spoken))
    return sha(voice["rev"], voice["speaker"], voice["instruct"], tts, json.dumps(SAMPLER, sort_keys=True))


def file_hash(keys_and_gaps: list[tuple[str, float]]) -> str:
    mat = f"pause{PAUSE_S}|split{SPLIT_S}|tail{TAIL_S}|" + "".join(f"{k}:{g:.3f};" for k, g in keys_and_gaps)
    return hashlib.sha256(mat.encode()).hexdigest()[:8]


def compute_keys(say: dict) -> tuple[dict[str, str], str]:
    pron = say.get("pronounce", {})
    keys = {ln["id"]: line_key(say["voice"], ln["spoken"], pron) for ln in say["lines"]}
    h = file_hash([(keys[ln["id"]], float(ln.get("gap", 0.0))) for ln in say["lines"]])
    return keys, h


def check(say: dict, out: Path) -> list[str]:
    """Stale-audio gate: returns problems (empty = fresh)."""
    p = out / "align.json"
    if not p.exists():
        return [f"missing {p}"]
    al = json.loads(p.read_text())
    keys, h = compute_keys(say)
    bad = []
    for i, k in keys.items():
        if i not in al["lines"]:
            bad.append(f"{i}: not in align.json")
        elif al["lines"][i]["key"] != k:
            bad.append(f"{i}: key differs (text, voice or sampler changed)")
    bad += [f"{i}: in align.json but not in say.json" for i in al["lines"] if i not in keys]
    if al["voice"] != say["voice"]:
        bad.append("voice object differs")
    if not bad and al["hash"] != h:
        bad.append(f"hash differs ({al['hash']} vs {h}): gaps or order changed")
    return bad


# ---------------------------------------------------------------- audio helpers

def trim(a: np.ndarray) -> np.ndarray:
    idx = np.flatnonzero(np.abs(a) > TRIM_AMP)
    if len(idx) == 0:
        return a
    s = max(0, idx[0] - int(LEAD_KEEP_S * SR))
    e = min(len(a), idx[-1] + 1 + int(TAIL_KEEP_S * SR))
    return a[s:e]


def silence(sec: float) -> np.ndarray:
    return np.zeros(int(round(sec * SR)), dtype=np.float32)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=kw.pop("text", True), check=True, **kw)


def decode_f32(path: Path, sr: int = 48000) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ar", str(sr), "-ac", "1", "-"],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def measure_ebur128(path: Path) -> dict:
    r = subprocess.run(["ffmpeg", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, check=True)
    tail = r.stderr[r.stderr.rfind("Summary:"):]
    g = lambda pat: float(re.search(pat, tail).group(1))
    return {"lufs": g(r"I:\s+(-?[\d.]+) LUFS"), "lra": g(r"LRA:\s+(-?[\d.]+) LU"), "true_peak_dbtp": g(r"Peak:\s+(-?[\d.]+) dBFS")}


def loudnorm_two_pass(src: Path, dst: Path) -> dict:
    """Two-pass loudnorm of src to a 48 kHz float wav at -16 LUFS, true peak -2 dBTP (covers the -1.5 target and AAC overshoot)."""
    base = "loudnorm=I=-16:TP=-2:LRA=11"
    r = subprocess.run(["ffmpeg", "-nostats", "-i", str(src), "-af", base + ":print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, check=True)
    m = json.loads(re.findall(r"\{[^{}]*\}", r.stderr)[-1])
    f = (f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
         f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=48000")
    run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", f, "-ac", "1", "-c:a", "pcm_f32le", str(dst)])
    return m


def encode(master: Path, base: Path) -> None:
    run(["ffmpeg", "-v", "error", "-y", "-i", str(master), "-ac", "1", "-c:a", "libopus", "-b:a", "40k", "-application", "audio", str(base) + ".opus"])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(master), "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(base) + ".m4a"])


# ---------------------------------------------------------------- verification

def audible_bounds(a: np.ndarray, db: float = ONSET_DB) -> tuple[float, float]:
    idx = np.flatnonzero(np.abs(a) > 10 ** (db / 20))
    if len(idx) == 0:
        return 0.0, 0.0
    return idx[0] / SR, (idx[-1] + 1) / SR


def inner_silences(a: np.ndarray, min_len: float = 0.3, db: float = -50.0) -> int:
    """Count runs of 10 ms RMS frames below db, longer than min_len, between the first and last audible sample."""
    s, e = audible_bounds(a)
    seg = a[int(s * SR):int(e * SR)]
    n = len(seg) // 240
    if n == 0:
        return 0
    rms = np.sqrt((seg[: n * 240].reshape(n, 240) ** 2).mean(axis=1))
    low = rms < 10 ** (db / 20)
    count = run_len = 0
    for v in low:
        if v:
            run_len += 1
        else:
            count += run_len * 0.01 > min_len
            run_len = 0
    count += run_len * 0.01 > min_len
    return int(count)


def verify_line(lid: str, audio: np.ndarray, words: list[list], n_pauses: int) -> dict:
    """Metrics + failures for one clip. words are [w, start, end] relative to the clip."""
    dur = len(audio) / SR
    fails = []
    for i, (w, s, e) in enumerate(words):
        if e - s < MIN_WORD - 1e-9:
            fails.append(f"word {i} '{w}' is {1000 * (e - s):.0f} ms (< 40)")
        if i and s < words[i - 1][1] - 1e-3:
            fails.append(f"word {i} '{w}' starts {1000 * (words[i - 1][1] - s):.0f} ms before the previous ends")
    if words and words[-1][2] > dur + END_SLACK:
        fails.append(f"last word ends {words[-1][2]:.3f} > clip {dur:.3f}")
    first, last = audible_bounds(audio)
    on_err = abs(first - words[0][1]) if words else 0.0
    off_err = abs(last - words[-1][2]) if words else 0.0
    if on_err > ONSET_TOL:
        fails.append(f"onset error {1000 * on_err:.0f} ms (audio {first:.3f}, word1 {words[0][1]:.3f})")
    if off_err > OFFSET_TOL:
        fails.append(f"end error {1000 * off_err:.0f} ms (audio {last:.3f}, last word {words[-1][2]:.3f})")
    sil = inner_silences(audio)
    return {"id": lid, "dur": round(dur, 3), "words": len(words), "onset_err": round(on_err, 3), "end_err": round(off_err, 3),
            "repaired_min_dur_words": 0, "inner_silences": sil, "expected_pauses": n_pauses, "failures": fails}


def fix_min_dur(words: list[list]) -> tuple[list[list], int]:
    """Whisper frames are 20 ms, so a weak function word can come back 0 ms long. Give it MIN_WORD by moving its
    start back (into the gap before it, else stealing the tail of the previous word). Returns (words, repaired)."""
    w = [list(x) for x in words]
    fixed = set()
    for _ in range(3):
        changed = False
        for i, x in enumerate(w):
            if x[2] - x[1] < MIN_WORD - 1e-9:
                x[1] = round(max(0.0, x[2] - MIN_WORD), 3)
                if i and w[i - 1][2] > x[1]:
                    w[i - 1][2] = x[1]
                fixed.add(i)
                changed = True
        if not changed:
            break
    return w, len(fixed)


# ---------------------------------------------------------------- engines

class Engine:
    def synth(self, text: str, voice: dict, seed: int) -> np.ndarray:
        raise NotImplementedError

    def align(self, audio: np.ndarray, words: list[str]) -> list[list]:
        raise NotImplementedError


class QwenEngine(Engine):
    def __init__(self, voice: dict):
        from mlx_audio.tts.utils import load_model

        self.model = load_model(voice["model"])
        self.aligner = None

    def synth(self, text: str, voice: dict, seed: int) -> np.ndarray:
        import mlx.core as mx

        mx.random.seed(seed)
        parts = []
        for r in self.model.generate(text=text, voice=voice["speaker"], lang_code=SAMPLER["lang"], instruct=voice["instruct"],
                                     temperature=SAMPLER["temperature"], top_k=SAMPLER["top_k"], top_p=SAMPLER["top_p"],
                                     repetition_penalty=SAMPLER["repetition_penalty"], max_tokens=SAMPLER["max_tokens"]):
            assert r.sample_rate == SR, r.sample_rate
            parts.append(np.array(r.audio).reshape(-1).astype(np.float32))
        return np.concatenate(parts)

    def align(self, audio: np.ndarray, words: list[str]) -> list[list]:
        import stable_whisper

        if self.aligner is None:
            self.aligner = stable_whisper.load_model("small.en", device="cpu")
        from scipy.signal import resample_poly

        # stable-ts treats a bare array as 16 kHz; our clips are 24 kHz (bug found by the end-of-clip check: times were 1.5x)
        a16 = resample_poly(audio, 2, 3).astype(np.float32)
        r = self.aligner.align(a16, " ".join(words), language="en", verbose=None, suppress_silence=False,
                               suppress_word_ts=False, regroup=False)
        got = [[w.word.strip(), w.start, w.end] for s in r.segments for w in s.words]
        return got


def assert_snapshot(voice: dict) -> None:
    """mlx-audio 0.5.8 load_model takes no revision: it loads the HF cache's refs/main. Refuse to run on any other snapshot."""
    ref = Path.home() / ".cache/huggingface/hub" / ("models--" + voice["model"].replace("/", "--")) / "refs/main"
    got = ref.read_text().strip() if ref.exists() else "<not downloaded>"
    if got != voice["rev"]:
        raise SystemExit(f"model snapshot is {got}, say.json pins {voice['rev']}")


# ---------------------------------------------------------------- build

def prepare_line(ln: dict, say: dict, key: str, engine: Engine | None, force: bool, stats: dict) -> tuple[np.ndarray, list[list], dict]:
    """Synthesise (or load) one line; returns trimmed audio, clip-relative words, info."""
    voice, pron = say["voice"], say.get("pronounce", {})
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    wav, meta, alj = CACHE_DIR / f"{key}.wav", CACHE_DIR / f"{key}.meta.json", CACHE_DIR / f"{key}.align.json"
    import soundfile as sf

    if wav.exists() and not force:
        raw, sr = sf.read(wav, dtype="float32")
        assert sr == SR
        stats["hits"] += 1
    else:
        assert engine is not None
        t0 = time.time()
        pieces = []
        for ci, (chunk, sil) in enumerate(chunk_plan(ln["spoken"])):
            pieces.append(silence(sil))
            pieces.append(engine.synth(tts_text(chunk, pron), voice, int(sha(key, str(ci))[:8], 16)))
        raw = np.concatenate(pieces).astype(np.float32)
        took = time.time() - t0
        sf.write(wav, raw, SR, subtype="FLOAT")
        meta.write_text(json.dumps({"synth_s": took, "dur": len(raw) / SR}))
        alj.unlink(missing_ok=True)
        stats["synth_s"] += took
        stats["synth_audio_s"] += len(raw) / SR
        stats["misses"] += 1
    audio = trim(raw)
    words_text = align_words_text(ln["spoken"])
    if alj.exists():
        words = json.loads(alj.read_text())
    else:
        assert engine is not None, f"{ln['id']}: alignment needed but no engine"
        got = engine.align(audio, words_text)
        if [g[0] for g in got] != words_text:
            raise SystemExit(f"{ln['id']}: alignment words do not match the text\n  text: {words_text}\n  got:  {[g[0] for g in got]}")
        words = [[words_text[i], round(float(g[1]), 3), round(float(g[2]), 3)] for i, g in enumerate(got)]
        alj.write_text(json.dumps(words))
    m = json.loads(meta.read_text()) if meta.exists() else {}
    words, m["repaired_words"] = fix_min_dur(words)
    return audio, words, m


def build(say: dict, out: Path, engine: Engine | None, only: set[str] | None = None, force: bool = False,
          work: Path = WORK_DIR) -> int:
    keys, _ = compute_keys(say)
    stats = {"hits": 0, "misses": 0, "synth_s": 0.0, "synth_audio_s": 0.0}
    lines = say["lines"]
    if only is not None:
        for ln in lines:
            if ln["id"] in only:
                a, w, _ = prepare_line(ln, say, keys[ln["id"]], engine, force, stats)
                print(f"{ln['id']}: {len(a) / SR:.2f}s, {len(w)} words, key {keys[ln['id']][:8]}")
        return 0

    clips = []
    for ln in lines:
        a, w, m = prepare_line(ln, say, keys[ln["id"]], engine, False, stats)
        clips.append((ln, a, w, m))
        print(f"{ln['id']}: {len(a) / SR:.2f}s {len(w)} words", flush=True)

    # layout
    pos = 0.0
    pieces: list[np.ndarray] = []
    placed = {}
    vers = {}
    for ln, a, w, m in clips:
        start_idx = int(round((pos + float(ln.get("gap", 0.0))) * SR))
        cur = sum(len(p) for p in pieces)
        pieces.append(np.zeros(start_idx - cur, dtype=np.float32))
        pieces.append(a)
        start = start_idx / SR
        placed[ln["id"]] = {"key": keys[ln["id"]], "start": round(start, 3), "dur": round(len(a) / SR, 3),
                            "words": [[x, round(start + s, 3), round(start + e, 3)] for x, s, e in w]}
        pos = (start_idx + len(a)) / SR
        vers[ln["id"]] = verify_line(ln["id"], a, w, len(pause_parts(ln["spoken"])) - 1)
        vers[ln["id"]]["repaired_min_dur_words"] = m["repaired_words"]
    pieces.append(silence(TAIL_S))
    timeline = np.concatenate(pieces)
    total = len(timeline) / SR
    h = file_hash([(keys[ln["id"]], float(ln.get("gap", 0.0))) for ln in lines])

    work.mkdir(parents=True, exist_ok=True)
    import soundfile as sf

    raw_wav, master = work / f"{say['slug']}.timeline.wav", work / f"{say['slug']}.master.wav"
    sf.write(raw_wav, timeline, SR, subtype="FLOAT")
    pre = measure_ebur128(raw_wav)
    loudnorm_two_pass(raw_wav, master)

    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("voice.*"):
        old.unlink()
    base = out / f"voice.{h}"
    encode(master, base)

    fails = [f"{v['id']}: {f}" for v in vers.values() for f in v["failures"]]
    final = {}
    for ext in ("opus", "m4a"):
        p = Path(f"{base}.{ext}")
        dec = decode_f32(p)
        d = len(dec) / 48000
        met = measure_ebur128(p)
        peak = float(np.abs(dec).max())
        final[ext] = {"bytes": p.stat().st_size, "decoded_dur": round(d, 3), "dur_err": round(abs(d - total), 3), "sample_peak": round(peak, 4),
                      "clipped_samples": int((np.abs(dec) >= 0.999).sum()), **met}
        if abs(d - total) > DUR_TOL:
            fails.append(f"{ext}: decoded duration {d:.3f} vs timeline {total:.3f}")
        if abs(met["lufs"] + 16) > LUFS_TOL:
            fails.append(f"{ext}: integrated {met['lufs']} LUFS outside -16 +-{LUFS_TOL}")
        if final[ext]["clipped_samples"]:
            fails.append(f"{ext}: {final[ext]['clipped_samples']} clipped samples")
        if met["true_peak_dbtp"] > -1.0:
            fails.append(f"{ext}: true peak {met['true_peak_dbtp']} dBTP > -1")

    align = {"voice": say["voice"], "hash": h, "total": round(total, 3),
             "files": {"opus": f"voice.{h}.opus", "m4a": f"voice.{h}.m4a"}, "lines": placed}
    (out / "align.json").write_text(json.dumps(align, separators=(",", ":")))
    rtf_all = [m["synth_s"] / m["dur"] for _, _, _, m in clips if m.get("dur")]
    report = {
        "hash": h, "total": round(total, 3), "tail_s": TAIL_S, "pause_s": PAUSE_S, "words": sum(v["words"] for v in vers.values()),
        "synth": {"lines_synthesised_now": stats["misses"], "cache_hits": stats["hits"],
                  "rtf_this_run": round(stats["synth_s"] / stats["synth_audio_s"], 3) if stats["synth_audio_s"] else None,
                  "rtf_all_lines_from_cache_meta": round(sum(m["synth_s"] for _, _, _, m in clips if m.get("dur")) / sum(m["dur"] for _, _, _, m in clips if m.get("dur")), 3) if rtf_all else None},
        "loudness_pre_norm": pre, "final": final,
        "onset_err_max": max((v["onset_err"] for v in vers.values()), default=0), "end_err_max": max((v["end_err"] for v in vers.values()), default=0),
        "lines_over_onset_tol": [v["id"] for v in vers.values() if v["onset_err"] > ONSET_TOL],
        "lines_over_end_tol": [v["id"] for v in vers.values() if v["end_err"] > OFFSET_TOL],
        "inner_silences_unexpected": {v["id"]: v["inner_silences"] - v["expected_pauses"] for v in vers.values() if v["inner_silences"] > v["expected_pauses"]},
        "repaired_min_dur_words_total": sum(v["repaired_min_dur_words"] for v in vers.values()),
        "failures": fails, "lines": vers,
    }
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(f"total {total:.2f}s hash {h}; opus {final['opus']['lufs']} LUFS tp {final['opus']['true_peak_dbtp']}; "
          f"m4a {final['m4a']['lufs']} LUFS tp {final['m4a']['true_peak_dbtp']}; onset max {report['onset_err_max']}s; {len(fails)} failures")
    for f in fails:
        print("FAIL", f)
    return 2 if fails else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("say")
    ap.add_argument("--out")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    say = json.loads(Path(a.say).read_text())
    out = Path(a.out) if a.out else SITE_ROOT / "static" / "film" / say["slug"]
    if a.check:
        bad = check(say, out)
        for b in bad:
            print("STALE", b)
        print("fresh" if not bad else f"{len(bad)} stale")
        sys.exit(1 if bad else 0)
    assert_snapshot(say["voice"])
    only = set(a.only.split(",")) if a.only else None
    sys.exit(build(say, out, QwenEngine(say["voice"]), only=only, force=a.force and only is not None))


if __name__ == "__main__":
    main()
