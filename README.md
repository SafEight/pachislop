![Pachislop](docs/pachislop-logo.png)

<p align="center"><img src="docs/ai-bloat-certified.png" alt="AI bloat certified"></p>

Make flashy pachislot title art in your browser. A mix of Photoshop and After Effects, with Element 3D and Eye Candy built in.

**Live:** https://safeight.github.io/pachislop/ (desktop Chrome, Edge, Firefox or Safari)

## Features

- **2D titles:** stacked rims, bevels, satin, metal finishes, reflection maps, glass and patterns
- **3D titles:** extrude or inflate, bevel bands, backplates, PBR materials, HDR environments, glints and AO
- **Effects:** glows, Deep Glow, shadows, blurs, distortions, keylines, gradient overlays, adjustments
- **Generators:** particles, glints, speed lines, sunbursts, light streaks, fire, smoke, lightning, lens flares
- **Compositing:** groups, clipping, layer masks, adjustment layers, blend modes
- **Library:** 84 looks, 11 colourways, 37 templates
- **Input:** text, shapes, SVG, images, GLB models, custom fonts
- **Export:** transparent PNG (8/16-bit), layered PSD, SVG
- **UI:** English / Japanese

## Development

Requires Node.js 20+.

```sh
npm install
npm run dev     # dev server
npm run build   # production build to dist/
npm test        # unit, golden-image and perf tests (needs a GPU)
```

## Credits

Fonts, images and libraries: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
