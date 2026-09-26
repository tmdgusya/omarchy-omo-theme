# art/ - Nightsea sources

| File | Role |
|---|---|
| `reference/omo-icon-light.svg` | Upstream OmO icon (dev branch), fidelity reference only |
| `omo-cat-moon.svg` | Moon cat symbol: ink backing + plate evenodd glyph, 1024 canvas, transparent |
| `nightsea-base.png` | Atmosphere raster (sky, sea, shafts, haze, vignette, grain), float-rendered and dithered |
| `wallpaper-nightsea-cat.svg` | Main wallpaper master (cat + lightning), references `nightsea-base.png` |
| `wallpaper-nightsea-calm.svg` | Calm wallpaper master (cat, no lightning) |
| `build-wallpapers.mjs` | Generates everything above from the reference icon |

Re-render:

```sh
bun art/build-wallpapers.mjs --render          # regenerates art/ and backgrounds/*.png
rsvg-convert -w 2560 -h 1440 art/wallpaper-nightsea-cat.svg -o out.png   # SVG only
```

The SVG masters must stay next to `nightsea-base.png`; rsvg resolves the
`<image href>` relative to the SVG file.
