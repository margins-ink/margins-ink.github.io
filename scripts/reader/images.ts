// Stage 2, step 7: image tiers. sharp writes w512 / w1024 / w2048 / min(orig, 4096) WebP, content
// hashed, under static/reader/img/. Lossless for screenshots/diagrams (few distinct colours), q90 lossy
// otherwise. Already-written tiers are reused (the content hash is in the file name).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ROOT } from './fonts';
import type { Block } from './parse';

export interface ImageInfo {
	id: number;
	src: string;
	w: number;
	h: number;
	hash: string;
	lossless: boolean;
	tiers: { w: number; h: number; url: string; bytes: number }[];
}

export const OUT_DIR = path.join(ROOT, 'static/reader');
const TIERS = [512, 1024, 2048, 4096];

export function collectImageSrcs(blocks: Block[], out = new Set<string>()): Set<string> {
	for (const b of blocks) {
		if (b.t === 'image') out.add(b.src);
		else if (b.t === 'list') b.items.forEach((i) => collectImageSrcs(i, out));
		else if (b.t === 'quote' || b.t === 'note') collectImageSrcs(b.children, out);
		else if (b.t === 'footnotes') b.items.forEach((i) => collectImageSrcs(i.children, out));
	}
	return out;
}

export class ImageStore {
	byId: ImageInfo[] = [];
	bySrc = new Map<string, ImageInfo>();

	async add(src: string, where: string): Promise<ImageInfo> {
		const hit = this.bySrc.get(src);
		if (hit) return hit;
		if (!src.startsWith('/')) throw new Error(`${where}: image ${src} is not a site-relative path`);
		const file = path.join(ROOT, 'static', src);
		if (!fs.existsSync(file)) throw new Error(`${where}: image file ${file} does not exist`);
		const bytes = fs.readFileSync(file);
		const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10);
		const img = sharp(bytes);
		const meta = await img.metadata();
		const w = meta.width!, h = meta.height!;
		// distinct colours in a 96x96 nearest-neighbour sample
		const { data } = await sharp(bytes).resize(96, 96, { fit: 'fill', kernel: 'nearest' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		const seen = new Set<number>();
		for (let i = 0; i < data.length; i += 3) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
		const lossless = seen.size < 1200;
		const base = path.basename(src).replace(/\.[^.]+$/, '');
		const widths = [...new Set(TIERS.map((t) => Math.min(t, w)))].sort((a, b) => a - b);
		fs.mkdirSync(path.join(OUT_DIR, 'img'), { recursive: true });
		const tiers: ImageInfo['tiers'] = [];
		for (const tw of widths) {
			const th = Math.round((h * tw) / w);
			const name = `${base}.${hash}.w${tw}.webp`;
			const out = path.join(OUT_DIR, 'img', name);
			if (!fs.existsSync(out)) {
				const pipe = sharp(bytes).resize(tw, th, { fit: 'fill' });
				await pipe.webp(lossless ? { lossless: true, effort: 4 } : { quality: 90, effort: 4 }).toFile(out);
			}
			tiers.push({ w: tw, h: th, url: `/reader/img/${name}`, bytes: fs.statSync(out).size });
		}
		const info: ImageInfo = { id: this.byId.length, src, w, h, hash, lossless, tiers };
		this.byId.push(info);
		this.bySrc.set(src, info);
		return info;
	}
}
