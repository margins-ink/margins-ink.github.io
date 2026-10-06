# Room lighting: per-surface lightmaps

Code: `src/lib/gpu/room/shader.ts` (`bake_lightmap`, `cs_view`, `lightmap`), `lightmap.ts` (layout), `room.ts` (bake scheduling).

## Algorithm

Still frames: progressive path tracer (`cs`), demodulated radiance E = L / first-hit albedo, atrous denoise, as before.
Moving frames (scroll, zoom): `cs_view` traces only the primary ray and sets `E = lightmap(hit) + direct_sun(hit)`.
Still resumes from the same `accum` buffer (weight 6) with no pop. Nothing in the moving path depends on the camera
(the old screen-space per-floor cache, ambient probes and background cache build are deleted).

Lightmap: every box face and sphere has a texel grid; texel = diffuse irradiance E/pi at the texel centre, accumulated by
`bake_lightmap` (one thread per texel): NEE to panes and lamp at the first vertex (no sun there), then 3 cosine bounces with
full `direct` (sun included) at later vertices, bg through the open front (4 vertices in total, same as `cs`).
The sun at the first hit is added exactly at run time (`direct_sun`, one shadow ray, noise free), so sun edges and
contact shadows are exact and need no texel density.

## Buffers

- `lm_meta` (binding 14, `array<vec4u>`): index `obj*6+face` = (texel offset, nu, nv, level). nu = 0: no map (kinds 1, 9).
  Offsets are ascending, so the bake finds its face by binary search. Box face f: axis `a=f>>1`, sign + for even f,
  u along axis `(a+1)%3`, v along `(a+2)%3`, texel centres at `((i+.5)/n*2-1)*h`. Spheres: face 0 only, lat-long
  (u = atan2(z,x), v = acos(y), u wraps, v clamps), `nu=clamp(ceil(2 pi r/0.05),8,64)`, `nv=nu/2`.
- Texel size: 0.05 m furniture (2..128 per side), 0.04 m room shell (2..192). 397k texels for the current 4 floors.
- Shell faces are baked with the inward normal (seen from inside), all other boxes outward.
- `lm_acc` (15, `vec4f` running sum) lives only during the bake and is destroyed at convergence. `lm` (16 write / 19 read,
  `array<vec2u>`): mean irradiance as f16x3 (`pack2x16float(rg)`, `pack2x16float(b,0)`), 8 B per texel.
  f16 precision (11 bits, 0.05 % relative) is far below the 8-bit output step and the 1/sqrt(640) bake noise; range 65504 vs clamp 30.
- Scene uniform: `bg.xyz` is the base outside radiance, `bg.w` the live fade; `lmx` = (samples so far, samples this pass, texel count, workgroups per row).
- View pass storage buffers: objs, panes, lvl, gbuf, accum, lm_meta, lm = 7 of the 8 allowed.

## Scheduling

One bake dispatch per animation frame (also while scrolling), sample count per pass adapts to ~5 ms GPU time (1..32 spp),
target 640 spp per texel, restarted only when the colour scheme changes (sky and sun). Moving frames show whatever has been
accumulated so far (noisy first, converged after ~1.6 s).

## Traps and checks

| Trap | Check |
|---|---|
| Outside radiance fades with the live elevator depth, so baked light entering a floor disagreed with the traced one (lower wall went brown). Bounce light through the front uses the floor's own depth in both paths (`lm_bg`). | `cmp2.ts light`: lower-wall MAD stays ~2; it was a visible tint before. |
| Fetching across faces leaks light at box edges. | `lightmap()` derives the face from the local hit, clamps uv to that face's texel range. Inspect `diff-*.png` (8x amplified): no lines along edges beyond 1 px misalignment. |
| Sparse zero-size meta entries break the binary search. | Entries with nu=0 carry the next offset, so "last entry with offset <= t" is always a real face. |
| 256 spp left mottled walls while moving. | Compare moving vs still wall crops; 640 spp at 0.04 m is the chosen point. |
| WGSL reserved words (`active target get sample texture ref half`), vec3 uniform pads to 16 B. | Shader compile errors print through `uncapturederror`. |
| Auto layouts only contain bindings an entry point uses; extra entries fail validation. | `perf2.ts` prints `webgpu:` errors. |

## Measurements (1440x900, dpr 1, scroll 1100, `cmp2.ts`, background load average ~5, display capped at 120 Hz)

Mean abs difference between still.png and moving.png over pixels with still luminance > 40:

| | light | dark |
|---|---|---|
| before (screen-space cache) | 23.37 | 7.52 |
| after | 2.46 | 2.75 |

Wall regions after (MAD / p95): light lower wall 2.34 / 5.3, upper wall 1.64 / 4.0, wall by window 1.12 / 4.0;
dark 1.68 / 5.0, 1.63 / 4.3, 1.97 / 7.0. The remainder is mostly the still frame's own 160 spp noise and 1 px scroll offset.

Scroll rAF test (1 s scripted scroll): before 120 fps (8.3 ms mean, p95 9.0-9.2); after 120 fps (8.3 ms, p95 8.7-9.3): capped by the display,
so no regression visible, headroom not measured. Startup: lightmaps converged 640 spp in ~1.65 s (light), frames during the bake: max 25 ms, 1 of 195 over 25 ms.
Dark mode brightened: moon sky x1.4, exposure 2.4 -> 3.4, bg x1.6.

## Remaining artifacts

Hard sun edges on walls are exact; lamp and window soft shadows are limited to 4 cm texels. Dark-mode shelf fronts and floors are still near black (true to the lighting, not tuned). Moving frames are noisy for the first ~1.6 s after load or a theme change.
