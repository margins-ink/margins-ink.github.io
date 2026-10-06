/**
 * WGSL of the page pass (docs/READING.md section 7, docs/READING_CONTRACT.md): the evaluator pieces of the old magazine
 * spread shader (Slug glyph coverage, groups, strokes, shapes, paths, numerals, rects, images) copied out of
 * src/lib/gpu/room/magazine.wgsl.ts and generated from the RDR3 SCHEMA the same way, plus four render passes:
 *
 *   vs_ground / fs_ground   full screen triangle: page ground (theme.ts GROUND: one flat tinted near-black), rounded rect clip
 *   vs_text / fs_text       instanced quads over a contiguous range of the items table (glyph, rect, image words)
 *   vs_fig / fs_fig         one instanced quad per visible figure block, items found through the figure cell grid
 *   vs_ovl / fs_ovl         instanced rounded rectangles (UI overlays)
 *   vs_ui / fs_ui           instanced UI glyph quads (same union glyph table and slug_cov coverage as the article text)
 *
 * Output is premultiplied alpha, blend one / one-minus-src-alpha. On an 8 bit canvas the shader gamma-encodes (blending in
 * display space like CSS text); the extended range float16 canvas is extended sRGB, which is also gamma encoded (values above 1 allowed), so it
 * gets the same encode; writing linear there shows every colour about two stops too dark and too saturated (fixed 2026-10-06, found on an XDR display).
 *
 * Bindings: group 0 = reader storage buffer (6), image texture array (27), sampler (28); group 1 = frame uniform (0),
 * dynamic per-draw segment uniform (1), figure instance list (2), overlay list (3), UI glyph list (4).
 *
 * WGSL reserved words avoided as identifiers (active, target, get, sample, texture, ref, half, loop, filter, mod, set, view, ...).
 * No backticks in comments: this is a TS template literal.
 */
import { REC2, SCHEMA, fieldOffset, CELL_W, CELL_H } from '../magazine/format';
import { GROUND_WGSL } from './theme';

/** Header word indices of the page buffer, shared with page.ts. Word values are offsets (in words) of each section. */
export const MH = {
	magic: 0, fdir: 1, fcur: 2, fband: 3, xdir: 4, xcur: 5, xband: 6,
	cells: 7, items: 8, glyphs: 9, rects: 10, images: 11, shapes: 12, paths: 13, strokes: 14, segs: 15,
	groups: 16, numerals: 17, digits: 18, palette: 19, figures: 20, blocks: 21, notes: 22, chans: 23,
	nBlocks: 24, nNotes: 25, nFigures: 26, nItems: 27
} as const;
export const MH_WORDS = 32;
export const CHAN_FLOATS = 256;
/** word index of the channel table (rewritten each dirty frame with a writeBuffer subrange) */
export const CHAN_BASE = MH_WORDS;
/** first word after header and channel table */
export const DATA_BASE = MH_WORDS + CHAN_FLOATS;
export const MAGIC_PAGE = 0x50414745; // 'PAGE'

/** Frame uniform: FRAME_VEC4 vec4f, layout documented at struct FrameU below, packed by packFrame in page.ts. */
export const FRAME_VEC4 = 6;
/** Segment uniform payload bytes (struct SegU); page.ts pads each slot to the device uniform offset alignment. */
export const SEG_BYTES = 32;

type Rec = keyof typeof SCHEMA;
const FN: Record<string, string> = { f32: 'ff32', u32: 'fu32', i32: 'fi32', u16: 'fu16', i16: 'fi16', u8: 'fu8', f16: 'ff16' };
/** WGSL read expression for a record field, typed from SCHEMA, byte offset from fieldOffset (so strides cannot drift). */
const g = (rec: Rec, field: string, base = 'r'): string => {
	const ty = (SCHEMA[rec] as readonly (readonly [string, string])[]).find(([k]) => k === field)?.[1];
	if (!ty) throw new Error(`page.wgsl: no field ${rec}.${field}`);
	return `${FN[ty]}(${base}, ${fieldOffset(rec, field)}u)`;
};
const sz = (rec: Rec) => `${REC2[rec] / 4}u`;
const headerConsts = Object.entries(MH).map(([k, v]) => `const MH_${k.toUpperCase()} = ${v}u;`).join('\n');
const sizeConsts = (['glyph', 'rect', 'image', 'shape', 'path', 'stroke', 'seg', 'group', 'numeral', 'figure', 'cell'] as Rec[])
	.map((k) => `const SZ_${k.toUpperCase()} = ${sz(k)};`).join('\n');
const segCum = fieldOffset('seg', 'cum');

