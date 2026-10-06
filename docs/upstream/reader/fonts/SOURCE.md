# Reader fonts (variable TTFs, source for the build-time glyph curve tables)
- URL: https://github.com/google/fonts/tree/7085eb89a950e85db5b166b7a58d414544b4140c/ofl/{newsreader,firacode,inter}  (rev 7085eb89a950e85db5b166b7a58d414544b4140c); fetched 2026-10-06 UTC
- Licence (read, OFL-*.txt copied beside each font): SIL Open Font License 1.1 for all three. The copyright lines carry no Reserved Font Name, so subsetting and converting to outline tables is permitted (clause 3 only restricts RFN reuse; the Font Software may not be sold by itself). The site's colophon must keep the copyright notices.
- Question: same families as the site CSS (src/app.css loads Inter, Fira Code, Newsreader from Google Fonts) as local bytes for harfbuzzjs shaping and outline extraction.
- sha256 (read): Newsreader.ttf 8a08d13f..., Newsreader-Italic.ttf 79666861..., FiraCode.ttf 9335b082..., Inter.ttf 29160a80... (full: `shasum -a 256 *.ttf`).
- Used instances (variation settings, set at build time with hb_font_set_variations, so no static instancing step needed): Newsreader opsz 14 wght 400 / italic 400 / wght 600; Fira Code wght 400; Inter opsz 14 wght 500.
9335b082b3c7850d98a64b584f3417f65355f3471278bb5eeb8c6c0e8657aeeb  FiraCode.ttf
29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031  Inter.ttf
796668611f80b64d5adf182fde3b6f29ed83b4e7cbec7b96937e84ac01364792  Newsreader-Italic.ttf
8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1  Newsreader.ttf

## Added 2026-10-06 UTC: Noto Emoji (fallback for characters Newsreader, Inter and Fira Code lack)
- URL: https://github.com/google/fonts/tree/7085eb89a950e85db5b166b7a58d414544b4140c/ofl/notoemoji/NotoEmoji[wght].ttf (same rev); OFL-NotoEmoji.txt copied beside it.
- Licence (read): SIL OFL 1.1, "Copyright 2013 Google LLC"; no Reserved Font Name.
- Question: the corpus contains U+1F61E (rust-named-parameters) which no text font covers. Monochrome outlines, so the quadratic pipeline applies. Fira Code 400 also covers the math characters U+2208 and U+2124 used as plain text in optimal-parkour; fallback order: Fira Code 400, then Noto Emoji.
- sha256 NotoEmoji.ttf de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551
