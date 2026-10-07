// The narrated film: transport and gates (pure), the film engine in world.wasm (seek equals play, golden timeline, lint), the captions against the
// voice file's alignment, and planted-bug controls proving the sync check can fail. Runs the wasm from disk through scripts/film/engine.ts.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newFilmEngine, FILM_SRC } from '../../../scripts/film/engine';
import type { FilmInfo } from './abi';
import { activeWord, advanceTo, captionPage, gatesOf, leaveGate, newTransport, sayAt, seekTo, stepTransport, wrapWords, type TransportEvent } from './core';

const SRC = fs.readFileSync(FILM_SRC('models'), 'utf8');
const ALIGN_PATH = path.resolve(import.meta.dir, '../../../static/film/models/align.json');
const GOLDEN = path.resolve(import.meta.dir, '../../../tests/golden/models.film.json');

const engine = () => {
	const e = newFilmEngine();
	const err = e.load(SRC);
	if (err) throw new Error(err);
	return e;
};
const sha = (b: Float32Array, n = b.length) => createHash('sha1').update(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4))).digest('hex').slice(0, 12);
const sig = (f: { count: number; items: Float32Array; meta: Float32Array }) => `${f.count}:${sha(f.items, f.count * 8)}:${sha(f.meta, 8 + 8 * (f.meta[6] | 0))}`;

describe('transport', () => {
	const info = engine().info() as FilmInfo;
	const gates = gatesOf(info);
	const total = info.total;

	test('the film has gates and they are ordered', () => {
		expect(gates.length).toBe(6);
		for (let i = 1; i < gates.length; i++) expect(gates[i].t).toBeGreaterThan(gates[i - 1].t);
	});

	test('the clock stops at a gate, holds it, and jumps over the held silence', () => {
		const tr = newTransport();
		tr.playing = true;
		const ev: TransportEvent[] = [];
		const g = gates[0];
		advanceTo(tr, gates, g.t + 5, total, ev);
		expect(tr.t).toBe(g.t);
		expect(tr.gate?.id).toBe(g.id);
		expect(ev.map((e) => e.kind)).toEqual(['enter']);
		// held: the wall clock runs, the film does not
		stepTransport(tr, gates, total, g.hold / 2, null, ev);
		expect(tr.t).toBe(g.t);
		stepTransport(tr, gates, total, g.hold, null, ev);
		expect(tr.gate).toBeNull();
		expect(tr.t).toBeCloseTo(g.t + g.hold, 6);
		expect(ev.map((e) => e.kind)).toEqual(['enter', 'leave']);
		// an early Continue lands at the same place
		const t2 = newTransport();
		t2.playing = true;
		advanceTo(t2, gates, g.t + 1, total, []);
		leaveGate(t2, []);
		expect(t2.t).toBeCloseTo(g.t + g.hold, 6);
	});

	test('seeking past a gate passes it, seeking inside its hold passes it, seeking before keeps it', () => {
		const tr = newTransport();
		const g = gates[1];
		seekTo(tr, gates, g.t + 1, total);
		expect(tr.passed.has(g.id)).toBe(true);
		expect(tr.gate).toBeNull();
		seekTo(tr, gates, g.t - 1, total);
		expect(tr.passed.has(g.id)).toBe(false);
		seekTo(tr, gates, total + 50, total);
		expect(tr.t).toBe(total);
		expect(gates.every((x) => tr.passed.has(x.id))).toBe(true);
	});

	test('slaved to the audio clock the film still stops at gates, and the end stops playback', () => {
		const tr = newTransport();
		tr.playing = true;
		const ev: TransportEvent[] = [];
		stepTransport(tr, gates, total, 0.016, gates[0].t + 0.2, ev);
		expect(tr.gate?.id).toBe(gates[0].id);
		const t3 = newTransport();
		seekTo(t3, gates, total - 0.01, total);
		t3.playing = true;
		stepTransport(t3, gates, total, 0.05, null, ev);
		expect(t3.ended).toBe(true);
		expect(t3.playing).toBe(false);
	});
});

describe('film engine: seek equals play', () => {
	test('the stage at time t depends on t only (forward, reverse and repeat orders agree)', () => {
		const a = engine(), b = engine();
		const total = (a.info() as FilmInfo).total;
		const ts = Array.from({ length: 40 }, (_, i) => (total * i) / 39 + 0.137);
		const fwd = ts.map((t) => { return sig(a.pack(t)); });
		const rev = [...ts].reverse().map((t) => { return sig(b.pack(t)); }).reverse();
		expect(rev).toEqual(fwd);
		const again = ts.map((t) => { return sig(a.pack(t)); });
		expect(again).toEqual(fwd);
	});

	test('a 60 fps play of one scene matches direct seeks at the same times', () => {
		const e = engine();
		const info = e.info() as FilmInfo;
		const sc = info.scenes[3];
		const tr = newTransport();
		seekTo(tr, gatesOf(info), sc.start + 0.01, info.total);
		const played: string[] = [], direct: string[] = [];
		const ts: number[] = [];
		for (let i = 0; i < 90; i++) { tr.t += 1 / 60; ts.push(tr.t); const f = e.pack(tr.t); played.push(sig(f)); }
		const fresh = engine();
		for (const t of ts.reverse()) direct.push(sig(fresh.pack(t)));
		expect(direct.reverse()).toEqual(played);
	});

	test('draw list stays within the 400 item cap in every sampled frame', () => {
		const e = engine();
		const total = (e.info() as FilmInfo).total;
		for (let i = 0; i <= 120; i++) expect(e.pack((total * i) / 120).count).toBeLessThanOrEqual(400);
	});
});

