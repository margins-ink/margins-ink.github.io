// Flat orthographic evaluator for the preview page: paper, rects, shapes (rrect, circle, line) and Slug glyph
// coverage for ONE spread, read from the buffer built by pack.ts. This is a stand-in for the room evaluator
// (src/lib/gpu/room/magazine.wgsl.ts, `shader` lane): MAGAZINE.md section 7 wants both to include the same
// function block. Until that module exists and exports an includable evaluator, the glyph coverage routine below
// is the same Slug walk as src/lib/gpu/room/reader.wgsl.ts (copied, not shared) and paths, strokes, groups and
// numerals are NOT drawn here (they need the shader lane's records and the channel uniform). Swap `EVAL` for the
// shared block when it lands; the uniform and buffer contract stay.
import { PH } from './pack';

const H = Object.entries(PH).map(([k, v]) => `const PH_${k.toUpperCase()} = ${v}u;`).join('\n');

export const PREVIEW_WGSL = /* wgsl */ `
${H}
@group(0) @binding(0) var<storage, read> d: array<u32>;

struct U {
  vp: vec4f,      // viewport px: x, y, w, h
  view: vec4f,    // em at the viewport top-left (x, y), px per em, spread index
  opts: vec4f,    // dark, flags (1 gutter shadow, 2 bow), time, tone-only (1 = draw the compiled tone)
  surf: vec4f,    // canvas width, height px, unused, unused
};
@group(0) @binding(1) var<uniform> u: U;

fn f(i: u32) -> f32 { return bitcast<f32>(d[i]); }

struct VOut { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return VOut(vec4f(p * 2.0 - 1.0, 0.0, 1.0));
}

fn pal(i: u32) -> vec4f { return unpack4x8unorm(d[d[PH_PAL] + select(0u, 32u, u.opts.x > 0.5) + i]); }

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

fn solve_poly(p12: vec4f, p3: vec2f, horiz: bool) -> vec2f {
  let a = p12.xy - p12.zw * 2.0 + p3;
  let b = p12.xy - p12.zw;
  let ca = select(a.x, a.y, horiz);
  let cb = select(b.x, b.y, horiz);
  let c0 = select(p12.x, p12.y, horiz);
  var t1: f32; var t2: f32;
  if (abs(ca) < 1.0 / 65536.0) { t1 = c0 * 0.5 / cb; t2 = t1; }
  else { let dd = sqrt(max(cb * cb - ca * c0, 0.0)); let ra = 1.0 / ca; t1 = (cb - dd) * ra; t2 = (cb + dd) * ra; }
  let oa = select(a.y, a.x, horiz);
  let ob = select(b.y, b.x, horiz);
  let o0 = select(p12.y, p12.x, horiz);
  return vec2f((oa * t1 - ob * 2.0) * t1 + o0, (oa * t2 - ob * 2.0) * t2 + o0);
}

// EVAL: Slug coverage of glyph gid at em-space point rc (y up), ppe pixels per em of the glyph
fn slug_cov(gid: u32, rc: vec2f, ppe: f32) -> f32 {
  let extra = (gid & 0x80000000u) != 0u;
  let gi = gid & 0x7fffffffu;
  let dir = select(d[PH_FDIR], d[PH_XDIR], extra) + gi * 8u;
  let cur = select(d[PH_FCUR], d[PH_XCUR], extra);
  let band = select(d[PH_FBAND], d[PH_XBAND], extra);
  let bstart = band + d[dir + 1u];
  let nh = d[dir + 2u] & 0xffffu;
  let nv = d[dir + 2u] >> 16u;
  let bx0 = bitcast<f32>(d[dir + 4u]); let by0 = bitcast<f32>(d[dir + 5u]);
  let bx1 = bitcast<f32>(d[dir + 6u]); let by1 = bitcast<f32>(d[dir + 7u]);
  let e = 1.0 / ppe;
  if (rc.x < bx0 - e || rc.x > bx1 + e || rc.y < by0 - e || rc.y > by1 + e) { return 0.0; }
  let kh = u32(clamp(floor((rc.y - by0) / max(by1 - by0, 1e-6) * f32(nh)), 0.0, f32(nh) - 1.0));
  let kv = u32(clamp(floor((rc.x - bx0) / max(bx1 - bx0, 1e-6) * f32(nv)), 0.0, f32(nv) - 1.0));
  var xcov = 0.0; var xwgt = 0.0;
  let hh = d[bstart + kh]; let hn = hh & 0xffffu; let hoff = bstart + (hh >> 16u);
  for (var i = 0u; i < hn; i++) {
    let tx = d[hoff + i];
    let p12 = vec4f(unpack2x16float(d[cur + 2u * tx]), unpack2x16float(d[cur + 2u * tx + 1u])) - vec4f(rc, rc);
    let p3 = unpack2x16float(d[cur + 2u * tx + 2u]) - rc;
    if (max(max(p12.x, p12.z), p3.x) * ppe < -0.5) { break; }
    let code = root_code(p12.y, p12.w, p3.y);
    if (code != 0u) {
      let r = solve_poly(p12, p3, true) * ppe;
      if ((code & 1u) != 0u) { xcov += saturate(r.x + 0.5); xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0)); }
      if (code > 1u) { xcov -= saturate(r.y + 0.5); xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0)); }
    }
  }
  var ycov = 0.0; var ywgt = 0.0;
  let vh = d[bstart + nh + kv]; let vn = vh & 0xffffu; let voff = bstart + (vh >> 16u);
  for (var i = 0u; i < vn; i++) {
    let tx = d[voff + i];
    let p12 = vec4f(unpack2x16float(d[cur + 2u * tx]), unpack2x16float(d[cur + 2u * tx + 1u])) - vec4f(rc, rc);
    let p3 = unpack2x16float(d[cur + 2u * tx + 2u]) - rc;
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

fn sd_rrect(p: vec2f, a: vec2f, b: vec2f, r: f32) -> f32 {
  let c = 0.5 * (a + b); let h = 0.5 * (b - a) - vec2f(r);
  let q = abs(p - c) - h;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn shape_cov(s: u32, p: vec2f, fw: f32) -> vec4f {
  let a = vec2f(f(s), f(s + 1u)); let b = vec2f(f(s + 2u), f(s + 3u));
  let w4 = d[s + 4u];
  let kind = w4 & 0xffu; let col = (w4 >> 8u) & 0xffu; let flags = w4 >> 24u;
  let rp = unpack2x16float(d[s + 5u]);
  var dist = 1e9;
  var width = max(rp.y, 0.0);
  if (kind == 0u) { dist = sd_rrect(p, a, b, min(rp.x, 0.5 * min(b.x - a.x, b.y - a.y))); }
  else if (kind == 1u) { let c = 0.5 * (a + b); let r = 0.5 * (b - a); dist = (length((p - c) / r) - 1.0) * min(r.x, r.y); }
  else if (kind == 2u) { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0); dist = length(pa - ba * h) - 0.5 * max(rp.x, 0.05); }
  else { return vec4f(0.0); }
  var cov: f32;
  if ((flags & 1u) != 0u && kind != 2u) { cov = saturate(0.5 - (abs(dist) - 0.5 * max(width, 0.05)) / fw); }
  else if ((flags & 2u) != 0u) { cov = 0.0; }
  else { cov = saturate(0.5 - dist / fw); }
  if ((flags & 4u) != 0u && cov > 0.0) { let hh = fract((p.x + p.y) / 0.6); cov *= step(0.5, hh); }
  return vec4f(vec3f(f32(col)), cov);
}

fn page_albedo(sp: u32, p: vec2f, fw: f32) -> vec3f {
  let dark = u.opts.x > 0.5;
  let so = d[PH_SPREAD] + sp * 8u;
  let sw = f(so + 4u); let sh = f(so + 5u);
  var col = pal(17u).rgb;
  if (p.x < 0.0 || p.y < 0.0 || p.x > sw || p.y > sh) { return col * 0.5; }
  let ppem = 1.0 / fw;
  let cols = d[so + 1u]; let rows = d[so + 2u];
  let cx = u32(clamp(floor(p.x / 6.0), 0.0, f32(cols) - 1.0));
  let cy = u32(clamp(floor(p.y / 1.6), 0.0, f32(rows) - 1.0));
  let cell = d[PH_CELL] + 2u * (d[so] + cy * cols + cx);
  let istart = d[PH_ITEM] + d[cell];
  let icount = d[cell + 1u] & 0xffffu;
  // below ~3 px per em text is a tone, not letters (the compiled tone from the spread record)
  if (ppem < 3.0 || u.opts.w > 0.5) {
    let t565 = d[so + 3u] & 0xffffu;
    let tone = vec3f(f32(t565 >> 11u) / 31.0, f32((t565 >> 5u) & 63u) / 63.0, f32(t565 & 31u) / 31.0);
    col = mix(col, tone, 0.9);
  } else {
    for (var i = 0u; i < icount; i++) {
      let it = d[istart + i];
      let ty = it >> 28u; let ix = it & 0x0fffffffu;
      if (ty == 1u) {
        let r = d[PH_RECT] + ix * 5u;
        let cov = box_cov(p, vec2f(f(r), f(r + 1u)), vec2f(f(r + 2u), f(r + 3u)), fw);
        if (cov > 0.0) { let pc = pal(d[r + 4u] & 0xffu); col = mix(col, pc.rgb, cov * pc.a); }
      } else if (ty == 2u) {
        let r = d[PH_RECT]; // images are not decoded in the preview: a grey placeholder is drawn by the overlay
      } else if (ty == 3u) {
        let sc = shape_cov(d[PH_SHAPE] + ix * 6u, p, fw);
        if (sc.w > 0.0) { let s = d[PH_SHAPE] + ix * 6u; let pc = pal(u32(sc.x)); col = mix(col, pc.rgb, sc.w * pc.a); }
      }
    }
    for (var i = 0u; i < icount; i++) {
      let it = d[istart + i];
      if ((it >> 28u) != 0u) { continue; }
      let g = d[PH_GLYPH] + (it & 0x0fffffffu) * 5u;
      let w3 = d[g + 3u];
      let size = unpack2x16float(w3 & 0xffffu).x;
      let rc = vec2f((p.x - f(g)) / size, (f(g + 1u) - p.y) / size);
      let cov = slug_cov(d[g + 2u], rc, size / fw);
      if (cov > 0.0) { let pc = pal((w3 >> 16u) & 0xffu); col = mix(col, pc.rgb, cov * pc.a); }
    }
  }
  // optional light cues (flat stand-ins for section 4.4): gutter shadow and bow gradient about the spine
  let spine = 0.5 * sw;
  let dd = abs(p.x - spine);
  let flags = u32(u.opts.y);
  if ((flags & 1u) != 0u) { col *= 1.0 - 0.18 * exp(-dd / 1.6); }
  if ((flags & 2u) != 0u) { col *= 1.0 + 0.03 * (1.0 - clamp(dd / spine, 0.0, 1.0)) * select(1.0, -1.0, p.x > spine); }
  return col;
}

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let q = fc.xy - u.vp.xy;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= u.vp.z || q.y >= u.vp.w) { discard; }
  let ppe = u.view.z;
  let p = u.view.xy + q / ppe;
  let col = page_albedo(u32(u.view.w), p, 1.0 / ppe);
  return vec4f(col, 1.0);
}
`;
