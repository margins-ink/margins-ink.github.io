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

@group(0) @binding(17) var<storage, read_write> vol_w: array<f32>;
@group(0) @binding(18) var<storage, read> vol: array<f32>;
const VX = 96u;
const VY = 48u;
const VZ = 64u;

var<private> rng_state: u32;

fn pcg() -> f32 {
  rng_state = rng_state * 747796405u + 2891336453u;
  let w = ((rng_state >> ((rng_state >> 28u) + 4u)) ^ rng_state) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967295.0;
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
  let first = u32(lvl[level * 3u].x);
  let n = first + u32(lvl[level * 3u].y);
  for (var i = first; i < n; i++) {
    if (skip_room && i == first) { continue; }
    let ob = objs[i];
    var h: Hit;
    if (ob.c.w >= 8.0) { h = sphere_hit(o, d, ob, tmax); } else { h = box_hit(o, d, ob, tmax); }
    if (h.t > 0.0) { best = h; best.id = i32(i); tmax = h.t; }
  }
  return best;
}

fn albedo_of(ob: Obj, hit: Hit, wp: vec3f) -> vec3f {
  let kind = ob.c.w;
  if (kind == 4.0) {
    if (hit.n.y > 0.5) {
      let p = wp.x * 5.0 + ob.alb.w;
      let plank = floor(p);
      let tone = hash21(vec2f(plank, 3.0));
      let grain = vnoise(vec2f(wp.x * 40.0, wp.z * 2.5 + plank * 7.0));
      let seam = smoothstep(0.0, 0.03, fract(p)) * smoothstep(1.0, 0.97, fract(p));
      return vec3f(0.42, 0.25, 0.13) * (0.7 + 0.45 * tone) * (0.85 + 0.3 * grain) * (0.35 + 0.65 * seam);
    }
    if (hit.n.y < -0.5) { return vec3f(0.82, 0.8, 0.74); }
    let plaster = 0.94 + 0.12 * vnoise(wp.xy * 14.0 + wp.zz * 9.0);
    let ly = wp.y - ob.c.y + ob.h.y; // height above this room's floor
    if (ly < 0.95) { return ob.tx.rgb * plaster; }
    if (ly < 1.0) { return vec3f(0.55, 0.45, 0.3); }
    return ob.alb.rgb * plaster;
  }
  if (kind == 6.0) {
    let g = vnoise(vec2f(wp.x * 22.0, wp.z * 3.0 + wp.y * 3.0));
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

fn cosine_dir(n: vec3f) -> vec3f {
  let r1 = pcg();
  let r2 = pcg();
  let phi = 6.2831853 * r1;
  let s = sqrt(r2);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.99);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  return normalize(tx * (cos(phi) * s) + ty * (sin(phi) * s) + n * sqrt(1.0 - r2));
}

// next event estimation: one of the level's window panes or its lamp, chosen uniformly
fn direct_area(p: vec3f, n: vec3f, level: u32) -> vec3f {
  let np = u32(lvl[level * 3u].z);
  let pick = min(u32(pcg() * f32(np + 1u)), np);
  var lp: vec3f;
  var ln: vec3f;
  var le: vec3f;
  var area: f32;
  if (pick < np) {
    let pn = panes[level * 4u + pick];
    lp = vec3f(pn.x + (pcg() * 2.0 - 1.0) * sc.pane.x, pn.y + (pcg() * 2.0 - 1.0) * sc.pane.y, sc.pane.z);
    ln = vec3f(0.0, 0.0, 1.0);
    le = sc.sky.rgb;
    area = 4.0 * sc.pane.x * sc.pane.y;
  } else {
    let lam = lvl[level * 3u + 1u];
    let z = pcg() * 2.0 - 1.0;
    let a = pcg() * 6.2831853;
    let rr = sqrt(max(0.0, 1.0 - z * z));
    ln = vec3f(rr * cos(a), rr * sin(a), z);
    lp = lam.xyz + ln * lam.w;
    le = lvl[level * 3u + 2u].rgb;
    area = 4.0 * 3.1415927 * lam.w * lam.w;
  }
  let v = lp - p;
  let d2 = dot(v, v);
  let dir = v * inverseSqrt(d2);
  let cs = dot(n, dir);
  let cl = dot(ln, -dir);
  if (cs <= 0.0 || cl <= 0.0) { return vec3f(0.0); }
  let o = p + n * 2e-3;
  let vv = lp - o;
  let dist = length(vv);
  let h = intersect(o, vv / dist, dist * 0.997 - 0.004, true, level);
  if (h.t > 0.0) { return vec3f(0.0); }
  return le * (cs * cl * area / d2) * f32(np + 1u) / 3.1415927;
}

// the sun (or moon) shines through the window panes: direction towards it, and its colour
const SUN_L = vec3f(0.2, 0.6, -1.0);
fn sun_dir() -> vec3f { return normalize(SUN_L); }
fn sun_col() -> vec3f { return sc.sky.rgb / max(max(sc.sky.r, sc.sky.g), sc.sky.b) * sc.sky.w; }

fn in_pane(c: vec3f, level: u32) -> bool {
  let np = u32(lvl[level * 3u].z);
  for (var i = 0u; i < np; i++) {
    let pn = panes[level * 4u + i];
    if (abs(c.x - pn.x) < sc.pane.x && abs(c.y - pn.y) < sc.pane.y) { return true; }
  }
  return false;
}

fn direct_sun(p: vec3f, n: vec3f, level: u32) -> vec3f {
  if (lvl[level * 3u].z < 0.5) { return vec3f(0.0); }
  let l = sun_dir();
  let cs = dot(n, l);
  if (cs <= 0.0 || p.z < 0.1) { return vec3f(0.0); }
  let s = (0.1 - p.z) / l.z;
  if (!in_pane(p + l * s, level)) { return vec3f(0.0); }
  let h = intersect(p + n * 2e-3, l, s * 0.995, true, level);
  if (h.t > 0.0) { return vec3f(0.0); }
  return sun_col() * cs / 3.1415927;
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
  if (s > 0.0 && lvl[level * 3u].z > 0.5 && in_pane(p + l * s, level)) {
    let h = intersect(p, l, s * 0.995, true, level);
    if (h.t < 0.0) { v = 1.0; }
  }
  vol_w[((level * VZ + iz) * VY + g.y) * VX + g.x] = v;
}

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.x) >= sc.res.x || f32(gid.y) >= sc.res.y) { return; }
  let idx = gid.y * u32(sc.res.x) + gid.x;
  rng_state = idx * 9781u + u32(sc.tone.y) * 6271u + 1u;
  pcg(); pcg();

  let uv = (vec2f(gid.xy) + vec2f(pcg(), pcg())) / sc.res;
  let ndc = sc.view.xy + vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * sc.view.z;
  let aspect = sc.res.x / sc.res.y;
  let th = sc.cam.w;
  var d = normalize(sc.fwd.xyz + sc.rgt.xyz * (ndc.x * th * aspect) + sc.up.xyz * (ndc.y * th));
  var o = sc.cam.xyz;

  var col = vec3f(0.0);
  var thr = vec3f(1.0);
  var level = 0u;
  var first_alb = vec3f(1.0);
  var first_n = vec3f(0.0);
  var first_t = 1e5;

  // enter the building through its open front
  let tp = (sc.misc.z - o.z) / d.z;
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
  if (from_inside) {
    level = u32(clamp(floor((top - o.y) / sc.misc.y), 0.0, sc.misc.x - 1.0));
  } else if (inside && rel > top) {
    col = vec3f(0.1, 0.085, 0.07); // the floor slab between two rooms
    inside = false;
  } else if (!inside) {
    col = live_bg();
  }
  if (inside) {
    if (!from_inside) {
      level = u32(k);
      o = q + d * 1e-3;
    }
    for (var bounce = 0; bounce < 4; bounce++) {
      let h = intersect(o, d, 1e5, false, level);
      if (h.t < 0.0) { break; }
      let ob = objs[u32(h.id)];
      let kind = ob.c.w;
      if (kind == 1.0 || kind == 9.0) {
        if (bounce == 0) { col += thr * select(lvl[level * 3u + 2u].rgb, sc.sky.rgb, kind == 1.0); }
        break;
      }
      let p = o + d * h.t;
      var n = h.n;
      if (dot(n, d) > 0.0) { n = -n; }
      if (kind == 4.0 && n.z < -0.5 && p.z > sc.misc.z - 0.02) {
        col += thr * select(lm_bg(level), live_bg(), bounce == 0);
        break;
      }
      let alb = albedo_of(ob, h, p);
      if (bounce == 0) { first_alb = alb; first_n = n; first_t = h.t; }
      col += thr * alb * direct(p, n, level);
      thr *= alb;
      d = cosine_dir(n);
      o = p + n * 2e-3;
    }
  }

  col = col / max(first_alb, vec3f(0.03));
  let prev = accum[idx];
  var n_prev = prev.a;
  if (sc.frame < 0.5) { n_prev = min(n_prev, 1.0); }
  let wgt = max(1.0 / (n_prev + 1.0), sc.blend);
  let mean = mix(prev.rgb, min(col, vec3f(30.0)), select(1.0, wgt, n_prev > 0.0));
  accum[idx] = vec4f(mean, n_prev + 1.0);
  let wa = select(1.0, wgt, n_prev > 0.0);
  gbuf[idx * 2u] = vec4f(first_n, first_t);
  gbuf[idx * 2u + 1u] = vec4f(mix(gbuf[idx * 2u + 1u].rgb, first_alb, wa), 0.0);
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
  var e = direct_area(p, n, level);
  var thr = vec3f(1.0);
  var o = p + n * 2e-3;
  var d = cosine_dir(n);
  for (var b = 0; b < LM_BOUNCES; b++) {
    let h = intersect(o, d, 1e5, false, level);
    if (h.t < 0.0) { break; }
    let ob = objs[u32(h.id)];
    let kind = ob.c.w;
    if (kind == 1.0 || kind == 9.0) { break; }
    let p2 = o + d * h.t;
    var n2 = h.n;
    if (dot(n2, d) > 0.0) { n2 = -n2; }
    if (kind == 4.0 && n2.z < -0.5 && p2.z > sc.misc.z - 0.02) { e += thr * lm_bg(level); break; }
    let a2 = albedo_of(ob, h, p2);
    e += thr * a2 * direct(p2, n2, level);
    thr *= a2;
    d = cosine_dir(n2);
    o = p2 + n2 * 2e-3;
  }
  return e;
}

