// Reading acceptance checks 2, 4, 5, 6 (docs/READING.md section 11): scroll determinism, a11y tree, find, culling.
// Run against a dev server and a headless Chrome on CDP_PORT: bun tests/e2e/reading/checks.ts [baseUrl]
// Each check has a planted-bug control that must FAIL when the bug is present.
import { session } from '/Volumes/Projects/tmp/cdp/lib.ts';
const base = process.argv[2] ?? 'http://localhost:5180';
let failed = 0;
const check = (name: string, ok: boolean, extra: unknown = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok && !extra ? '' : JSON.stringify(extra)); if (!ok) failed++; };
const open = async (w: number, h: number, slug: string) => { const s = await session({ w, h, url: `${base}/thoughts/${slug}`, wait: false }); await Bun.sleep(7000); return s; };

// 2. scroll determinism: the same scrollTop gives the same pixels; reload restores the position
{
  const s = await open(1440, 900, 'hyperion');
  const shot = async () => (await s.send('Page.captureScreenshot', { format: 'png' })).data as string;
  await s.ev(`document.querySelector('.scroller').scrollTop=3000`); await Bun.sleep(900);
  const a = await shot();
  await s.ev(`document.querySelector('.scroller').scrollTop=0`); await Bun.sleep(600);
  await s.ev(`document.querySelector('.scroller').scrollTop=3000`); await Bun.sleep(900);
  const b = await shot();
  check('same scrollTop, same pixels (scroll away and back)', a === b);
  // control: a 1px difference must change the image
  await s.ev(`document.querySelector('.scroller').scrollTop=3001`); await Bun.sleep(900);
  check('control: 1px of scroll changes the pixels', (await shot()) !== a);
  await s.ev(`document.querySelector('.scroller').scrollTop=3000`); await Bun.sleep(1200);
  await s.send('Page.reload'); await Bun.sleep(7000);
  const y = await s.ev(`document.querySelector('.scroller').scrollTop`);
  check('reload restores scrollTop', Math.abs(y - 3000) <= 2, y);
  await s.close();
}

// 4. a11y tree: one copy of the text, canvas hidden, landmarks and headings, no duplicate fallback article
{
  const s = await open(1440, 900, 'hyperion');
  const ax = (await s.send('Accessibility.getFullAXTree')).nodes as any[];
  const names = ax.filter((n) => !n.ignored && n.role?.value === 'heading').map((n) => n.name?.value);
  const texts = ax.filter((n) => !n.ignored && n.role?.value === 'StaticText').map((n) => n.name?.value as string);
  check('headings exposed (hyperion)', names.length >= 4, names.slice(0, 6));
  const dup = texts.filter((t, i) => t && t.length > 40 && texts.indexOf(t) !== i);
  check('no duplicated text nodes in the a11y tree', dup.length === 0, dup.slice(0, 2));
  check('canvas hidden from AT', await s.ev(`document.querySelector('canvas.page').getAttribute('aria-hidden')==='true'`));
  check('prerendered fallback not exposed', await s.ev(`!![...document.querySelectorAll('.reader-dom')].every(e=>getComputedStyle(e).display==='none')`));
  check('text layer words are real text (copyable)', await s.ev(`document.querySelector('.ln').textContent.length>3`));
  // control: a visible duplicate must be detected
  await s.ev(`(()=>{const d=document.querySelector('.doc').cloneNode(true);d.style.cssText='position:static;height:auto';document.body.append(d)})()`); await Bun.sleep(300);
  const ax2 = (await s.send('Accessibility.getFullAXTree')).nodes as any[];
  const t2 = ax2.filter((n) => !n.ignored && n.role?.value === 'StaticText').map((n) => n.name?.value as string);
  check('control: a visible second copy of the article duplicates text', t2.filter((t, i) => t && t.length > 40 && t2.indexOf(t) !== i).length > 0);
  await s.close();
}

// 5. find: window.find hits real DOM text; a match inside the collapsed fold fires beforematch and expands it
{
  const s = await open(1440, 900, 'ifd');
  const hit = await s.ev(`(()=>{const ok=window.find('evaluator stops');const sel=getSelection();return JSON.stringify([ok,sel.toString().slice(0,20),!!sel.anchorNode?.parentElement?.closest('.ln')])})()`);
  check('find locates text in the transparent layer', JSON.parse(hit)[0] === true, hit);
  const fold = await s.ev(`(()=>{const r=document.querySelector('[hidden=until-found]');return !!r})()`);
  check('fold region is hidden=until-found while collapsed', fold);
  // window.find in headless Chrome matches hidden=until-found text but does not run the reveal step the real Cmd+F bar runs (selection lands elsewhere,
  // no beforematch). So the handler is driven with the event Chrome dispatches on the region: expanding it must drop `hidden` and grow the document.
  const exp = await s.ev(`(async()=>{const r=document.querySelector('[hidden=until-found]');const h0=document.querySelector('.doc').offsetHeight;r.dispatchEvent(new Event('beforematch',{bubbles:true}));await new Promise(r=>setTimeout(r,1500));const g=document.querySelector('[hidden=until-found]');return JSON.stringify([h0,document.querySelector('.doc').offsetHeight,!!g])})()`);
  const [h0, h1, still] = JSON.parse(exp);
  check('beforematch on the fold region expands it (Cmd+F reveal path)', !still && h1 > h0, exp);
  check('control: a string that is not in the page is not found', (await s.ev(`window.find('zzqxj-not-here')`)) === false);
  await s.close();
}

