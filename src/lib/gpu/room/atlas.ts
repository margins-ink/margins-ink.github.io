import { geoConicConformal, geoGraticule10, geoPath } from 'd3';
import type { Thought } from '$lib/thoughts';
import { drawCover as paintCover } from './emblems';

/**
 * Everything the room's walls and magazines show, painted once into a single
 * 2048x2048 canvas that is uploaded as a GPU texture.
 *
 * Layout (pixels): map 1024x720 at (0,0); cover tiles 256x340 starting at y=768,
 * four per row.
 */
export const ATLAS = 2048;
export const MAP = { x: 0, y: 0, w: 1024, h: 720 };
export const TILE = { w: 256, h: 340, y0: 768, perRow: 4 };
export const SIGN = { x: 1024, w: 1024, h: 180 };
export const signRect = (i: number) => ({ x: SIGN.x, y: i * SIGN.h, w: SIGN.w, h: SIGN.h });
export const tileRect = (i: number) => ({
	x: (i % TILE.perRow) * TILE.w,
	y: TILE.y0 + Math.floor(i / TILE.perRow) * TILE.h,
	w: TILE.w,
	h: TILE.h
});

type Scheme = { paper: string; ink: string; sea: string; land: string; heritage: string; nordic: string; line: string };
const LIGHT: Scheme = {
	paper: '#efe6d2',
	ink: '#1d1a16',
	sea: '#2c4a5c',
	land: '#e6d9bc',
	heritage: '#b8321f',
	nordic: '#2f6f8f',
	line: 'rgba(240,230,205,0.16)'
};
const DARK: Scheme = {
	paper: '#d8cdb6',
	ink: '#171410',
	sea: '#1c3140',
	land: '#cfc2a4',
	heritage: '#b8321f',
	nordic: '#2f6f8f',
	line: 'rgba(240,230,205,0.12)'
};

interface Country {
	iso: string;
	name: string;
	polys: number[][][][];
}

const NORDIC = new Set(['FIN', 'NOR', 'SWE', 'ISL']);

async function drawMap(ctx: CanvasRenderingContext2D, s: Scheme) {
	const { x, y, w, h } = MAP;
	const countries: Country[] = await (await fetch('/geo/europe.json')).json();

	ctx.save();
	ctx.translate(x, y);
	ctx.beginPath();
	ctx.rect(0, 0, w, h);
	ctx.clip();
	ctx.fillStyle = s.sea;
	ctx.fillRect(0, 0, w, h);

	const feature = {
		type: 'FeatureCollection',
		features: countries.map((c) => ({
			type: 'Feature',
			properties: { iso: c.iso },
			geometry: { type: 'MultiPolygon', coordinates: c.polys }
		}))
	} as any;
	const proj = geoConicConformal()
		.parallels([48, 62])
		.rotate([-17, 0])
		.fitExtent(
			[
				[40, 40],
				[w - 40, h - 40]
			],
			{
				type: 'FeatureCollection',
				features: feature.features.filter((f: any) =>
					['POL', 'FIN', 'NOR', 'SWE', 'ISL', 'DNK', 'DEU'].includes(f.properties.iso)
				)
			} as any
		);
	const path = geoPath(proj, ctx);

	ctx.strokeStyle = s.line;
	ctx.lineWidth = 1;
	ctx.beginPath();
	path(geoGraticule10());
	ctx.stroke();

	for (const f of feature.features) {
		const iso = f.properties.iso as string;
		ctx.beginPath();
		path(f);
		// offset shadow, like a misregistered print plate
		if (iso === 'POL' || NORDIC.has(iso)) {
			ctx.save();
			ctx.translate(5, 5);
			ctx.fillStyle = 'rgba(0,0,0,0.35)';
			ctx.fill();
			ctx.restore();
		}
		ctx.fillStyle = iso === 'POL' ? s.heritage : NORDIC.has(iso) ? s.nordic : s.land;
		ctx.fill();
		ctx.strokeStyle = s.ink;
		ctx.lineWidth = iso === 'POL' || NORDIC.has(iso) ? 1.6 : 0.8;
		ctx.stroke();
	}

	// engraved hatching over the Nordic countries
	ctx.save();
	ctx.beginPath();
	for (const f of feature.features) if (NORDIC.has(f.properties.iso)) path(f);
	ctx.clip();
	ctx.strokeStyle = 'rgba(0,0,0,0.28)';
	ctx.lineWidth = 1;
	for (let k = -h; k < w + h; k += 7) {
		ctx.beginPath();
		ctx.moveTo(k, 0);
		ctx.lineTo(k + h, h);
		ctx.stroke();
	}
	ctx.restore();

	// labels
	ctx.fillStyle = s.paper;
	ctx.textAlign = 'center';
	ctx.font = '700 26px Newsreader, Georgia, serif';
	const pl = proj([19.4, 52.1]);
	if (pl) ctx.fillText('POLAND', pl[0], pl[1]);
	ctx.font = '700 17px Newsreader, Georgia, serif';
	for (const [t, lon, lat] of [
		['NORWAY', 9.5, 62],
		['SWEDEN', 16, 62.5],
		['FINLAND', 26.5, 64.2],
		['ICELAND', -18.5, 64.9]
	] as [string, number, number][]) {
		const p = proj([lon, lat]);
		if (p) ctx.fillText(t, p[0], p[1]);
	}

	// heritage bar: Poland about half, the Nordics the rest
	const bx = 40;
	const by = h - 48;
	const bw = 360;
	ctx.fillStyle = s.heritage;
	ctx.fillRect(bx, by, bw * 0.5, 16);
	ctx.fillStyle = s.nordic;
	ctx.fillRect(bx + bw * 0.5, by, bw * 0.5, 16);
	ctx.textAlign = 'left';
	ctx.fillStyle = s.paper;
	ctx.font = '500 15px "Fira Code", monospace';
	ctx.fillText('POLAND ~50%', bx, by - 8);
	ctx.textAlign = 'right';
	ctx.fillText('NORDICS, THE REST', bx + bw, by - 8);

	ctx.restore();
}

