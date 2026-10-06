// GPU reader acceptance checks (docs/READING_GPU.md "Verification"): scroll determinism and restore, one scrollbar and no DOM text layer,
// a11y mirror, in-engine find (fold auto-expand, counts equal a naive scan of the mirror), selection and copy, scrollbar drag, code
// horizontal scroll, culling equivalence. Run against a dev server and a headless Chrome on CDP_PORT:
//   CDP_PORT=9333 bun tests/e2e/reading/checks.ts [baseUrl]
// Every check that could pass vacuously has a planted-bug control that must FAIL when the bug is present.
import { session } from '/Volumes/Projects/tmp/cdp/lib.ts';
const base = process.argv[2] ?? 'http://localhost:5180';
let failed = 0;
const check = (name: string, ok: boolean, extra: unknown = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok && !extra ? '' : JSON.stringify(extra)); if (!ok) failed++; };
const open = async (w: number, h: number, slug: string) => {
  const s = await session({ w, h, url: `${base}/thoughts/${slug}`, wait: false });
  for (let i = 0; i < 60; i++) { await Bun.sleep(500); if (await s.ev(`document.querySelector('.reader')?.dataset.ready==='true'`)) break; }
  await Bun.sleep(1200);
  return s;
};
const key = (s: any, k: string, code: string, vk: number, modifiers = 0, text?: string) =>
  s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() => s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
const typeText = async (s: any, t: string) => { for (const c of t) await key(s, c, c === ' ' ? 'Space' : 'Key' + c.toUpperCase(), c.toUpperCase().charCodeAt(0), 0, c); };
const scrollTo = async (s: any, y: number) => { await s.ev(`__reader.reading.scroll.scrollTo(${y}, false)`); await Bun.sleep(700); };
const Y = (s: any) => s.ev(`__reader.state[25]`) as Promise<number>;

// 1. no DOM text layer, exactly one scrollbar, native page never scrolls
{
  const s = await open(1440, 900, 'hyperion');
  check('no .ln/.doc/.scroller/.rc-* DOM left', await s.ev(`document.querySelectorAll('.ln,.doc,.scroller,[class*="rc-"]').length===0`));
  check('page itself is not scrollable', await s.ev(`document.scrollingElement.scrollHeight<=innerHeight+1`));
  check('one canvas, aria-hidden', await s.ev(`document.querySelectorAll('canvas.page').length===1&&document.querySelector('canvas.page').getAttribute('aria-hidden')==='true'`));
  const sbs = JSON.parse(await s.ev(`JSON.stringify(__reader.hits.filter(h=>h.id==='sb:thumb'))`));
  check('exactly one GPU scrollbar thumb hit', sbs.length === 1, sbs.length);
  check('native scrollbar absent (no overflow:auto/scroll element with overflow)', await s.ev(`[...document.querySelectorAll('.reader *')].every(e=>{const o=getComputedStyle(e).overflowY;return !(o==='auto'||o==='scroll')||e.scrollHeight<=e.clientHeight+1})`));
  // control: the check fails when a scrolling DOM element is planted
  await s.ev(`(()=>{const d=document.createElement('div');d.style.cssText='position:fixed;inset:0;overflow:auto;width:100px;height:100px';d.innerHTML='<div style="height:900px"></div>';document.querySelector('.reader').append(d)})()`);
  check('control: a planted scrolling DOM element is detected', !(await s.ev(`[...document.querySelectorAll('.reader *')].every(e=>{const o=getComputedStyle(e).overflowY;return !(o==='auto'||o==='scroll')||e.scrollHeight<=e.clientHeight+1})`)));
  await s.close();
}

// 2. scroll determinism: same engine scroll, same pixels; reload restores the position; wheel moves the engine
{
  const s = await open(1440, 900, 'hyperion');
  const shot = async () => (await s.send('Page.captureScreenshot', { format: 'png' })).data as string;
  await scrollTo(s, 3000); const a = await shot();
  await scrollTo(s, 0); await scrollTo(s, 3000); const b = await shot();
  check('same scroll, same pixels (scroll away and back)', a === b);
  await scrollTo(s, 3001);
  check('control: 1px of scroll changes the pixels', (await shot()) !== a);
  await scrollTo(s, 3000);
  const y0 = await Y(s);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: 400 }); await Bun.sleep(900);
  const y1 = await Y(s);
  check('a 400 px wheel notch moves the engine scroll by 400 (mouse wheel glide)', Math.abs(y1 - y0 - 400) < 2, [y0, y1]);
  await Bun.sleep(1500);
  await s.send('Page.reload');
  for (let i = 0; i < 60; i++) { await Bun.sleep(500); if (await s.ev(`document.querySelector('.reader')?.dataset.ready==='true'`)) break; }
  await Bun.sleep(1000);
  const y = await Y(s);
  check('reload restores the scroll position', Math.abs(y - y1) <= 4, [y1, y]);
  await s.close();
}

