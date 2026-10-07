// Writes the say.json the TTS pipeline reads (scripts/film/narrate.py) from a film's script:
//   bun scripts/film/say.ts <slug> [out.json]
// Line ids are `scene/say` (the key align.json uses); `gap` is the authored silence before the line.
import fs from 'node:fs';
import { newFilmEngine, FILM_SRC } from './engine';

const slug = process.argv[2] ?? 'models';
const out = process.argv[3] ?? `/Volumes/Projects/tmp/film/say/${slug}.json`;
const e = newFilmEngine();
const r = e.inspect(fs.readFileSync(FILM_SRC(slug), 'utf8'));
if (!r.ok) throw new Error(r.error);
const [engine, speaker] = r.info.voice.id.split(':');
const lines = r.info.scenes.flatMap((s: any) =>
	s.says.filter((l: any) => l.spoken.trim()).map((l: any) => ({ id: l.key, scene: s.name, spoken: l.spoken, gap: Math.round(l.gap * 1000) / 1000 }))
);
const say = {
	slug,
	voice: {
		engine,
		model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
		rev: r.info.voice.rev,
		speaker,
		instruct: 'Warm, curious science-explainer narrator, like a documentary host. Natural pacing, leaning into key words, genuine wonder, slightly slower than conversation.'
	},
	pronounce: { Kleene: 'Klay-nee' },
	lines
};
fs.mkdirSync(out.replace(/\/[^/]*$/, ''), { recursive: true });
fs.writeFileSync(out, JSON.stringify(say, null, 1));
console.log(`${out}: ${lines.length} lines`);
