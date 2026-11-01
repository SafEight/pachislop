![AI bloat certified](docs/ai-bloat-certified.png)

# Pachislop

Make flashy pachislot title art in your browser. A mix of Photoshop and After Effects, with Element 3D and Eye Candy built in.

**Try it here:** https://safeight.github.io/pachislop/

It works best in a recent desktop version of Chrome, Edge or Safari.

## What you can do

- Type a title and give it a finished look in one click: gold, chrome, rainbow, neon, fire and more.
- Make titles flat (2D) or as real 3D lettering with bevels, metal and glass.
- Add outlines, glows, shadows, sparkles, light rays, particles and other effects.
- Start from a ready-made template, or from an empty canvas.
- Use your own fonts, images, SVG logos and 3D models.
- Export transparent PNGs, layered Photoshop files (PSD), or SVG outlines.
- Switch the interface between English and Japanese.

## How to use it

1. Open the link above, or run it yourself (see below).
2. Add some text with the T tool, or pick a template from **File › New from template**.
3. Open the **Library** tab and click a look. Hover a look to preview it first.
4. Fine-tune it in the **Properties** tab. Press **⌘F** (Ctrl+F) to search for any setting.
5. Click **Export…** to save your image.

Your work is saved in the browser automatically. Use **File › Save** to keep a copy as a file.

## Run it yourself

You need [Node.js](https://nodejs.org) (version 20 or newer).

```sh
npm install
npm run dev
```

Then open the address it prints, usually http://localhost:5173.

Other commands:

- `npm run build` makes a production build in the `dist` folder.
- `npm test` runs the checks: unit tests, reference-image tests and speed tests. The image and speed tests need a browser with a working GPU.

## Credits

Pachislop uses free fonts, images and open-source libraries. Their authors and licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
