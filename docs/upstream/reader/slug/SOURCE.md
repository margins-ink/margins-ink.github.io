# Slug reference shaders (Eric Lengyel)
- URL: https://github.com/EricLengyel/Slug  rev be3c13eb7d63f9e8aa5c583e42d92c374cb91d98 (main); fetched 2026-10-06 UTC
- Files kept: LICENSE, LICENSE-MIT, LICENSE-APACHE, NOTICE, README.md, SlugPixelShader.hlsl, SlugVertexShader.hlsl, decade-slug.html (https://terathon.com/blog/decade-slug.html)
- Licence (read from LICENSE): dual MIT or Apache-2.0, at our option. README (read): code free for any purpose, patent dedicated to the public domain, credit required if distributed. NOTICE: Slug shader code Copyright 2017 by Eric Lengyel.
- Paper (reported, bytes not stored): JCGT 2017, https://jcgt.org/published/0006/02/02/
- Question answered: can we use Slug text rendering in a shipped site? Answer: yes (MIT/Apache, patent public domain since 2026-03-17 per the repo README and Hackaday report). Extracted: curve texture = RGBA16F quadratic Bezier control points; band texture = 2x u16; bands sorted by max x or y; dynamic dilation in the vertex shader; no hinting, size chosen so cap-height is integer px for crisp tops.
- Status: read (README, licence files); reported (decade-slug summary via fetch tool).