function drawCover(ctx: CanvasRenderingContext2D, t: Thought, accent: string, i: number, dark: boolean) {
	paintCover(ctx, t, accent, tileRect(i), dark);
}

function drawSign(ctx: CanvasRenderingContext2D, i: number, title: string, sub: string, big: boolean) {
	const { x, y, w, h } = signRect(i);
	ctx.save();
	ctx.translate(x, y);
	ctx.fillStyle = '#231a12';
	ctx.fillRect(0, 0, w, h);
	ctx.strokeStyle = '#a8864f';
	ctx.lineWidth = 3;
	ctx.strokeRect(10, 10, w - 20, h - 20);
	ctx.fillStyle = '#e9d9b3';
	ctx.textBaseline = 'alphabetic';
	ctx.font = `800 ${big ? 108 : 96}px Newsreader, Georgia, serif`;
	ctx.fillText(title, 44, sub ? 112 : 124);
	if (sub) {
		ctx.fillStyle = '#a8864f';
		ctx.font = '500 24px "Fira Code", monospace';
		ctx.fillText(sub.toUpperCase(), 48, 152);
	}
	ctx.restore();
}

export async function buildAtlas(
	items: Thought[],
	accents: string[],
	dark: boolean,
	signs: { title: string; sub: string }[]
): Promise<HTMLCanvasElement> {
	await Promise.all([
		document.fonts.load('800 40px Newsreader'),
		document.fonts.load('italic 500 14px Newsreader'),
		document.fonts.load('500 12px "Fira Code"')
	]);
	const c = document.createElement('canvas');
	c.width = c.height = ATLAS;
	const ctx = c.getContext('2d')!;
	ctx.fillStyle = '#f1ead9';
	ctx.fillRect(0, 0, ATLAS, ATLAS);
	await drawMap(ctx, dark ? DARK : LIGHT);
	items.forEach((t, i) => drawCover(ctx, t, accents[i], i, dark));
	signs.forEach((g, i) => drawSign(ctx, i, g.title, g.sub, i === 0));
	return c;
}
