# Magazine fonts: Inter (variable) and Instrument Sans (variable)

- URL: https://github.com/google/fonts/tree/7085eb89a950e85db5b166b7a58d414544b4140c/ofl/{inter,instrumentsans} (google/fonts rev 7085eb89a950e85db5b166b7a58d414544b4140c, the same rev as docs/upstream/reader/fonts); fetched 2026-10-06 UTC via raw.githubusercontent.com. These are the files Google Fonts serves; upstream sources: https://github.com/rsms/inter (commit 66647c0bbbe41a850d79d9c76fb13add3378940f per METADATA.pb) and https://github.com/Instrument/instrument-sans (commit 7fa22308a3d0c94ee2b3cd537a1196b65db34a3e per METADATA.pb).
- Licence (read, full text stored as OFL-*.txt): SIL Open Font License 1.1.
  - Inter: "Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)". OFL-Inter.txt is byte-identical to docs/upstream/reader/fonts/OFL-Inter.txt (diff, 2026-10-06).
  - Instrument Sans: "Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)".
  - Geist (spare, not shipped; text only): "Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)", OFL-Geist.txt.
  - None of the three copyright lines names a Reserved Font Name (read: the term appears only in the OFL definitions and clause 3). Subsetting and compiling outlines into curve tables is permitted; the fonts may not be sold by themselves. Keep the copyright lines in the colophon.
- Question: which bytes feed the glyph-table build for the one-sans-family direction (MAGAZINE.md 3.1), and which axes and features do they have.
- sha256 (read, `shasum -a 256`):
  - 29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031  Inter.ttf  (upstream name `Inter[opsz,wght].ttf`)
  - acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6  Inter-Italic.ttf  (`Inter-Italic[opsz,wght].ttf`)
  - b24f1812584816958afcf22e22d08e44318c5e51651e25d2438efdde389b33b1  InstrumentSans.ttf  (`InstrumentSans[wdth,wght].ttf`)
  - a74203cc5066a3b2f8de1a7b0887ef897773c2319dc86c911f8e85350cde0d07  InstrumentSans-Italic.ttf  (`InstrumentSans-Italic[wdth,wght].ttf`)
  - OFL-Inter.txt 5b9321a4..., OFL-InstrumentSans.txt 9e27a72e..., OFL-Geist.txt 1781d280..., METADATA-*.pb 79e4721e... (Inter), 111191da... (Instrument Sans).
- Extracted (read with harfbuzzjs on the stored bytes, 2026-10-06):
  - Inter: axes opsz 14..32 (default 14), wght 100..900 (default 400); upem 2048; GSUB has calt, case, tnum, pnum, zero, frac, ss01-08, cv01-14 and **no `liga`**; GPOS has kern. Inter-Italic: same axes and features.
  - Instrument Sans: axes wdth 75..100 (default 100), wght 400..700 (default 400); upem 1000; GSUB has liga, case, tnum, pnum, ss01-12 and **no `calt`**; GPOS has kern. Italic: same.
  - So `tnum` and `kern` exist in both (MAGAZINE.md 3.1 and 9 "unverified" resolved); `liga` is Instrument Sans only, Inter uses `calt`.
- Used instances (set at build with hb_font_set_variations, no static instancing step): Inter wght 400 opsz 14 (body), Inter Italic 400, Inter wght 600 (bold), Inter wght 500 (label); Instrument Sans wdth/wght per article voice (scripts/magazine/voices.ts), default wdth 80 wght 600. Instrument Sans Italic is stored but unused in v1.
- Retired: Newsreader (docs/upstream/reader/fonts/Newsreader*.ttf stay in git for history; no longer in FONT_SPECS). src/lib/gpu/room/atlas.ts and emblems.ts still draw the shelf covers with the Newsreader CSS family; that is outside the reader and untouched.

## Berkeley Mono (commercial, bytes NOT stored in this repo)

- Family: Berkeley Mono, copyright 2022-2026 U.S. Graphics LLC (name table, read 2026-10-06). Files used: BerkeleyMono-Regular.otf, BerkeleyMono-Bold.otf (Oblique present, unused). Version string in the name table reads 2.4 (reported, not cross-checked against the purchase).
- Where the bytes live: copied by hand into the gitignored `fonts-private/` (repo root) from `~/Library/Fonts/BerkeleyMono-*.otf` (also at `~/Downloads/old/BerkeleyMono/`). Never commit them and never put them under docs/upstream. sha256 of the copies (read): Regular a6711febd4dc..., Bold d4090d067799..., Oblique 0595f9e03fb3...
- Slot: `MONO_FAMILY` in scripts/reader/fonts.ts (one-line swap to `'fira'`). When the files are absent the build falls back to Fira Code (OFL, vendored in docs/upstream/reader/fonts) with a warning; `MAGAZINE_REQUIRE_BERKELEY=1` makes a missing file an error. Fira Code is also the glyph-coverage fallback (box drawing, maths) because Berkeley lacks them; both fonts advance 0.6 em.
- Ligatures (read with harfbuzzjs, 2026-10-06): contextual alternates in `calt` (glyphs named `hyphen_greater.lig` and so on), no `liga` table. A sequence keeps one glyph per character (clusters 1:1), the lead glyph draws the whole symbol. `scripts/magazine/type.test.ts` and `FontSet` check that `=> -> != == <= ::` shape differently with liga/calt/clig on and off.
- OPEN ITEM FOR ANDREW: the licence must include web and app embedding (outline curves are compiled into the published RDR2 binaries under static/magazine) before this site ships with Berkeley Mono. Until confirmed, treat published builds as Fira Code (build without fonts-private/) or keep the binaries off the public deploy. Licence text not read in this session (status: unverified).
