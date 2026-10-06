// Plain strings read straight out of the RDR3 model (code source for the copy button, image alt for the lightbox caption).
// There is no DOM copy of the article: the model blob is the only text the page has.
import { ItemType, itemIndex, itemType, type ReadingModel } from '../magazine/format';

const dec = new TextDecoder();

/** Source text of a code block: its lines joined with "\n". */
export function codeText(model: ReadingModel, block: number): string {
	const b = model.blocks[block];
	if (!b) return '';
	const out: string[] = [];
	for (let k = 0; k < b.lineCount; k++) {
		const l = model.lines[b.firstLine + k];
		out.push(dec.decode(model.text.subarray(l.textOff, Math.min(l.textOff + l.textLen, model.text.length))));
	}
	return out.join('\n').replace(/\n$/, '');
}

/** Alt text of the first image item of a block, or "". */
export function imageAlt(model: ReadingModel, block: number): string {
	const b = model.blocks[block];
	if (!b) return '';
	for (let k = 0; k < b.itemCount; k++) {
		const w = model.items[b.firstItem + k];
		if (itemType(w) !== ItemType.image) continue;
		const off = model.images[itemIndex(w)]?.altOffset ?? 0;
		if (!off) return '';
		let e = off;
		while (e < model.strings.length && model.strings[e] !== 0) e++;
		return dec.decode(model.strings.subarray(off, e));
	}
	return '';
}
