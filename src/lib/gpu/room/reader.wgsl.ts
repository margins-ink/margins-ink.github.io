/**
 * Surface kind 10, the article "page": Slug-style analytic curve coverage text (docs/READER.md section 1)
 * evaluated in the primary hit of the tracer. Appended to TRACE (shader.ts); uses its `sc`, `lvl`, `objs`, `atlas`.
 *
 * Bindings (only cs and cs_view reference them, so the bake pipelines keep their layouts):
 *   6  reader      u32 words: header, fonts (dir/curves/bands), the open article (see reader.ts for the layout)
 *   27 reader_img  texture_2d_array<f32> rgba8unorm-srgb, one layer per image of the open article
 *   28 img_s       trilinear + anisotropic sampler
 * Scene uniform fields: rd0 (k, magazine obj, em, scroll), rd1 (sheet plane x, top y, z, unused),
 * rd2 (first page, page count, hover page, dark), rd3 (hover rect).
 */
export const READER_WGSL = /* wgsl */ `
@group(0) @binding(6) var<storage, read> reader: array<u32>;
@group(0) @binding(27) var reader_img: texture_2d_array<f32>;
@group(0) @binding(28) var img_s: sampler;

const RH_SHEET_W = 1u;
const RH_SHEET_H = 2u;
const RH_COLS = 3u;
const RH_ROWS = 4u;
const RH_CELL_W = 5u;
const RH_CELL_H = 6u;
const RH_PAGES = 7u;
const RH_FDIR = 8u;
const RH_FCUR = 9u;
const RH_FBAND = 10u;
const RH_XDIR = 11u;
const RH_XCUR = 12u;
const RH_XBAND = 13u;
const RH_PAGE = 14u;
const RH_CELL = 15u;
const RH_ITEM = 16u;
const RH_GLYPH = 17u;
const RH_RECT = 18u;
const RH_IMG = 19u;
const RH_PAL = 20u;
const RH_STRIDE = 21u;

fn rd_f(i: u32) -> f32 { return bitcast<f32>(reader[i]); }

struct PHit {
  t: f32,
  page: u32,
  p: vec2f,   // page-local position in em, y down
};

// Ray against the stack of sheets (all parallel to the xy plane). Sheet i is spread out of sheet 0 as the magazine opens.
fn page_trace(o: vec3f, d: vec3f) -> PHit {
  var res = PHit(-1.0, 0u, vec2f(0.0));
  let npages = reader[RH_PAGES];
  if (sc.rd0.x < 0.9 || npages == 0u || abs(d.z) < 1e-6) { return res; }
  let em = sc.rd0.z;
  let sw = rd_f(RH_SHEET_W);
  let sh = rd_f(RH_SHEET_H);
  let stride = rd_f(RH_STRIDE);
  let unf = smoothstep(0.9, 1.0, sc.rd0.x);
  let first = u32(sc.rd2.x);
  let last = min(first + u32(sc.rd2.y), npages);
  for (var i = first; i < last; i++) {
    let z = sc.rd1.z - 0.0015 * f32(i);
    let t = (z - o.z) / d.z;
    if (t <= 0.0 || (res.t > 0.0 && t >= res.t)) { continue; }
    let q = o + d * t;
    let px = (q.x - sc.rd1.x) / em + sw * 0.5;
    let py = (sc.rd1.y - q.y) / em + sc.rd0.w * unf - f32(i) * stride * unf;
    if (px < 0.0 || px > sw || py < 0.0 || py > sh) { continue; }
    res = PHit(t, i, vec2f(px, py));
  }
  return res;
}

fn pal_col(i: u32) -> vec4f {
  let c = unpack4x8unorm(reader[reader[RH_PAL] + select(0u, 24u, sc.rd2.w > 0.5) + i]);
  return vec4f(pow(c.rgb, vec3f(2.2)), c.a);
}

fn box_cov(p: vec2f, a: vec2f, b: vec2f, fw: f32) -> f32 {
  let lo = max(a, p - vec2f(0.5 * fw));
  let hi = min(b, p + vec2f(0.5 * fw));
  let o = clamp(hi - lo, vec2f(0.0), vec2f(fw)) / fw;
  return o.x * o.y;
}

fn root_code(y1: f32, y2: f32, y3: f32) -> u32 {
  var s = 0u;
  if (y1 < 0.0) { s |= 1u; }
  if (y2 < 0.0) { s |= 2u; }
  if (y3 < 0.0) { s |= 4u; }
  return (0x2E74u >> s) & 0x0101u;
}

// the x (h = true) or y of the two roots of the curve relative to the sample, see SlugPixelShader.hlsl SolveHorizPoly / SolveVertPoly
fn solve_poly(p12: vec4f, p3: vec2f, horiz: bool) -> vec2f {
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

// coverage of glyph gi (index in the font table, or in the article's own table when extra) at em-space point rc (y up)
fn slug_cov(gid: u32, rc: vec2f, ppe: f32) -> f32 {
  let extra = (gid & 0x80000000u) != 0u;
  let gi = gid & 0x7fffffffu;
  let dir = select(reader[RH_FDIR], reader[RH_XDIR], extra) + gi * 8u;
  let cur = select(reader[RH_FCUR], reader[RH_XCUR], extra);
  let band = select(reader[RH_FBAND], reader[RH_XBAND], extra);
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
    let code = root_code(p12.y, p12.w, p3.y);
    if (code != 0u) {
      let r = solve_poly(p12, p3, true) * ppe;
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
    let code = root_code(p12.x, p12.z, p3.x);
    if (code != 0u) {
      let r = solve_poly(p12, p3, false) * ppe;
      if ((code & 1u) != 0u) { ycov -= saturate(r.x + 0.5); ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0)); }
      if (code > 1u) { ycov += saturate(r.y + 0.5); ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0)); }
    }
  }
  let c = max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov)));
  return saturate(c);
}

fn srgb_lin(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

// albedo of the page at a point: paper, rects, images, then glyphs; fw = footprint of one pixel in em
fn page_albedo(page: u32, p: vec2f, fw: f32) -> vec3f {
  let dark = sc.rd2.w > 0.5;
  var col = select(vec3f(0.87, 0.835, 0.76), vec3f(0.0125, 0.0105, 0.009), dark);
  // paper grain, band-limited to the footprint
  col *= 1.0 + 0.025 * (mix(0.5, vnoise(p * 3.0 + vec2f(f32(page) * 7.0, 0.0)), aa_amp(3.0, fw)) - 0.5);
  let sw = rd_f(RH_SHEET_W);
  let sh = rd_f(RH_SHEET_H);
  let cols = reader[RH_COLS];
  let rows = reader[RH_ROWS];
  let cx = u32(clamp(floor(p.x / rd_f(RH_CELL_W)), 0.0, f32(cols) - 1.0));
  let cy = u32(clamp(floor(p.y / rd_f(RH_CELL_H)), 0.0, f32(rows) - 1.0));
  let cell = reader[RH_CELL] + 2u * (page * cols * rows + cy * cols + cx);
  let istart = reader[RH_ITEM] + reader[cell];
  let icount = reader[cell + 1u] & 0xffffu;
  let ppem = 1.0 / fw;
  // below ~3 px per em text is a tone, not letters: the page's mean ink colour (build time)
  if (ppem < 3.0) {
    let pr = reader[RH_PAGE] + page * 9u;
    let t565 = reader[pr + 6u] & 0xffffu;
    let tone = vec3f(f32(t565 >> 11u) / 31.0, f32((t565 >> 5u) & 63u) / 63.0, f32(t565 & 31u) / 31.0);
    return mix(col, srgb_lin(tone), 0.9);
  }
  let hp = u32(sc.rd2.z);
  let hov = hp == page + 1u && p.x >= sc.rd3.x && p.x <= sc.rd3.z && p.y >= sc.rd3.y && p.y <= sc.rd3.w;
  let hovline = hp == page + 1u && p.x >= sc.rd3.x && p.x <= sc.rd3.z && p.y >= sc.rd3.w - 0.2 && p.y <= sc.rd3.w - 0.1;
  for (var i = 0u; i < icount; i++) {
    let it = reader[istart + i];
    let ty = it >> 29u;
    let ix = it & 0x1fffffffu;
    if (ty == 1u) {
      let r = reader[RH_RECT] + ix * 5u;
      let a = vec2f(rd_f(r), rd_f(r + 1u));
      let b = vec2f(rd_f(r + 2u), rd_f(r + 3u));
      let cov = box_cov(p, a, b, fw);
      if (cov > 0.0) {
        let pc = pal_col(reader[r + 4u] & 0xffu);
        col = mix(col, pc.rgb, cov * pc.a);
      }
    } else if (ty == 2u) {
      let r = reader[RH_IMG] + ix * 6u;
      let a = vec2f(rd_f(r), rd_f(r + 1u));
      let b = vec2f(rd_f(r + 2u), rd_f(r + 3u));
      let cov = box_cov(p, a, b, fw);
      if (cov > 0.0) {
        let slot = reader[r + 4u] & 0xffffu;
        let sc2 = unpack2x16float(reader[r + 5u]);
        let uv = (p - a) / (b - a);
        let ddx = vec2f(fw / (b.x - a.x) * sc2.x, 0.0);
        let ddy = vec2f(0.0, fw / (b.y - a.y) * sc2.y);
        let sm = textureSampleGrad(reader_img, img_s, clamp(uv, vec2f(0.0), vec2f(1.0)) * sc2, slot, ddx, ddy);
        var im = sm.rgb;
        if (dark) { im *= 0.9; }
        col = mix(col, im, cov * sm.a);
      }
    }
  }
  for (var i = 0u; i < icount; i++) {
    let it = reader[istart + i];
    if ((it >> 29u) != 0u) { continue; }
    let g = reader[RH_GLYPH] + (it & 0x1fffffffu) * 5u;
    let gx = rd_f(g);
    let gy = rd_f(g + 1u);
    let w3 = reader[g + 3u];
    let size = unpack2x16float(w3 & 0xffffu).x;
    let rc = vec2f((p.x - gx) / size, (gy - p.y) / size);
    let cov = slug_cov(reader[g + 2u], rc, size / fw);
    if (cov > 0.0) {
      var ci = (w3 >> 16u) & 0xffu;
      if (hov) { ci = 1u; }
      let pc = pal_col(ci);
      col = mix(col, pc.rgb, cov * pc.a);
    }
  }
  if (hovline) { col = mix(col, pal_col(1u).rgb, 0.9); }
  return col;
}

// Irradiance of the reading light: the room lamp as a soft gradient over the sheet. Exposure-independent, so the
// backdrop can be darkened by lowering sc.tone.x without dimming the paper.
fn page_light(p: vec3f, level: u32) -> f32 {
  let lamp = lvl[level * 3u + 1u].xyz;
  let dv = lamp - p;
  let f = 1.0 / (1.0 + 0.5 * dot(dv, dv));
  return (0.98 + 0.5 * f) / sc.tone.x * select(1.0, 0.9, sc.rd2.w > 0.5);
}

// the sheet's whole shading: returns (albedo, irradiance) with the paper-to-cover crossfade on sheet 0
struct PShade { alb: vec3f, e: f32 };
fn page_shade(ph: PHit, wp: vec3f, level: u32) -> PShade {
  let em = sc.rd0.z;
  let fw = pix_fw(ph.t) / em;
  var alb = page_albedo(ph.page, ph.p, fw);
  let k = sc.rd0.x;
  if (ph.page == 0u && sc.rd0.y >= 0.0 && k < 0.995) {
    let mg = objs[u32(sc.rd0.y)];
    let uv = ph.p / vec2f(rd_f(RH_SHEET_W), rd_f(RH_SHEET_H));
    let cover = textureSampleLevel(atlas, atlas_s, (mg.tx.xy + uv * mg.tx.zw) / 2048.0, 0.0).rgb;
    alb = mix(cover, alb, smoothstep(0.9, 0.99, k));
  }
  return PShade(alb, page_light(wp, level));
}
`;