// one thread per texel: sc.lmx = (samples so far, samples this pass, texel count, workgroups per row)
@compute @workgroup_size(64)
fn bake_lightmap(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let t = (wid.y * u32(sc.lmx.w) + wid.x) * 64u + li;
  if (t >= u32(sc.lmx.z)) { return; }
  // metadata is sorted by offset: find the last entry whose offset is <= t
  var lo = 0u;
  var hi = arrayLength(&lm_meta) - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) / 2u;
    if (lm_meta[mid].x <= t) { lo = mid; } else { hi = mid - 1u; }
  }
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
  for (var s = 0; s < i32(sc.lmx.y); s++) { sum += min(lm_sample(p, n, m.w), vec3f(30.0)); }
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

// bilinear fetch from the surface's own map (never from a neighbouring face)
fn lightmap(oi: u32, ob: Obj, hit: Hit) -> vec3f {
  var m: vec4u;
  var g: vec2f;
  if (ob.c.w >= 8.0) {
    m = lm_meta[oi * 6u];
    let dn = hit.lp;
    g = vec2f((atan2(dn.z, dn.x) / 6.2831853 + 0.5) * f32(m.y) - 0.5,
              acos(clamp(dn.y, -1.0, 1.0)) / 3.1415927 * f32(m.z) - 0.5);
    let nu = i32(m.y);
    let nv = i32(m.z);
    let i0 = vec2i(floor(g));
    let f = fract(g);
    let xa = ((i0.x % nu) + nu) % nu;
    let xb = (xa + 1) % nu;
    let ya = clamp(i0.y, 0, nv - 1);
    let yb = clamp(i0.y + 1, 0, nv - 1);
    return mix(mix(lm_texel(m.x, nu, xa, ya), lm_texel(m.x, nu, xb, ya), f.x),
               mix(lm_texel(m.x, nu, xa, yb), lm_texel(m.x, nu, xb, yb), f.x), f.y);
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
  let i0 = vec2i(floor(g));
  let f = g - vec2f(i0);
  let i1 = min(i0 + vec2i(1), vec2i(nu - 1, nv - 1));
  return mix(mix(lm_texel(m.x, nu, i0.x, i0.y), lm_texel(m.x, nu, i1.x, i0.y), f.x),
             mix(lm_texel(m.x, nu, i0.x, i1.y), lm_texel(m.x, nu, i1.x, i1.y), f.x), f.y);
}

// scroll / zoom pass: trace only the primary ray; lighting = lightmap + the exact sun
@compute @workgroup_size(8, 8)
fn cs_view(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.x) >= sc.res.x || f32(gid.y) >= sc.res.y) { return; }
  let idx = gid.y * u32(sc.res.x) + gid.x;

  let uv = (vec2f(gid.xy) + vec2f(0.5)) / sc.res;
  let ndc = sc.view.xy + vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * sc.view.z;
  let aspect = sc.res.x / sc.res.y;
  let th = sc.cam.w;
  let d = normalize(sc.fwd.xyz + sc.rgt.xyz * (ndc.x * th * aspect) + sc.up.xyz * (ndc.y * th));
  let o = sc.cam.xyz;

  var e = vec3f(0.0);
  var alb = vec3f(1.0);
  var nrm = vec3f(0.0);
  var tt = 1e5;

  let tp = (sc.misc.z - o.z) / d.z;
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

  if (inside) {
    let h = intersect(start, d, 1e5, false, level);
    if (h.t >= 0.0) {
      let ob = objs[u32(h.id)];
      let kind = ob.c.w;
      let p = start + d * h.t;
      var n = h.n;
      if (dot(n, d) > 0.0) { n = -n; }
      if (kind == 1.0) {
        e = sc.sky.rgb;
      } else if (kind == 9.0) {
        e = lvl[level * 3u + 2u].rgb;
      } else if (kind == 4.0 && n.z < -0.5 && p.z > sc.misc.z - 0.02) {
        e = live_bg();
      } else {
        alb = albedo_of(ob, h, p);
        nrm = n;
        tt = h.t;
        e = lightmap(u32(h.id), ob, h) + direct_sun(p, n, level);
      }
    }
  }

  accum[idx] = vec4f(e, 6.0);
  gbuf[idx * 2u] = vec4f(nrm, tt);
  gbuf[idx * 2u + 1u] = vec4f(alb, 0.0);
}

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