/** The evaluator: bindings, header, typed reads, item evaluators. Needs nothing else. */
export const PAGE_EVAL_WGSL = /* wgsl */ `
@group(0) @binding(6) var<storage, read> reader: array<u32>;
@group(0) @binding(27) var reader_img: texture_2d_array<f32>;
@group(0) @binding(28) var img_s: sampler;

${headerConsts}
${sizeConsts}
const MG_CHAN_BASE = ${CHAN_BASE}u;
const MG_NONE16 = 0xffffu;
const MG_CELL_W = ${CELL_W.toFixed(1)};
const MG_CELL_H = ${CELL_H.toFixed(2)};

// ---- typed field reads (byte offsets come from SCHEMA in format.ts) ----
fn mg_f(i: u32) -> f32 { return bitcast<f32>(reader[i]); }
fn fu32(r: u32, o: u32) -> u32 { return reader[r + (o >> 2u)]; }
fn ff32(r: u32, o: u32) -> f32 { return bitcast<f32>(reader[r + (o >> 2u)]); }
fn fi32(r: u32, o: u32) -> i32 { return bitcast<i32>(reader[r + (o >> 2u)]); }
fn fu16(r: u32, o: u32) -> u32 { return (reader[r + (o >> 2u)] >> ((o & 2u) * 8u)) & 0xffffu; }
fn fi16(r: u32, o: u32) -> i32 { return bitcast<i32>(fu16(r, o) << 16u) >> 16u; }
fn fu8(r: u32, o: u32) -> u32 { return (reader[r + (o >> 2u)] >> ((o & 3u) * 8u)) & 0xffu; }
fn ff16(r: u32, o: u32) -> f32 { return unpack2x16float(fu16(r, o)).x; }

fn pg_srgb_dec(c: vec3f) -> vec3f { return select(pow((c + vec3f(0.055)) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn pg_srgb_enc(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - vec3f(0.055), x * 12.92, x <= vec3f(0.0031308));
}

fn mg_chan(ci: i32) -> f32 {
  if (ci < 0 || ci >= ${CHAN_FLOATS}) { return 0.0; }
  return bitcast<f32>(reader[MG_CHAN_BASE + u32(ci)]);
}
// channel value, or the constant k when the field has no channel
fn mg_cv(ci: i32, k: f32) -> f32 {
  if (ci < 0 || ci >= ${CHAN_FLOATS}) { return k; }
  return bitcast<f32>(reader[MG_CHAN_BASE + u32(ci)]);
}

fn mg_pal(i: u32) -> vec4f {
  let c = unpack4x8unorm(reader[reader[MH_PALETTE] + (i & 31u)]);
  return vec4f(pg_srgb_dec(c.rgb), c.a);
}
fn mg_mixc(c1: u32, c2: u32, mixch: i32) -> vec4f {
  let a = mg_pal(c1);
  if (mixch < 0) { return a; }
  return mix(a, mg_pal(c2), saturate(mg_chan(mixch)));
}
// straight alpha over
fn mg_over(t: vec4f, b: vec4f) -> vec4f {
  let a = t.a + b.a * (1.0 - t.a);
  return vec4f((t.rgb * t.a + b.rgb * b.a * (1.0 - t.a)) / max(a, 1e-5), a);
}

fn mg_box(p: vec2f, a: vec2f, b: vec2f, fw: f32) -> f32 {
  let lo = max(a, p - vec2f(0.5 * fw));
  let hi = min(b, p + vec2f(0.5 * fw));
  let o = clamp(hi - lo, vec2f(0.0), vec2f(fw)) / fw;
  return o.x * o.y;
}

// ---- Slug coverage (glyphs and filled paths): see SlugPixelShader.hlsl ----
fn mg_root_code(y1: f32, y2: f32, y3: f32) -> u32 {
  var s = 0u;
  if (y1 < 0.0) { s |= 1u; }
  if (y2 < 0.0) { s |= 2u; }
  if (y3 < 0.0) { s |= 4u; }
  return (0x2E74u >> s) & 0x0101u;
}

fn mg_solve_poly(p12: vec4f, p3: vec2f, horiz: bool) -> vec2f {
  let a = p12.xy - p12.zw * 2.0 + p3;
  let b = p12.xy - p12.zw;
  let ca = select(a.x, a.y, horiz);
  let cb = select(b.x, b.y, horiz);
  let c0 = select(p12.x, p12.y, horiz);
  var t1: f32;
  var t2: f32;
  if (abs(ca) < 1.0 / 65536.0) {
    t1 = c0 * 0.5 / cb;
    t2 = t1;
  } else {
    let dd = sqrt(max(cb * cb - ca * c0, 0.0));
    let ra = 1.0 / ca;
    t1 = (cb - dd) * ra;
    t2 = (cb + dd) * ra;
  }
  let oa = select(a.y, a.x, horiz);
  let ob = select(b.y, b.x, horiz);
  let o0 = select(p12.y, p12.x, horiz);
  return vec2f((oa * t1 - ob * 2.0) * t1 + o0, (oa * t2 - ob * 2.0) * t2 + o0);
}

// coverage of glyph gid (bit 31 = the article's own table) at em-space point rc (y up); eo = even-odd fill
fn slug_cov(gid: u32, rc: vec2f, ppe: f32, eo: bool) -> f32 {
  let extra = (gid & 0x80000000u) != 0u;
  let gi = gid & 0x7fffffffu;
  let dir = select(reader[MH_FDIR], reader[MH_XDIR], extra) + gi * 8u;
  let cur = select(reader[MH_FCUR], reader[MH_XCUR], extra);
  let band = select(reader[MH_FBAND], reader[MH_XBAND], extra);
  let bstart = band + reader[dir + 1u];
  let nh = reader[dir + 2u] & 0xffffu;
  let nv = reader[dir + 2u] >> 16u;
  let bx0 = bitcast<f32>(reader[dir + 4u]);
  let by0 = bitcast<f32>(reader[dir + 5u]);
  let bx1 = bitcast<f32>(reader[dir + 6u]);
  let by1 = bitcast<f32>(reader[dir + 7u]);
  let e = 1.0 / ppe;
  if (rc.x < bx0 - e || rc.x > bx1 + e || rc.y < by0 - e || rc.y > by1 + e) { return 0.0; }
  let kh = u32(clamp(floor((rc.y - by0) / max(by1 - by0, 1e-6) * f32(nh)), 0.0, f32(nh) - 1.0));
  let kv = u32(clamp(floor((rc.x - bx0) / max(bx1 - bx0, 1e-6) * f32(nv)), 0.0, f32(nv) - 1.0));

  var xcov = 0.0;
  var xwgt = 0.0;
  let hh = reader[bstart + kh];
  let hn = hh & 0xffffu;
  let hoff = bstart + (hh >> 16u);
  for (var i = 0u; i < hn; i++) {
    let tx = reader[hoff + i];
    let p12 = vec4f(unpack2x16float(reader[cur + 2u * tx]), unpack2x16float(reader[cur + 2u * tx + 1u])) - vec4f(rc, rc);
    let p3 = unpack2x16float(reader[cur + 2u * tx + 2u]) - rc;
    if (max(max(p12.x, p12.z), p3.x) * ppe < -0.5) { break; }
    let code = mg_root_code(p12.y, p12.w, p3.y);
    if (code != 0u) {
      let r = mg_solve_poly(p12, p3, true) * ppe;
      if ((code & 1u) != 0u) { xcov += saturate(r.x + 0.5); xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0)); }
      if (code > 1u) { xcov -= saturate(r.y + 0.5); xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0)); }
    }
  }
  var ycov = 0.0;
  var ywgt = 0.0;
  let vh = reader[bstart + nh + kv];
  let vn = vh & 0xffffu;
  let voff = bstart + (vh >> 16u);
  for (var i = 0u; i < vn; i++) {
    let tx = reader[voff + i];
    let p12 = vec4f(unpack2x16float(reader[cur + 2u * tx]), unpack2x16float(reader[cur + 2u * tx + 1u])) - vec4f(rc, rc);
    let p3 = unpack2x16float(reader[cur + 2u * tx + 2u]) - rc;
    if (max(max(p12.y, p12.w), p3.y) * ppe < -0.5) { break; }
    let code = mg_root_code(p12.x, p12.z, p3.x);
    if (code != 0u) {
      let r = mg_solve_poly(p12, p3, false) * ppe;
      if ((code & 1u) != 0u) { ycov -= saturate(r.x + 0.5); ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0)); }
      if (code > 1u) { ycov += saturate(r.y + 0.5); ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0)); }
    }
  }
  var c = max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov)));
  if (eo) { c = 1.0 - abs(1.0 - (c - 2.0 * floor(c * 0.5))); }
  return saturate(c);
}

// ---- groups: forward transform P = pivot + S R (q - pivot) + t, chain root to leaf; returns the item-local point,
// the item-local pixel footprint and the product of opacities as (x, y, fw, alpha)
fn mg_xf(g0: u32, p: vec2f, fw: f32) -> vec4f {
  if (g0 == MG_NONE16) { return vec4f(p, fw, 1.0); }
  var chain: array<u32, 6>;
  var n = 0u;
  var gi = g0;
  for (var k = 0u; k < 6u; k++) {
    chain[n] = gi;
    n++;
    let r = reader[MH_GROUPS] + gi * SZ_GROUP;
    let par = ${g('group', 'parent')};
    if (par < 0) { break; }
    gi = u32(par);
  }
  var q = p;
  var f = fw;
  var a = 1.0;
  for (var k = n; k > 0u; k--) {
    let r = reader[MH_GROUPS] + chain[k - 1u] * SZ_GROUP;
    let tx = mg_cv(${g('group', 'txChan')}, ${g('group', 'tx')});
    let ty = mg_cv(${g('group', 'tyChan')}, ${g('group', 'ty')});
    let rot = mg_cv(${g('group', 'rotChan')}, ${g('group', 'rot')});
    let scl = max(abs(mg_cv(${g('group', 'scaleChan')}, ${g('group', 'scale')})), 1e-4);
    let op = mg_cv(${g('group', 'opacityChan')}, ${g('group', 'opacity')});
    let pv = vec2f(${g('group', 'pivotX')}, ${g('group', 'pivotY')});
    let c = cos(rot);
    let s = sin(rot);
    let w = q - vec2f(tx, ty) - pv;
    q = pv + vec2f(c * w.x + s * w.y, -s * w.x + c * w.y) / scl;
    f = f / scl;
    a *= saturate(op);
  }
  return vec4f(q, f, a);
}

// ---- quadratic Bezier: closest point (closed form cubic), arc length ----
// returns (distance, t)
fn mg_quad_dist(pa: vec2f, pb: vec2f, pc: vec2f, pos: vec2f) -> vec2f {
  let a = pb - pa;
  let b = pa - 2.0 * pb + pc;
  let c = a * 2.0;
  let d = pa - pos;
  let bb = dot(b, b);
  if (bb < 1e-9) {
    let e = pc - pa;
    let t = clamp(dot(pos - pa, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    return vec2f(length(pos - (pa + e * t)), t);
  }
  let kk = 1.0 / bb;
  let kx = kk * dot(a, b);
  let ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  let kz = kk * dot(d, a);
  let p = ky - kx * kx;
  let p3 = p * p * p;
  let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  var h = q * q + 4.0 * p3;
  var res = 0.0;
  var tt = 0.0;
  if (h >= 0.0) {
    h = sqrt(h);
    let x = (vec2f(h, -h) - q) * 0.5;
    let uv = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
    tt = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    let dv = d + (c + b * tt) * tt;
    res = dot(dv, dv);
  } else {
    let z = sqrt(-p);
    let v = acos(clamp(q / (p * z * 2.0), -1.0, 1.0)) / 3.0;
    let m = cos(v);
    let n = sin(v) * 1.732050808;
    let t3 = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));
    let d1 = d + (c + b * t3.x) * t3.x;
    let d2 = d + (c + b * t3.y) * t3.y;
    let r1 = dot(d1, d1);
    let r2 = dot(d2, d2);
    if (r1 < r2) { res = r1; tt = t3.x; } else { res = r2; tt = t3.y; }
  }
  return vec2f(sqrt(res), tt);
}

// speed |B'(t)| / 2 style helper: a = pb - pa, b = pa - 2 pb + pc
fn mg_speed(a: vec2f, b: vec2f, t: f32) -> f32 { return 2.0 * length(a + b * t); }
// arc length from 0 to t, 3 point Gauss-Legendre
fn mg_arc(a: vec2f, b: vec2f, t: f32) -> f32 {
  let h = 0.5 * t;
  let k = 0.7745966692;
  return h * (0.5555555556 * (mg_speed(a, b, h * (1.0 - k)) + mg_speed(a, b, h * (1.0 + k))) + 0.8888888889 * mg_speed(a, b, h));
}

struct MgNear { d: f32, s: f32, len: f32 };

fn mg_stroke_len(si: u32) -> f32 {
  let sr = reader[MH_STROKES] + si * SZ_STROKE;
  let last = ${g('stroke', 'firstSeg', 'sr')} + ${g('stroke', 'segCount', 'sr')} - 1u;
  let r = reader[MH_SEGS] + last * SZ_SEG;
  return ${g('seg', 'cum')} + ${g('seg', 'len')};
}

// nearest point of stroke si within reach: effective distance (caps applied), arc coordinate s, total length
fn mg_stroke_near(si: u32, p: vec2f, reach: f32, hw: f32) -> MgNear {
  let sr = reader[MH_STROKES] + si * SZ_STROKE;
  let first = ${g('stroke', 'firstSeg', 'sr')};
  let count = ${g('stroke', 'segCount', 'sr')};
  let flags = ${g('stroke', 'flags', 'sr')};
  var best = 1.0e9;
  var bs = 0u;
  var bt = 0.0;
  for (var i = 0u; i < count; i++) {
    let r = reader[MH_SEGS] + (first + i) * SZ_SEG;
    let p0 = vec2f(${g('seg', 'x0')}, ${g('seg', 'y0')});
    let p1 = vec2f(${g('seg', 'x1')}, ${g('seg', 'y1')});
    let p2 = vec2f(${g('seg', 'x2')}, ${g('seg', 'y2')});
    let lo = min(min(p0, p1), p2) - vec2f(reach);
    let hi = max(max(p0, p1), p2) + vec2f(reach);
    if (p.x < lo.x || p.y < lo.y || p.x > hi.x || p.y > hi.y) { continue; }
    let dq = mg_quad_dist(p0, p1, p2, p);
    if (dq.x < best) { best = dq.x; bs = i; bt = dq.y; }
  }
  let lr = reader[MH_SEGS] + (first + count - 1u) * SZ_SEG;
  let total = ff32(lr, ${segCum}u) + ff32(lr, ${fieldOffset('seg', 'len')}u);
  if (best > reach) { return MgNear(1.0e9, 0.0, total); }
  let r = reader[MH_SEGS] + (first + bs) * SZ_SEG;
  let p0 = vec2f(${g('seg', 'x0')}, ${g('seg', 'y0')});
  let p1 = vec2f(${g('seg', 'x1')}, ${g('seg', 'y1')});
  let p2 = vec2f(${g('seg', 'x2')}, ${g('seg', 'y2')});
  let a = p1 - p0;
  let b = p0 - 2.0 * p1 + p2;
  let g1 = max(mg_arc(a, b, 1.0), 1e-6);
  let s = ${g('seg', 'cum')} + ${g('seg', 'len')} * mg_arc(a, b, bt) / g1;
  var de = best;
  if ((flags & 8u) == 0u) {
    var ex = -1.0;
    if (bs == 0u && bt <= 0.0) {
      var tg = p1 - p0;
      if (dot(tg, tg) < 1e-12) { tg = p2 - p0; }
      ex = -dot(p - p0, normalize(tg));
    } else if (bs == count - 1u && bt >= 1.0) {
      var tg = p2 - p1;
      if (dot(tg, tg) < 1e-12) { tg = p2 - p0; }
      ex = dot(p - p2, normalize(tg));
    }
    if (ex > 0.0) {
      let perp = sqrt(max(best * best - ex * ex, 0.0));
      let cap = flags & 3u;
      if (cap == 1u) { de = max(perp, ex + hw); }
      else if (cap == 2u) { de = max(perp, ex); }
    }
  }
  return MgNear(de, s, total);
}

// point and unit tangent of stroke si at arc coordinate s: (x, y, tx, ty)
fn mg_stroke_at(si: u32, s: f32) -> vec4f {
  let sr = reader[MH_STROKES] + si * SZ_STROKE;
  let first = ${g('stroke', 'firstSeg', 'sr')};
  let count = ${g('stroke', 'segCount', 'sr')};
  var k = 0u;
  for (var i = 0u; i < count; i++) {
    let rr = reader[MH_SEGS] + (first + i) * SZ_SEG;
    if (ff32(rr, ${segCum}u) <= s) { k = i; }
  }
  let r = reader[MH_SEGS] + (first + k) * SZ_SEG;
  let p0 = vec2f(${g('seg', 'x0')}, ${g('seg', 'y0')});
  let p1 = vec2f(${g('seg', 'x1')}, ${g('seg', 'y1')});
  let p2 = vec2f(${g('seg', 'x2')}, ${g('seg', 'y2')});
  let fr = clamp((s - ${g('seg', 'cum')}) / max(${g('seg', 'len')}, 1e-6), 0.0, 1.0);
  let a = p1 - p0;
  let b = p0 - 2.0 * p1 + p2;
  let g1 = max(mg_arc(a, b, 1.0), 1e-6);
  var lo = 0.0;
  var hi = 1.0;
  for (var j = 0; j < 6; j++) {
    let mid = 0.5 * (lo + hi);
    if (mg_arc(a, b, mid) / g1 < fr) { lo = mid; } else { hi = mid; }
  }
  let t = 0.5 * (lo + hi);
  let pos = (1.0 - t) * (1.0 - t) * p0 + 2.0 * (1.0 - t) * t * p1 + t * t * p2;
  var tg = a + b * t;
  if (dot(tg, tg) < 1e-12) { tg = p2 - p0; }
  let tn = normalize(tg);
  return vec4f(pos, tn);
}

// ---- item evaluators: each returns straight-alpha colour, alpha already includes coverage and group opacity ----
fn mg_glyph(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_GLYPHS] + ix * SZ_GLYPH;
  let q = mg_xf(${g('glyph', 'group')}, p0, fw0);
  let size = ${g('glyph', 'size')};
  let rc = vec2f((q.x - ${g('glyph', 'x')}) / size, (${g('glyph', 'y')} - q.y) / size);
  let cov = slug_cov(${g('glyph', 'glyphId')}, rc, size / q.z, false);
  if (cov <= 0.0) { return vec4f(0.0); }
  let pc = mg_pal(${g('glyph', 'colour')});
  return vec4f(pc.rgb, cov * pc.a * q.w);
}

fn mg_rect(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_RECTS] + ix * SZ_RECT;
  let q = mg_xf(${g('rect', 'group')}, p0, fw0);
  let a = vec2f(${g('rect', 'x0')}, ${g('rect', 'y0')});
  let b = vec2f(${g('rect', 'x1')}, ${g('rect', 'y1')});
  let rad = min(${g('rect', 'radius')}, 0.5 * min(b.x - a.x, b.y - a.y));
  var cov = 0.0;
  var edge = 0.0;
  if (rad > 1e-4) {
    // rounded box: analytic coverage from the signed distance and the pixel footprint
    let c = 0.5 * (a + b);
    let h = 0.5 * (b - a);
    let qq = abs(q.xy - c) - h + vec2f(rad);
    let sd = length(max(qq, vec2f(0.0))) + min(max(qq.x, qq.y), 0.0) - rad;
    cov = saturate(0.5 - sd / q.z);
    // 1 px hairline just inside the edge (code panel, RectKind.codeBg = 1): 1 where -1 px < sd < 0
    edge = saturate(0.5 - (-sd - q.z) / q.z) * select(0.0, 1.0, ${g('rect', 'kind')} == 1u);
  } else {
    cov = mg_box(q.xy, a, b, q.z);
  }
  if (cov <= 0.0) { return vec4f(0.0); }
  var pc = mg_pal(${g('rect', 'colour')});
  if (edge > 0.0) { pc = mix(pc, mg_pal(4u), edge); } // palette slot 4 (PAL2.rule) is the hairline colour (theme.ts hairline)
  return vec4f(pc.rgb, cov * pc.a * q.w);
}

fn mg_image(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_IMAGES] + ix * SZ_IMAGE;
  let a = vec2f(${g('image', 'x0')}, ${g('image', 'y0')});
  let b = vec2f(${g('image', 'x1')}, ${g('image', 'y1')});
  let cov = mg_box(p0, a, b, fw0);
  if (cov <= 0.0) { return vec4f(0.0); }
  let slot = ${g('image', 'imageId')};
  let us = unpack2x16float(${g('image', 'altOffset')});
  let uv = (p0 - a) / (b - a);
  let ddx = vec2f(fw0 / (b.x - a.x) * us.x, 0.0);
  let ddy = vec2f(0.0, fw0 / (b.y - a.y) * us.y);
  let sm = textureSampleGrad(reader_img, img_s, clamp(uv, vec2f(0.0), vec2f(1.0)) * us, slot, ddx, ddy);
  var im = sm.rgb;
  im *= 0.9;
  return vec4f(im, cov * sm.a);
}

fn mg_hatch(p: vec2f, period: f32, phase: f32, fw: f32) -> f32 {
  let v = (p.x + p.y) * 0.70710678;
  let k = v / period + phase;
  let fr = k - floor(k);
  let dist = abs(fr - 0.5) * period;
  let cov = saturate(0.5 - (dist - 0.175 * period) / fw);
  let amp = saturate((period / fw - 1.5) / 2.0);
  return mix(0.35, cov, amp);
}

fn mg_dist_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let e = b - a;
  let t = clamp(dot(p - a, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
  return length(p - (a + e * t));
}

fn mg_shape(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_SHAPES] + ix * SZ_SHAPE;
  let q = mg_xf(${g('shape', 'group')}, p0, fw0);
  let p = q.xy;
  let fw = q.z;
  let a = vec2f(${g('shape', 'x0')}, ${g('shape', 'y0')});
  let b = vec2f(${g('shape', 'x1')}, ${g('shape', 'y1')});
  let kind = ${g('shape', 'kind')};
  let flags = ${g('shape', 'flags')};
  let param = ${g('shape', 'param')};
  let chan = ${g('shape', 'chan')};
  let pad = 2.0 * fw + param + select(0.0, 2.0, kind == 6u);
  if (p.x < a.x - pad || p.y < a.y - pad || p.x > b.x + pad || p.y > b.y + pad) { return vec4f(0.0); }
  let c1 = mg_pal(${g('shape', 'colour')});
  let c2 = mg_pal(${g('shape', 'colour2')});
  let hasStroke = (flags & 1u) != 0u;
  let cm = mg_mixc(${g('shape', 'colour')}, ${g('shape', 'colour2')}, select(${g('shape', 'mixChan')}, -1, hasStroke));
  var out = vec4f(0.0);

  if (kind == 0u || kind == 1u) {
    // rrect (0) and circle (1): fill, optional inside stroke (colour2), optional hatch
    var sd = 0.0;
    var inside = 1.0;
    if (kind == 0u) {
      var bb = b;
      if (chan >= 0) {
        let rv = saturate(mg_chan(chan));
        if (rv < 0.002) { return vec4f(0.0); }
        bb.x = a.x + (b.x - a.x) * rv;
      }
      let c = 0.5 * (a + bb);
      let h = 0.5 * (bb - a);
      let rad = min(${g('shape', 'radius')}, min(h.x, h.y));
      let qq = abs(p - c) - h + vec2f(rad);
      sd = length(max(qq, vec2f(0.0))) + min(max(qq.x, qq.y), 0.0) - rad;
    } else {
      let sm = select(1.0, max(mg_chan(chan), 0.0), chan >= 0);
      let c = 0.5 * (a + b);
      sd = length(p - c) - 0.5 * (b.x - a.x) * sm;
    }
    inside = saturate(0.5 - sd / fw);
    var fillc = cm;
    fillc.a = select(cm.a * inside, 0.0, (flags & 2u) != 0u);
    if ((flags & 4u) != 0u) {
      let hv = mg_hatch(p, 0.7, 0.0, fw) * inside * c2.a;
      fillc = mg_over(vec4f(c2.rgb, hv * 0.6), fillc);
    }
    out = fillc;
    if (hasStroke) {
      let ring = abs(sd + 0.5 * param) - 0.5 * param;
      out = mg_over(vec4f(c2.rgb, saturate(0.5 - ring / fw) * c2.a), out);
    }
  } else if (kind == 2u) {
    // line a to b, width param, round caps, chan reveals along the line
    var pb = b;
    if (chan >= 0) {
      let rv = saturate(mg_chan(chan));
      if (rv < 0.002) { return vec4f(0.0); }
      pb = mix(a, b, rv);
    }
    let w = max(param, 0.0);
    let hwe = max(0.5 * w, 0.5 * fw);
    let cov = saturate(0.5 - (mg_dist_seg(p, a, pb) - hwe) / fw) * min(1.0, w / fw);
    out = vec4f(cm.rgb, cov * cm.a);
  } else if (kind == 3u) {
    // arrow head at the trimmed end of stroke aux
    let si = ${g('shape', 'aux')};
    let sr = reader[MH_STROKES] + si * SZ_STROKE;
    let t1 = mg_cv(${g('stroke', 'trimT1Chan', 'sr')}, 1.0);
    let t0 = mg_cv(${g('stroke', 'trimT0Chan', 'sr')}, 0.0);
    if (t1 <= t0 + 1e-3) { return vec4f(0.0); }
    let tp = mg_stroke_at(si, clamp(t1, 0.0, 1.0) * mg_stroke_len(si));
    let rel = p - tp.xy;
    let u = dot(rel, tp.zw);
    let v = abs(rel.x * tp.w - rel.y * tp.z);
    let hl = max(${g('shape', 'radius')}, 1e-3);
    let hwid = max(param, 1e-3);
    let dbase = -u - hl;
    let dside = (v * hl + hwid * u) / sqrt(hl * hl + hwid * hwid);
    out = vec4f(cm.rgb, saturate(0.5 - max(dbase, dside) / fw) * cm.a);
  } else if (kind == 4u) {
    // hatch field over the bounds, chan = phase in periods
    let period = select(0.6, param, param > 0.0);
    let cov = mg_box(p, a, b, fw) * mg_hatch(p, period, mg_cv(chan, 0.0), fw);
    out = vec4f(cm.rgb, cov * cm.a);
  } else if (kind == 5u) {
    // dots travelling along stroke aux: count in flags, stagger (fraction of the path) in param, u in chan, radius in radius
    let si = ${g('shape', 'aux')};
    let rad = max(${g('shape', 'radius')}, 1e-3);
    let nr = mg_stroke_near(si, p, rad + fw, rad);
    if (nr.d > rad + fw) { return vec4f(0.0); }
    let cnt = f32(max(flags, 1u));
    let u = mg_cv(chan, 0.0);
    let L = max(nr.len, 1e-6);
    var cov = 0.0;
    var k0 = 0.0;
    var nk = 1;
    if (param > 1e-5) {
      k0 = floor((u - nr.s / L) / param + 0.5) - 1.0;
      nk = 3;
    }
    for (var j = 0; j < nk; j++) {
      let k = k0 + f32(j);
      if (k < 0.0 || k >= cnt) { continue; }
      let uk = u - k * param;
      if (uk < 0.0 || uk > 1.0) { continue; }
      let dd = length(vec2f(nr.d, nr.s - uk * L));
      cov = max(cov, saturate(0.5 - (dd - rad) / fw));
    }
    out = vec4f(cm.rgb, cov * cm.a);
  } else if (kind == 6u) {
    // ring: radius grows to half the bounds width with progress (chan), thickness param, fades out
    let prog = saturate(select(1.0, mg_chan(chan), chan >= 0));
    if (prog <= 0.0) { return vec4f(0.0); }
    let th = select(0.15, param, param > 0.0);
    let c = 0.5 * (a + b);
    let sd = abs(length(p - c) - 0.5 * (b.x - a.x) * prog) - 0.5 * th;
    out = vec4f(cm.rgb, saturate(0.5 - sd / fw) * cm.a * (1.0 - prog));
  }
  out.a *= q.w;
  return out;
}

fn mg_path(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_PATHS] + ix * SZ_PATH;
  let q = mg_xf(${g('path', 'group')}, p0, fw0);
  let scale = max(${g('path', 'scale')}, 1e-6);
  let rc = vec2f((q.x - ${g('path', 'x')}) / scale, (${g('path', 'y')} - q.y) / scale);
  let cov = slug_cov(0x80000000u | ${g('path', 'glyphIdx')}, rc, scale / q.z, (${g('path', 'flags')} & 1u) != 0u);
  if (cov <= 0.0) { return vec4f(0.0); }
  let pc = mg_pal(${g('path', 'colour')});
  return vec4f(pc.rgb, cov * pc.a * q.w);
}

fn mg_stroke(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let sr = reader[MH_STROKES] + ix * SZ_STROKE;
  let q = mg_xf(${g('stroke', 'group', 'sr')}, p0, fw0);
  let p = q.xy;
  let fw = q.z;
  let w = max(mg_cv(${g('stroke', 'widthChan', 'sr')}, ${g('stroke', 'width', 'sr')}), 0.0);
  let hw = max(0.5 * w, 0.5 * fw);
  let t0 = mg_cv(${g('stroke', 'trimT0Chan', 'sr')}, 0.0);
  let t1 = mg_cv(${g('stroke', 'trimT1Chan', 'sr')}, 1.0);
  if (t1 <= t0 || t1 <= 0.0 || t0 >= 1.0) { return vec4f(0.0); }
  let nr = mg_stroke_near(ix, p, hw + fw, hw);
  if (nr.d > hw + fw) { return vec4f(0.0); }
  var cov = saturate(0.5 - (nr.d - hw) / fw) * min(1.0, w / fw);
  if (t0 > 0.0) { cov *= saturate((nr.s - t0 * nr.len) / fw + 0.5); }
  if (t1 < 1.0) { cov *= saturate((t1 * nr.len - nr.s) / fw + 0.5); }
  let don = ${g('stroke', 'dashOn', 'sr')};
  if (don > 0.0) {
    let per = don + ${g('stroke', 'dashOff', 'sr')};
    let qq = (nr.s - mg_cv(${g('stroke', 'phaseChan', 'sr')}, 0.0)) / per;
    let u = (qq - floor(qq)) * per;
    cov *= max(saturate(min(u, don - u) / fw + 0.5), saturate((u - per) / fw + 0.5));
  }
  if (cov <= 0.0) { return vec4f(0.0); }
  let c = mg_mixc(${g('stroke', 'colour', 'sr')}, ${g('stroke', 'colour2', 'sr')}, ${g('stroke', 'mixChan', 'sr')});
  return vec4f(c.rgb, cov * c.a * q.w);
}

// one digit glyph of an odometer, solid or outlined
fn mg_digit(gid: u32, rc: vec2f, ppe: f32, outline: bool) -> f32 {
  let c0 = slug_cov(gid, rc, ppe, false);
  if (!outline) { return c0; }
  let o = 0.045;
  let inner = min(min(slug_cov(gid, rc + vec2f(o, 0.0), ppe, false), slug_cov(gid, rc - vec2f(o, 0.0), ppe, false)),
                  min(slug_cov(gid, rc + vec2f(0.0, o), ppe, false), slug_cov(gid, rc - vec2f(0.0, o), ppe, false)));
  return saturate(c0 - inner);
}

fn mg_numeral(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_NUMERALS] + ix * SZ_NUMERAL;
  let q = mg_xf(${g('numeral', 'group')}, p0, fw0);
  let ox = ${g('numeral', 'x')};
  let oy = ${g('numeral', 'y')};
  let cw = max(${g('numeral', 'cellW')}, 1e-3);
  let size = ${g('numeral', 'size')};
  let digits = ${g('numeral', 'digits')};
  let fi = floor((q.x - ox) / cw);
  if (fi < 0.0 || fi >= f32(digits)) { return vec4f(0.0); }
  let top = oy - size * 0.82;
  let bot = oy + size * 0.22;
  let clip = saturate((q.y - top) / q.z + 0.5) * saturate((bot - q.y) / q.z + 0.5);
  if (clip <= 0.0) { return vec4f(0.0); }
  let i = u32(fi);
  let k = digits - 1u - i;
  let pw = pow(10.0, f32(k));
  let v = max(mg_cv(${g('numeral', 'chan')}, 0.0), 0.0);
  if (k > 0u && v < pw) { return vec4f(0.0); }
  let roll = v / pw;
  let whole = floor(roll);
  let cur = whole + saturate((roll - whole - 0.8) * 5.0);
  let dg = cur - 10.0 * floor(cur / 10.0);
  let da = floor(dg);
  let rf = dg - da;
  let db = select(da + 1.0, 0.0, da > 8.5);
  let lh = size * 1.2;
  let cx = ox + f32(i) * cw;
  let dset = ${g('numeral', 'digitSet')};
  let base = reader[MH_DIGITS] + dset * 10u;
  let outline = ${g('numeral', 'style')} == 1u;
  let ppe = size / q.z;
  var cov = mg_digit(reader[base + u32(da)], vec2f((q.x - cx) / size, (oy - rf * lh - q.y) / size), ppe, outline);
  if (rf > 0.001) {
    cov = max(cov, mg_digit(reader[base + u32(db)], vec2f((q.x - cx) / size, (oy + (1.0 - rf) * lh - q.y) / size), ppe, outline));
  }
  let pc = mg_pal(${g('numeral', 'colour')});
  return vec4f(pc.rgb, cov * clip * pc.a * q.w);
}
`;

