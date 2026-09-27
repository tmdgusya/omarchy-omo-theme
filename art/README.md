# art/ - Nightsea sources

| File | Role |
|---|---|
| `reference/omo-icon-light.svg` | Upstream OmO icon (dev branch), fidelity reference only |
| `omo-cat-moon.svg` | Moon cat symbol: ink backing + plate evenodd glyph, 1024 canvas, transparent |
| `nightsea-base.png` | Atmosphere raster (sky with faint nebulosity, storm clouds, moon rays, stars, sea, glitter path, vignette, grain), float-rendered and dithered |
| `nightsea-open-base.png` | Cat-free open-sea atmosphere (horizon glow, galaxy band, depth stars, low clouds, glitter path) |
| `layers/*.png` | Strike layers (RGBA, cropped to content): `bolt-leader`, `bolt-strike`, `bolt-afterglow`, `ear-spark`, `cat-glow`, `sky-flash` |
| `layers/manifest.json` | Per-layer frame offsets, draw order, and the suggested strike sequence timings |
| `wallpaper-nightsea-calm.svg` | Calm wallpaper master (cat, clouds, no lightning) |
| `wallpaper-nightsea-cat.svg` | Storm wallpaper master = calm master + strike layers |
| `wallpaper-nightsea-open.svg` | Open-sea wallpaper master (no cat) |
| `build-wallpapers.mjs` | Generates everything above from the reference icon (`layers/` is wiped and rebuilt) |

Re-render:

```sh
bun art/build-wallpapers.mjs --render          # regenerates art/, backgrounds/*.png and preview.png
bun art/build-wallpapers.mjs --scene open      # regenerates only the open-sea source
rsvg-convert -w 2560 -h 1440 art/wallpaper-nightsea-cat.svg -o out.png
```

The SVG masters must stay next to `nightsea-base.png` and `layers/`; rsvg resolves
`<image href>` relative to the SVG file. The build is deterministic: rebuilding from
unchanged sources produces byte-identical PNGs (no date/tIME chunks are written).

## Live strike contract

`backgrounds/02-nightsea-storm.png` is exactly `backgrounds/01-nightsea-calm.png` with the
strike layers drawn over it, source-over, in `manifest.order`, each at its `x`/`y`
(frame 2560x1440; scale offsets and sizes together for other resolutions). A live
strike therefore keeps the calm wallpaper on screen and animates only the layers:

| Phase | Layers | Timing (visual.md motion tokens) |
|---|---|---|
| leader | `bolt-leader` | 90 ms step |
| strike | `sky-flash`, `cat-glow`, `bolt-strike`, `ear-spark` | 90 ms step |
| afterglow | `bolt-afterglow`, `cat-glow` | 600 ms OutExpo fade-out |
| working | `cat-glow` | 2400 ms InOutSine breathe, opacity 0.35..0.8 |

The bolt stages differ in geometry (the leader is the upper 74% of the channel with the
early branches) and in bloom, so they can be shown in sequence without a crossfade.
The cat itself is never a layer: its face stays the untouched reference glyph in the
masters (flat `#F4F4F4` plate, thin inner rim light clipped to the plate), and every
layer is punched out where the cat is so nothing washes the face.
