import { MAGAZINE_WGSL } from './magazine.wgsl';

/**
 * Progressive path tracer for the study. One compute pass adds one sample per pixel
 * to an accumulation buffer; a fullscreen pass tonemaps it. Diffuse surfaces, next
 * event estimation to the four window panes and the lamp, four bounces.
 */
export const TRACE = /* wgsl */ `
struct Obj {
  c: vec4f,   // xyz centre, w kind
  h: vec4f,   // xyz half extents (x = radius for spheres)
  r0: vec4f,  // local x axis in world space
  r1: vec4f,
  r2: vec4f,
  alb: vec4f,
  tx: vec4f,  // atlas rect in pixels: x y w h
};

struct Scene {
  res: vec2f,
  frame: f32,
  blend: f32,       // minimum history weight while the camera is moving
  sky: vec4f,       // window radiance
  bg: vec4f,        // xyz radiance outside the building at the surface, w its fade at the live elevator depth
  cam: vec4f,       // xyz position, w tan(half fov)
  fwd: vec4f,
  rgt: vec4f,
  up: vec4f,
  pane: vec4f,      // x half width, y half height, z plane
  misc: vec4f,      // x levels, y level height, z front plane z, w room height
  tone: vec4f,      // x exposure, y rng seed, zw output size
  view: vec4f,      // zoom window: centre xy (rest ndc), half size s
  lmx: vec4f,       // lightmap bake: samples so far, samples this pass, texel count, workgroups per row
  suncol: vec4f,    // rgb sun colour, w unused
  amb: vec4f,       // rgb ambient irradiance (E / pi units, added at the first vertex), w unused
  post: vec4f,      // x bloom strength, y chromatic aberration, z grain, w fog density
  fx: vec4f,        // probe bake: samples so far, samples this pass, 0, 0
  rd0: vec4f,       // magazine (magazine.wgsl.ts): reading blend k, magazine object index (-1 none), em in metres, turn progress
  rd1: vec4f,       // magazine: spine x, y of the top edge, plane z, turn direction
  rd2: vec4f,       // magazine: shown spread index, 0, hovered spread + 1 (0 none), unused
  rd3: vec4f,       // magazine: hovered rect in spread em (x0 y0 x1 y1)
  rd4: vec4f,       // magazine: x tab peel amount (-1 none), y cover hinge 0..1, z cover board in play
  rd5: vec4f,       // magazine: x page bow, y gutter, z gain
  cab: vec4f,       // elevator (docs/ELEVATOR.md): x car depth in metres (cab frame y = world y + x), y settled (skip rays that clearly pass the open door), z cab on, w cab level index in lvl
  ov: array<vec4f, 24>, // the world's scrollbar (rail.ts): 12 rounded rects, each (x y w h in device px) then (straight sRGB rgb, alpha)
  lab: vec4f,       // floor sign plate beside the thumb: rect in device px
  labt: vec4f,      // its atlas rect (u0 v0 u1 v1)
  laba: vec4f,      // x alpha
};

@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var<storage, read> objs: array<Obj>;
@group(0) @binding(2) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var atlas_s: sampler;
@group(0) @binding(5) var<storage, read> panes: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> gbuf: array<vec4f>;
@group(0) @binding(9) var<storage, read> gb_ro: array<vec4f>;
@group(0) @binding(10) var<storage, read> filt_in: array<vec4f>;
@group(0) @binding(11) var<storage, read_write> filt_out: array<vec4f>;
@group(0) @binding(12) var<storage, read> final_ro: array<vec4f>;
struct AF { step: vec4f };
@group(0) @binding(13) var<uniform> af: AF;
@group(0) @binding(14) var<storage, read> lm_meta: array<vec4u>;
@group(0) @binding(15) var<storage, read_write> lm_acc: array<vec4f>;
@group(0) @binding(16) var<storage, read_write> lm_w: array<vec2u>;
@group(0) @binding(19) var<storage, read> lm: array<vec2u>;
@group(0) @binding(7) var<storage, read> lvl: array<vec4f>;
// reflection probe: one cube map per floor (6 layers each), rgba16float, mip chain = roughness
@group(0) @binding(22) var probe: texture_cube_array<f32>;
@group(0) @binding(23) var probe_s: sampler;
@group(0) @binding(24) var probe_w: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(25) var<storage, read_write> probe_acc: array<vec4f>;
@group(0) @binding(26) var probe_src: texture_cube_array<f32>;
// vec4s per level in lvl: (start, count, panes, 0), (lamp xyz, radius), (lamp colour), (accent centre, half width), (accent colour, half height)
const LS = 5u;
const GS = 3u;   // vec4 per pixel in gbuf: (normal, depth), (albedo, 0), (specular radiance, 0)
const PI = 3.1415927;

@group(0) @binding(17) var<storage, read_write> vol_w: array<f32>;
@group(0) @binding(18) var<storage, read> vol: array<f32>;
const VX = 96u;
const VY = 48u;
const VZ = 64u;

var<private> rng_state: u32;
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

fn pcg() -> f32 {
  rng_state = rng_state * 747796405u + 2891336453u;
  let w = ((rng_state >> ((rng_state >> 28u) + 4u)) ^ rng_state) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967295.0;
}

// Low-discrepancy samples for the lightmap bake: the first 5 random numbers of every path (light pick and point,
// bounce direction) come from the R5 additive recurrence (Roberts 2018), rotated per texel by a random offset
// (Cranley-Patterson). Fixed-point u32 arithmetic keeps the sequence exact for any sample index. Later vertices use pcg.
var<private> qmc_on: bool;
var<private> qmc_i: u32;
var<private> qmc_d: u32;
var<private> qmc_o: array<u32, 5>;
var<private> QA = array<u32, 5>(0xe19b01aau, 0xc6d1d6c8u, 0xaf36d01eu, 0x9a69443fu, 0x881403b9u);
fn rnd() -> f32 {
  if (qmc_on && qmc_d < 5u) {
    let v = qmc_o[qmc_d] + qmc_i * QA[qmc_d];
    qmc_d++;
    return f32(v >> 8u) * (1.0 / 16777216.0);
  }
  return pcg();
}
fn hash_u(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), s.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), s.x), s.y);
}

struct Hit {
  t: f32,
  n: vec3f,
  lp: vec3f,
  id: i32,
};

fn box_hit(o: vec3f, d: vec3f, ob: Obj, tmax_in: f32) -> Hit {
  var res = Hit(-1.0, vec3f(0.0), vec3f(0.0), -1);
  let r0 = ob.r0.xyz; let r1 = ob.r1.xyz; let r2 = ob.r2.xyz;
  let oc = o - ob.c.xyz;
  let ol = vec3f(dot(oc, r0), dot(oc, r1), dot(oc, r2));
  var dl = vec3f(dot(d, r0), dot(d, r1), dot(d, r2));
  dl = select(dl, vec3f(1e-7), abs(dl) < vec3f(1e-7));
  let inv = 1.0 / dl;
  let t1 = (-ob.h.xyz - ol) * inv;
  let t2 = (ob.h.xyz - ol) * inv;
  let tn = min(t1, t2);
  let tf = max(t1, t2);
  let t_enter = max(max(tn.x, tn.y), tn.z);
  let t_exit = min(min(tf.x, tf.y), tf.z);
  if (t_exit < max(t_enter, 0.0)) { return res; }
  var nl: vec3f;
  var t: f32;
  if (t_enter > 1e-4) {
    t = t_enter;
    nl = -sign(dl) * step(tn.yzx, tn.xyz) * step(tn.zxy, tn.xyz);
  } else {
    t = t_exit;
    // inside the box: the exit face's outward normal, flipped to face the ray
    nl = -sign(dl) * step(tf.xyz, tf.yzx) * step(tf.xyz, tf.zxy);
  }
  if (t > tmax_in || t < 1e-4) { return res; }
  res.t = t;
  res.lp = ol + dl * t;
  res.n = normalize(nl.x * r0 + nl.y * r1 + nl.z * r2);
  return res;
}

fn sphere_hit(o: vec3f, d: vec3f, ob: Obj, tmax_in: f32) -> Hit {
  var res = Hit(-1.0, vec3f(0.0), vec3f(0.0), -1);
  let oc = o - ob.c.xyz;
  let b = dot(oc, d);
  let c = dot(oc, oc) - ob.h.x * ob.h.x;
  let disc = b * b - c;
  if (disc < 0.0) { return res; }
  let s = sqrt(disc);
  var t = -b - s;
  if (t < 1e-4) { t = -b + s; }
  if (t < 1e-4 || t > tmax_in) { return res; }
  res.t = t;
  res.n = normalize(oc + d * t);
  res.lp = res.n;
  return res;
}

fn intersect(o: vec3f, d: vec3f, tmax_in: f32, skip_room: bool, level: u32) -> Hit {
  var best = Hit(-1.0, vec3f(0.0), vec3f(0.0), -1);
  var tmax = tmax_in;
  let first = u32(lvl[level * LS].x);
  let n = first + u32(lvl[level * LS].y);
  for (var i = first; i < n; i++) {
    if (skip_room && i == first) { continue; }
    let ob = objs[i];
    var h: Hit;
    if (ob.c.w >= 8.0) { h = sphere_hit(o, d, ob, tmax); } else { h = box_hit(o, d, ob, tmax); }
    if (h.t > 0.0) { best = h; best.id = i32(i); tmax = h.t; }
  }
  return best;
}

// world-space size of one screen pixel at distance t
fn pix_fw(t: f32) -> f32 { return t * 2.0 * sc.cam.w * sc.view.z / sc.res.y; }
// band-limit a noise of spatial frequency f (cycles per metre) to the footprint fw: full amplitude while the pixel is
// well below the period, none once it nears the Nyquist limit (the noise would alias). Returns the amplitude scale.
fn aa_amp(f: f32, fw: f32) -> f32 { return 1.0 - smoothstep(0.15, 0.5, fw * f); }

// fw: footprint (world metres) over which the result is averaged; wood grain, planks and plaster are filtered to it
fn albedo_of(ob: Obj, hit: Hit, wp: vec3f, fw: f32) -> vec3f {
  let kind = ob.c.w;
  if (kind == 4.0) {
    if (hit.n.y > 0.5) {
      let p = wp.x * 5.0 + ob.alb.w;
      let plank = floor(p);
      let tone = hash21(vec2f(plank, 3.0));
      let grain = mix(0.5, vnoise(vec2f(wp.x * 40.0, wp.z * 2.5 + plank * 7.0)), aa_amp(40.0, fw));
      // seams: a 0.03 plank wide dark groove, box filtered (widened by the footprint, darkness conserved)
      let fwp = fw * 5.0;
      let gw = 0.03 + fwp;
      let fr = fract(p);
      let groove = (1.0 - smoothstep(0.0, gw, fr) * smoothstep(1.0, 1.0 - gw, fr)) * (0.03 / gw);
      return vec3f(0.42, 0.25, 0.13) * (0.7 + 0.45 * tone) * (0.85 + 0.3 * grain) * (1.0 - 0.65 * groove);
    }
    if (hit.n.y < -0.5) { return vec3f(0.82, 0.8, 0.74); }
    let plaster = 0.94 + 0.12 * mix(0.5, vnoise(wp.xy * 14.0 + wp.zz * 9.0), aa_amp(14.0, fw));
    let ly = wp.y - ob.c.y + ob.h.y; // height above this room's floor
    // wainscot rail (0.95..1.0 m): its 5 cm band is smoothly keyed so it filters instead of stair-stepping
    let rail = smoothstep(0.95 - fw, 0.95 + fw, ly) * (1.0 - smoothstep(1.0 - fw, 1.0 + fw, ly));
    let wain = ob.tx.rgb * plaster;
    let upper = ob.alb.rgb * plaster;
    let base = mix(wain, upper, smoothstep(1.0 - fw, 1.0 + fw, ly));
    return mix(base, vec3f(0.55, 0.45, 0.3), rail);
  }
  if (kind == 6.0) {
    let g = mix(0.5, vnoise(vec2f(wp.x * 22.0, wp.z * 3.0 + wp.y * 3.0)), aa_amp(22.0, fw));
    return ob.alb.rgb * (0.8 + 0.4 * g);
  }
  if (kind == 2.0) {
    if (hit.lp.z > ob.h.z - 1e-4) {
      let u = (hit.lp.x / ob.h.x + 1.0) * 0.5;
      let v = (1.0 - hit.lp.y / ob.h.y) * 0.5;
      let px = ob.tx.xy + vec2f(u, v) * ob.tx.zw;
      return textureSampleLevel(atlas, atlas_s, px / 2048.0, 0.0).rgb;
    }
    return vec3f(0.88, 0.85, 0.76);
  }
  return ob.alb.rgb;
}

fn onb(n: vec3f) -> mat3x3f {
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.99);
  let tx = normalize(cross(up, n));
  return mat3x3f(tx, cross(n, tx), n);
}

fn cosine_dir(n: vec3f) -> vec3f {
  let r1 = rnd();
  let r2 = rnd();
  let phi = 6.2831853 * r1;
  let s = sqrt(r2);
  let b = onb(n);
  return normalize(b[0] * (cos(phi) * s) + b[1] * (sin(phi) * s) + n * sqrt(1.0 - r2));
}

// ---- materials: GGX specular over a Lambert base (see docs/LOOK.md) ----------------------------
struct Mat {
  rough: f32,
  metal: f32,
  f0: vec3f,
  dif: vec3f,       // diffuse albedo (zero for a metal)
  spec_on: bool,    // false for matte dielectrics: pure Lambert, no specular lobe
};

fn material(ob: Obj, n: vec3f, alb: vec3f) -> Mat {
  var m: Mat;
  m.rough = ob.r0.w;
  // the room shell: its Material is the floor's, walls and ceiling are matte plaster
  if (ob.c.w == 4.0 && n.y < 0.5) { m.rough = 0.9; }
  m.metal = ob.r1.w;
  m.f0 = mix(vec3f(0.04), alb, m.metal);
  m.dif = alb * (1.0 - m.metal);
  m.spec_on = m.rough < 0.85 || m.metal > 0.5;
  return m;
}

fn ggx_d(nh: f32, a2: f32) -> f32 {
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
fn smith_g1(nx: f32, a2: f32) -> f32 { return 2.0 * nx / (nx + sqrt(a2 + (1.0 - a2) * nx * nx)); }
fn fres(f0: vec3f, c: f32) -> vec3f {
  let k = pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
  return f0 + (vec3f(1.0) - f0) * k;
}
// GGX BRDF times cos(l): D G F / (4 n.v), separable Smith
fn spec_eval(n: vec3f, v: vec3f, l: vec3f, alpha: f32, f0: vec3f) -> vec3f {
  let nl = dot(n, l);
  let nv = dot(n, v);
  if (nl <= 0.0 || nv <= 0.0) { return vec3f(0.0); }
  let h = normalize(v + l);
  let a2 = alpha * alpha;
  return fres(f0, max(dot(v, h), 0.0)) * (ggx_d(max(dot(n, h), 0.0), a2) * smith_g1(nv, a2) * smith_g1(nl, a2) / (4.0 * nv));
}
// solid-angle density of sample_vndf's reflected direction
fn spec_pdf(n: vec3f, v: vec3f, l: vec3f, alpha: f32) -> f32 {
  let nv = dot(n, v);
  if (nv <= 0.0 || dot(n, l) <= 0.0) { return 0.0; }
  let h = normalize(v + l);
  let a2 = alpha * alpha;
  return ggx_d(max(dot(n, h), 0.0), a2) * smith_g1(nv, a2) / (4.0 * nv);
}
// Heitz 2018, sampling the GGX distribution of visible normals; vl is the view vector in the shading frame (z = normal)
fn sample_vndf(vl: vec3f, alpha: f32, u1: f32, u2: f32) -> vec3f {
  let vh = normalize(vec3f(alpha * vl.x, alpha * vl.y, vl.z));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  var t1 = vec3f(1.0, 0.0, 0.0);
  if (lensq > 1e-7) { t1 = vec3f(-vh.y, vh.x, 0.0) * inverseSqrt(lensq); }
  let t2 = cross(vh, t1);
  let r = sqrt(u1);
  let phi = 6.2831853 * u2;
  let a = r * cos(phi);
  var b = r * sin(phi);
  let s = 0.5 * (1.0 + vh.z);
  b = (1.0 - s) * sqrt(max(0.0, 1.0 - a * a)) + s * b;
  let nh = a * t1 + b * t2 + sqrt(max(0.0, 1.0 - a * a - b * b)) * vh;
  return normalize(vec3f(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}
fn mis(a: f32, b: f32) -> f32 {
  let a2 = a * a;
  return a2 / max(a2 + b * b, 1e-20);
}
// Karis' analytic split-sum environment BRDF (scale and bias on F0)
fn env_brdf(f0: vec3f, rough: f32, nv: f32) -> vec3f {
  let r = rough * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

fn is_emitter(kind: f32) -> bool { return kind == 1.0 || kind == 3.0 || kind == 9.0; }
fn accent_on(level: u32) -> bool {
  let c = lvl[level * LS + 4u].rgb;
  return c.x + c.y + c.z > 0.0;
}
fn n_lights(level: u32) -> f32 { return f32(u32(lvl[level * LS].z) + 1u + select(0u, 1u, accent_on(level))); }
fn emission(kind: f32, level: u32) -> vec3f {
  if (kind == 1.0) { return sc.sky.rgb; }
  if (kind == 3.0) { return lvl[level * LS + 4u].rgb; }
  return lvl[level * LS + 2u].rgb;
}

struct Nee { ok: bool, l: vec3f, le: vec3f, pdf: f32 };

// next event estimation: one light of the level (window pane, lamp or accent panel) chosen uniformly and sampled by area.
// pdf is the solid-angle density including the choice of the light.
fn nee_light(p: vec3f, n: vec3f, level: u32) -> Nee {
  var r: Nee;
  r.ok = false;
  let np = u32(lvl[level * LS].z);
  let nl = n_lights(level);
  let pick = min(u32(rnd() * nl), u32(nl) - 1u);
  var lp: vec3f;
  var ln = vec3f(0.0, 0.0, 1.0);
  var area: f32;
  if (pick < np) {
    let pn = panes[level * 4u + pick];
    lp = vec3f(pn.x + (rnd() * 2.0 - 1.0) * sc.pane.x, pn.y + (rnd() * 2.0 - 1.0) * sc.pane.y, sc.pane.z);
    r.le = sc.sky.rgb;
    area = 4.0 * sc.pane.x * sc.pane.y;
  } else if (pick == np) {
    let lam = lvl[level * LS + 1u];
    let z = rnd() * 2.0 - 1.0;
    let a = rnd() * 6.2831853;
    let rr = sqrt(max(0.0, 1.0 - z * z));
    ln = vec3f(rr * cos(a), rr * sin(a), z);
    lp = lam.xyz + ln * lam.w;
    r.le = lvl[level * LS + 2u].rgb;
    area = 4.0 * PI * lam.w * lam.w;
  } else {
    let ac = lvl[level * LS + 3u];
    let acc = lvl[level * LS + 4u];
    lp = vec3f(ac.x + (rnd() * 2.0 - 1.0) * ac.w, ac.y + (rnd() * 2.0 - 1.0) * acc.w, ac.z);
    r.le = acc.rgb;
    area = 4.0 * ac.w * acc.w;
  }
  let v = lp - p;
  let d2 = dot(v, v);
  let dir = v * inverseSqrt(d2);
  let cs = dot(n, dir);
  let cl = dot(ln, -dir);
  if (cs <= 0.0 || cl <= 0.0) { return r; }
  let o = p + n * 2e-3;
  let vv = lp - o;
  let dist = length(vv);
  let h = intersect(o, vv / dist, dist * 0.997 - 0.004, true, level);
  if (h.t > 0.0) { return r; }
  r.ok = true;
  r.l = dir;
  r.pdf = d2 / (cl * area) / nl;
  return r;
}

// solid-angle density with which nee_light would have picked the emitter hit h (0: it could not)
fn light_pdf(kind: f32, h: Hit, d: vec3f, level: u32) -> f32 {
  let nl = n_lights(level);
  var area: f32;
  var cl = -d.z;
  if (kind == 1.0) {
    area = 4.0 * sc.pane.x * sc.pane.y;
  } else if (kind == 9.0) {
    let lr = lvl[level * LS + 1u].w;
    area = 4.0 * PI * lr * lr;
    cl = dot(h.n, -d);
  } else {
    area = 4.0 * lvl[level * LS + 3u].w * lvl[level * LS + 4u].w;
  }
  if (cl <= 1e-3) { return 0.0; }
  return h.t * h.t / (cl * area * nl);
}

// irradiance (E / pi) from the level's lights at a diffuse surface point; no MIS, used by the lightmap bake
fn direct_area(p: vec3f, n: vec3f, level: u32) -> vec3f {
  let ne = nee_light(p, n, level);
  if (!ne.ok) { return vec3f(0.0); }
  return ne.le * (dot(n, ne.l) / ne.pdf / PI);
}

// the sun (or moon) shines through the window panes: direction towards it, and its colour
const SUN_L = vec3f(0.2, 0.6, -1.0);
fn sun_dir() -> vec3f { return normalize(SUN_L); }
fn sun_col() -> vec3f { return sc.suncol.rgb; }

fn in_pane(c: vec3f, level: u32) -> bool {
  let np = u32(lvl[level * LS].z);
  for (var i = 0u; i < np; i++) {
    let pn = panes[level * 4u + i];
    if (abs(c.x - pn.x) < sc.pane.x && abs(c.y - pn.y) < sc.pane.y) { return true; }
  }
  return false;
}

fn sun_visible(p: vec3f, n: vec3f, level: u32) -> bool {
  if (lvl[level * LS].z < 0.5) { return false; }
  let l = sun_dir();
  let cs = dot(n, l);
  if (cs <= 0.0 || p.z < 0.1) { return false; }
  let s = (0.1 - p.z) / l.z;
  if (!in_pane(p + l * s, level)) { return false; }
  let h = intersect(p + n * 2e-3, l, s * 0.995, true, level);
  return h.t < 0.0;
}

fn direct_sun(p: vec3f, n: vec3f, level: u32) -> vec3f {
  if (!sun_visible(p, n, level)) { return vec3f(0.0); }
  return sun_col() * dot(n, sun_dir()) / PI;
}

fn direct(p: vec3f, n: vec3f, level: u32) -> vec3f {
  return direct_area(p, n, level) + direct_sun(p, n, level);
}

// bake where the sun's beam reaches, per floor, into a voxel grid (the scene is static)
@compute @workgroup_size(4, 4, 4)
fn bake_sun(@builtin(global_invocation_id) g: vec3u) {
  let level = g.z / VZ;
  let iz = g.z % VZ;
  if (g.x >= VX || g.y >= VY || level >= u32(sc.misc.x)) { return; }
  let yl = (f32(g.y) + 0.5) / f32(VY) * sc.misc.w;
  let p = vec3f(
    mix(-3.3, 3.3, (f32(g.x) + 0.5) / f32(VX)),
    yl - f32(level) * sc.misc.y,
    mix(0.1, sc.misc.z, (f32(iz) + 0.5) / f32(VZ)));
  let l = sun_dir();
  let s = (0.1 - p.z) / l.z;
  var v = 0.0;
  if (s > 0.0 && lvl[level * LS].z > 0.5 && in_pane(p + l * s, level)) {
    let h = intersect(p, l, s * 0.995, true, level);
    if (h.t < 0.0) { v = 1.0; }
  }
  vol_w[((level * VZ + iz) * VY + g.y) * VX + g.x] = v;
}

struct PathOut {
  diff: vec3f,   // diffuse radiance divided by the first-hit diffuse albedo alb (what the denoiser filters)
  spec: vec3f,   // radiance that went through a specular lobe at the first vertex (not modulated by alb)
  alb: vec3f,
  n: vec3f,
  t: f32,
};

// One path from (o, d) inside the room of level: full BSDF (Lambert + GGX), next event estimation to every light with
// multiple importance sampling against BSDF-sampled hits of the emitters, the exact sun at every vertex, 4 vertices.
// The result is split by the lobe taken at the first vertex so that the diffuse part can be denoised demodulated.
// cam: the ray is a camera ray (albedo is filtered to the pixel footprint), else to 8 cm.
// the first vertex of a camera path ends here: the cab hit that is nearer than any room geometry (see cab_primary)
var<private> prim_tmax: f32 = 1e5;
fn radiance(o_in: vec3f, d_in: vec3f, level: u32, cam: bool) -> PathOut {
  var po: PathOut;
  po.diff = vec3f(0.0);
  po.spec = vec3f(0.0);
  po.alb = vec3f(1.0);
  po.n = vec3f(0.0);
  po.t = 1e5;
  var o = o_in;
  var d = d_in;
  var thr = vec3f(1.0);
  var lobe = 0;          // lobe taken at the first vertex: 1 diffuse, 2 specular (or the glass reflection)
  var prev_pdf = -1.0;   // BSDF density of the last sampled direction, for MIS; < 0: none (camera ray, mirror)
  for (var b = 0; b < 4; b++) {
    let h = intersect(o, d, select(1e5, prim_tmax, b == 0 && cam), false, level);
    if (h.t < 0.0) { break; }
    let ob = objs[u32(h.id)];
    let kind = ob.c.w;
    let p = o + d * h.t;
    if (is_emitter(kind)) {
      if (b == 0) { po.t = h.t; }
      if (kind == 1.0 && b == 0) {
        // glass: the Fresnel reflection continues into the room as a mirror lobe
        let f = 0.04 + 0.96 * pow(clamp(1.0 + d.z, 0.0, 1.0), 5.0);
        po.diff += sc.sky.rgb * (1.0 - f);
        po.n = vec3f(0.0, 0.0, 1.0);
        thr = vec3f(f);
        lobe = 2;
        prev_pdf = -1.0;
        o = p + vec3f(0.0, 0.0, 2e-3);
        d = vec3f(d.x, d.y, -d.z);
        continue;
      }
      var w = 1.0;
      if (prev_pdf > 0.0) {
        let pl = light_pdf(kind, h, d, level);
        if (pl > 0.0) { w = mis(prev_pdf, pl); }
      }
      let c = thr * emission(kind, level) * w;
      if (lobe == 2) { po.spec += c; } else { po.diff += c; }
      break;
    }
    var n = h.n;
    if (dot(n, d) > 0.0) { n = -n; }
    if (kind == 4.0 && n.z < -0.5 && p.z > sc.misc.z - 0.02) {
      // the open front: outside radiance
      let c = thr * select(lm_bg(level), live_bg(), b == 0);
      if (lobe == 2) { po.spec += c; } else { po.diff += c; }
      break;
    }
    let alb = albedo_of(ob, h, p, select(0.08, pix_fw(h.t), b == 0 && cam));
    let m = material(ob, n, alb);
    let v = -d;
    let ns = n;
    let nv = max(dot(ns, v), 1e-3);
    let alpha = max(m.rough * m.rough, 0.004);
    var ps = 0.0;
    var kd = 1.0;
    if (m.spec_on) {
      let fa = lum(fres(m.f0, nv));
      ps = clamp(fa, 0.1, 0.9);
      kd = 1.0 - fa;
    }
    if (b == 0) { po.alb = m.dif; po.n = n; po.t = h.t; }

    // direct light: area lights with MIS, the sun exactly
    var cd = vec3f(0.0);
    var cs = vec3f(0.0);
    let ne = nee_light(p, n, level);
    if (ne.ok) {
      let nl = max(dot(n, ne.l), 0.0);
      var pdf_b = (1.0 - ps) * nl / PI;
      var fs = vec3f(0.0);
      if (m.spec_on) {
        fs = spec_eval(ns, v, ne.l, alpha, m.f0);
        pdf_b += ps * spec_pdf(ns, v, ne.l, alpha);
      }
      let wl = mis(ne.pdf, pdf_b) / ne.pdf;
      cd += ne.le * (kd * nl / PI * wl);
      cs += ne.le * fs * wl;
    }
    if (sun_visible(p, n, level)) {
      let sl = sun_dir();
      cd += sun_col() * (kd * dot(n, sl) / PI);
      if (m.spec_on) { cs += sun_col() * spec_eval(ns, v, sl, alpha, m.f0); }
    }
    if (b == 0) {
      po.diff += cd + sc.amb.rgb;
      po.spec += cs;
    } else {
      let c = thr * (m.dif * cd + cs);
      if (lobe == 2) { po.spec += c; } else { po.diff += c; }
    }
    if (b == 3) { break; }

    // next direction
    var l: vec3f;
    if (rnd() < ps) {
      let tb = onb(ns);
      let vl = vec3f(dot(v, tb[0]), dot(v, tb[1]), dot(v, tb[2]));
      let hw = tb * sample_vndf(vl, alpha, rnd(), rnd());
      l = reflect(-v, hw);
      if (dot(l, n) <= 0.0 || dot(l, ns) <= 0.0) { break; }
      let wgt = fres(m.f0, max(dot(v, hw), 0.0)) * (smith_g1(dot(ns, l), alpha * alpha) / ps);
      if (b == 0 && lobe == 0) { lobe = 2; thr = wgt; } else { thr *= wgt; }
    } else {
      l = cosine_dir(n);
      if (b == 0 && lobe == 0) { lobe = 1; thr = vec3f(kd / (1.0 - ps)); } else { thr *= m.dif * (kd / (1.0 - ps)); }
    }
    prev_pdf = (1.0 - ps) * max(dot(n, l), 0.0) / PI;
    if (m.spec_on) { prev_pdf += ps * spec_pdf(ns, v, l, alpha); }
    o = p + n * 2e-3;
    d = l;
  }
  return po;
}

// ---- the elevator cab (docs/ELEVATOR.md): a separate object list in the cab frame, traced for primary rays only and
// lit analytically by its own lamp (no lightmap). The cab never moves; the building slides past it, so the ray origin
// is shifted by the car depth. The hall doors of every floor are part of this list.
const CAB_GAIN = 7.0;
fn cab_level() -> u32 { return u32(sc.cab.w); }
// zoomed out: per-ray random for the cutaway dissolve, the share of rays that skip the building's front wall
var<private> cut_r: f32 = 1.0;
fn hall_cut() -> f32 { return smoothstep(0.1, 0.5, sc.fx.z); }
// where a ray enters the building: the front plane, or just behind the hall wall for the rays that cut it away
fn front_z() -> f32 { return select(sc.misc.z, sc.misc.z - 0.11, cut_r < hall_cut()); }
fn cab_primary(oc: vec3f, d: vec3f) -> Hit {
  if (sc.cab.y > 0.5 && oc.z > 4.6 && d.z < -1e-3) {
    // settled with the doors open: a ray that stays inside the clear opening from the eye to the shaft rails cannot hit
    // the cab (no cab object sits inside |x| < 0.8, 0.15 < y < 1.85 between z 4.1 and 4.5)
    let xa = oc.x + d.x * (4.1 - oc.z) / d.z;
    let xb = oc.x + d.x * (4.5 - oc.z) / d.z;
    let ya = oc.y + d.y * (4.1 - oc.z) / d.z;
    if (abs(xa) < 0.8 && abs(xb) < 0.8 && ya > 0.15 && ya < 1.85) { return Hit(-1.0, vec3f(0.0), vec3f(0.0), -1); }
  }
  if (sc.fx.z <= 0.0) { return intersect(oc, d, 1e5, false, cab_level()); }
  // zoomed out: the ceiling (and the hall door leaves, which stand in the building's front wall) dissolve per ray with the zoom,
  // the accumulation turns the noise into a see-through cutaway
  let cut_ceil = smoothstep(0.05, 0.3, sc.fx.z);
  let cut_wall = hall_cut();
  var best = Hit(-1.0, vec3f(0.0), vec3f(0.0), -1);
  var tmax = 1e5;
  let first = u32(lvl[cab_level() * LS].x);
  let n = first + u32(lvl[cab_level() * LS].y);
  for (var i = first; i < n; i++) {
    let ob = objs[i];
    if (ob.c.z > 4.5 && ob.c.y > 2.3 && ob.c.y < 2.8 && cut_r < cut_ceil) { continue; }
    if (ob.c.z > 3.8 && ob.c.z < 3.9 && cut_r < cut_wall) { continue; }
    var h: Hit;
    if (ob.c.w >= 8.0) { h = sphere_hit(oc, d, ob, tmax); } else { h = box_hit(oc, d, ob, tmax); }
    if (h.t > 0.0) { best = h; best.id = i32(i); tmax = h.t; }
  }
  return best;
}

// sphere light of the cab lamp at cab-frame point pc: (direction to it, irradiance factor E / pi per unit colour)
fn cab_lamp_at(pc: vec3f, n: vec3f, shadow: bool) -> vec4f {
  let lamp = lvl[cab_level() * LS + 1u];
  let tl = lamp.xyz - pc;
  let d2 = max(dot(tl, tl), 0.04);
  let l = tl * inverseSqrt(d2);
  let nl = max(dot(n, l), 0.0);
  var vis = 1.0;
  if (shadow && nl > 0.0) {
    let sh = intersect(pc + n * 2e-3, l, sqrt(d2) - lamp.w - 0.02, false, cab_level());
    if (sh.t > 0.0) { vis = 0.0; }
  }
  return vec4f(l, lamp.w * lamp.w / d2 * nl * vis * CAB_GAIN);
}

fn cab_shade(h: Hit, oc: vec3f, d: vec3f) -> vec3f {
  let ob = objs[u32(h.id)];
  // emissive parts (lamps, dial and button lights, door seam light) carry their radiance in tx, flagged by w
  if (ob.tx.w > 0.5) { return ob.tx.rgb; }
  let pc = oc + d * h.t;
  var n = h.n;
  if (dot(n, d) > 0.0) { n = -n; }
  let alb = albedo_of(ob, h, pc, pix_fw(h.t));
  let m = material(ob, n, alb);
  let lc = lvl[cab_level() * LS + 2u].rgb;
  let la = cab_lamp_at(pc, n, true);
  var col = m.dif * lc * la.w;
  if (m.spec_on) {
    col += lc * la.w * PI * spec_eval(n, -d, la.xyz, max(m.rough * m.rough, 0.004), m.f0) ;
  }
  // warm bounce fill: the oak and tile return the lamp light, stronger from below
  let fill = vec3f(0.075, 0.05, 0.03) * (0.55 + 0.45 * (0.5 - 0.5 * n.y));
  col += m.dif * fill;
  return col;
}

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.x) >= sc.res.x || f32(gid.y) >= sc.res.y) { return; }
  let idx = gid.y * u32(sc.res.x) + gid.x;
  rng_state = idx * 9781u + u32(sc.tone.y) * 6271u + 1u;
  pcg(); pcg();

  cut_r = pcg();
  let uv = (vec2f(gid.xy) + vec2f(pcg(), pcg())) / sc.res;
  let ndc = sc.view.xy + vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * sc.view.z;
  let aspect = sc.res.x / sc.res.y;
  let th = sc.cam.w;
  let d = normalize(sc.fwd.xyz + sc.rgt.xyz * (ndc.x * th * aspect) + sc.up.xyz * (ndc.y * th));
  var o = sc.cam.xyz;

  var po: PathOut;
  po.diff = vec3f(0.0);
  po.spec = vec3f(0.0);
  po.alb = vec3f(1.0);
  po.n = vec3f(0.0);
  po.t = 1e5;
  var level = 0u;

  // the cab (primary rays only); its hits are measured from the same origin as the room's
  let oc = vec3f(o.x, o.y + sc.cab.x, o.z);
  var ch = Hit(-1.0, vec3f(0.0), vec3f(0.0), -1);
  if (sc.cab.z > 0.5) { ch = cab_primary(oc, d); }

  // enter the building through its open front
  let tp = (front_z() - o.z) / d.z;
  let q = o + d * tp;
  let top = sc.misc.w;
  let depth = top - q.y;
  let k = floor(depth / sc.misc.y);
  let rel = depth - k * sc.misc.y;
  var inside = tp > 0.0 && k >= 0.0 && k < sc.misc.x && abs(q.x) < 3.3;
  var from_inside = false;
  if (o.z < sc.misc.z) {
    // the camera is already in a room (close-up shots)
    from_inside = true;
    inside = true;
  }
  let cab_first = ch.t > 0.0 && !from_inside && ch.t < tp;
  if (from_inside) {
    level = u32(clamp(floor((top - o.y) / sc.misc.y), 0.0, sc.misc.x - 1.0));
  } else if (inside && rel > top) {
    po.diff = vec3f(0.1, 0.085, 0.07); // the floor slab between two rooms
    inside = false;
  } else if (!inside) {
    po.diff = live_bg();
  } else {
    level = u32(k);
    o = q + d * 1e-3;
  }
  // the cab's hits are measured from the eye, the room's from the front plane
  let t_cab = ch.t - tp;
  var cab_win = cab_first;
  if (inside && !cab_first) {
    if (ch.t > 0.0) { prim_tmax = t_cab; }
    po = radiance(o, d, level, true);
    if (ch.t > 0.0 && po.t >= t_cab) { cab_win = true; }
  }
  if (cab_win) {
    po.diff = cab_shade(ch, oc, d);
    po.spec = vec3f(0.0);
    po.alb = vec3f(1.0);
    po.n = select(ch.n, -ch.n, dot(ch.n, d) > 0.0);
    po.t = 0.0; // no depth: the shaft light shafts and the denoiser's depth stop treat the cab as the near field
  }

  let col = po.diff; // already demodulated: the first-hit diffuse albedo was never multiplied in
  let prev = accum[idx];
  var n_prev = prev.a;
  if (sc.frame < 0.5) { n_prev = min(n_prev, 1.0); }
  let wgt = max(1.0 / (n_prev + 1.0), sc.blend);
  let wa = select(1.0, wgt, n_prev > 0.0);
  let mean = mix(prev.rgb, min(col, vec3f(30.0)), wa);
  accum[idx] = vec4f(mean, n_prev + 1.0);
  gbuf[idx * GS] = vec4f(po.n, po.t);
  gbuf[idx * GS + 1u] = vec4f(mix(gbuf[idx * GS + 1u].rgb, po.alb, wa), 0.0);
  gbuf[idx * GS + 2u] = vec4f(mix(gbuf[idx * GS + 2u].rgb, min(po.spec, vec3f(30.0)), wa), 0.0);
}

// ---- reflection probes: radiance seen from the room centre, a cube map per floor (layers level * 6 + face) ------------
const PN = 128u;
const PROBE_MIPS = 5.0;
const PROBE_C = vec3f(0.0, 1.5, 2.0);
// the box that stands in for the room when a reflection ray is parallax corrected: the back wall is moved forward to
// where the window, lamp, sign and magazines are, so their reflections land where they do in the path-traced frame
const PROBE_BMIN = vec3f(-3.3, 0.0, 0.25);

// direction of texel (u, v) in [0,1]^2 of cube face f (the sampling convention of cube maps)
fn cube_dir(f: u32, uv: vec2f) -> vec3f {
  let a = uv.x * 2.0 - 1.0;
  let b = uv.y * 2.0 - 1.0;
  var d: vec3f;
  switch (f) {
    case 0u: { d = vec3f(1.0, -b, -a); }
    case 1u: { d = vec3f(-1.0, -b, a); }
    case 2u: { d = vec3f(a, 1.0, b); }
    case 3u: { d = vec3f(a, -1.0, -b); }
    case 4u: { d = vec3f(a, -b, 1.0); }
    default: { d = vec3f(-a, -b, -1.0); }
  }
  return normalize(d);
}

@compute @workgroup_size(8, 8, 1)
fn bake_probe(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= PN || g.y >= PN || g.z >= u32(sc.misc.x) * 6u) { return; }
  let level = g.z / 6u;
  let idx = (g.z * PN + g.y) * PN + g.x;
  rng_state = idx * 9781u + u32(sc.tone.y) * 6271u + 1u;
  pcg(); pcg();
  let o = PROBE_C - vec3f(0.0, f32(level) * sc.misc.y, 0.0);
  var sum = vec3f(0.0);
  for (var s = 0; s < i32(sc.fx.y); s++) {
    let d = cube_dir(g.z % 6u, (vec2f(g.xy) + vec2f(pcg(), pcg())) / f32(PN));
    let po = radiance(o, d, level, false);
    sum += min(po.diff * po.alb + po.spec, vec3f(30.0));
  }
  var prev = probe_acc[idx].rgb;
  if (sc.fx.x < 0.5) { prev = vec3f(0.0); }
  let tot = prev + sum;
  probe_acc[idx] = vec4f(tot, 0.0);
  textureStore(probe_w, vec2i(g.xy), g.z, vec4f(tot / (sc.fx.x + sc.fx.y), 1.0));
}

// mip m holds the radiance convolved with a GGX lobe of roughness m / (mips - 1): 64 importance samples of mip 0
@compute @workgroup_size(8, 8, 1)
fn probe_mip(@builtin(global_invocation_id) g: vec3u) {
  let ds = textureDimensions(probe_w).x;
  if (g.x >= ds || g.y >= ds || g.z >= u32(sc.misc.x) * 6u) { return; }
  let rough = log2(f32(PN / ds)) / (PROBE_MIPS - 1.0);
  let a2 = pow(rough, 4.0);
  let n = cube_dir(g.z % 6u, (vec2f(g.xy) + vec2f(0.5)) / f32(ds));
  let tb = onb(n);
  let layer = g.z / 6u;
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0u; i < 64u; i++) {
    let u1 = (f32(i) + 0.5) / 64.0;
    let u2 = f32(reverseBits(i)) * 2.3283064e-10;
    let ct = sqrt((1.0 - u1) / (1.0 + (a2 - 1.0) * u1));
    let st = sqrt(max(0.0, 1.0 - ct * ct));
    let phi = 6.2831853 * u2;
    let h = tb * vec3f(st * cos(phi), st * sin(phi), ct);
    let l = 2.0 * dot(n, h) * h - n;
    let nl = dot(n, l);
    if (nl > 0.0) {
      sum += textureSampleLevel(probe_src, probe_s, l, layer, 0.0).rgb * nl;
      wsum += nl;
    }
  }
  textureStore(probe_w, vec2i(g.xy), g.z, vec4f(sum / max(wsum, 1e-4), 1.0));
}

// reflection lookup for a surface point p (world, floor level) and reflected direction r: the room is a box, so the
// ray is intersected with it and the probe is read in the direction of the hit seen from the probe centre (parallax correction)
fn probe_sample(p: vec3f, r: vec3f, level: u32, mip: f32) -> vec3f {
  let pl = vec3f(p.x, p.y + f32(level) * sc.misc.y, p.z);
  let bmax = vec3f(3.3, sc.misc.w, sc.misc.z);
  let inv = 1.0 / select(r, vec3f(1e-6), abs(r) < vec3f(1e-6));
  let t1 = (PROBE_BMIN - pl) * inv;
  let t2 = (bmax - pl) * inv;
  let t = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
  let q = pl + r * max(t, 0.0);
  return textureSampleLevel(probe, probe_s, normalize(q - PROBE_C), level, mip).rgb;
}


// ---- per-surface irradiance lightmaps (static scene, baked progressively) ----------------------
// Every box face and every sphere owns a texel grid. lm_meta[obj * 6 + face] = (texel offset, nu, nv, level);
// nu = 0 marks a surface without a map (glass panes, the lamp bulb). Spheres use face 0 as a lat-long grid.
// A texel stores diffuse irradiance E / pi (so albedo * E is the outgoing radiance) WITHOUT the sun's direct
// term at the first hit; the view pass adds that exactly, with one noise-free shadow ray.

const LM_BOUNCES = 3;

// local axis a of a box, as a world vector
fn lm_axis(ob: Obj, a: u32) -> vec3f {
  if (a == 0u) { return ob.r0.xyz; }
  if (a == 1u) { return ob.r1.xyz; }
  return ob.r2.xyz;
}

// outside radiance fades as the elevator descends (see room.ts): seen directly it follows the live depth,
// as light entering a floor it is that floor's own depth, so baked and traced lighting agree at any camera height
fn live_bg() -> vec3f { return sc.bg.rgb * sc.bg.w; }
fn lm_bg(level: u32) -> vec3f {
  return sc.bg.rgb * (1.0 - 0.85 * min(1.0, 1.4 * f32(level) / max(1.0, sc.misc.x - 1.0)));
}

// diffuse irradiance estimate at a surface point: area lights by NEE, then cosine bounces (sun kept from the 2nd vertex on)
fn lm_sample(p: vec3f, n: vec3f, level: u32) -> vec3f {
  var e = direct_area(p, n, level) + sc.amb.rgb;
  var thr = vec3f(1.0);
  var o = p + n * 2e-3;
  var d = cosine_dir(n);
  for (var b = 0; b < LM_BOUNCES; b++) {
    let h = intersect(o, d, 1e5, false, level);
    if (h.t < 0.0) { break; }
    let ob = objs[u32(h.id)];
    let kind = ob.c.w;
    if (is_emitter(kind)) { break; }
    let p2 = o + d * h.t;
    var n2 = h.n;
    if (dot(n2, d) > 0.0) { n2 = -n2; }
    if (kind == 4.0 && n2.z < -0.5 && p2.z > sc.misc.z - 0.02) { e += thr * lm_bg(level); break; }
    let a2 = material(ob, n2, albedo_of(ob, h, p2, 0.08)).dif;
    e += thr * a2 * direct(p2, n2, level);
    thr *= a2;
    d = cosine_dir(n2);
    o = p2 + n2 * 2e-3;
  }
  return e;
}

// metadata is sorted by offset: the entry of the face that owns texel t is the last one whose offset is <= t
fn lm_find(t: u32) -> u32 {
  var lo = 0u;
  var hi = arrayLength(&lm_meta) - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) / 2u;
    if (lm_meta[mid].x <= t) { lo = mid; } else { hi = mid - 1u; }
  }
  return lo;
}

// one thread per texel: sc.lmx = (samples so far, samples this pass, texel count, workgroups per row)
@compute @workgroup_size(64)
fn bake_lightmap(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = (wid.y * u32(sc.lmx.w) + wid.x) * 64u + li;
  if (t >= u32(sc.lmx.z)) { return; }
  let lo = lm_find(t);
  let m = lm_meta[lo];
  let ob = objs[lo / 6u];
  let face = lo % 6u;
  let nu = m.y;
  let ti = t - m.x;
  let iu = ti % nu;
  let iv = ti / nu;
  var p: vec3f;
  var n: vec3f;
  if (ob.c.w >= 8.0) {
    let phi = (f32(iu) + 0.5) / f32(nu) * 6.2831853 - 3.1415927;
    let th = (f32(iv) + 0.5) / f32(m.z) * 3.1415927;
    n = vec3f(sin(th) * cos(phi), cos(th), sin(th) * sin(phi));
    p = ob.c.xyz + n * ob.h.x;
  } else {
    let a = face / 2u;
    let ua = (a + 1u) % 3u;
    let va = (a + 2u) % 3u;
    let sg = select(1.0, -1.0, (face & 1u) == 1u);
    var l = vec3f(0.0);
    l[a] = sg * ob.h[a];
    l[ua] = ((f32(iu) + 0.5) / f32(nu) * 2.0 - 1.0) * ob.h[ua];
    l[va] = ((f32(iv) + 0.5) / f32(m.z) * 2.0 - 1.0) * ob.h[va];
    p = ob.c.xyz + ob.r0.xyz * l.x + ob.r1.xyz * l.y + ob.r2.xyz * l.z;
    n = lm_axis(ob, a) * sg;
    // the room shell is seen from inside
    if (ob.c.w == 4.0) { n = -n; }
  }
  rng_state = t * 9781u + u32(sc.tone.y) * 6271u + 1u;
  pcg(); pcg();
  var sum = vec3f(0.0);
  // low-discrepancy sample index continues across passes, so the progressive mean stays a prefix of one sequence
  for (var d = 0u; d < 5u; d++) { qmc_o[d] = hash_u(t * 5u + d + 12345u); }
  qmc_on = true;
  for (var s = 0; s < i32(sc.lmx.y); s++) {
    qmc_i = u32(sc.lmx.x) + u32(s) + 1u;
    qmc_d = 0u;
    sum += min(lm_sample(p, n, m.w), vec3f(30.0));
  }
  var prev = lm_acc[t].rgb;
  if (sc.lmx.x < 0.5) { prev = vec3f(0.0); }
  let tot = prev + sum;
  lm_acc[t] = vec4f(tot, 0.0);
  let mean = tot / (sc.lmx.x + sc.lmx.y);
  lm_w[t] = vec2u(pack2x16float(mean.rg), pack2x16float(vec2f(mean.b, 0.0)));
}

fn lm_texel(off: u32, nu: i32, ix: i32, iy: i32) -> vec3f {
  let v = lm[off + u32(iy * nu + ix)];
  return vec3f(unpack2x16float(v.x), unpack2x16float(v.y).x);
}

// Catmull-Rom weights for the 4 taps around fractional position f (taps at -1, 0, 1, 2)
fn cr_w(f: f32) -> vec4f {
  let f2 = f * f;
  let f3 = f2 * f;
  return vec4f(-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1.0, -1.5 * f3 + 2.0 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2);
}

// Bicubic (Catmull-Rom) fetch at texel-space position g of one face's map. Taps never leave the face: indices are
// clamped to the face's range (u wraps instead when wrapx, for the lat-long sphere map). Negative lobes are clamped to 0.
fn lm_bicubic(off: u32, nu: i32, nv: i32, g: vec2f, wrapx: bool) -> vec3f {
  let i0 = vec2i(floor(g));
  let f = g - vec2f(i0);
  let wx = cr_w(f.x);
  let wy = cr_w(f.y);
  var acc = vec3f(0.0);
  for (var j = 0; j < 4; j++) {
    let iy = clamp(i0.y + j - 1, 0, nv - 1);
    var row = vec3f(0.0);
    for (var i = 0; i < 4; i++) {
      var ix = i0.x + i - 1;
      if (wrapx) { ix = ((ix % nu) + nu) % nu; } else { ix = clamp(ix, 0, nu - 1); }
      row += lm_texel(off, nu, ix, iy) * wx[i];
    }
    acc += row * wy[j];
  }
  return max(acc, vec3f(0.0));
}

// smooth reconstruction from the surface's own map (never from a neighbouring face)
fn lightmap(oi: u32, ob: Obj, hit: Hit) -> vec3f {
  var m: vec4u;
  var g: vec2f;
  if (ob.c.w >= 8.0) {
    m = lm_meta[oi * 6u];
    let dn = hit.lp;
    g = vec2f((atan2(dn.z, dn.x) / 6.2831853 + 0.5) * f32(m.y) - 0.5,
              acos(clamp(dn.y, -1.0, 1.0)) / 3.1415927 * f32(m.z) - 0.5);
    return lm_bicubic(m.x, i32(m.y), i32(m.z), g, true);
  }
  let r = abs(hit.lp) / max(ob.h.xyz, vec3f(1e-6));
  var a = 0u;
  var mx = r.x;
  if (r.y > mx) { a = 1u; mx = r.y; }
  if (r.z > mx) { a = 2u; }
  let face = a * 2u + select(0u, 1u, hit.lp[a] < 0.0);
  m = lm_meta[oi * 6u + face];
  let ua = (a + 1u) % 3u;
  let va = (a + 2u) % 3u;
  let nu = i32(m.y);
  let nv = i32(m.z);
  g = vec2f((hit.lp[ua] / ob.h[ua] + 1.0) * 0.5 * f32(nu) - 0.5,
            (hit.lp[va] / ob.h[va] + 1.0) * 0.5 * f32(nv) - 0.5);
  g = clamp(g, vec2f(0.0), vec2f(f32(nu - 1), f32(nv - 1)));
  return lm_bicubic(m.x, nu, nv, g, false);
}

// ---- lightmap denoise: edge-avoiding a-trous on the f16 irradiance texels, strictly inside each face ----
// Input is the raw progressive mean (lm_in), output the filtered map. Edge stopping is the relative luminance
// difference, tolerance sigma shrinks as 1/sqrt(samples) (the noise level), so real edges (shadow boundaries,
// the lamp's falloff over a few texels) survive while sample noise is averaged away.
@group(0) @binding(20) var<storage, read> lm_in: array<vec2u>;
@group(0) @binding(21) var<storage, read_write> lm_out: array<vec2u>;

fn lm_ld(t: u32) -> vec3f {
  let v = lm_in[t];
  return vec3f(unpack2x16float(v.x), unpack2x16float(v.y).x);
}

@compute @workgroup_size(64)
fn denoise_lightmap(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = (wid.y * u32(sc.lmx.w) + wid.x) * 64u + li;
  if (t >= u32(sc.lmx.z)) { return; }
  let lo = lm_find(t);
  let m = lm_meta[lo];
  let nu = i32(m.y);
  let nv = i32(m.z);
  let ti = i32(t - m.x);
  let ix = ti % nu;
  let iy = ti / nu;
  let wrapx = objs[lo / 6u].c.w >= 8.0;
  let c = lm_ld(t);
  let l0 = lum(c);
  let n = sc.lmx.x + sc.lmx.y;
  let sigma = 0.06 + 1.6 / sqrt(n);
  let st = i32(af.step.x);
  var k = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
  var sum = c * 0.140625;
  var wsum = 0.140625;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      if (i == 0 && j == 0) { continue; }
      var qx = ix + i * st;
      let qy = clamp(iy + j * st, 0, nv - 1);
      if (wrapx) { qx = ((qx % nu) + nu) % nu; } else { qx = clamp(qx, 0, nu - 1); }
      let p = lm_ld(m.x + u32(qy * nu + qx));
      let lp = lum(p);
      let rel = abs(l0 - lp) / (max(l0, lp) + 0.03);
      let wt = k[i + 2] * k[j + 2] * exp(-rel / sigma);
      sum += p * wt;
      wsum += wt;
    }
  }
  let r = sum / wsum;
  lm_out[t] = vec2u(pack2x16float(r.rg), pack2x16float(vec2f(r.b, 0.0)));
}

// scroll / zoom pass: trace only the primary ray; lighting = lightmap + the exact sun, reflections from the floor's probe
@compute @workgroup_size(8, 8)
fn cs_view(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.x) >= sc.res.x || f32(gid.y) >= sc.res.y) { return; }
  let idx = gid.y * u32(sc.res.x) + gid.x;

  cut_r = hash21(vec2f(gid.xy) + vec2f(0.5));
  let uv = (vec2f(gid.xy) + vec2f(0.5)) / sc.res;
  let ndc = sc.view.xy + vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * sc.view.z;
  let aspect = sc.res.x / sc.res.y;
  let th = sc.cam.w;
  let d = normalize(sc.fwd.xyz + sc.rgt.xyz * (ndc.x * th * aspect) + sc.up.xyz * (ndc.y * th));
  let o = sc.cam.xyz;

  var e = vec3f(0.0);
  var sp = vec3f(0.0);
  var alb = vec3f(1.0);
  var nrm = vec3f(0.0);
  var tt = 1e5;

  let oc = vec3f(o.x, o.y + sc.cab.x, o.z);
  var ch = Hit(-1.0, vec3f(0.0), vec3f(0.0), -1);
  if (sc.cab.z > 0.5) { ch = cab_primary(oc, d); }

  let tp = (front_z() - o.z) / d.z;
  let q = o + d * tp;
  let top = sc.misc.w;
  let depth = top - q.y;
  let k = floor(depth / sc.misc.y);
  let rel = depth - k * sc.misc.y;
  var inside = tp > 0.0 && k >= 0.0 && k < sc.misc.x && abs(q.x) < 3.3;
  var from_inside = false;
  var level = 0u;
  var start = q + d * 1e-3;
  if (o.z < sc.misc.z) {
    from_inside = true;
    inside = true;
    start = o;
    level = u32(clamp(floor((top - o.y) / sc.misc.y), 0.0, sc.misc.x - 1.0));
  } else if (inside && rel > top) {
    e = vec3f(0.1, 0.085, 0.07);
    inside = false;
  } else if (!inside) {
    e = live_bg();
  } else {
    level = u32(k);
  }

  let cab_first = ch.t > 0.0 && !from_inside && ch.t < tp;
  var cab_win = cab_first;
  if (inside && !cab_first) {
    // the cab's hits are measured from the eye, the room's from the front plane
    var tmax_room = 1e5;
    if (ch.t > 0.0) { tmax_room = ch.t - tp; }
    let h = intersect(start, d, tmax_room, false, level);
    if (h.t < 0.0 && ch.t > 0.0) { cab_win = true; }
    if (h.t >= 0.0) {
      let ob = objs[u32(h.id)];
      let kind = ob.c.w;
      let p = start + d * h.t;
      var n = h.n;
      if (dot(n, d) > 0.0) { n = -n; }
      if (kind == 1.0) {
        // glass: transmitted sky plus the Fresnel reflection of the room, read from the probe
        let f = 0.04 + 0.96 * pow(clamp(1.0 + d.z, 0.0, 1.0), 5.0);
        e = sc.sky.rgb * (1.0 - f);
        sp = probe_sample(p, vec3f(d.x, d.y, -d.z), level, 0.0) * f;
        nrm = vec3f(0.0, 0.0, 1.0);
        tt = h.t;
      } else if (is_emitter(kind)) {
        e = emission(kind, level);
        tt = h.t;
      } else if (kind == 4.0 && n.z < -0.5 && p.z > sc.misc.z - 0.02) {
        e = live_bg();
      } else {
        alb = albedo_of(ob, h, p, pix_fw(h.t));
        let m = material(ob, n, alb);
        let v = -d;
        let ns = n;
        let nv = max(dot(ns, v), 1e-3);
        var kd = 1.0;
        if (m.spec_on) { kd = 1.0 - lum(fres(m.f0, nv)); }
        let lmv = lightmap(u32(h.id), ob, h);
        e = (lmv + direct_sun(p, n, level)) * kd;
        alb = m.dif;
        nrm = n;
        tt = h.t;
        if (m.spec_on) {
          let alpha = max(m.rough * m.rough, 0.004);
          // environment reflection from the floor probe: parallax-corrected, blurred by roughness, split-sum Fresnel
          let r = reflect(d, ns);
          let env = probe_sample(p, r, level, m.rough * (PROBE_MIPS - 1.0));
          // specular occlusion: a point that sees less light than the probe centre reflects proportionally less
          let ref_e = lum(probe_sample(p, n, level, PROBE_MIPS - 1.0));
          let so = smoothstep(0.05, 0.5, lum(lmv) / max(ref_e, 1e-3));
          sp = env * env_brdf(m.f0, m.rough, nv) * so;
          if (sun_visible(p, n, level)) { sp += sun_col() * spec_eval(ns, v, sun_dir(), alpha, m.f0); }
        }

        // the magazine being opened takes on the reading light as it arrives
        if (i32(h.id) == i32(sc.rd0.y)) { e = mix(e, vec3f(page_light(p, level)), sc.rd0.x); }
      }
    }
  }

  if (cab_win) {
    e = cab_shade(ch, oc, d);
    sp = vec3f(0.0);
    alb = vec3f(1.0);
    nrm = select(ch.n, -ch.n, dot(ch.n, d) > 0.0);
    tt = 0.0; // see cs: the cab is the near field
  }

  // article sheets (surface kind 10), see magazine.wgsl.ts
  if (sc.rd0.x > 0.0) {
    let ph = page_trace(o, d);
    if (ph.t > 0.0 && ph.t < tt) {
      let ps = page_shade(ph, o + d * ph.t, level);
      alb = ps.alb;
      e = vec3f(ps.e);
      nrm = vec3f(0.0, 0.0, 1.0);
      tt = ph.t;
      sp = vec3f(0.0);
    } else {
      // everything that is not a page falls into shadow while an article is open
      let dim = 1.0 - 0.85 * smoothstep(0.0, 1.0, sc.rd0.x);
      e *= dim;
      sp *= dim;
    }
  }

  accum[idx] = vec4f(e, 6.0);
  gbuf[idx * GS] = vec4f(nrm, tt);
  gbuf[idx * GS + 1u] = vec4f(alb, 0.0);
  gbuf[idx * GS + 2u] = vec4f(sp, 0.0);
}


// edge-avoiding a-trous wavelet filter on demodulated irradiance
@compute @workgroup_size(8, 8)
fn atrous(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.x) >= sc.res.x || f32(gid.y) >= sc.res.y) { return; }
  let w = i32(sc.res.x);
  let hh = i32(sc.res.y);
  let ip = vec2i(gid.xy);
  let idx = u32(ip.y * w + ip.x);
  let c = filt_in[idx];
  let g0 = gb_ro[idx * GS];
  let l0 = lum(c.rgb);
  let sigma = 0.1 + 1.5 / sqrt(c.a + 1.0);
  var k = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
  var sum = c.rgb * 0.140625;
  var wsum = 0.140625;
  let st = i32(af.step.x);
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      if (i == 0 && j == 0) { continue; }
      let q = clamp(ip + vec2i(i, j) * st, vec2i(0), vec2i(w - 1, hh - 1));
      let qi = u32(q.y * w + q.x);
      let p = filt_in[qi];
      let g = gb_ro[qi * GS];
      let wn = pow(max(dot(g0.xyz, g.xyz), 0.0), 24.0);
      let wd = exp(-abs(g0.w - g.w) / (0.05 * g0.w + 0.02));
      let rel = abs(l0 - lum(p.rgb)) / (max(l0, lum(p.rgb)) + 0.1);
      let wl = exp(-rel / sigma);
      let wt = k[i + 2] * k[j + 2] * wn * wd * wl;
      sum += p.rgb * wt;
      wsum += wt;
    }
  }
  filt_out[idx] = vec4f(sum / wsum, c.a);
}

struct VOut { @builtin(position) pos: vec4f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return VOut(vec4f(p[i], 0.0, 1.0));
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn shade_at(ix: i32, iy: i32) -> vec3f {
  let rw = i32(sc.res.x);
  let rh = i32(sc.res.y);
  let x = clamp(ix, 0, rw - 1);
  let y = clamp(iy, 0, rh - 1);
  let idx = u32(y * rw + x);
  return final_ro[idx].rgb * gb_ro[idx * GS + 1u].rgb + gb_ro[idx * GS + 2u].rgb;
}

// light shafts: march the primary ray and add in-scatter wherever the sun beam passes through a pane
fn shafts(pos: vec2f, tend_in: f32) -> vec3f {
  let o = sc.cam.xyz;
  if (o.z < sc.misc.z) { return vec3f(0.0); }
  let uv = pos / vec2f(sc.tone.z, sc.tone.w);
  let ndc = sc.view.xy + vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * sc.view.z;
  let aspect = sc.res.x / sc.res.y;
  let d = normalize(sc.fwd.xyz + sc.rgt.xyz * (ndc.x * sc.cam.w * aspect) + sc.up.xyz * (ndc.y * sc.cam.w));
  let tp = (sc.misc.z - o.z) / d.z;
  if (tp <= 0.0) { return vec3f(0.0); }
  let q = o + d * tp;
  let tend = min(tend_in, 7.0);
  let l = sun_dir();
  let N = 40;
  let j = fract(52.9829189 * fract(dot(pos, vec2f(0.06711056, 0.00583715))));
  var sum = 0.0;
  for (var i = 0; i < N; i++) {
    let x = q + d * (tend * (f32(i) + j) / f32(N));
    let depth = sc.misc.w - x.y;
    let k = floor(depth / sc.misc.y);
    if (k < 0.0 || k >= sc.misc.x || depth - k * sc.misc.y > sc.misc.w || x.z < 0.1 || x.z > sc.misc.z) { continue; }
    let yl = x.y + k * sc.misc.y;
    // trilinear fetch of the baked sun-visibility grid (nearest voxels showed as steps in the beam)
    let g = vec3f(
      clamp((x.x + 3.3) / 6.6 * f32(VX) - 0.5, 0.0, f32(VX - 1u)),
      clamp(yl / sc.misc.w * f32(VY) - 0.5, 0.0, f32(VY - 1u)),
      clamp((x.z - 0.1) / (sc.misc.z - 0.1) * f32(VZ) - 0.5, 0.0, f32(VZ - 1u)));
    let g0 = vec3u(floor(g));
    let g1 = min(g0 + vec3u(1u), vec3u(VX - 1u, VY - 1u, VZ - 1u));
    let fr = g - floor(g);
    let kb = u32(k) * VZ;
    var v = array<f32, 8>();
    for (var c = 0u; c < 8u; c++) {
      let px = select(g0.x, g1.x, (c & 1u) != 0u);
      let py = select(g0.y, g1.y, (c & 2u) != 0u);
      let pz = select(g0.z, g1.z, (c & 4u) != 0u);
      v[c] = vol[((kb + pz) * VY + py) * VX + px];
    }
    sum += mix(mix(mix(v[0], v[1], fr.x), mix(v[2], v[3], fr.x), fr.y),
               mix(mix(v[4], v[5], fr.x), mix(v[6], v[7], fr.x), fr.y), fr.z);
  }
  return sun_col() * (sum / f32(N)) * tend * 0.022;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // the trace may run at a lower resolution while the camera moves: bilinear upsample
  let p = pos.xy / vec2f(sc.tone.z, sc.tone.w) * sc.res - 0.5;
  let i0 = vec2i(floor(p));
  let f = fract(p);
  var c = mix(mix(shade_at(i0.x, i0.y), shade_at(i0.x + 1, i0.y), f.x),
              mix(shade_at(i0.x, i0.y + 1), shade_at(i0.x + 1, i0.y + 1), f.x), f.y);
  let gi = u32(clamp(i32(round(p.y)), 0, i32(sc.res.y) - 1)) * u32(sc.res.x) + u32(clamp(i32(round(p.x)), 0, i32(sc.res.x) - 1));
  if (sc.post.x == 1.0) { return vec4f(pow(final_ro[gi].rgb * 0.3, vec3f(0.45)), 1.0); }
  if (sc.post.x == 2.0) { return vec4f(pow(gb_ro[gi * GS + 1u].rgb, vec3f(0.45)), 1.0); }
  if (sc.post.x == 3.0) { return vec4f(pow(gb_ro[gi * GS + 2u].rgb * 0.3, vec3f(0.45)), 1.0); }
  c += shafts(pos.xy, gb_ro[gi * GS].w) * (1.0 - smoothstep(0.0, 0.9, sc.rd0.x));
  c = aces(c * sc.tone.x);
  let uv = pos.xy / vec2f(sc.tone.z, sc.tone.w) - 0.5;
  c *= 1.0 - 0.55 * dot(uv, uv);
  // dither after the gamma curve (1.5 / 255 peak to peak): before it, the curve amplified the noise visibly in dark areas
  var o = pow(c, vec3f(1.0 / 2.2)) + (hash21(pos.xy) - 0.5) * (1.5 / 255.0);
  // the scrollbar, in display space over the finished picture
  for (var i = 0u; i < 12u; i++) {
    let r = sc.ov[i * 2u];
    let col = sc.ov[i * 2u + 1u];
    if (col.w <= 0.0) { continue; }
    let hs = r.zw * 0.5;
    let rad = min(hs.x, hs.y);
    let q = abs(pos.xy - (r.xy + hs)) - hs + vec2f(rad);
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
    o = mix(o, col.rgb, clamp(0.5 - d, 0.0, 1.0) * col.w);
  }
  if (sc.laba.x > 0.0) {
    let r = sc.lab;
    let hs = r.zw * 0.5;
    let q = abs(pos.xy - (r.xy + hs)) - hs + vec2f(6.0);
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 6.0;
    let t = clamp((pos.xy - r.xy) / r.zw, vec2f(0.0), vec2f(1.0));
    let tc = mix(sc.labt.xy, sc.labt.zw, t);
    let tx = textureSampleLevel(atlas, atlas_s, tc, 0.0).rgb;
    o = mix(o, tx, clamp(0.5 - d, 0.0, 1.0) * sc.laba.x);
  }
  return vec4f(o, 1.0);
}
` + MAGAZINE_WGSL;
