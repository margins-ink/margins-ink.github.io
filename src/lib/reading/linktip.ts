// What the link preview card says about a link (pure, no DOM): external and article links use the metadata baked at build time
// (scripts/magazine/linkmeta.ts -> articles[].links); #anchor links read the target heading and the text after it from the model.
import { LinkKind, stringAt, type ReadingModel } from '../magazine/format';
import { hostOf } from './ui/layout';

export interface TipContent { host: string; url: string; title: string; description: string }

const dec = new TextDecoder();
const blockText = (m: ReadingModel, b: number): string => {
	const r = m.blocks[b];
	return r && r.textLen > 0 ? dec.decode(m.text.subarray(r.textOff, r.textOff + r.textLen)).replace(/\s+/g, ' ').trim() : '';
};

/** content for link `li`; `siteHost` is the host shown for in-site links; null for citations (they have their own popover) or an unknown link */
export function linkTipContent(m: ReadingModel, links: Record<string, { t: string; d: string }>, li: number, siteHost: string): TipContent | null {
	const l = m.links[li];
	if (!l || l.kind === LinkKind.ref) return null;
	const target = stringAt(m.strings, l.offset);
	if (!target) return null;
	if (l.kind === LinkKind.anchor) {
		let id = target.replace(/^#/, '');
		try { id = decodeURIComponent(id); } catch { /* keep raw */ }
		const a = m.anchors.find((x) => stringAt(m.strings, x.idOffset) === id);
		const title = a ? blockText(m, a.block) : '';
		let description = '';
		if (a) for (let b = a.block + 1; b < Math.min(m.blocks.length, a.block + 6) && !description; b++) description = blockText(m, b);
		return { host: 'On this page', url: target, title, description };
	}
	if (l.kind === LinkKind.article) {
		const key = target.replace(/[#?].*$/, '').replace(/\/$/, '');
		const e = links[key];
		return { host: siteHost, url: target, title: e?.t ?? '', description: e?.d ?? '' };
	}
	const e = links[target];
	return { host: hostOf(target), url: target, title: e?.t ?? '', description: e?.d ?? '' };
}