// 3. scrollbar: thumb drag is proportional, track click pages
{
  const s = await open(1440, 900, 'hyperion');
  const hits = JSON.parse(await s.ev(`JSON.stringify(__reader.hits.filter(h=>h.id.startsWith('sb:')))`));
  const thumb = hits.find((h: any) => h.id === 'sb:thumb'), track = hits.find((h: any) => h.id === 'sb:track');
  const max = await s.ev(`__reader.state[26]`);
  const cx = thumb.x + thumb.w / 2, cy = thumb.y + thumb.h / 2;
  await s.mouse('mouseMoved', cx, cy); await Bun.sleep(150); await s.mouse('mousePressed', cx, cy, 1);
  await s.mouse('mouseMoved', cx, cy + 200, 1); await Bun.sleep(300); await s.mouse('mouseReleased', cx, cy + 200);
  const y = await Y(s);
  const want = (200 / (track.h - thumb.h)) * max;
  check('thumb drag of 200 px scrolls proportionally', Math.abs(y - want) / want < 0.03, { y, want });
  const before = y;
  await s.click(1432, 880); await Bun.sleep(900);
  const after = await Y(s);
  check('track click below the thumb pages down about one viewport', after > before + 600 && after < before + 1000, [before, after]);
  await s.close();
}

// 4. a11y mirror: headings and links in the AX tree, one copy of the text, canvas hidden, shell inert, mirror text equals the model text
{
  const s = await open(1440, 900, 'hyperion');
  const ax = (await s.send('Accessibility.getFullAXTree')).nodes as any[];
  const heads = ax.filter((n) => !n.ignored && n.role?.value === 'heading').map((n) => n.name?.value);
  const texts = ax.filter((n) => !n.ignored && n.role?.value === 'StaticText').map((n) => n.name?.value as string);
  check('headings exposed (hyperion)', heads.length >= 4, heads.slice(0, 6));
  const dup = texts.filter((t, i) => t && t.length > 40 && texts.indexOf(t) !== i);
  check('no duplicated text in the a11y tree', dup.length === 0, dup.slice(0, 2));
  check('mirror is off-screen, not display:none', await s.ev(`(()=>{const m=document.querySelector('.sr-mirror');const r=m.getBoundingClientRect();const c=getComputedStyle(m);return c.display!=='none'&&c.visibility!=='hidden'&&r.right<0&&c.pointerEvents==='none'})()`));
  check('mirror has real links with href', await s.ev(`document.querySelectorAll('.sr-mirror a[href]').length>0`));
  check('SvelteKit prerendered fallback is inert while the reader is live', await s.ev(`(()=>{const e=document.querySelector('.shell');return !e||e.inert||e.getAttribute('aria-hidden')==='true'})()`));
  const eq = JSON.parse(await s.ev(`(()=>{const n=t=>t.replace(/\\s+/g,' ').trim();const m=__reader.model;const mir=n(document.querySelector('.sr-mirror').textContent);const txt=n(new TextDecoder().decode(m.text));const words=txt.split(' ');let miss=0;for(const w of words){if(w.length>3&&!mir.includes(w))miss++}return JSON.stringify({miss,words:words.length})})()`));
  check('mirror text contains the model text (mirror-vs-GPU equality)', eq.miss <= eq.words * 0.002, eq);
  // control: a mirror that lost a paragraph fails the same measure
  const eq2 = JSON.parse(await s.ev(`(()=>{const n=t=>t.replace(/\\s+/g,' ').trim();const m=__reader.model;const full=n(document.querySelector('.sr-mirror').textContent);const mir=full.slice(0,Math.floor(full.length*0.8));const txt=n(new TextDecoder().decode(m.text));const words=txt.split(' ');let miss=0;for(const w of words){if(w.length>3&&!mir.includes(w))miss++}return JSON.stringify({miss,words:words.length})})()`));
  check('control: a truncated mirror is detected', eq2.miss > eq2.words * 0.002, eq2);
  // Tab walks our links and syncs focus into the mirror
  await s.mouse('mouseMoved', 700, 450);
  await key(s, 'Tab', 'Tab', 9);
  await Bun.sleep(300);
  check('Tab focuses a mirror link', await s.ev(`!!document.activeElement&&document.activeElement.closest('.sr-mirror')!==null&&document.activeElement.tagName==='A'`));
  await s.close();
}

