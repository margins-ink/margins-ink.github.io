/**
 * Surface kind 10, the magazine spread (docs/MAGAZINE.md sections 1.6, 2.2, 4.4): Slug glyph and path coverage, analytic
 * strokes with trim and dash, shapes, groups driven by channels, odometer numerals, evaluated in the primary hit of the
 * tracer, plus the open-book geometry (two bowed sheets, a turning leaf of 8 strips, a peeling corner).
 * Replaces reader.wgsl.ts. Two blocks:
 *
 *   MAGAZINE_EVAL_WGSL   self contained evaluator: bindings, header, spread_albedo(). Needs nothing from the tracer, so
 *                        the flat preview page (tools/magazine-preview) includes just this block.
 *   MAGAZINE_TRACE_WGSL  appended to TRACE (shader.ts): uses sc, lvl, objs, atlas, atlas_s, pix_fw. Exposes page_trace,
 *                        page_shade, page_light (same names the tracer already calls).
 *   MAGAZINE_WGSL        both, in that order.
 *
 * Bindings (only cs and cs_view reference them, so the bake pipelines keep their layouts):
 *   6  reader      array<u32>: header, channel table (256 f32), fonts, the open article (layout in magazine.ts)
 *   27 reader_img  texture_2d_array<f32> rgba8unorm-srgb, one layer per image of the open article
 *   28 img_s       trilinear + anisotropic sampler
 *
 * Scene uniform fields (vec4f each, 24 floats from rd0; host fills them with writeRd in magazine.ts):
 *   rd0 = (k reading blend, magazine obj index or -1, em in metres, turn progress 0..1)
 *   rd1 = (spine world x, world y of the sheet top edge, spine plane z, turn dir -1 | 0 | +1)
 *   rd2 = (spread index shown, unused, hovered spread + 1 (0 none), dark 0|1)
 *   rd3 = hover rect in spread em (x0 y0 x1 y1)
 *   rd4 = (corner peel 0..1 or -1 for no corner, unused, unused, unused)
 *   rd5 = (bow radians, gutter shadow strength, paper gain, unused)
 *
 * Conventions the compile lane must match: item and record coordinates are spread-local em, y down, x from the left edge of
 * the left sheet (narrow class: spread = one sheet, x from its left edge, the spine is that edge); cell start is an
 * absolute index into the items table; a group or group field of 0xffff (NONE16) means none; channel fields are indices into
 * the 256 float channel table, -1 means "use the constant". Shape chan semantics: rrect, line: reveal fraction along x or
 * along the line; circle: radius multiplier; ring: progress (radius grows, alpha 1 - progress); dot: u along the stroke aux;
 * hatch: phase in periods. Stroke phaseChan is in em (positive flows toward the end). Numeral chan is the displayed value.
 *
 * WGSL reserved words avoided as identifiers (active, target, get, sample, texture, ref, half, loop, filter, mod, set, ...).
 * No backticks in comments: this is a TS template literal.
 */
import { REC2, SCHEMA, fieldOffset } from '../../magazine/format';

/** Header word indices of the reader buffer, shared with magazine.ts. */
export const MH = {
	magic: 0, sheetW: 1, spreadW: 2, spreadH: 3, cellW: 4, cellH: 5, spreadN: 6, single: 7,
	fdir: 8, fcur: 9, fband: 10, xdir: 11, xcur: 12, xband: 13,
	spreads: 14, cells: 15, items: 16, glyphs: 17, rects: 18, images: 19, shapes: 20, paths: 21, strokes: 22, segs: 23,
	groups: 24, numerals: 25, digits: 26, palette: 27, chans: 28
} as const;
export const MH_WORDS = 32;
export const CHAN_FLOATS = 256;
/** word index of the channel table (a per-frame writeBuffer subrange) */
export const CHAN_BASE = MH_WORDS;
/** first word after header and channel table: sections start here */
export const DATA_BASE = MH_WORDS + CHAN_FLOATS;
export const MAGIC_MAG = 0x4d414732; // 'MAG2'

type Rec = keyof typeof SCHEMA;
const FN: Record<string, string> = { f32: 'ff32', u32: 'fu32', i32: 'fi32', u16: 'fu16', i16: 'fi16', u8: 'fu8', f16: 'ff16' };
/** WGSL read expression for a record field, typed from SCHEMA, byte offset from fieldOffset (so strides cannot drift). */
const g = (rec: Rec, field: string, base = 'r'): string => {
	const ty = (SCHEMA[rec] as readonly (readonly [string, string])[]).find(([k]) => k === field)?.[1];
	if (!ty) throw new Error(`magazine.wgsl: no field ${rec}.${field}`);
	return `${FN[ty]}(${base}, ${fieldOffset(rec, field)}u)`;
};
const sz = (rec: Rec) => `${REC2[rec] / 4}u`;
const headerConsts = Object.entries(MH).map(([k, v]) => `const MH_${k.toUpperCase()} = ${v}u;`).join('\n');
const sizeConsts = (['spread', 'glyph', 'rect', 'image', 'shape', 'path', 'stroke', 'seg', 'group', 'numeral'] as Rec[])
	.map((k) => `const SZ_${k.toUpperCase()} = ${sz(k)};`).join('\n');