describe('film engine: golden timeline (estimate, no voice file)', () => {
	test('scene bounds, gates and line times match tests/golden/models.film.json', () => {
		const r = newFilmEngine().inspect(SRC);
		if (!r.ok) throw new Error(r.error);
		const g = {
			total: +r.info.total.toFixed(2),
			scenes: r.info.scenes.map((s) => ({
				name: s.name, start: +s.start.toFixed(2), end: +s.end.toFixed(2), says: s.says.map((q) => [q.key, +q.start.toFixed(2), +q.dur.toFixed(2)]),
				gates: s.gates.map((q) => [+q.t.toFixed(2), q.hold]), mounts: s.mounts.map((m) => m.id), placeholders: s.placeholders
			}))
		};
		if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n');
		expect(g).toEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
	});
});

describe('film lint (fail closed, the error names the entity)', () => {
	const head = 'm : Film, Narrator {\n  Title: {"x"}\n  s1 : Scene {\n    Heading: {"h"}\n    Still: {5}\n';
	const line = 'l1 : CaptionLine { Text: {"one two three"} }\n p : Plate { Pos: {1,1} Size: {2,2} Ink: {"ink"} }\n';
	const bad: Record<string, [string, RegExp]> = {
		'a word pin past the last word': [`${line} b : Beat { Fade: {1}\n (On, p)\n (Pin, l1)\n Word: {9, 0} }`, /b: word 9 is past the last word \(3\) of l1/],
		'an untweenable path': [`${line} b : Beat { Tween: {"Nope.x", 1, 1, ""}\n (On, p)\n (Pin, l1)\n Word: {0, 0} }`, /Tween path "Nope.x" is not tweenable/],
		'a mount without a dock': ['l1 : CaptionLine { Text: {"one two"} }\n m1 : Prop { Mount: {"models/x"} }', /m1: a Mount needs a Dock/],
		'an unknown tone': ['l1 : CaptionLine { Text: {"a b"} }\n p : Plate { Pos: {1,1} Size: {2,2} Ink: {"nope"} }', /Ink \{"nope"\} is not a palette tone/],
		'an unknown status': ['l1 : CaptionLine { Text: {"a b"}\n Status: {"final"} }', /Status \{"final"\} is not draft approved voiced/],
		'a beat without a time': [`${line} b : Beat { Fade: {1}\n (On, p) }`, /b: a beat needs a time/]
	};
	const run = (body: string) => newFilmEngine().inspect(`${head}${body}\n  }\n}`);
	test('a good script passes', () => {
		expect(run(`${line} b : Beat { Fade: {1}\n (On, p)\n (Pin, l1)\n Word: {1, 0} }`).ok).toBe(true);
	});
	for (const [name, [body, re]] of Object.entries(bad)) {
		test(`rejects ${name}`, () => {
			const r = run(body);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(re);
		});
	}
});

// ---- captions against the voice file ----

interface Align { total: number; lines: Record<string, { start: number; dur: number; words: [string, number, number][] }> }
const align: Align | null = fs.existsSync(ALIGN_PATH) ? (JSON.parse(fs.readFileSync(ALIGN_PATH, 'utf8')) as Align) : null;

/** problems of a film laid on a voice alignment: line starts, word order and containment, coverage. Empty = in sync. */
export function syncProblems(info: FilmInfo, a: Align, tol = 0.02): string[] {
	const out: string[] = [];
	const keys = new Set<string>();
	for (const sc of info.scenes) {
		for (const s of sc.says) {
			if (!s.spoken.trim()) continue;
			keys.add(s.key);
			const l = a.lines[s.key];
			if (!l) { out.push(`${s.key}: no voice line`); continue; }
			if (Math.abs(s.start - l.start) > tol) out.push(`${s.key}: starts at ${s.start.toFixed(3)} but the voice at ${l.start.toFixed(3)}`);
			if (Math.abs(s.dur - l.dur) > tol) out.push(`${s.key}: lasts ${s.dur.toFixed(3)} but the voice ${l.dur.toFixed(3)}`);
			let prev = s.start - tol;
			s.cw.forEach(([w0, w1], i) => {
				if (w0 < prev - tol) out.push(`${s.key}: word ${i} starts before the previous one`);
				if (w1 < w0) out.push(`${s.key}: word ${i} ends before it starts`);
				if (w0 < s.start - tol || w1 > s.start + s.dur + tol) out.push(`${s.key}: word ${i} leaves its line`);
				prev = w0;
			});
		}
	}
	for (const k of Object.keys(a.lines)) if (!keys.has(k)) out.push(`${k}: voice line with no caption`);
	return out;
}

