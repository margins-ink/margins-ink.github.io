// Fetch one article for a width class: the index (cached), the class bin and the shared fonts bin.
import { unpackReading, type ReadingModel } from '../magazine/format';
import { PAL2 } from '../magazine/format';

export const CLASS_NAMES = ['wide', 'mid', 'narrow'] as const;

interface IndexImage { id: number; tiers: { w: number; h: number; url: string }[] }
interface IndexBin { file: string; bytes?: number; brotli?: number }
interface IndexArticle {
	slug: string; title: string; dek?: string; date?: string; hidden?: boolean;
	fullWords?: number; briefWords?: number; wordsFull?: number; wordsBrief?: number; opensFull?: boolean; wdth?: number; wght?: number; refs?: { id: string; title: string; url: string }[]; links?: Record<string, { t: string; d: string }>;
	bins: Partial<Record<(typeof CLASS_NAMES)[number], IndexBin>>;
}
export interface MagazineIndex { version: number; fonts: string; articles: IndexArticle[]; images: IndexImage[] }

export interface ArticleMeta { title: string; dek: string; date: string; wordsBrief: number; wordsFull: number; opensFull: boolean; wdth: number; wght: number; refs: { id: string; title: string; url: string }[]; /** baked link previews: href -> title, description (scripts/magazine/linkmeta.ts) */ links: Record<string, { t: string; d: string }> }
export interface LoadedArticle {
	slug: string;
	widthClass: number;
	model: ReadingModel;
	/** fonts.bin bytes for the page pass */
	fonts: Uint8Array;
	/** per image id, the url the page pass fetches (the largest tier up to IMAGE_MAX_W) */
	imageUrls: string[];
	meta: ArticleMeta;
}

export const IMAGE_MAX_W = 2048;

let indexP: Promise<MagazineIndex> | null = null;
let fontsP: { file: string; p: Promise<Uint8Array> } | null = null;
const bins = new Map<string, Promise<Uint8Array>>();

async function fetchBytes(file: string): Promise<Uint8Array> {
	const r = await fetch(`/magazine/${file}`);
	if (!r.ok) throw new Error(`magazine/${file}: ${r.status}`);
	return new Uint8Array(await r.arrayBuffer());
}

export function loadIndex(): Promise<MagazineIndex> {
	return (indexP ??= fetch('/magazine/index.json').then((r) => {
		if (!r.ok) throw new Error(`magazine/index.json: ${r.status}`);
		return r.json() as Promise<MagazineIndex>;
	}).catch((e) => { indexP = null; throw e; }));
}

/** The class bin, or the nearest class that exists (a class missing from the index falls back toward the narrower, then the wider). */
export function pickBin(a: IndexArticle, widthClass: number): { name: (typeof CLASS_NAMES)[number]; bin: IndexBin } {
	const order = [widthClass, ...[widthClass + 1, widthClass + 2, widthClass - 1, widthClass - 2].filter((c) => c >= 0 && c < 3)];
	for (const c of order) {
		const bin = a.bins[CLASS_NAMES[c]];
		if (bin) return { name: CLASS_NAMES[c], bin };
	}
	throw new Error(`magazine: ${a.slug} has no bins`);
}

export async function loadArticle(slug: string, widthClass: number): Promise<LoadedArticle> {
	const ix = await loadIndex();
	const a = ix.articles.find((x) => x.slug === slug);
	if (!a) throw new Error(`magazine: unknown article ${slug}`);
	const { bin } = pickBin(a, widthClass);
	if (!fontsP || fontsP.file !== ix.fonts) fontsP = { file: ix.fonts, p: fetchBytes(ix.fonts) };
	let bp = bins.get(bin.file);
	if (!bp) {
		bp = fetchBytes(bin.file);
		bins.set(bin.file, bp);
		if (bins.size > 4) bins.delete(bins.keys().next().value!);
	}
	const [fonts, bytes] = await Promise.all([fontsP.p, bp]);
	const model = unpackReading(bytes);
	const imageUrls: string[] = [];
	for (const im of ix.images ?? []) {
		const fit = im.tiers.filter((t) => t.w <= IMAGE_MAX_W);
		imageUrls[im.id] = (fit[fit.length - 1] ?? im.tiers[0])?.url ?? '';
	}
	return {
		slug, widthClass: model.widthClass, model, fonts, imageUrls,
		meta: {
			title: a.title, dek: a.dek ?? '', date: a.date ?? '',
			wordsBrief: a.briefWords ?? a.wordsBrief ?? 0, wordsFull: a.fullWords ?? a.wordsFull ?? 0, opensFull: !!a.opensFull,
			wdth: a.wdth ?? 80, wght: a.wght ?? 600, refs: a.refs ?? [], links: a.links ?? {}
		}
	};
}