const segCum = fieldOffset('seg', 'cum');

export const MAGAZINE_EVAL_WGSL = /* wgsl */ `
@group(0) @binding(6) var<storage, read> reader: array<u32>;
@group(0) @binding(27) var reader_img: texture_2d_array<f32>;
@group(0) @binding(28) var img_s: sampler;

${headerConsts}
${sizeConsts}
const MG_CHAN_BASE = ${CHAN_BASE}u;
const MG_NONE16 = 0xffffu;
const PAL_PAPER = 17u;

// per-call state the host sets before spread_albedo (private, so the preview page can set it without the scene uniform)
var<private> mg_dark: f32 = 0.0;
var<private> mg_hov_spread: u32 = 0u;
var<private> mg_hov_rect: vec4f = vec4f(0.0);
var<private> mg_gain: f32 = 1.0;
var<private> mg_peel: f32 = -1.0;

// ---- typed field reads (byte offsets come from SCHEMA in format.ts) ----
fn mg_f(i: u32) -> f32 { return bitcast<f32>(reader[i]); }
fn fu32(r: u32, o: u32) -> u32 { return reader[r + (o >> 2u)]; }
fn ff32(r: u32, o: u32) -> f32 { return bitcast<f32>(reader[r + (o >> 2u)]); }
fn fi32(r: u32, o: u32) -> i32 { return bitcast<i32>(reader[r + (o >> 2u)]); }
fn fu16(r: u32, o: u32) -> u32 { return (reader[r + (o >> 2u)] >> ((o & 2u) * 8u)) & 0xffffu; }
fn fi16(r: u32, o: u32) -> i32 { return bitcast<i32>(fu16(r, o) << 16u) >> 16u; }
fn fu8(r: u32, o: u32) -> u32 { return (reader[r + (o >> 2u)] >> ((o & 3u) * 8u)) & 0xffu; }
fn ff16(r: u32, o: u32) -> f32 { return unpack2x16float(fu16(r, o)).x; }

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
  let c = unpack4x8unorm(reader[reader[MH_PALETTE] + select(0u, 32u, mg_dark > 0.5) + (i & 31u)]);
  return vec4f(pow(c.rgb, vec3f(2.2)), c.a);
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

fn mg_hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn mg_vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(mg_hash(i), mg_hash(i + vec2f(1.0, 0.0)), s.x),
             mix(mg_hash(i + vec2f(0.0, 1.0)), mg_hash(i + vec2f(1.0, 1.0)), s.x), s.y);
}
// band-limit a noise of frequency f (cycles per em) to the footprint fw (em)
fn mg_aa(f: f32, fw: f32) -> f32 { return 1.0 - smoothstep(0.15, 0.5, fw * f); }

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
fn mg_glyph(ix: u32, p0: vec2f, fw0: f32, hov: bool) -> vec4f {
  let r = reader[MH_GLYPHS] + ix * SZ_GLYPH;
  let q = mg_xf(${g('glyph', 'group')}, p0, fw0);
  let size = ${g('glyph', 'size')};
  let rc = vec2f((q.x - ${g('glyph', 'x')}) / size, (${g('glyph', 'y')} - q.y) / size);
  let cov = slug_cov(${g('glyph', 'glyphId')}, rc, size / q.z, false);
  if (cov <= 0.0) { return vec4f(0.0); }
  var ci = ${g('glyph', 'colour')};
  if (hov) { ci = 1u; }
  let pc = mg_pal(ci);
  return vec4f(pc.rgb, cov * pc.a * q.w);
}

fn mg_rect(ix: u32, p0: vec2f, fw0: f32) -> vec4f {
  let r = reader[MH_RECTS] + ix * SZ_RECT;
  let q = mg_xf(${g('rect', 'group')}, p0, fw0);
  let cov = mg_box(q.xy, vec2f(${g('rect', 'x0')}, ${g('rect', 'y0')}), vec2f(${g('rect', 'x1')}, ${g('rect', 'y1')}), q.z);
  if (cov <= 0.0) { return vec4f(0.0); }
  let pc = mg_pal(${g('rect', 'colour')});
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
  if (mg_dark > 0.5) { im *= 0.9; }
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

struct MgOut { col: vec3f, coat: f32 };

fn mg_paper() -> vec3f {
  let pp = mg_pal(PAL_PAPER);
  let fallback = select(vec3f(0.87, 0.835, 0.76), vec3f(0.0125, 0.0105, 0.009), mg_dark > 0.5);
  return select(fallback, pp.rgb, pp.a > 0.5) * mg_gain;
}

// albedo of spread si at the spread-local point p (em, y down); fw = footprint of one pixel in em
fn spread_albedo(si: u32, p: vec2f, fw: f32) -> MgOut {
  let r = reader[MH_SPREADS] + si * SZ_SPREAD;
  let cols = ${g('spread', 'gridCols')};
  let rows = ${g('spread', 'gridRows')};
  let mask = ${g('spread', 'materialMask')};
  var col = mg_paper();
  col *= 1.0 + 0.025 * (mix(0.5, mg_vnoise(p * 3.0 + vec2f(f32(si) * 7.0, 0.0)), mg_aa(3.0, fw)) - 0.5);
  var res = MgOut(col, 0.0);
  // below about 3 px per em text is a tone: the spread mean ink colour (build time)
  if (1.0 / fw < 3.0) {
    let t565 = ${g('spread', 'tone565')};
    let tone = vec3f(f32(t565 >> 11u) / 31.0, f32((t565 >> 5u) & 63u) / 63.0, f32(t565 & 31u) / 31.0);
    res.col = mix(col, pow(tone, vec3f(2.2)), 0.9);
    return res;
  }
  var keep = 1.0;
  if (mg_peel >= 0.0) {
    // peeling corner at the outer bottom corner of the right sheet: removed triangle, flap, fold shading
    let cx0 = ${g('spread', 'w')} - p.x;
    let cy0 = ${g('spread', 'h')} - p.y;
    let cs = 2.5 + mg_peel * 0.5 * mg_f(MH_SHEETW);
    let dl = (cx0 + cy0 - cs) * 0.70710678;
    keep = saturate(dl / fw + 0.5);
    let under = mg_paper() * (0.5 - 0.15 * saturate(-dl / cs));
    col = mix(under, col, keep);
    let fl = saturate(0.5 - (cx0 - cs) / fw) * saturate(0.5 - (cy0 - cs) / fw) * keep;
    let fold = saturate(dl / (0.7 * cs));
    col = mix(col, mg_paper() * (1.04 - 0.14 * fold), fl);
  }
  let cellw = mg_f(MH_CELLW);
  let cellh = mg_f(MH_CELLH);
  let cx = u32(clamp(floor(p.x / cellw), 0.0, f32(cols) - 1.0));
  let cy = u32(clamp(floor(p.y / cellh), 0.0, f32(rows) - 1.0));
  let cell = reader[MH_CELLS] + 2u * (${g('spread', 'firstCell')} + cy * cols + cx);
  let istart = reader[MH_ITEMS] + reader[cell];
  let icount = reader[cell + 1u] & 0xffffu;
  let hov = mg_hov_spread == si + 1u && p.x >= mg_hov_rect.x && p.x <= mg_hov_rect.z && p.y >= mg_hov_rect.y && p.y <= mg_hov_rect.w;
  let hovline = mg_hov_spread == si + 1u && p.x >= mg_hov_rect.x && p.x <= mg_hov_rect.z && p.y >= mg_hov_rect.w - 0.2 && p.y <= mg_hov_rect.w - 0.1;
  let coatOn = f32((mask >> 1u) & 1u);
  var coat = 0.0;
  for (var i = 0u; i < icount; i++) {
    let it = reader[istart + i];
    let ty = it >> 28u;
    let ix = it & 0x0fffffffu;
    var c = vec4f(0.0);
    var painted = true;
    if (ty == 0u) { c = mg_glyph(ix, p, fw, hov); painted = false; }
    else if (ty == 1u) { c = mg_rect(ix, p, fw); painted = false; }
    else if (ty == 2u) { c = mg_image(ix, p, fw); }
    else if (ty == 3u) { c = mg_shape(ix, p, fw); }
    else if (ty == 4u) { c = mg_path(ix, p, fw); }
    else if (ty == 5u) { c = mg_stroke(ix, p, fw); }
    else if (ty == 7u) { c = mg_numeral(ix, p, fw); }
    let al = c.a * keep;
    if (al > 0.0) {
      col = mix(col, c.rgb, al);
      if (painted) { coat = max(coat, al * coatOn); }
    }
  }
  if (hovline) { col = mix(col, mg_pal(1u).rgb, 0.9); }
  return MgOut(col, coat);
}
`;

