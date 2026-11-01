# Third-party notices

## Patchy: Photoshop Warp Text mesh constructions

`src/text/warp.ts` ports the warp-mesh constructions from Patchy
(https://github.com/shabanmohd/patchy, `docs/warp.md` and `src/core/warp_mesh.cpp`).

```
MIT License

Copyright (c) 2026 Seth A. Robinson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Fonts (SIL OFL) and the HDRI (CC0) carry their own licence files under `public/fonts/` and `public/hdri/`.

## Playfair Black Italic (modified)

`public/fonts/Playfair-BlackItalic.ttf` is derived from Playfair 2 by The Playfair Project
Authors (https://github.com/googlefonts/Playfair; Copyright 2005), taken from
https://github.com/google/fonts/tree/main/ofl/playfair. With fontTools: a static instance
(wght 900, opsz 5, wdth 100) of `Playfair-Italic[opsz,wdth,wght].ttf`; its `plus` glyph replaced
by the upright `plus` of the same instance of `Playfair[opsz,wdth,wght].ttf`; subset to Basic
Latin, Latin-1, general punctuation and the kern / liga / figure features. The font declares no
Reserved Font Name; the modified font is distributed under the SIL Open Font License 1.1, in
`public/fonts/OFL-Playfair-BlackItalic.txt`.

## Reflection maps (Poly Haven, CC0)

`public/reflections/*.jpg` are Poly Haven's tone-mapped previews of CC0 HDRIs
(https://polyhaven.com, CC0 1.0), resized to 1024 × 512: `highway.jpg` = Autumn Road,
`city.jpg` = Potsdamer Platz, `sky.jpg` = Derelict Highway (Midday), `studio.jpg` = Studio
Small 09.

## Fonts (SIL Open Font License 1.1)

`public/fonts/` bundles Dela Gothic One, M PLUS 1p Black, Zen Kaku Gothic New Black, Zen Old
Mincho Black, Yuji Syuku, Reggae One, RocknRoll One, Rampart One, Train One, Potta One, Mochiy
Pop One and Playfair Black Italic (above). Each font's licence and copyright notice is in the
matching `public/fonts/OFL-*.txt`.

## HDRI (Poly Haven, CC0)

`public/hdri/studio_small_09_1k.hdr` is Studio Small 09 from https://polyhaven.com (CC0 1.0).

## Japan Color 2011 Coated ICC profile

`public/icc/JapanColor2011Coated.icc` (JPMA / X-Rite, from the ICC Profile Registry,
https://registry.color.org/profile-registry/JapanColor2011Coated) is free to use and share
unmodified and not for sale. Its terms are in `public/icc/LICENSE-JapanColor2011Coated.txt`.

## Libraries

Pachislop is built with React, three.js, zustand, ag-psd (PSD reading and writing),
Clipper2 (`clipper2-ts`), fflate and opentype.js. All are under the MIT licence except
`clipper2-ts` (Boost Software License 1.0); each licence ships with its package in `node_modules`.