describe('captions against the voice file', () => {
	test('the voice file exists for the models film', () => { expect(align).not.toBeNull(); });
	const withVoice = () => {
		const e = engine();
		expect(e.align(JSON.stringify(align))).toBeNull();
		return e;
	};
	test('every caption line starts and lasts as the voice does, words ordered inside their line', () => {
		if (!align) return;
		const e = withVoice();
		const info = e.info() as FilmInfo;
		expect(syncProblems(info, align)).toEqual([]);
		expect(info.scenes.flatMap((s) => s.says).every((s) => s.aligned || !s.spoken.trim())).toBe(true);
		// the film is at least as long as the voice (it ends after the last scene's tail)
		expect(info.total).toBeGreaterThanOrEqual(align.total - 0.05);
	});
	test('line starts are the previous end plus the authored gap (the gate holds live in those gaps)', () => {
		if (!align) return;
		const info = withVoice().info() as FilmInfo;
		let prev = 0;
		for (const s of info.scenes.flatMap((x) => x.says)) {
			expect(s.start - prev).toBeCloseTo(s.gap, 1);
			prev = s.start + s.dur;
		}
	});
	test('planted bug: a voice line shifted 2 s is caught', () => {
		if (!align) return;
		const bad: Align = JSON.parse(JSON.stringify(align));
		const k = Object.keys(bad.lines)[5];
		bad.lines[k].start += 2;
		bad.lines[k].words = bad.lines[k].words.map(([w, s, e]) => [w, s + 2, e + 2]);
		// the film timeline follows the voice file, so the planted file is checked against the real one
		const info = withVoice().info() as FilmInfo;
		const problems = syncProblems(info, bad);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain(k);
	});
	test('planted bug: a dropped voice line and an unknown line are both caught', () => {
		if (!align) return;
		const info = withVoice().info() as FilmInfo;
		const bad: Align = JSON.parse(JSON.stringify(align));
		const k = Object.keys(bad.lines)[3];
		bad.lines['ghost/line'] = bad.lines[k];
		delete bad.lines[k];
		const p = syncProblems(info, bad);
		expect(p.some((x) => x.includes('no voice line'))).toBe(true);
		expect(p.some((x) => x.includes('voice line with no caption'))).toBe(true);
	});
	test('word highlight tracks the voice: at each word start the active word is that word', () => {
		if (!align) return;
		const info = withVoice().info() as FilmInfo;
		for (const s of info.scenes.flatMap((x) => x.says)) {
			s.cw.forEach((w, i) => {
				if (i + 1 < s.cw.length && s.cw[i + 1][0] <= w[0] + 1e-6) return; // zero-length repairs share a start
				expect(activeWord(s.cw, w[0] + 1e-4)).toBeGreaterThanOrEqual(i);
			});
		}
	});
	test('the film plays on the reading-speed estimate when the voice file is cleared', () => {
		const e = withVoice();
		const withV = (e.info() as FilmInfo).total;
		e.alignClear();
		const est = e.info() as FilmInfo;
		expect(est.scenes.flatMap((s) => s.says).some((s) => s.aligned)).toBe(false);
		expect(Math.abs(est.total - withV)).toBeGreaterThan(0.01);
	});
});

describe('caption layout', () => {
	test('wrapWords breaks at the width and keeps every word once', () => {
		const lines = wrapWords([30, 30, 30, 30, 30], 5, 100);
		expect(lines).toEqual([[0, 1, 2], [3, 4]]);
		expect(wrapWords([300], 5, 100)).toEqual([[0]]);
	});
	test('activeWord, captionPage and sayAt', () => {
		const cw: [number, number][] = [[1, 1.5], [1.5, 2], [2.2, 3]];
		expect(activeWord(cw, 0.5)).toBe(-1);
		expect(activeWord(cw, 1.6)).toBe(1);
		expect(activeWord(cw, 2.1)).toBe(1);
		expect(activeWord(cw, 9)).toBe(2);
		expect(captionPage([[0, 1], [2, 3], [4, 5]], 4, 2)).toBe(2);
		expect(captionPage([[0, 1], [2, 3], [4, 5]], 1, 2)).toBe(0);
		const says = [{ start: 1, dur: 2 }, { start: 5, dur: 1 }];
		expect(sayAt(says, 0.2)).toBe(-1);
		expect(sayAt(says, 2)).toBe(0);
		expect(sayAt(says, 3.3)).toBe(0);
		expect(sayAt(says, 4.5)).toBe(-1);
		expect(sayAt(says, 5.5)).toBe(1);
	});
});
