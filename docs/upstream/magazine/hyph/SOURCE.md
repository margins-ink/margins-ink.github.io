# hyph-en-us (Liang patterns, American English)

- URL: https://github.com/hyphenation/tex-hyphen/tree/master/hyph-utf8/tex/generic/hyph-utf8/patterns (files `tex/hyph-en-us.tex`, `txt/hyph-en-us.pat.txt`, `txt/hyph-en-us.hyp.txt`), master as fetched
- Fetched: 2026-10-06 (UTC); version header in the file: 2005-05-30
- sha256: hyph-en-us.tex f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8; hyph-en-us.pat.txt 0f57318b878b132547ae92db39a6e1d1cf2a05d9008874955d6ecb910007a463; hyph-en-us.hyp.txt 5e785c27e151f878c312991d937b5582615b77737ab30bac413d5967d6aa21da
- Licence (read from the .tex header): "Copying and distribution of this file, with or without modification, are permitted in any medium without royalty provided the copyright notice and this notice are preserved." Copyright (C) 1990, 2004, 2005 Gerard D.C. Kuiken. The notice is kept in `hyph-en-us.tex`; the `.pat.txt` and `.hyp.txt` are the same data as plain lists and carry no header, so the notice applies via this file.
- Question answered: which pattern set and licence for `scripts/magazine/hyph.ts` (MAGAZINE.md section 1.4 step 3 and the stack table).
- Extracted: the pattern list (one per line, digits are inter-letter priorities) and 14 exceptions (`as-so-ciate` form). Known bug (read, header): `de-mo-c-rat` where `dem-o-crat` is right (GitHub issue 15); add per-article exceptions in `spread.json` `hyphenExceptions`.