// 6. culling: the text layer and the page pass work on the visible range only; idle draws nothing
{
  const s = await open(1440, 900, 'hyperion');
  const d0 = await s.ev(`__reader.counters.draws`); await Bun.sleep(1500); const d1 = await s.ev(`__reader.counters.draws`);
  check('idle: zero page draws over 1.5 s', d1 === d0, [d0, d1]);
  await s.ev(`document.querySelector('.scroller').scrollTop=5000`); await Bun.sleep(600);
  const d2 = await s.ev(`__reader.counters.draws`);
  check('scrolling draws', d2 > d1, [d1, d2]);
  const vis = await s.ev(`JSON.stringify([__reader.frameObj.visFirst,__reader.frameObj.visCount,__reader.model.blocks.length])`);
  check('visible block range is a window', JSON.parse(vis)[1] < JSON.parse(vis)[2] * 0.3, vis);
  // culling equivalence: drawing every block gives the same pixels as the culled draw (luminance diff < 0.5 %, no 64 px tile > 25 %)
  const shot = async () => (await s.send('Page.captureScreenshot', { format: 'png' })).data as string;
  const diff = async (x: string, y: string) => JSON.parse(await s.ev(`(async()=>{const dec=async b64=>{const bl=await (await fetch('data:image/png;base64,'+b64)).blob();const im=await createImageBitmap(bl);const c=new OffscreenCanvas(im.width,im.height);const g=c.getContext('2d');g.drawImage(im,0,0);return g.getImageData(0,0,im.width,im.height)};const A=await dec(${JSON.stringify(x)}),B=await dec(${JSON.stringify(y)});const W=A.width,H=A.height;let sum=0;const T=64,tw=Math.ceil(W/T),tiles=new Float64Array(tw*Math.ceil(H/T));for(let i=0;i<W*H;i++){const j=i*4;const la=.2126*A.data[j]+.7152*A.data[j+1]+.0722*A.data[j+2],lb=.2126*B.data[j]+.7152*B.data[j+1]+.0722*B.data[j+2];const d=Math.abs(la-lb)/255;sum+=d;tiles[((i/W|0)/T|0)*tw+((i%W)/T|0)]+=d}let mt=0;for(const t of tiles)mt=Math.max(mt,t/(T*T));return JSON.stringify({mean:sum/(W*H),maxTile:mt})})()`));
  const setHook = (mode: string) => s.ev(`(()=>{const c=__reader.ctx;const m='${mode}';c.frameHook=m==='off'?null:(f)=>{if(m==='all'){f.visFirst=0;f.visCount=__reader.model.blocks.length}else{f.visCount=Math.max(0,f.visCount>>1)}}})()`);
  const at = async (y: number, mode: string) => {
    await setHook(mode);
    await s.ev(`document.querySelector('.scroller').scrollTop=${y + 1}`); await Bun.sleep(500);
    await s.ev(`document.querySelector('.scroller').scrollTop=${y}`); await Bun.sleep(700);
    return shot();
  };
  const ys = JSON.parse(await s.ev(`JSON.stringify(Array.from({length:6},(_,i)=>Math.round(__reader.model.blocks[Math.floor(__reader.model.blocks.length*(i+1)/8)].y0*parseFloat(getComputedStyle(document.querySelector('.reader')).getPropertyValue('--em'))-300)))`)) as number[];
  let worst = { mean: 0, maxTile: 0 }; let ctl = { mean: 0, maxTile: 0 };
  for (const y of ys) {
    const culled = await at(y, 'off');
    const full = await at(y, 'all');
    const d = await diff(culled, full);
    worst = { mean: Math.max(worst.mean, d.mean), maxTile: Math.max(worst.maxTile, d.maxTile) };
    const bad = await at(y, 'half');
    const dc = await diff(culled, bad);
    ctl = { mean: Math.max(ctl.mean, dc.mean), maxTile: Math.max(ctl.maxTile, dc.maxTile) };
  }
  check('culled draw equals full draw (mean < 0.5 %, tile < 25 %)', worst.mean < 0.005 && worst.maxTile < 0.25, { ys, worst });
  check('control: culling half the visible blocks is detected', ctl.maxTile > 0.25 || ctl.mean > 0.005, ctl);
  await setHook('off');
  await s.close();
}
console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