export const MAGAZINE_TRACE_WGSL = /* wgsl */ `
struct PHit {
  t: f32,
  spread: u32,
  p: vec2f,    // spread-local position in em, y down
  a: f32,      // distance from the spine along the sheet, em
  n: vec3f,    // unit normal facing the viewer
  cs: f32,     // abs cosine between ray and normal
  vd: vec3f,   // ray direction
  face: u32,   // 0 front, 1 back of the turning leaf (shows another spread), 2 blank back
};

fn mg_cross(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }

// ray o2 + d2 t against the segment p0 + u (p1 - p0), in the (x, toward viewer) plane: returns (t, u), t < 0 on a miss
fn mg_seg(o2: vec2f, d2: vec2f, p0: vec2f, p1: vec2f) -> vec2f {
  let e = p1 - p0;
  let den = mg_cross(d2, e);
  if (abs(den) < 1e-9) { return vec2f(-1.0, 0.0); }
  let w = p0 - o2;
  let t = mg_cross(w, e) / den;
  let u = mg_cross(w, d2) / den;
  if (u < 0.0 || u > 1.0) { return vec2f(-1.0, 0.0); }
  return vec2f(t, u);
}

// Ray against the open book: left and right sheet bowed by rd5.x toward the viewer about the spine, and while rd1.w != 0
// the turning leaf, 8 strips hinged along the spine (front shows this spread, back shows the next or previous one).
fn page_trace(o: vec3f, d: vec3f) -> PHit {
  var res = PHit(-1.0, 0u, vec2f(0.0), 0.0, vec3f(0.0, 0.0, 1.0), 1.0, d, 0u);
  let ns = reader[MH_SPREADN];
  if (sc.rd0.x < 0.9 || ns == 0u) { return res; }
  let em = sc.rd0.z;
  let sw = mg_f(MH_SHEETW);
  let shh = mg_f(MH_SPREADH);
  let single = reader[MH_SINGLE] != 0u;
  let spx = select(sw, 0.0, single);
  let bow = sc.rd5.x;
  let len = sw * em;
  let sg = select(-1.0, 1.0, o.z >= sc.rd1.z);
  let o2 = vec2f(o.x - sc.rd1.x, sg * (o.z - sc.rd1.z));
  let d2 = vec2f(d.x, sg * d.z);
  var idx = min(u32(max(sc.rd2.x, 0.0)), ns - 1u);
  var dir = i32(round(sc.rd1.w));
  var prog = saturate(sc.rd0.w);
  // narrow class: turning back is the previous sheet turning forward, run in reverse
  if (single && dir < 0) {
    if (idx == 0u) { dir = 0; } else { idx -= 1u; dir = 1; prog = 1.0 - prog; }
  }
  if (dir > 0 && idx + 1u >= ns) { dir = 0; }
  if (dir < 0 && idx == 0u) { dir = 0; }

  // static sheets: side 0 left (outward is -x), side 1 right
  for (var side = 0; side < 2; side++) {
    if (single && side == 0) { continue; }
    let m = select(-1.0, 1.0, side == 1);
    var sp = idx;
    if (side == 1 && dir > 0) { sp = idx + 1u; }
    if (side == 0 && dir < 0) { sp = idx - 1u; }
    let h = mg_seg(o2, d2, vec2f(0.0), len * vec2f(m * cos(bow), sin(bow)));
    if (h.x <= 0.0 || (res.t > 0.0 && h.x >= res.t)) { continue; }
    let py = (sc.rd1.y - (o.y + d.y * h.x)) / em;
    if (py < 0.0 || py > shh) { continue; }
    let nn = vec2f(-m * sin(bow), cos(bow));
    let n3 = vec3f(nn.x, 0.0, sg * nn.y);
    res = PHit(h.x, sp, vec2f(spx + m * h.y * sw, py), h.y * sw, n3, abs(dot(d, n3)), d, 0u);
  }

  // turning leaf
  if (dir != 0) {
    let m = f32(dir);
    let phi = bow + prog * (3.14159265 - 2.0 * bow);
    let lag = 0.8 * sin(3.14159265 * prog);
    let sl = len / 8.0;
    var pt = vec2f(0.0);
    var best = PHit(-1.0, 0u, vec2f(0.0), 0.0, vec3f(0.0, 0.0, 1.0), 1.0, d, 0u);
    for (var j = 0; j < 8; j++) {
      let th = max(phi - lag * f32(j) / 7.0, bow);
      let p1 = pt + sl * vec2f(m * cos(th), sin(th));
      let h = mg_seg(o2, d2, pt, p1);
      pt = p1;
      if (h.x <= 0.0 || (best.t > 0.0 && h.x >= best.t)) { continue; }
      let py = (sc.rd1.y - (o.y + d.y * h.x)) / em;
      if (py < 0.0 || py > shh) { continue; }
      let a = (f32(j) + h.y) * sw / 8.0;
      let nf = vec2f(-m * sin(th), cos(th));
      let front = dot(d2, nf) < 0.0;
      var n3 = vec3f(nf.x, 0.0, sg * nf.y);
      if (!front) { n3 = -n3; }
      var sp = idx;
      var px = spx + m * a;
      var face = 0u;
      if (!front) {
        if (single) { face = 2u; px = a; }
        else { face = 1u; sp = select(idx - 1u, idx + 1u, dir > 0); px = spx - m * a; }
      }
      best = PHit(h.x, sp, vec2f(px, py), a, n3, abs(dot(d, n3)), d, face);
    }
    if (best.t > 0.0 && (res.t < 0.0 || best.t < res.t + 1e-4)) { res = best; }
  }
  return res;
}

// Irradiance of the reading light: the room lamp as a soft gradient over the sheet, tilted sheets get their own gradient.
// Exposure-independent (divides by tone.x) so the backdrop can darken without dimming the paper.
fn page_light_n(p: vec3f, n: vec3f, level: u32) -> f32 {
  let lamp = lvl[level * 3u + 1u].xyz;
  let dv = lamp - p;
  let f = 1.0 / (1.0 + 0.5 * dot(dv, dv));
  let nl = 0.75 + 0.25 * saturate(dot(n, dv / max(length(dv), 1e-4)));
  if (sc.rd2.w > 0.5) { return 0.9 * (0.98 + 0.3 * f * nl) / sc.tone.x; }
  return (0.98 + 0.5 * f * nl) / sc.tone.x;
}
fn page_light(p: vec3f, level: u32) -> f32 { return page_light_n(p, vec3f(0.0, 0.0, 1.0), level); }

struct PShade { alb: vec3f, e: f32 };

// the sheet's whole shading: (albedo, irradiance), paper-to-cover crossfade on the first spread, gutter shadow in the
// illumination term (not the albedo), clearcoat sheen on figure ink
fn page_shade(ph: PHit, wp: vec3f, level: u32) -> PShade {
  let em = sc.rd0.z;
  let sw = mg_f(MH_SHEETW);
  let shh = mg_f(MH_SPREADH);
  let single = reader[MH_SINGLE] != 0u;
  let spx = select(sw, 0.0, single);
  mg_dark = sc.rd2.w;
  mg_hov_spread = u32(max(sc.rd2.z, 0.0));
  mg_hov_rect = sc.rd3;
  mg_gain = select(1.0, sc.rd5.z, sc.rd5.z > 0.0);
  mg_peel = -1.0;
  if (sc.rd4.x >= 0.0 && ph.face == 0u && abs(sc.rd1.w) < 0.5 && ph.p.x >= spx) { mg_peel = sc.rd4.x; }
  let fw = pix_fw(ph.t) / em / max(ph.cs, 0.15);
  var out = MgOut(vec3f(0.0), 0.0);
  if (ph.face == 2u) {
    out.col = mg_paper() * 0.92;
  } else {
    out = spread_albedo(ph.spread, ph.p, fw);
  }
  var alb = out.col;
  let k = sc.rd0.x;
  if (ph.face == 0u && ph.spread == 0u && ph.p.x >= spx && sc.rd0.y >= 0.0 && k < 0.995) {
    let mg = objs[u32(sc.rd0.y)];
    let uv = (ph.p - vec2f(spx, 0.0)) / vec2f(sw, shh);
    let cover = textureSampleLevel(atlas, atlas_s, (mg.tx.xy + uv * mg.tx.zw) / 2048.0, 0.0).rgb;
    alb = mix(cover, alb, smoothstep(0.9, 0.99, k));
  }
  var e = page_light_n(wp, ph.n, level);
  if (!single) { e *= 1.0 - sc.rd5.y * exp(-ph.a / 1.6); }
  if (out.coat > 0.0) {
    let lamp = lvl[level * 3u + 1u].xyz;
    let hv = normalize(normalize(lamp - wp) - ph.vd);
    e *= 1.0 + 0.4 * out.coat * pow(saturate(dot(ph.n, hv)), 48.0);
  }
  return PShade(alb, e);
}
`;

export const MAGAZINE_WGSL = MAGAZINE_EVAL_WGSL + MAGAZINE_TRACE_WGSL;
