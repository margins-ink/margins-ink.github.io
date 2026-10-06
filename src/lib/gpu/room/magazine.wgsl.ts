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
 *
 * Scene uniform fields (vec4f each, 24 floats from rd0; host fills them with writeRd in magazine.ts):
 *   rd0 = (k reading blend, magazine obj index or -1, em in metres, turn progress 0..1)
 *   rd1 = (spine world x, world y of the sheet top edge, spine plane z, turn dir -1 | 0 | +1)
 *   rd2 = (spread index shown, hover kind 0 link | 1 figure, hovered spread + 1 (0 none), unused (the world has one look: dark))
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
/** word index of the selection highlight table: [count, spread + 1, then SEL_RECTS x (x0 y0 x1 y1) f32], a writeBuffer subrange */
export const SEL_BASE = MH_WORDS + CHAN_FLOATS;
export const SEL_RECTS = 160;
export const SEL_WORDS = 2 + 4 * SEL_RECTS;
export const DATA_BASE = SEL_BASE + SEL_WORDS;
export const MAGIC_MAG = 0x4d414732; // 'MAG2'

const headerConsts = Object.entries(MH).map(([k, v]) => `const MH_${k.toUpperCase()} = ${v}u;`).join('\n');

export const MAGAZINE_EVAL_WGSL = /* wgsl */ `
@group(0) @binding(6) var<storage, read> reader: array<u32>;

${headerConsts}
const MG_CHAN_BASE = ${CHAN_BASE}u;
const MG_SEL_BASE = ${SEL_BASE}u;
const MG_NONE16 = 0xffffu;
const PAL_PAPER = 17u;

// per-call state the host sets before spread_albedo (private, so the preview page can set it without the scene uniform)
var<private> mg_hov_spread: u32 = 0u;
var<private> mg_hov_rect: vec4f = vec4f(0.0);
var<private> mg_hov_kind: f32 = 0.0; // 0 link, 1 figure (scrubbable, drawn as a frame)
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
  let c = unpack4x8unorm(reader[reader[MH_PALETTE] + (i & 31u)]);
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

struct MgOut { col: vec3f, coat: f32 };

fn mg_paper() -> vec3f {
  let pp = mg_pal(PAL_PAPER);
  let fallback = vec3f(0.0125, 0.0105, 0.009);
  return select(fallback, pp.rgb, pp.a > 0.5) * mg_gain;
}

// the in-world book shows blank paper: reading happens on the page pass (src/lib/reading/page.ts), not on the 3D sheet
fn spread_albedo(si: u32, p: vec2f, fw: f32) -> MgOut {
  var col = mg_paper();
  col *= 1.0 + 0.025 * (mix(0.5, mg_vnoise(p * 3.0 + vec2f(f32(si) * 7.0, 0.0)), mg_aa(3.0, fw)) - 0.5);
  return MgOut(col, 0.0);
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

// ---- the front cover: a rigid board of thickness MG_COVER_T hinged on the spine, swung by the Flecs hinge channel (rd4.y, 0 closed
// .. 1 open, rd4.z = 1 while the board is in play). An oriented box in the (x, toward viewer) cross-section plane, extruded over the
// sheet height; slab test in the board frame (s along the board from the spine, v out of its outside face, y down the sheet). ----
const MG_COVER_T = 0.22;

struct CHit {
  t: f32,
  face: u32,   // 3 outside (cover art), 1 inside (the spread's left page; 2 blank for the narrow class), 4 edge
  a: f32,      // distance from the spine along the board, em
  py: f32,     // down the sheet, em
  n: vec3f,    // unit normal, facing the ray
};

fn mg_cover_psi() -> f32 {
  let bow = sc.rd5.x;
  return bow + saturate(sc.rd4.y) * (3.14159265 - 2.0 * bow);
}

fn mg_view_sg() -> f32 { return select(-1.0, 1.0, sc.cam.z >= sc.rd1.z); }

fn mg_cover(o: vec3f, d: vec3f, sg: f32) -> CHit {
  var res = CHit(-1.0, 0u, 0.0, 0.0, vec3f(0.0, 0.0, 1.0));
  let em = sc.rd0.z;
  let sw = mg_f(MH_SHEETW);
  let shh = mg_f(MH_SPREADH);
  let psi = mg_cover_psi();
  let e = vec2f(cos(psi), sin(psi));
  let nb = vec2f(-e.y, e.x);
  let o2 = vec2f(o.x - sc.rd1.x, sg * (o.z - sc.rd1.z)) / em;
  let d2 = vec2f(d.x, sg * d.z);
  // board frame: x = s, y = v, z = py (em, down the sheet)
  let ol = vec3f(dot(o2, e), dot(o2, nb), (sc.rd1.y - o.y) / em);
  let dl = vec3f(dot(d2, e), dot(d2, nb), -d.y);
  let lo = vec3f(0.0, 0.0, 0.0);
  let hi = vec3f(sw, MG_COVER_T, shh);
  var tn = -1e9;
  var tf = 1e9;
  var ax = 0u;
  var hiside = false;
  for (var i = 0u; i < 3u; i++) {
    let oa = ol[i];
    let da = dl[i];
    if (abs(da) < 1e-9) {
      if (oa < lo[i] || oa > hi[i]) { return res; }
      continue;
    }
    var t0 = (lo[i] - oa) / da;
    var t1 = (hi[i] - oa) / da;
    var h0 = false;
    if (t0 > t1) { let tt = t0; t0 = t1; t1 = tt; h0 = true; }
    if (t0 > tn) { tn = t0; ax = i; hiside = h0; }
    tf = min(tf, t1);
  }
  if (tn > tf || tn <= 0.0) { return res; }
  // tn is in em of path length per unit of d: the ray parameter in metres is tn * em
  let pl = ol + dl * tn;
  res.t = tn * em;
  res.a = pl.x;
  res.py = pl.z;
  var n2 = vec2f(0.0);
  var ny = 0.0;
  if (ax == 1u) {
    res.face = select(1u, 3u, hiside);
    n2 = select(-nb, nb, hiside);
  } else if (ax == 0u) {
    res.face = 4u;
    n2 = select(-e, e, hiside);
  } else {
    res.face = 4u;
    ny = select(1.0, -1.0, hiside);
  }
  res.n = vec3f(n2.x, ny, sg * n2.y);
  return res;
}

// Ray against the open book: left and right sheet bowed by rd5.x toward the viewer about the spine, and while rd1.w != 0
// the turning leaf, 8 strips hinged along the spine (front shows this spread, back shows the next or previous one).
fn page_trace(o: vec3f, d: vec3f) -> PHit {
  var res = PHit(-1.0, 0u, vec2f(0.0), 0.0, vec3f(0.0, 0.0, 1.0), 1.0, d, 0u);
  let ns = reader[MH_SPREADN];
  if (sc.rd0.x < 0.8995 || ns == 0u) { return res; }
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

  let cover_on = sc.rd4.z > 0.5;
  // static sheets: side 0 left (outward is -x), side 1 right; while the cover swings the left sheet is the cover's inside
  for (var side = 0; side < 2; side++) {
    if (single && side == 0) { continue; }
    if (cover_on && side == 0) { continue; }
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

  // the front cover board
  if (cover_on && dir == 0) {
    let ch = mg_cover(o, d, sg);
    if (ch.t > 0.0 && (res.t < 0.0 || ch.t < res.t + 1e-4)) {
      var px = spx + ch.a;
      let sp = 0u;
      if (ch.face == 1u) {
        if (single) { px = ch.a; } else { px = spx - ch.a; }
      }
      var face = ch.face;
      if (face == 1u && single) { face = 2u; }
      res = PHit(ch.t, sp, vec2f(px, ch.py), ch.a, ch.n, abs(dot(d, ch.n)), d, face);
    }
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
  let lamp = lvl[level * LS + 1u].xyz;
  let dv = lamp - p;
  let f = 1.0 / (1.0 + 0.5 * dot(dv, dv));
  let nl = 0.75 + 0.25 * saturate(dot(n, dv / max(length(dv), 1e-4)));
  if (sc.rd2.w > 0.5) { return 0.9 * (0.98 + 0.3 * f * nl) / sc.tone.x; }
  return (0.98 + 0.5 * f * nl) / sc.tone.x;
}
fn page_light(p: vec3f, level: u32) -> f32 { return page_light_n(p, vec3f(0.0, 0.0, 1.0), level); }

// Shading of the sheet under the swinging cover: the soft shadow of a key light high, front and left of the book (6 taps in its
// cone) plus the form factor of the board seen from the point (analytic, 2D strip), both fading out as the cover lies flat.
const MG_KEY = vec3f(-0.5, 0.62, 0.6);
fn mg_cover_vis(p: vec3f, n: vec3f) -> f32 {
  let sg = mg_view_sg();
  let em = sc.rd0.z;
  let fade = 1.0 - smoothstep(0.88, 1.0, sc.rd4.y);
  if (fade <= 0.0) { return 1.0; }
  // key light direction in world space: x as is, toward-viewer component along the viewer side of z
  let kd = normalize(vec3f(MG_KEY.x, MG_KEY.y, sg * MG_KEY.z));
  let t1 = normalize(cross(kd, vec3f(0.0, 1.0, 0.0)));
  let t2 = cross(kd, t1);
  var lit = 0.0;
  for (var i = 0u; i < 6u; i++) {
    let a = f32(i) * 1.0471976 + 0.3;
    let r = 0.09 * sqrt((f32(i) + 0.5) / 6.0);
    let dir = normalize(kd + (t1 * cos(a) + t2 * sin(a)) * r * 2.0);
    let ch = mg_cover(p + n * 0.001, dir, sg);
    lit += select(1.0, 0.0, ch.t > 0.0);
  }
  lit /= 6.0;
  // ambient: form factor of the board strip from the sheet point, in the cross-section plane
  let px = (p.x - sc.rd1.x) / em;
  let psi = mg_cover_psi();
  let e = vec2f(cos(psi), sin(psi));
  let sw = mg_f(MH_SHEETW);
  let q = vec2f(px, 0.0);
  let ua = normalize(vec2f(0.0, 0.0) - q);
  let ub = normalize(e * sw - q);
  let ff = clamp(0.5 * abs(ua.x - ub.x), 0.0, 1.0);
  let vis = (0.45 + 0.55 * lit) * (1.0 - 0.45 * ff);
  return mix(1.0, vis, fade);
}

struct PShade { alb: vec3f, e: f32 };

// the sheet's whole shading: (albedo, irradiance), paper-to-cover crossfade on the first spread, gutter shadow in the
// illumination term (not the albedo), clearcoat sheen on figure ink
fn page_shade(ph: PHit, wp: vec3f, level: u32) -> PShade {
  let em = sc.rd0.z;
  let sw = mg_f(MH_SHEETW);
  let shh = mg_f(MH_SPREADH);
  let single = reader[MH_SINGLE] != 0u;
  let spx = select(sw, 0.0, single);
  mg_hov_spread = u32(max(sc.rd2.z, 0.0));
  mg_hov_rect = sc.rd3;
  mg_hov_kind = sc.rd2.y;
  mg_gain = select(1.0, sc.rd5.z, sc.rd5.z > 0.0);
  mg_peel = -1.0;
  if (sc.rd4.x >= 0.0 && ph.face == 0u && abs(sc.rd1.w) < 0.5 && ph.p.x >= spx) { mg_peel = sc.rd4.x; }
  let fw = pix_fw(ph.t) / em / max(ph.cs, 0.15);
  var out = MgOut(vec3f(0.0), 0.0);
  var cov = vec3f(0.0);
  if (ph.face >= 3u) {
    // the cover board: art on the outside, a dark tone of it on the edges
    var uv = vec2f(0.5);
    if (ph.face == 3u) { uv = vec2f(ph.a / sw, ph.p.y / shh); }
    if (sc.rd0.y >= 0.0) {
      let mg = objs[u32(sc.rd0.y)];
      cov = textureSampleLevel(atlas, atlas_s, (mg.tx.xy + uv * mg.tx.zw) / 2048.0, 0.0).rgb;
    } else { cov = mg_paper(); }
    if (ph.face == 4u) { cov *= 0.22; }
    out.col = cov;
  } else if (ph.face == 2u) {
    out.col = mg_paper() * 0.92;
  } else {
    out = spread_albedo(ph.spread, ph.p, fw);
  }
  var alb = out.col;
  var e = page_light_n(wp, ph.n, level);
  if (sc.rd4.z > 0.5 && ph.face == 0u) { e *= mg_cover_vis(wp, ph.n); }
  if (!single && ph.face < 3u) { e *= 1.0 - sc.rd5.y * exp(-ph.a / 1.6); }
  if (out.coat > 0.0) {
    let lamp = lvl[level * LS + 1u].xyz;
    let hv = normalize(normalize(lamp - wp) - ph.vd);
    e *= 1.0 + 0.4 * out.coat * pow(saturate(dot(ph.n, hv)), 48.0);
  }
  return PShade(alb, e);
}
`;

export const MAGAZINE_WGSL = MAGAZINE_EVAL_WGSL + MAGAZINE_TRACE_WGSL;