/** Evaluator plus the four passes. */
export const PAGE_WGSL = /* wgsl */ `
${PAGE_EVAL_WGSL}

// Frame uniform (all vec4f):
//   v0 = (css viewport w, css viewport h, device px per css px, css px per em)
//   v1 = (css x of doc x = 0, css y of doc y = 0 at this frame (scroll applied), fold clip y em, fold fade em)
//   v2 = (em per device px, canvas 1 = 8 bit | 2 = extended float16 (both gamma encoded; 2 skips the dither), hdr cap, time)
//   v3 = ground rect (x0 y0 x1 y1 css px)
//   v4 = (ground corner radius css px, ground alpha, unused, unused)
//   v5 = unused
struct FrameU { v0: vec4f, v1: vec4f, v2: vec4f, v3: vec4f, v4: vec4f, v5: vec4f };
// per draw, dynamic offset: first item of the run, block opacity, block dy and dx in css px (dx > 0 moves the content left)
struct SegU { first: u32, pad0: u32, alpha: f32, dy: f32, dx: f32, pad1: f32, pad2: f32, pad3: f32 };
@group(1) @binding(0) var<uniform> fu: FrameU;
@group(1) @binding(1) var<uniform> sg: SegU;
@group(1) @binding(2) var<storage, read> fig_inst: array<vec4u>;
@group(1) @binding(3) var<storage, read> ovl: array<vec4f>;
// UI text glyphs, 3 vec4f each: (x css, y css baseline, size css px, glyph id as an exact f32 integer), (r g b a straight sRGB), (hdr, 0, 0, 0)
@group(1) @binding(4) var<storage, read> uitext: array<vec4f>;

fn pg_clip(px: vec2f) -> vec4f { return vec4f(px.x / fu.v0.x * 2.0 - 1.0, 1.0 - px.y / fu.v0.y * 2.0, 0.0, 1.0); }
fn pg_px(p: vec2f, dy: f32, dx: f32) -> vec2f { return vec2f(fu.v1.x + p.x * fu.v0.w - dx, fu.v1.y + p.y * fu.v0.w + dy); }
// document em point of a fragment centre
fn pg_doc(pos: vec2f, dy: f32, dx: f32) -> vec2f {
  let css = pos / fu.v0.z;
  return vec2f((css.x + dx - fu.v1.x) / fu.v0.w, (css.y - fu.v1.y - dy) / fu.v0.w);
}
fn pg_fold(y: f32) -> f32 { return saturate((fu.v1.z - y) / max(fu.v1.w, 1e-4)); }
// straight linear colour and alpha to the premultiplied output
fn pg_out(rgb: vec3f, a: f32) -> vec4f {
  var c = rgb;
  c = pg_srgb_enc(c);
  return vec4f(c * a, a);
}
fn pg_hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

// ---- text items ----
struct TOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) it: vec2u,
  @location(1) @interpolate(flat) ad: vec3f,
};

@vertex fn vs_text(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TOut {
  var o: TOut;
  let w = reader[reader[MH_ITEMS] + sg.first + ii];
  let ty = w >> 28u;
  let ix = w & 0x0fffffffu;
  let m = fu.v2.x;
  var lo = vec2f(0.0);
  var hi = vec2f(0.0);
  var ok = true;
  if (ty == 0u) {
    let r = reader[MH_GLYPHS] + ix * SZ_GLYPH;
    let gid = ${g('glyph', 'glyphId')};
    let size = ${g('glyph', 'size')};
    let gx = ${g('glyph', 'x')};
    let gy = ${g('glyph', 'y')};
    let extra = (gid & 0x80000000u) != 0u;
    let dir = select(reader[MH_FDIR], reader[MH_XDIR], extra) + (gid & 0x7fffffffu) * 8u;
    let b0 = vec2f(mg_f(dir + 4u), mg_f(dir + 5u));
    let b1 = vec2f(mg_f(dir + 6u), mg_f(dir + 7u));
    if (b1.x <= b0.x || b1.y <= b0.y) { ok = false; }
    lo = vec2f(gx + b0.x * size - m, gy - b1.y * size - m);
    hi = vec2f(gx + b1.x * size + m, gy - b0.y * size + m);
  } else if (ty == 1u) {
    let r = reader[MH_RECTS] + ix * SZ_RECT;
    lo = vec2f(${g('rect', 'x0')}, ${g('rect', 'y0')}) - vec2f(m);
    hi = vec2f(${g('rect', 'x1')}, ${g('rect', 'y1')}) + vec2f(m);
  } else if (ty == 2u) {
    let r = reader[MH_IMAGES] + ix * SZ_IMAGE;
    lo = vec2f(${g('image', 'x0')}, ${g('image', 'y0')}) - vec2f(m);
    hi = vec2f(${g('image', 'x1')}, ${g('image', 'y1')}) + vec2f(m);
  } else {
    ok = false;
  }
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  o.pos = select(vec4f(-2.0, -2.0, 0.0, 1.0), pg_clip(pg_px(mix(lo, hi, c), sg.dy, sg.dx)), ok);
  o.it = vec2u(ty, ix);
  o.ad = vec3f(sg.alpha, sg.dy, sg.dx);
  return o;
}

@fragment fn fs_text(in: TOut) -> @location(0) vec4f {
  let p = pg_doc(in.pos.xy, in.ad.y, in.ad.z);
  let fw = fu.v2.x;
  var c = vec4f(0.0);
  if (in.it.x == 0u) { c = mg_glyph(in.it.y, p, fw); }
  else if (in.it.x == 1u) { c = mg_rect(in.it.y, p, fw); }
  else { c = mg_image(in.it.y, p, fw); }
  let a = c.a * in.ad.x * pg_fold(p.y);
  if (a <= 0.0) { discard; }
  return pg_out(c.rgb, a);
}

// ---- figures ----
// straight alpha result of every item of the cell that holds the point p (document em); items in order, over blending
fn fig_eval(fi: u32, p: vec2f, fw: f32) -> vec4f {
  let r = reader[MH_FIGURES] + fi * SZ_FIGURE;
  let cols = ${g('figure', 'gridCols')};
  let rows = ${g('figure', 'gridRows')};
  if (cols == 0u || rows == 0u) { return vec4f(0.0); }
  let q = p - vec2f(${g('figure', 'x0')}, ${g('figure', 'y0')});
  let cx = u32(clamp(floor(q.x / MG_CELL_W), 0.0, f32(cols) - 1.0));
  let cy = u32(clamp(floor(q.y / MG_CELL_H), 0.0, f32(rows) - 1.0));
  let cr = reader[MH_CELLS] + (${g('figure', 'firstCell')} + cy * cols + cx) * SZ_CELL;
  let istart = reader[MH_ITEMS] + ${g('cell', 'start', 'cr')};
  let icount = ${g('cell', 'count', 'cr')};
  var acc = vec4f(0.0);
  for (var i = 0u; i < icount; i++) {
    let it = reader[istart + i];
    let ty = it >> 28u;
    let ix = it & 0x0fffffffu;
    var c = vec4f(0.0);
    if (ty == 0u) { c = mg_glyph(ix, p, fw); }
    else if (ty == 1u) { c = mg_rect(ix, p, fw); }
    else if (ty == 2u) { c = mg_image(ix, p, fw); }
    else if (ty == 3u) { c = mg_shape(ix, p, fw); }
    else if (ty == 4u) { c = mg_path(ix, p, fw); }
    else if (ty == 5u) { c = mg_stroke(ix, p, fw); }
    else if (ty == 7u) { c = mg_numeral(ix, p, fw); }
    if (c.a > 0.0) { acc = mg_over(c, acc); }
  }
  return acc;
}

struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) fi: u32,
  @location(1) @interpolate(flat) ad: vec2f,
};

@vertex fn vs_fig(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FOut {
  var o: FOut;
  let d = fig_inst[ii];
  let r = reader[MH_FIGURES] + d.x * SZ_FIGURE;
  let m = fu.v2.x;
  let lo = vec2f(${g('figure', 'x0')}, ${g('figure', 'y0')}) - vec2f(m);
  let hi = vec2f(${g('figure', 'x1')}, ${g('figure', 'y1')}) + vec2f(m);
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let dy = bitcast<f32>(d.z);
  o.pos = pg_clip(pg_px(mix(lo, hi, c), dy, 0.0));
  o.fi = d.x;
  o.ad = vec2f(bitcast<f32>(d.y), dy);
  return o;
}

@fragment fn fs_fig(in: FOut) -> @location(0) vec4f {
  let p = pg_doc(in.pos.xy, in.ad.y, 0.0);
  let c = fig_eval(in.fi, p, fu.v2.x);
  let a = c.a * in.ad.x * pg_fold(p.y);
  if (a <= 0.0) { discard; }
  return pg_out(c.rgb, a);
}

// ---- ground ----
fn pg_oklch(l: f32, ch: f32, hdeg: f32) -> vec3f {
  let h = radians(hdeg);
  let a = ch * cos(h);
  let b = ch * sin(h);
  let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  let lc = l_ * l_ * l_;
  let mc = m_ * m_ * m_;
  let sc = s_ * s_ * s_;
  return max(vec3f(
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc), vec3f(0.0));
}

fn pg_rrect_sd(p: vec2f, a: vec2f, b: vec2f, radius: f32) -> f32 {
  let c = 0.5 * (a + b);
  let h = 0.5 * (b - a);
  let rad = min(radius, min(h.x, h.y));
  let qq = abs(p - c) - h + vec2f(rad);
  return length(max(qq, vec2f(0.0))) + min(max(qq.x, qq.y), 0.0) - rad;
}

@vertex fn vs_ground(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs_ground(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let css = pos.xy / fu.v0.z;
  let sd = pg_rrect_sd(css, fu.v3.xy, fu.v3.zw, fu.v4.x);
  let cov = saturate(0.5 - sd * fu.v0.z);
  let ga = fu.v4.y * cov;
  if (ga <= 0.0) { discard; }
  // ground: ONE flat tinted near-black (theme.ts GROUND, TINT_HUE), identical on every page and at every scroll position
  var col = pg_oklch(${GROUND_WGSL.L}, ${GROUND_WGSL.chroma}, ${GROUND_WGSL.hue});
  col = pg_srgb_enc(col);
  if (fu.v2.y < 1.5) { col += vec3f((pg_hash(pos.xy) + pg_hash(pos.yx + 17.0) - 1.0) / 255.0); } // dither only the 8 bit canvas
  return vec4f(col * ga, ga);
}

// ---- overlays ----
struct OOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) oi: u32,
};

@vertex fn vs_ovl(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> OOut {
  var o: OOut;
  let r = ovl[3u * ii];
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let lo = r.xy - vec2f(1.5);
  let hi = r.xy + r.zw + vec2f(1.5);
  o.pos = pg_clip(mix(lo, hi, c));
  o.oi = ii;
  return o;
}

@fragment fn fs_ovl(in: OOut) -> @location(0) vec4f {
  let r = ovl[3u * in.oi];
  let k = ovl[3u * in.oi + 1u];
  let col = ovl[3u * in.oi + 2u];
  let css = in.pos.xy / fu.v0.z;
  let sd = pg_rrect_sd(css, r.xy, r.xy + r.zw, k.x);
  let a = col.a * saturate(0.5 - sd * fu.v0.z);
  if (a <= 0.0) { discard; }
  return pg_out(pg_srgb_dec(col.rgb) * k.y, a);
}

// ---- UI text ----
struct UOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) ui: u32,
};

@vertex fn vs_ui(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> UOut {
  var o: UOut;
  let g0 = uitext[3u * ii];
  let gid = u32(g0.w);
  let dir = reader[MH_FDIR] + gid * 8u;
  let b0 = vec2f(mg_f(dir + 4u), mg_f(dir + 5u));
  let b1 = vec2f(mg_f(dir + 6u), mg_f(dir + 7u));
  let m = 2.0 / fu.v0.z;
  let lo = vec2f(g0.x + b0.x * g0.z - m, g0.y - b1.y * g0.z - m);
  let hi = vec2f(g0.x + b1.x * g0.z + m, g0.y - b0.y * g0.z + m);
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let ok = b1.x > b0.x && b1.y > b0.y;
  o.pos = select(vec4f(-2.0, -2.0, 0.0, 1.0), pg_clip(mix(lo, hi, c)), ok);
  o.ui = ii;
  return o;
}

@fragment fn fs_ui(in: UOut) -> @location(0) vec4f {
  let g0 = uitext[3u * in.ui];
  let col = uitext[3u * in.ui + 1u];
  let k = uitext[3u * in.ui + 2u];
  let css = in.pos.xy / fu.v0.z;
  let rc = vec2f((css.x - g0.x) / g0.z, (g0.y - css.y) / g0.z);
  let cov = slug_cov(u32(g0.w), rc, g0.z * fu.v0.z, false);
  let a = cov * col.a;
  if (a <= 0.0) { discard; }
  return pg_out(pg_srgb_dec(col.rgb) * k.x, a);
}
`;