// edge-avoiding a-trous wavelet filter on demodulated irradiance
@compute @workgroup_size(8, 8)
fn atrous(@builtin(global_invocation_id) gid: vec3u) {
  if (f32(gid.x) >= sc.res.x || f32(gid.y) >= sc.res.y) { return; }
  let w = i32(sc.res.x);
  let hh = i32(sc.res.y);
  let ip = vec2i(gid.xy);
  let idx = u32(ip.y * w + ip.x);
  let c = filt_in[idx];
  let g0 = gb_ro[idx * 2u];
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
      let g = gb_ro[qi * 2u];
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
  return final_ro[idx].rgb * gb_ro[idx * 2u + 1u].rgb;
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
  let N = 32;
  let j = hash21(pos);
  var sum = 0.0;
  for (var i = 0; i < N; i++) {
    let x = q + d * (tend * (f32(i) + j) / f32(N));
    let depth = sc.misc.w - x.y;
    let k = floor(depth / sc.misc.y);
    if (k < 0.0 || k >= sc.misc.x || depth - k * sc.misc.y > sc.misc.w || x.z < 0.1 || x.z > sc.misc.z) { continue; }
    let yl = x.y + k * sc.misc.y;
    let ix = u32(clamp((x.x + 3.3) / 6.6 * f32(VX), 0.0, f32(VX - 1u)));
    let iy = u32(clamp(yl / sc.misc.w * f32(VY), 0.0, f32(VY - 1u)));
    let iz = u32(clamp((x.z - 0.1) / (sc.misc.z - 0.1) * f32(VZ), 0.0, f32(VZ - 1u)));
    sum += vol[((u32(k) * VZ + iz) * VY + iy) * VX + ix];
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
  c += shafts(pos.xy, gb_ro[gi * 2u].w);
  c = aces(c * sc.tone.x);
  let uv = pos.xy / vec2f(sc.tone.z, sc.tone.w) - 0.5;
  c *= 1.0 - 0.55 * dot(uv, uv);
  c += (hash21(pos.xy) - 0.5) * 0.012;
  return vec4f(pow(c, vec3f(1.0 / 2.2)), 1.0);
}
`;
