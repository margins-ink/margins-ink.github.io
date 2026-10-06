
- (lane-b) Generate covers from a small bun script with rect/dither helpers that asserts 24x64 and palette keys, then writes the .ts; far faster to iterate than editing strings. Script: /Volumes/Projects/tmp/lane-b/gen.ts.
- (lane-b) shot.ts takes a 3rd arg of JS to eval (e.g. `window.scrollTo(0,99999)`) to see covers below the 1400px fold. Use one char per tone (a ink, b mid, c faint, x accent) so dark remaps by value, not inversion.
- Drawing technique: generate rows from a small bun script (rect/pixel helpers writing a 64x24 grid) and throw on bad dimensions, instead of hand-typing strings.
- /covers is long; screenshot your own covers with shot.ts's 3rd arg (JS eval), e.g. find the caption element by text and scrollIntoView({block:'end'}).
- Lane-a technique: generate covers from a small script (rect/dither/arc helpers) that validates 24x64 and palette keys, rather than hand-typing rows. Script: /Volumes/Projects/tmp/lane-a/gen.ts.
- Crowd/many-small-things reads only when heads and shoulders use two tones ('a' head, 'b' body) and rows overlap far-to-near; outlining each figure in a bg-coloured key (key = bg hex in both palettes) erases the crowd instead.
- Panel renders ~590px wide, so each pixel is ~9px: checkerboard dither reads as strong texture, use it sparingly.
- Drawing technique: generate rows from a small bun script (rect/pixel helpers writing a 64x24 grid) and throw on bad dimensions, instead of hand-typing strings.
- /covers is long; screenshot your own covers with shot.ts's 3rd arg (JS eval), e.g. find the caption element by text and scrollIntoView({block:'end'}).