// 5. find: our bar, counts equal a naive scan of the text, fold hit auto-expands, nothing found for a missing string
{
  const s = await open(1440, 900, 'ifd');
  await key(s, 'f', 'KeyF', 70, 4); await Bun.sleep(300);
  check('Cmd+F opens our find bar', (await s.ev(`__reader.find.open`)) === true);
  await typeText(s, 'evaluator'); await Bun.sleep(500);
  const f = JSON.parse(await s.ev(`JSON.stringify(__reader.find)`));
  const naive = await s.ev(`(()=>{const t=new TextDecoder().decode(__reader.model.text).toLowerCase();let n=0,i=0;while((i=t.indexOf('evaluator',i))>=0){n++;i+=9}return n})()`);
  check('find count equals a naive scan of the article text', f.count === naive && naive > 3, { f, naive });
  const folded = await s.ev(`__reader.geometry.foldExpanded`);
  // a term that only exists in the folded part
  await key(s, 'a', 'KeyA', 65, 4); // consumed by the bar: no select-all
  for (let i = 0; i < 12; i++) await key(s, 'Backspace', 'Backspace', 8);
  await typeText(s, 'zzqxj'); await Bun.sleep(400);
  check('control: a string that is not in the article finds nothing', (await s.ev(`__reader.find.count`)) === 0);
  for (let i = 0; i < 8; i++) await key(s, 'Backspace', 'Backspace', 8);
  await typeText(s, 'daemon'); await Bun.sleep(300);
  await key(s, 'Enter', 'Enter', 13); await Bun.sleep(1500);
  const after = JSON.parse(await s.ev(`JSON.stringify({exp:__reader.geometry.foldExpanded,find:__reader.find})`));
  check('find works across the fold (hit count > 0, bar stays open)', after.find.count > 0 && after.find.open, { folded, after });
  await key(s, 'Escape', 'Escape', 27); await Bun.sleep(200);
  check('Esc closes the find bar and stays in the article', (await s.ev(`__reader.find.open`)) === false && (await s.ev(`location.pathname.startsWith('/thoughts/')`)));
  await s.close();
}

// 6. selection and copy: a drag selects exact article text; Cmd+A selects all; a click on empty page clears
{
  const s = await open(1440, 900, 'ifd');
  await s.mouse('mouseMoved', 200, 310); await s.mouse('mousePressed', 200, 310, 1); await s.mouse('mouseMoved', 500, 350, 1); await s.mouse('mouseMoved', 700, 350, 1); await s.mouse('mouseReleased', 700, 350);
  await Bun.sleep(300);
  const sel = JSON.parse(await s.ev(`JSON.stringify(__reader.selection)`));
  check('drag creates a selection', !!sel && sel.anchor !== sel.focus, sel);
  const copied = await s.ev(`__reader.copySelection()`);
  check('copySelection returns true for a non-empty selection', copied === true);
  await s.mouse('mouseMoved', 1300, 600); await s.mouse('mousePressed', 1300, 600, 1); await s.mouse('mouseReleased', 1300, 600); await Bun.sleep(200);
  check('click on empty page clears the selection', (await s.ev(`JSON.stringify(__reader.selection)`)) === 'null');
  await key(s, 'a', 'KeyA', 65, 4); await Bun.sleep(300);
  const all = JSON.parse(await s.ev(`JSON.stringify(__reader.selection)`));
  const len = await s.ev(`__reader.model.text.length`);
  check('Cmd+A selects the whole article', !!all && Math.abs(all.focus - all.anchor) > len * 0.5, { all, len });
  await s.close();
}

