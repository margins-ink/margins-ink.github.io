"""Fast tests (no model): a fake engine that speaks sine bursts. Run:
  UV_PROJECT_ENVIRONMENT=/Volumes/Projects/tmp/tts/film-venv uv run --project scripts/film pytest scripts/film/test_narrate.py
Planted-bug controls: shifted word times fail the onset check, an edited line fails --check, the clean twin passes.
"""

import copy
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import narrate as n  # noqa: E402

WORD, GAP, LEAD = 0.25, 0.08, 0.06


class FakeEngine(n.Engine):
    """Each word is a 0.25 s 440 Hz burst, 80 ms apart; align finds the bursts by energy."""

    def synth(self, text, voice, seed):
        parts = [n.silence(LEAD)]
        t = np.arange(int(WORD * n.SR)) / n.SR
        for _ in text.split():
            burst = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
            burst[:120] *= np.linspace(0, 1, 120, dtype=np.float32)
            burst[-120:] *= np.linspace(1, 0, 120, dtype=np.float32)
            parts += [burst, n.silence(GAP)]
        return np.concatenate(parts)

    def align(self, audio, words):
        on = np.abs(audio) > 0.05
        edges = np.flatnonzero(np.diff(np.r_[0, on.astype(int), 0]))
        starts, ends = edges[0::2], edges[1::2]
        # merge bursts split by a zero crossing inside a burst: gaps shorter than 20 ms
        segs = []
        for s, e in zip(starts, ends):
            if segs and s - segs[-1][1] < 0.02 * n.SR:
                segs[-1][1] = e
            else:
                segs.append([s, e])
        got = [[words[i] if i < len(words) else "?", s / n.SR, e / n.SR] for i, (s, e) in enumerate(segs)]
        return got if len(segs) == len(words) else got[:1] + [["?", 0, 0]]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(n, "CACHE_DIR", tmp_path / "cache")
    say = {"slug": "t", "voice": {"engine": "fake", "model": "m", "rev": "r1", "speaker": "S", "instruct": "calm"},
           "lines": [{"id": "a", "scene": "x", "spoken": "Here is a *function* [pause] and more words", "gap": 0.5},
                     {"id": "b", "scene": "x", "spoken": "A second line of speech today", "gap": 0.7},
                     {"id": "c", "scene": "y", "spoken": "Third line closes it out", "gap": 1.2}]}
    return say, tmp_path / "out", tmp_path / "work"


def test_clean_twin_passes_and_check_fresh(env):
    say, out, work = env
    rc = n.build(say, out, FakeEngine(), work=work)
    report = json.loads((out / "report.json").read_text())
    assert rc == 0, report["failures"]
    al = json.loads((out / "align.json").read_text())
    assert al["lines"]["a"]["start"] == pytest.approx(0.5, abs=0.001)
    assert al["lines"]["b"]["start"] == pytest.approx(al["lines"]["a"]["start"] + al["lines"]["a"]["dur"] + 0.7, abs=0.002)
    assert (out / al["files"]["opus"]).exists() and (out / al["files"]["m4a"]).exists()
    assert report["onset_err_max"] < 0.05
    assert n.check(say, out) == []
    # emphasis marks never reach alignment; a [pause] gap is inside line a
    assert [w[0] for w in al["lines"]["a"]["words"]] == "Here is a function and more words".split()
    # a rebuild is all cache hits and byte-identical timings
    n.build(say, out, FakeEngine(), work=work)
    assert json.loads((out / "report.json").read_text())["synth"]["cache_hits"] == 3


def test_planted_shifted_words_fail_onset_check(env):
    say, out, work = env
    n.build(say, out, FakeEngine(), work=work)
    clean = FakeEngine()
    audio = n.trim(clean.synth("one two three", say["voice"], 0))
    words = clean.align(audio, ["one", "two", "three"])
    assert n.verify_line("t", audio, words, 0)["failures"] == []
    shifted = [[w, s + 0.3, e + 0.3] for w, s, e in words]
    v = n.verify_line("t", audio, shifted, 0)
    assert any("onset error" in f for f in v["failures"]), v


def test_planted_edit_without_regenerating_fails_check(env):
    say, out, work = env
    n.build(say, out, FakeEngine(), work=work)
    edited = copy.deepcopy(say)
    edited["lines"][1]["spoken"] = "A second line of speech tomorrow"
    bad = n.check(edited, out)
    assert len(bad) == 1 and bad[0].startswith("b:")
    gap = copy.deepcopy(say)
    gap["lines"][2]["gap"] = 2.0
    assert any("hash differs" in b for b in n.check(gap, out))
    voice = copy.deepcopy(say)
    voice["voice"]["instruct"] = "excited"
    assert n.check(voice, out)


def test_unmatched_alignment_fails_with_line_id(env):
    say, out, work = env

    class Bad(FakeEngine):
        def align(self, audio, words):
            return super().align(audio, words)[:-1]

    with pytest.raises(SystemExit) as e:
        n.build(say, out, Bad(), work=work)
    assert "a:" in str(e.value)


def test_zero_length_word_is_repaired_to_40ms():
    fixed, n_fixed = n.fix_min_dur([["The", 0.14, 0.14], ["answer", 0.14, 0.38], ["x", 0.38, 0.38]])
    assert n_fixed == 2
    assert all(e - s >= 0.04 - 1e-9 for _, s, e in fixed)
    assert all(fixed[i][2] <= fixed[i + 1][1] + 1e-9 for i in range(len(fixed) - 1))