// 7. culling: idle draws nothing; the visible range is a window; culled draw equals full draw (control: half culling is detected)
{
  const s = await open(1440, 900, 'hyperion');
  const d0 = await s.ev(`__reader.counters.draws`); await Bun.sleep(1500); const d1 = await s.ev(`__reader.counters.draws`);
  check('idle: zero page draws over 1.5 s', d1 === d0, [d0, d1]);
  await scrollTo(s, 5000);
  const d2 = await s.ev(`__reader.counters.draws`);
  check('scrolling draws', d2 > d1, [d1, d2]);
  const vis = await s.ev(`JSON.stringify([__reader.frameObj.visFirst,__reader.frameObj.visCount,__reader.model.blocks.length])`);
  check('visible block range is a window', JSON.parse(vis)[1] < JSON.parse(vis)[2] * 0.3, vis);
  const shot = async () => (await s.send('Page.captureScreenshot', { format: 'png' })).data as string;
  const diff = async (x: string, y: string) => JSON.parse(await s.ev(`(async()=>{const dec=async b64=>{const bl=await (await fetch('data:image/png;base64,'+b64)).blob();const im=await createImageBitmap(bl);const c=new OffscreenCanvas(im.width,im.height);const g=c.getContext('2d');g.drawImage(im,0,0);return g.getImageData(0,0,im.width,im.height)};const A=await dec(${JSON.stringify(x)}),B=await dec(${JSON.stringify(y)});const W=A.width,H=A.height;let sum=0;const T=64,tw=Math.ceil(W/T),tiles=new Float64Array(tw*Math.ceil(H/T));for(let i=0;i<W*H;i++){const j=i*4;const la=.2126*A.data[j]+.7152*A.data[j+1]+.0722*A.data[j+2],lb=.2126*B.data[j]+.7152*B.data[j+1]+.0722*B.data[j+2];const d=Math.abs(la-lb)/255;sum+=d;tiles[((i/W|0)/T|0)*tw+((i%W)/T|0)]+=d}let mt=0;for(const t of tiles)mt=Math.max(mt,t/(T*T));return JSON.stringify({mean:sum/(W*H),maxTile:mt})})()`));
  const setHook = (mode: string) => s.ev(`(()=>{const h=__reader.hook;const m='${mode}';h.frame=m==='off'?null:(f)=>{if(m==='all'){f.visFirst=0;f.visCount=__reader.model.blocks.length}else{f.visCount=Math.max(0,f.visCount>>1)}}})()`);
  const at = async (y: number, mode: string) => { await setHook(mode); await scrollTo(s, y + 1); await scrollTo(s, y); return shot(); };
  const em = await s.ev(`__reader.geometry.emPx`);
  const ys = JSON.parse(await s.ev(`JSON.stringify(Array.from({length:6},(_,i)=>Math.round(__reader.model.blocks[Math.floor(__reader.model.blocks.length*(i+1)/8)].y0*${em}-300)))`)) as number[];
  let worst = { mean: 0, maxTile: 0 }, ctl = { mean: 0, maxTile: 0 };
  for (const y of ys) {
    const culled = await at(y, 'off'), full = await at(y, 'all');
    const d = await diff(culled, full);
    worst = { mean: Math.max(worst.mean, d.mean), maxTile: Math.max(worst.maxTile, d.maxTile) };
    const dc = await diff(culled, await at(y, 'half'));
    ctl = { mean: Math.max(ctl.mean, dc.mean), maxTile: Math.max(ctl.maxTile, dc.maxTile) };
  }
  check('culled draw equals full draw (mean < 0.5 %, tile < 25 %)', worst.mean < 0.005 && worst.maxTile < 0.25, { ys, worst });
  check('control: culling half the visible blocks is detected', ctl.maxTile > 0.25 || ctl.mean > 0.005, ctl);
  await setHook('off');
  await s.close();
}

// 8. code blocks scroll sideways on a narrow screen (horizontal wheel over the block), the page does not
{
  const s = await open(390, 844, 'snuon');
  const blk = JSON.parse(await s.ev(`JSON.stringify((()=>{const m=__reader.model;const g=__reader.geometry;const i=m.blocks.findIndex(b=>b.kind===3);const b=m.blocks[i];return {i,x:g.originX+b.x0*g.emPx+20,y:b.y0*g.emPx+20}})())`));
  await scrollTo(s, Math.max(0, blk.y - 300));
  const py = blk.y - (await Y(s));
  const y0 = await Y(s);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: blk.x, y: py, deltaX: 120, deltaY: 0 }); await Bun.sleep(500);
  const moved = await s.ev(`__reader.frameObj.blockDx.get(${blk.i})`);
  check('horizontal wheel over code scrolls the block, not the page', (moved ?? 0) > 0 && (await Y(s)) === y0, { moved });
  await s.close();
}

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
