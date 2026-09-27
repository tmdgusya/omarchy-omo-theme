#!/usr/bin/env bun
// Builds the Nightsea art from the OmO reference icon.
//
//   bun art/build-wallpapers.mjs                # art/nightsea-*.png, art/layers/*, art/*.svg
//   bun art/build-wallpapers.mjs --render       # also backgrounds/*.png, preview.png, unlock.png, preview-unlock.png
//   bun art/build-wallpapers.mjs --scene open   # one scene only (calm | storm | open, repeatable)
//
// Scenes. Omarchy takes the sort-first file in backgrounds/ as the default wallpaper, so the honest
// default (no lightning) comes first:
//   01-nightsea-calm.png   moon cat, storm clouds, rays, stars, glitter; no lightning. Base of the live overlay.
//   02-nightsea-storm.png  exactly 01 + art/layers/{sky-flash,cat-glow,bolt-strike,ear-spark} (layers/manifest.json).
//   03-nightsea-open.png   no cat: the moon sits just below the horizon, only its glow, beams and glitter show.
//
// Pipeline
//   1. Atmosphere raster (sky with faint nebulosity, storm clouds lit by the moon cat, moon rays,
//      star field, sea with a wobbling sky reflection, moon glitter path, horizon haze, vignette,
//      grain) is computed in float and TPDF-dithered before the 8-bit store, because cairo renders
//      SVG gradients undithered and dark teal gradients band visibly at 8 bits. -> art/nightsea-base.png
//      (cat scenes) and art/nightsea-open-base.png (open sea: horizon glow, low streaks, galaxy band).
//   2. Strike layers (bolt at three stages, ear spark, cat glow, sky flash) are float RGBA rasters
//      with dithered alpha, cropped to content. -> art/layers/*.png + manifest.json. They composite
//      over backgrounds/01-nightsea-calm.png with plain source-over; 02-nightsea-storm.png is exactly
//      calm + the strike layers.
//   3. Hard edges stay vector: the moon cat is the untouched reference glyph in the SVG masters.
//   4. Plymouth: unlock.png is the moon cat over a dithered halo (RGBA; omarchy-plymouth-set streams it
//      in as logo.png and omarchy.script draws it 1:1, centered, with the password entry 40px below its
//      bottom edge). preview-unlock.png mirrors that boot screen at 1920x1080 with colors.toml's
//      background/foreground, the same pair omarchy-plymouth-set-by-theme applies.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ART = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(ART);
const BACKGROUNDS = join(ROOT, "backgrounds");
const LAYERS = join(ART, "layers");
const ARGS = process.argv.slice(2);
const RENDER = ARGS.includes("--render");
const SCENE_ARGS = ARGS.flatMap((a, i) => (a === "--scene" ? [ARGS[i + 1]] : a.startsWith("--scene=") ? [a.slice("--scene=".length)] : []));

// Design tokens. Every key mirrors colors.toml (name in the comment); nothing else is used.
const PALETTE = {
  ink: "#041617", // darker_background - OmO icon ink
  inkDark: "#071416", // dark_background
  surface: "#0B1B1D", // background
  lifted: "#12292C", // lighter_background - cloud shadow bodies
  muted: "#3B5658", // muted - moonlit cloud bodies
  horizonSky: "#0F2A2C", // sky at the horizon
  horizonSea: "#0C2426", // sea at the horizon
  lightFg: "#A8BFBF", // light_foreground - silver linings
  plate: "#F4F4F4", // bright_foreground - OmO icon plate, stars
  aqua: "#7FE0D4", // accent
  aquaGlow: "#9CF0FF", // bright_cyan - glow
  boltCore: "#EAFBFF", // bolt core (visual.md aqua.bolt)
};

// Composition (2560x1440). The left third stays quiet for terminals: the storm coverage, the
// rays and the flash fade out across a noise-wobbled boundary around CALM_EDGE (never a straight
// cut), only stars and faint nebulosity reach the rail, and the vignette pulls the rail into ink.
const W = 2560;
const H = 1440;
const HORIZON = 1000;
const CAT_CENTER = { x: 1800, y: 600 };
const CAT_WIDTH = 420;
const CALM_EDGE = 900;
const STORM = { x: 1480, y: 110, rx: 880, ry: 380 };
const STORM_GLOW = { x: 1440, y: 150 };
const BOLT_START = [1430, -40];
const BASE_NAME = "nightsea-base.png";
const OPEN_BASE_NAME = "nightsea-open-base.png";
// Open sea: the moon is just below the horizon at the cat's x, so the glitter path, the glow and
// the beams keep the same light source as the cat scenes; only the moon itself is out of frame.
const OPEN_LIGHT = { x: CAT_CENTER.x, y: HORIZON + 90 };
// Faint galaxy band from the upper middle down to the moonrise, with the dense far stars along it.
const OPEN_BAND = { ax: 1000, ay: 0, bx: 2000, by: HORIZON, halfWidth: 260 };

const SCENES = {
  calm: { svg: "wallpaper-nightsea-calm.svg", png: "01-nightsea-calm.png", base: BASE_NAME, cat: true, bolt: false },
  storm: { svg: "wallpaper-nightsea-cat.svg", png: "02-nightsea-storm.png", base: BASE_NAME, cat: true, bolt: true },
  open: { svg: "wallpaper-nightsea-open.svg", png: "03-nightsea-open.png", base: OPEN_BASE_NAME, cat: false, bolt: false },
};
for (const s of SCENE_ARGS) {
  if (!SCENES[s]) throw new Error(`--scene expects one of ${Object.keys(SCENES).join(", ")}, got ${JSON.stringify(s)}`);
}
const SELECTED = new Set(SCENE_ARGS.length ? SCENE_ARGS : Object.keys(SCENES));
// The two cat scenes share one atmosphere raster and the strike layers; they are built together.
const BUILD_CAT = SELECTED.has("calm") || SELECTED.has("storm");
const BUILD_OPEN = SELECTED.has("open");

const f = (n) => (Math.round(n * 100) / 100).toString();
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const C = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hex(v)]));
const LIT = lerp3(C.lightFg, C.aqua, 0.35);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded 2D gradient noise, range about [-0.7, 0.7].
function makePerlin(seed) {
  const rng = mulberry32(seed);
  const src = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = src[i];
    src[i] = src[j];
    src[j] = t;
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = src[i & 255];
  const GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
  const GY = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const aa = p[p[X] + Y] & 7;
    const ab = p[p[X] + Y + 1] & 7;
    const ba = p[p[X + 1] + Y] & 7;
    const bb = p[p[X + 1] + Y + 1] & 7;
    const n00 = GX[aa] * xf + GY[aa] * yf;
    const n10 = GX[ba] * (xf - 1) + GY[ba] * yf;
    const n01 = GX[ab] * xf + GY[ab] * (yf - 1);
    const n11 = GX[bb] * (xf - 1) + GY[bb] * (yf - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  };
}
function fbm(noise, x, y, octaves) {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x, y);
    norm += amp;
    x = x * 2 + 17.3;
    y = y * 2 + 9.1;
    amp *= 0.5;
  }
  return sum / norm;
}
const fbm01 = (noise, x, y, o) => clamp01(0.5 + 0.9 * fbm(noise, x, y, o));
const n01 = (noise, x, y) => clamp01(0.5 + 0.75 * noise(x, y));

// ---------------------------------------------------------------------------
// Reference glyph -> absolute 1024-canvas path data.
// The icon nests the glyph in scale(0.5) * translate(0,2048) scale(0.05,-0.05),
// so X = 0.025x and Y = 1024 - 0.025y with the y axis flipped.
// ---------------------------------------------------------------------------
function parseGlyph(svgText) {
  const match = svgText.match(/<path fill="#041617" fill-rule="evenodd" d="([^"]+)"/);
  if (!match) throw new Error("reference glyph path not found");
  const tokens = match[1].replace(/\s+/g, " ").trim().match(/[MmCcLlZz]|-?\d+(?:\.\d+)?/g);
  const subpaths = [];
  let current = null;
  let cmd = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const toCanvas = (px, py) => [px * 0.025, 1024 - py * 0.025];
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[MmCcLlZz]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        current.segments.push({ type: "Z" });
        x = startX;
        y = startY;
      }
      continue;
    }
    if (cmd === "M" || cmd === "m") {
      const nx = num();
      const ny = num();
      x = cmd === "m" ? x + nx : nx;
      y = cmd === "m" ? y + ny : ny;
      startX = x;
      startY = y;
      current = { segments: [{ type: "M", pt: toCanvas(x, y) }] };
      subpaths.push(current);
      cmd = cmd === "m" ? "l" : "L";
    } else if (cmd === "c" || cmd === "C") {
      const rel = cmd === "c";
      const nums = [num(), num(), num(), num(), num(), num()];
      const c1 = rel ? [x + nums[0], y + nums[1]] : [nums[0], nums[1]];
      const c2 = rel ? [x + nums[2], y + nums[3]] : [nums[2], nums[3]];
      const end = rel ? [x + nums[4], y + nums[5]] : [nums[4], nums[5]];
      current.segments.push({ type: "C", c1: toCanvas(...c1), c2: toCanvas(...c2), pt: toCanvas(...end) });
      [x, y] = end;
    } else if (cmd === "l" || cmd === "L") {
      const nx = num();
      const ny = num();
      x = cmd === "l" ? x + nx : nx;
      y = cmd === "l" ? y + ny : ny;
      current.segments.push({ type: "L", pt: toCanvas(x, y) });
    } else {
      throw new Error(`unsupported command ${cmd}`);
    }
  }
  return subpaths;
}

const segToD = (s) => {
  if (s.type === "M") return `M${f(s.pt[0])} ${f(s.pt[1])}`;
  if (s.type === "L") return `L${f(s.pt[0])} ${f(s.pt[1])}`;
  if (s.type === "C") return `C${f(s.c1[0])} ${f(s.c1[1])} ${f(s.c2[0])} ${f(s.c2[1])} ${f(s.pt[0])} ${f(s.pt[1])}`;
  return "Z";
};
const subpathToD = (sp) => sp.segments.map(segToD).join(" ");

// Subpath 0 walks the outer head, curls inward at the left chin tip, traces
// the inner face contour and returns via the right chin tip. Its segment
// layout is M C* L L C* L L C* Z; keeping only the two outer C* runs and
// bridging the chin tips yields the closed outer silhouette.
function outerSilhouette(sp0) {
  const segs = sp0.segments;
  const lineIdx = segs.map((s, idx) => (s.type === "L" ? idx : -1)).filter((idx) => idx >= 0);
  if (lineIdx.length !== 4) throw new Error(`expected 4 chin line segments, got ${lineIdx.length}`);
  const leftTipEnd = lineIdx[1];
  const rightTipEnd = lineIdx[3];
  const outer = [...segs.slice(0, leftTipEnd + 1), { type: "L", pt: segs[rightTipEnd].pt }, ...segs.slice(rightTipEnd + 1)];
  return { segments: outer };
}

const referenceSvg = readFileSync(join(ART, "reference", "omo-icon-light.svg"), "utf8");
const subpaths = parseGlyph(referenceSvg);
const GLYPH_D = subpaths.map(subpathToD).join(" ");
const OUTER_D = subpathToD(outerSilhouette(subpaths[0]));
const GLYPH_BBOX = { x: 190, y: 220, w: 644, h: 575 };

// Ink backing under the plate-colored evenodd glyph so the face cut-outs
// always read as ink no matter what glows behind the cat. The symbol stays
// flat two-tone; the wallpaper variant keeps the crisp plate and adds a thin
// inner rim light, clipped to the plate through the very same glyph path so
// the face lines never pick up any tint.
const catGroup = (id) => `<g id="${id}">
    <path d="${OUTER_D}" fill="${PALETTE.ink}"/>
    <path d="${GLYPH_D}" fill="${PALETTE.plate}" fill-rule="evenodd"/>
  </g>`;
const catGroupLit = (id) => `<g id="${id}">
    <path d="${OUTER_D}" fill="${PALETTE.ink}"/>
    <path d="${GLYPH_D}" fill="${PALETTE.plate}" fill-rule="evenodd"/>
    <path d="${OUTER_D}" clip-path="url(#plate-clip)" fill="none" stroke="${PALETTE.aquaGlow}" stroke-width="14" opacity="0.5" filter="url(#rim-blur)"/>
  </g>`;

const catMoonSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>OmO moon cat - plate silhouette with ink face, for dark surfaces</title>
  ${catGroup("omo-cat-moon")}
</svg>
`;

const catScale = CAT_WIDTH / GLYPH_BBOX.w;
const catTx = CAT_CENTER.x - (GLYPH_BBOX.x + GLYPH_BBOX.w / 2) * catScale;
const catTy = CAT_CENTER.y - (GLYPH_BBOX.y + GLYPH_BBOX.h / 2) * catScale;
const catBox = {
  x: catTx + GLYPH_BBOX.x * catScale,
  y: catTy + GLYPH_BBOX.y * catScale,
  w: GLYPH_BBOX.w * catScale,
  h: GLYPH_BBOX.h * catScale,
};
const leftEarTip = { x: catTx + 231.75 * catScale, y: catTy + 219.8 * catScale };
const catTransform = `translate(${f(catTx)} ${f(catTy)}) scale(${f(catScale)})`;
const insideCat = (p, m) => p[0] > catBox.x - m && p[0] < catBox.x + catBox.w + m && p[1] > catBox.y - m && p[1] < catBox.y + catBox.h + m;

// ---------------------------------------------------------------------------
// Raster I/O through ImageMagick (PPM/PAM in, PNG out) and rsvg (SVG -> mask).
// ---------------------------------------------------------------------------
const tmpPath = (ext) => join(tmpdir(), `nightsea-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`);

function writeRaster(pngPath, w, h, bytes, channels) {
  const header =
    channels === 4 ? `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n` : `P6\n${w} ${h}\n255\n`;
  const tmp = tmpPath(channels === 4 ? "pam" : "ppm");
  writeFileSync(tmp, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]));
  // No date/tIME chunks: a rebuild from unchanged sources must be byte-identical.
  const result = spawnSync(
    "magick",
    [tmp, "-define", "png:compression-level=9", "-define", "png:exclude-chunks=date,time", `${channels === 4 ? "PNG32" : "PNG24"}:${pngPath}`],
    { stdio: "inherit" },
  );
  rmSync(tmp, { force: true });
  if (result.status !== 0) throw new Error(`magick failed to encode ${pngPath}`);
}

// Rasterizes the cat silhouette at a placement and returns its coverage (0..1) on a w x h grid.
function rasterizeCatAlpha(w = W, h = H, transform = catTransform) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><g transform="${transform}"><path d="${OUTER_D}" fill="#fff"/></g></svg>`;
  const svgPath = tmpPath("svg");
  const pngPath = tmpPath("png");
  const pamPath = tmpPath("pam");
  writeFileSync(svgPath, svg);
  const r1 = spawnSync("rsvg-convert", ["-w", String(w), "-h", String(h), svgPath, "-o", pngPath], { stdio: "inherit" });
  if (r1.status !== 0) throw new Error("rsvg-convert failed to rasterize the cat mask");
  const r2 = spawnSync("magick", [pngPath, "-type", "TrueColorAlpha", "-depth", "8", pamPath], { stdio: "inherit" });
  if (r2.status !== 0) throw new Error("magick failed to convert the cat mask");
  const buf = readFileSync(pamPath);
  rmSync(svgPath, { force: true });
  rmSync(pngPath, { force: true });
  rmSync(pamPath, { force: true });
  const headerEnd = buf.indexOf("ENDHDR\n") + 7;
  const header = buf.subarray(0, headerEnd).toString("ascii");
  if (!/DEPTH 4/.test(header) || !new RegExp(`WIDTH ${w}\n`).test(header)) throw new Error(`unexpected PAM header: ${header}`);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = buf[headerEnd + i * 4 + 3] / 255;
  return alpha;
}

function boxBlur(src, w, h, r, passes) {
  let a = Float32Array.from(src);
  let b = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum > 0 ? sum / n : 0;
        sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        // The running sum drifts a few ulp below zero on empty spans; a negative
        // blur value turns into NaN under Math.pow and would punch holes in a layer.
        a[y * w + x] = sum > 0 ? sum / n : 0;
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Atmosphere raster.
// ---------------------------------------------------------------------------
const noise = {
  cloud: makePerlin(0x11),
  warp: makePerlin(0x23),
  ray: makePerlin(0x37),
  sea: makePerlin(0x41),
  neb: makePerlin(0x61),
};

// Cloud density and moon-facing edge light at half resolution (clouds are soft; the
// bilinear upsample hides nothing).
const HW = W >> 1;
const HH = (HORIZON >> 1) + 4;
const dens = new Float32Array(HW * HH);
const edge = new Float32Array(HW * HH);
function buildClouds() {
  const FREQ = 1 / 440;
  for (let hy = 0; hy < HH; hy++) {
    const y = hy * 2;
    // The storm's left boundary wanders about +-250px with height and fades over 800px,
    // so the calm side never meets the clouds along a straight vertical line.
    const bx = CALM_EDGE + 100 + 350 * noise.warp(y * 0.0025 + 7.7, 3.3);
    for (let hx = 0; hx < HW; hx++) {
      const x = hx * 2;
      const nx = x * FREQ;
      const ny = y * FREQ * 1.6;
      const qx = fbm(noise.warp, nx, ny, 4);
      const qy = fbm(noise.warp, nx + 5.2, ny + 1.3, 4);
      const v = fbm01(noise.cloud, nx + 0.45 * qx, ny + 0.45 * qy, 6);
      const leftRamp = smoothstep(bx - 450, bx + 350, x);
      const sx = (x - STORM.x) / STORM.rx;
      const sy = (y - STORM.y) / STORM.ry;
      const storm = Math.exp(-(sx * sx + sy * sy));
      const band = Math.exp(-(((y - 905) / 48) ** 2)) * smoothstep(1100, 1800, x) * 0.55;
      // Thin haze that reaches into the calm side (zero by x=150) so the left is weather, not a panel.
      const haze = 0.06 * smoothstep(150, 900, x);
      const cx = (x - CAT_CENTER.x) / 380;
      const cy = (y - CAT_CENTER.y) / 300;
      const clearing = 1 - 0.7 * Math.exp(-(cx * cx + cy * cy));
      const cov = clamp01((leftRamp * (storm * 1.15 + band) + haze) * clearing);
      dens[hy * HW + hx] = smoothstep(0.62 - 0.32 * cov, 0.86 - 0.22 * cov, v) * Math.min(1, cov * 1.6);
    }
  }
  const densNear = (hx, hy) => dens[Math.min(HH - 1, Math.max(0, hy | 0)) * HW + Math.min(HW - 1, Math.max(0, hx | 0))];
  for (let hy = 0; hy < HH; hy++) {
    for (let hx = 0; hx < HW; hx++) {
      const i = hy * HW + hx;
      const d = dens[i];
      if (d < 0.002) continue;
      const dx = CAT_CENTER.x / 2 - hx;
      const dy = CAT_CENTER.y / 2 - hy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const toward = densNear(hx + (dx / len) * 9, hy + (dy / len) * 9);
      edge[i] = clamp01((d - toward) * 2.6);
    }
  }
}
function sampleHalf(arr, x, y) {
  let fx = x * 0.5;
  let fy = y * 0.5;
  if (fx < 0) fx = 0;
  if (fy < 0) fy = 0;
  if (fx > HW - 1.001) fx = HW - 1.001;
  if (fy > HH - 1.001) fy = HH - 1.001;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * HW + x0;
  const top = arr[i] + (arr[i + 1] - arr[i]) * tx;
  const bottom = arr[i + HW] + (arr[i + HW + 1] - arr[i + HW]) * tx;
  return top + (bottom - top) * ty;
}
const densAt = (x, y) => (y >= HORIZON ? 0 : sampleHalf(dens, x, y));

function makeStars() {
  const rng = mulberry32(20260927);
  const stars = [];
  const add = (count, rMin, rMax, iMin, iMax, glow) => {
    let n = 0;
    while (n < count) {
      const x = 48 + rng() * (W - 96);
      const y = 8 + rng() * (HORIZON - 140);
      const d = densAt(x, y);
      if (d > 0.3) continue;
      const rr = Math.hypot(x - CAT_CENTER.x, y - CAT_CENTER.y);
      if (rr < CAT_WIDTH * 0.62) continue;
      const wash = 1 - 0.85 * Math.exp(-rr / 320);
      stars.push({ x, y, r: lerp(rMin, rMax, rng()), i: lerp(iMin, iMax, rng()) * (1 - d * 2.5) * wash, tint: rng() < 0.3, glow });
      n++;
    }
  };
  add(1100, 0.55, 1.0, 0.1, 0.34, false);
  add(170, 1.0, 1.7, 0.3, 0.62, false);
  add(18, 1.8, 2.6, 0.7, 1.0, true);
  return stars;
}

const sky = new Float32Array(W * HORIZON * 3);
const seaBuf = new Float32Array(W * (H - HORIZON) * 3);

// Fills the sky with the vertical gradient and returns it per row (ink -> surface -> horizon).
function fillSkyGradient() {
  const grad = new Float32Array(HORIZON * 3);
  for (let y = 0; y < HORIZON; y++) {
    const t = y / HORIZON;
    for (let c = 0; c < 3; c++) {
      const v = t < 0.55 ? lerp(C.inkDark[c], C.surface[c], t / 0.55) : lerp(C.surface[c], C.horizonSky[c], (t - 0.55) / 0.45);
      grad[y * 3 + c] = v;
      const row = y * W * 3;
      for (let x = 0; x < W; x++) sky[row + x * 3 + c] = v;
    }
  }
  return grad;
}

// Additive star discs (gaussian core, wide faint glow on the bright ones) into the sky buffer.
function paintStars(stars) {
  for (const s of stars) {
    const R = Math.ceil(s.glow ? s.r * 7 : s.r * 3);
    const col = s.tint ? lerp3(C.plate, C.aqua, 0.45) : C.plate;
    const sig2 = 2 * (s.r / 1.5) ** 2;
    const gsig2 = 2 * (s.r * 3.2) ** 2;
    for (let py = Math.max(0, Math.floor(s.y - R)); py <= Math.min(HORIZON - 1, Math.ceil(s.y + R)); py++) {
      for (let px = Math.max(0, Math.floor(s.x - R)); px <= Math.min(W - 1, Math.ceil(s.x + R)); px++) {
        const dd = (px - s.x) ** 2 + (py - s.y) ** 2;
        let w = s.i * Math.exp(-dd / sig2);
        if (s.glow) w += s.i * 0.1 * Math.exp(-dd / gsig2);
        if (w < 0.001) continue;
        const idx = (py * W + px) * 3;
        sky[idx] += col[0] * w;
        sky[idx + 1] += col[1] * w;
        sky[idx + 2] += col[2] * w;
      }
    }
  }
}

function buildSky() {
  const grad = fillSkyGradient();
  paintStars(makeStars());
  const col = [0, 0, 0];
  const mixTo = (target, a) => {
    col[0] += (target[0] - col[0]) * a;
    col[1] += (target[1] - col[1]) * a;
    col[2] += (target[2] - col[2]) * a;
  };
  for (let y = 0; y < HORIZON; y++) {
    const hzSky = Math.exp(-(((HORIZON - y) / 130) ** 2));
    const g0 = grad[y * 3];
    const g1 = grad[y * 3 + 1];
    const g2 = grad[y * 3 + 2];
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 3;
      col[0] = sky[idx];
      col[1] = sky[idx + 1];
      col[2] = sky[idx + 2];
      const d = sampleHalf(dens, x, y);
      const rx = x - CAT_CENTER.x;
      const ry = y - CAT_CENTER.y;
      const rr = Math.sqrt(rx * rx + ry * ry);
      const moonL = Math.exp(-rr / 520);
      // Faint large-scale nebulosity over the whole sky (fading out before the bar rail) so the
      // calm side has depth instead of a flat gradient.
      const nebWin = smoothstep(120, 420, x);
      if (nebWin > 0) {
        const neb = fbm01(noise.neb, x / 1200 + 2.2, y / 450 + 1.1, 3);
        mixTo(C.lifted, 0.1 * neb * nebWin);
        mixTo(C.muted, 0.025 * neb * neb * nebWin);
      }
      if (d > 0.001) {
        const e = sampleHalf(edge, x, y);
        const litAmt = e * (0.3 + 0.7 * moonL);
        const a = d * 0.94;
        const body0 = lerp(lerp(g0, C.lifted[0], 0.85), C.muted[0], moonL * 0.6);
        const body1 = lerp(lerp(g1, C.lifted[1], 0.85), C.muted[1], moonL * 0.6);
        const body2 = lerp(lerp(g2, C.lifted[2], 0.85), C.muted[2], moonL * 0.6);
        col[0] = lerp(col[0], lerp(body0, LIT[0], litAmt), a);
        col[1] = lerp(col[1], lerp(body1, LIT[1], litAmt), a);
        col[2] = lerp(col[2], lerp(body2, LIT[2], litAmt), a);
        const gx = (x - STORM_GLOW.x) / 210;
        const gy = (y - STORM_GLOW.y) / 150;
        mixTo(C.aquaGlow, 0.3 * Math.exp(-Math.sqrt(gx * gx + gy * gy)) * Math.pow(d, 1.3));
      }
      if (x > 600 && ry > -140 && rr < 1150 && rr > 1) {
        const theta = Math.atan2(ry, rx);
        const n = n01(noise.ray, theta * 14, rr * 0.0028);
        const rayI =
          0.075 *
          smoothstep(650, 1300, x) *
          smoothstep(0.52, 0.86, n) *
          Math.exp(-rr / 620) *
          smoothstep(-0.15, 0.7, ry / rr) *
          (1 - d) *
          (1 - 0.85 * Math.exp(-rr / 300));
        mixTo(C.aquaGlow, rayI);
      }
      const halo = 0.24 * Math.exp(-rr / 230) + 0.09 * Math.exp(-rr / 760);
      mixTo(C.aquaGlow, Math.min(1, halo * (1 + 0.9 * d)));
      mixTo(C.aqua, 0.09 * hzSky * Math.exp(-(((x - CAT_CENTER.x) / 900) ** 2)));
      sky[idx] = col[0];
      sky[idx + 1] = col[1];
      sky[idx + 2] = col[2];
    }
  }
}

// Sea below the horizon: gradient, wobbling sky reflection, glitter path under the light (x = 1800
// in every scene), horizon glow reflection. `gain` scales the glitter and the glow wash; 1 leaves
// the cat scenes' floats untouched.
function buildSea(gain = { glitter: 1, wash: 1 }) {
  const col = [0, 0, 0];
  const refl = [0, 0, 0];
  const mixTo = (target, a) => {
    col[0] += (target[0] - col[0]) * a;
    col[1] += (target[1] - col[1]) * a;
    col[2] += (target[2] - col[2]) * a;
  };
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    const g = [0, 1, 2].map((c) => (t < 0.35 ? lerp(C.horizonSea[c], C.inkDark[c], t / 0.35) : lerp(C.inkDark[c], C.ink[c], (t - 0.35) / 0.65)));
    const reflW = 0.42 * Math.pow(1 - t, 1.6);
    const spread = 2 + 10 * t;
    const hw = 70 + t * 640;
    const hzSea = Math.exp(-(((y - HORIZON) / 120) ** 2));
    const yr = HORIZON - 1 - (y - HORIZON) * 0.8;
    for (let x = 0; x < W; x++) {
      col[0] = g[0];
      col[1] = g[1];
      col[2] = g[2];
      const wob = noise.sea(x * 0.012 + 3.1, y * 0.11) * (12 + 60 * t);
      const xr = Math.min(W - 1, Math.max(0, Math.round(x + wob)));
      refl[0] = refl[1] = refl[2] = 0;
      for (let k = -2; k <= 2; k++) {
        const sy = Math.min(HORIZON - 1, Math.max(0, Math.round(yr + k * spread)));
        const si = (sy * W + xr) * 3;
        refl[0] += sky[si] * 0.2;
        refl[1] += sky[si + 1] * 0.2;
        refl[2] += sky[si + 2] * 0.2;
      }
      const streak = 0.55 + 0.45 * n01(noise.sea, x * 0.02 + 40, y * 0.7);
      mixTo(refl, reflW * (0.75 + 0.5 * streak));
      const gl = Math.exp(-2 * (((x - CAT_CENTER.x) / hw) ** 2));
      const sp = n01(noise.sea, x * (0.075 - 0.045 * t) + 200, y * (0.6 - 0.25 * t) + 11);
      const sp2 = n01(noise.sea, x * 0.16 + 300, y * 1.1 + 90);
      const sparkle = smoothstep(0.6, 0.9, sp) * (0.55 + 0.45 * smoothstep(0.4, 0.8, sp2));
      const glitter = gl * (sparkle * 0.55 + 0.1) * Math.pow(1 - t, 0.8) * (0.5 + 0.5 * streak);
      mixTo(lerp3(C.aquaGlow, C.plate, sparkle), Math.min(1, glitter * 0.85 * gain.glitter));
      mixTo(C.aquaGlow, 0.12 * Math.exp(-(((x - CAT_CENTER.x) / (150 + 320 * t)) ** 2)) * Math.pow(1 - t, 2.2) * (0.7 + 0.3 * streak) * gain.wash);
      const rip = noise.sea(x * 0.015 + 500, y * 0.8 + 5) * 0.06 * (1 - t);
      col[0] += C.aqua[0] * rip;
      col[1] += C.aqua[1] * rip;
      col[2] += C.aqua[2] * rip;
      mixTo(C.aqua, 0.1 * hzSea * Math.exp(-(((x - CAT_CENTER.x) / 800) ** 2)));
      const idx = ((y - HORIZON) * W + x) * 3;
      seaBuf[idx] = col[0];
      seaBuf[idx + 1] = col[1];
      seaBuf[idx + 2] = col[2];
    }
  }
}

function writeBase(name) {
  const rgb = new Uint8Array(W * H * 3);
  const rng = mulberry32(0x4e696768);
  const gaussian = () => {
    const u = 1 - rng();
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const grainSigma = 2.3 / 255;
  let o = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = y < HORIZON ? sky : seaBuf;
      const si = ((y < HORIZON ? y : y - HORIZON) * W + x) * 3;
      let r = src[si];
      let g = src[si + 1];
      let b = src[si + 2];
      const vd = Math.hypot((x - 1500) / 1750, (y - 620) / 1750);
      if (vd > 0.5) {
        const a = 0.42 * clamp01((vd - 0.5) / 0.5);
        r = lerp(r, C.ink[0], a);
        g = lerp(g, C.ink[1], a);
        b = lerp(b, C.ink[2], a);
      }
      // Bar rail: ease the leftmost 240px a little further into ink so the transparent
      // bar and the terminal edge sit on the quietest part of the frame.
      if (x < 240) {
        const a = 0.18 * (1 - smoothstep(0, 240, x));
        r = lerp(r, C.ink[0], a);
        g = lerp(g, C.ink[1], a);
        b = lerp(b, C.ink[2], a);
      }
      if (y === HORIZON) {
        r = lerp(r, C.aqua[0], 0.1);
        g = lerp(g, C.aqua[1], 0.1);
        b = lerp(b, C.aqua[2], 0.1);
      }
      const grain = gaussian() * grainSigma;
      const dither = (rng() + rng() - 1) / 255;
      rgb[o++] = Math.round(clamp01(r + grain + dither) * 255);
      rgb[o++] = Math.round(clamp01(g + grain + dither) * 255);
      rgb[o++] = Math.round(clamp01(b + grain + dither) * 255);
    }
  }
  writeRaster(join(ART, name), W, H, rgb, 3);
}

// ---------------------------------------------------------------------------
// Open sea (03): the same sky/sea machinery without the cat. The moon sits just below the horizon
// (OPEN_LIGHT), so the frame is lit from the horizon line: a glow dome with faint noise-broken
// beams, low stratus streaks with their undersides lit, a deeper star field with a galaxy band,
// and the glitter path on the water. The left third stays as quiet as in the cat scenes.
// ---------------------------------------------------------------------------
function openGlow(x, y) {
  const dx = x - OPEN_LIGHT.x;
  const dy = HORIZON - y;
  return {
    dome: Math.exp(-((dx / 820) ** 2) - ((dy / 300) ** 2)),
    core: Math.exp(-((dx / 360) ** 2) - ((dy / 110) ** 2)),
  };
}

// Galaxy band weight (0..1): gaussian profile around the band axis, broken up by nebulosity noise.
function bandAt(x, y) {
  const ax = OPEN_BAND.bx - OPEN_BAND.ax;
  const ay = OPEN_BAND.by - OPEN_BAND.ay;
  const dist = Math.abs((x - OPEN_BAND.ax) * ay - (y - OPEN_BAND.ay) * ax) / Math.hypot(ax, ay);
  return Math.exp(-((dist / OPEN_BAND.halfWidth) ** 2)) * fbm01(noise.neb, x / 520 + 4.4, y / 260 + 2.2, 4);
}

// Low stratus streaks over the right half, stretched ~16:1, in two thin bands above the horizon.
function buildOpenClouds() {
  dens.fill(0);
  edge.fill(0);
  for (let hy = 0; hy < HH; hy++) {
    const y = hy * 2;
    if (y < 520) continue;
    const bx = CALM_EDGE + 250 + 300 * noise.warp(y * 0.003 + 2.1, 5.5);
    const bands = 0.8 * Math.exp(-(((y - 890) / 120) ** 2)) + 0.5 * Math.exp(-(((y - 745) / 70) ** 2));
    for (let hx = 0; hx < HW; hx++) {
      const x = hx * 2;
      const nx = x / 1500;
      const ny = y / 95;
      const qx = fbm(noise.warp, nx + 1.7, ny, 3);
      const qy = fbm(noise.warp, nx + 6.1, ny + 2.9, 3);
      const v = fbm01(noise.cloud, nx + 0.35 * qx, ny + 0.35 * qy, 5);
      const cov = clamp01(smoothstep(bx - 400, bx + 400, x) * bands);
      dens[hy * HW + hx] = 0.75 * smoothstep(0.64 - 0.3 * cov, 0.9 - 0.2 * cov, v) * Math.min(1, cov * 1.5);
    }
  }
  // The light is below the horizon, so the lit rims are the undersides.
  const densNear = (hx, hy) => dens[Math.min(HH - 1, Math.max(0, hy | 0)) * HW + Math.min(HW - 1, Math.max(0, hx | 0))];
  for (let hy = 0; hy < HH; hy++) {
    for (let hx = 0; hx < HW; hx++) {
      const i = hy * HW + hx;
      const d = dens[i];
      if (d < 0.002) continue;
      const dx = OPEN_LIGHT.x / 2 - hx;
      const dy = OPEN_LIGHT.y / 2 - hy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const toward = densNear(hx + (dx / len) * 9, hy + (dy / len) * 9);
      edge[i] = clamp01((d - toward) * 2.6);
    }
  }
}

// Four magnitudes for depth: dense far stars mostly along the galaxy band plus the cat scenes'
// three populations, dimmed toward the horizon (extinction) and inside the glow dome.
function makeOpenStars() {
  const rng = mulberry32(20260927 ^ 0x0be4);
  const stars = [];
  const add = (count, rMin, rMax, iMin, iMax, glow, bandBias) => {
    let n = 0;
    while (n < count) {
      const x = 48 + rng() * (W - 96);
      const y = 8 + rng() * (HORIZON - 60);
      const d = densAt(x, y);
      if (d > 0.3) continue;
      if (rng() > 1 - bandBias + bandBias * Math.min(1, 1.6 * bandAt(x, y))) continue;
      const { dome } = openGlow(x, y);
      const extinction = 0.3 + 0.7 * smoothstep(HORIZON - 40, HORIZON - 420, y);
      stars.push({ x, y, r: lerp(rMin, rMax, rng()), i: lerp(iMin, iMax, rng()) * (1 - d * 2.5) * (1 - 0.8 * dome) * extinction, tint: rng() < 0.3, glow });
      n++;
    }
  };
  add(2400, 0.45, 0.7, 0.06, 0.2, false, 0.7);
  add(1100, 0.55, 1.0, 0.1, 0.34, false, 0.3);
  add(190, 1.0, 1.7, 0.3, 0.62, false, 0);
  add(22, 1.8, 2.6, 0.7, 1.0, true, 0);
  return stars;
}

function buildOpenSky() {
  const grad = fillSkyGradient();
  paintStars(makeOpenStars());
  const col = [0, 0, 0];
  const mixTo = (target, a) => {
    col[0] += (target[0] - col[0]) * a;
    col[1] += (target[1] - col[1]) * a;
    col[2] += (target[2] - col[2]) * a;
  };
  for (let y = 0; y < HORIZON; y++) {
    const hzSky = Math.exp(-(((HORIZON - y) / 130) ** 2));
    const ridge = y >= HORIZON - 2;
    const g0 = grad[y * 3];
    const g1 = grad[y * 3 + 1];
    const g2 = grad[y * 3 + 2];
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 3;
      col[0] = sky[idx];
      col[1] = sky[idx + 1];
      col[2] = sky[idx + 2];
      const d = sampleHalf(dens, x, y);
      const dx = x - OPEN_LIGHT.x;
      const dy = y - OPEN_LIGHT.y;
      const rr = Math.sqrt(dx * dx + dy * dy);
      const lightL = Math.exp(-rr / 560);
      const { dome, core } = openGlow(x, y);
      const ramp = smoothstep(500, 1150, x);
      const nebWin = smoothstep(120, 420, x);
      if (nebWin > 0) {
        const neb = fbm01(noise.neb, x / 1200 + 2.2, y / 450 + 1.1, 3);
        mixTo(C.lifted, 0.1 * neb * nebWin);
        mixTo(C.muted, 0.025 * neb * neb * nebWin);
      }
      const bw = bandAt(x, y) * ramp * (1 - 0.7 * dome);
      if (bw > 0.001) {
        mixTo(C.lifted, 0.18 * bw);
        mixTo(C.muted, 0.07 * bw * bw);
        mixTo(C.lightFg, 0.02 * bw * bw * bw);
      }
      if (d > 0.001) {
        const e = sampleHalf(edge, x, y);
        const litAmt = e * (0.25 + 0.75 * lightL);
        const a = d * 0.94;
        const body0 = lerp(lerp(g0, C.lifted[0], 0.85), C.muted[0], lightL * 0.6);
        const body1 = lerp(lerp(g1, C.lifted[1], 0.85), C.muted[1], lightL * 0.6);
        const body2 = lerp(lerp(g2, C.lifted[2], 0.85), C.muted[2], lightL * 0.6);
        col[0] = lerp(col[0], lerp(body0, LIT[0], litAmt), a);
        col[1] = lerp(col[1], lerp(body1, LIT[1], litAmt), a);
        col[2] = lerp(col[2], lerp(body2, LIT[2], litAmt), a);
        mixTo(C.aquaGlow, 0.35 * core * d);
      }
      if (x > 600 && rr > 1) {
        const theta = Math.atan2(dy, dx);
        const n = n01(noise.ray, theta * 16 + 3, rr * 0.0024);
        const rayI = 0.065 * smoothstep(650, 1300, x) * smoothstep(0.55, 0.88, n) * Math.exp(-rr / 560) * (1 - d) * (1 - 0.6 * core);
        mixTo(C.aquaGlow, rayI);
      }
      mixTo(C.aqua, 0.26 * dome * ramp);
      mixTo(C.aquaGlow, 0.3 * core * ramp);
      mixTo(C.aqua, 0.11 * hzSky * Math.exp(-((dx / 1100) ** 2)));
      if (ridge) mixTo(C.aquaGlow, 0.25 * Math.exp(-((dx / 700) ** 2)) * ramp);
      sky[idx] = col[0];
      sky[idx + 1] = col[1];
      sky[idx + 2] = col[2];
    }
  }
}

// ---------------------------------------------------------------------------
// Bolt geometry: seeded midpoint displacement from the storm to the left ear tip,
// with side branches that lean away from the cat.
// ---------------------------------------------------------------------------
function polylineLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
}
function pointAt(pts, frac) {
  const target = polylineLength(pts) * frac;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (acc + l >= target || i === pts.length - 2) {
      const t = l > 0 ? (target - acc) / l : 0;
      return {
        p: [lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)],
        tangent: [(pts[i + 1][0] - pts[i][0]) / (l || 1), (pts[i + 1][1] - pts[i][1]) / (l || 1)],
        index: i,
        t,
      };
    }
    acc += l;
  }
  throw new Error("unreachable");
}
function truncate(pts, frac) {
  const at = pointAt(pts, frac);
  return [...pts.slice(0, at.index + 1), at.p];
}

function makeBolt() {
  const rng = mulberry32(0xb0175);
  const end = [leftEarTip.x + 1, leftEarTip.y - 3];
  const displace = (pts, iters, amp) => {
    for (let it = 0; it < iters; it++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        const off = (rng() - 0.5) * len * amp;
        next.push([(ax + bx) / 2 + nx * off, (ay + by) / 2 + ny * off], [bx, by]);
      }
      pts = next;
    }
    return pts;
  };
  const main = displace([BOLT_START, end], 6, 0.46);
  const total = polylineLength(main);
  const branches = [];
  const fractions = [0.1, 0.24, 0.35, 0.47, 0.58, 0.69, 0.79];
  fractions.forEach((f0, k) => {
    const frac = f0 + (rng() - 0.5) * 0.05;
    const { p, tangent } = pointAt(main, frac);
    const side = frac > 0.62 ? -1 : k % 2 === 0 ? -1 : 1;
    const ang = (side * (28 + rng() * 26) * Math.PI) / 180;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const dir = [tangent[0] * cos - tangent[1] * sin, tangent[0] * sin + tangent[1] * cos];
    let len = (0.2 + rng() * 0.22) * total * (1 - frac) + 50;
    let tip = [p[0] + dir[0] * len, p[1] + dir[1] * len];
    while ((insideCat(tip, 40) || tip[0] < CALM_EDGE + 150) && len > 30) {
      len *= 0.6;
      tip = [p[0] + dir[0] * len, p[1] + dir[1] * len];
    }
    const pts = displace([p, tip], 4, 0.5);
    const w0 = lerp(8.5, 2.6, frac) * 0.5;
    branches.push({ frac, pts, w0, w1: 0.35, level: 1 });
    if (rng() < 0.65) {
      const sub = pointAt(pts, 0.45 + rng() * 0.15);
      const sang = (side * (30 + rng() * 25) * Math.PI) / 180;
      const sc = Math.cos(sang);
      const ss = Math.sin(sang);
      const sdir = [sub.tangent[0] * sc - sub.tangent[1] * ss, sub.tangent[0] * ss + sub.tangent[1] * sc];
      let slen = len * 0.45;
      let stip = [sub.p[0] + sdir[0] * slen, sub.p[1] + sdir[1] * slen];
      while ((insideCat(stip, 40) || stip[0] < CALM_EDGE + 150) && slen > 20) {
        slen *= 0.6;
        stip = [sub.p[0] + sdir[0] * slen, sub.p[1] + sdir[1] * slen];
      }
      branches.push({ frac, pts: displace([sub.p, stip], 3, 0.5), w0: w0 * 0.5, w1: 0.25, level: 2 });
    }
  });
  return { main, total, branches, end };
}

function polylineSegments(pts, w0, w1) {
  const L = polylineLength(pts) || 1;
  const segs = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segs.push({ ax: pts[i][0], ay: pts[i][1], bx: pts[i + 1][0], by: pts[i + 1][1], wa: lerp(w0, w1, acc / L), wb: lerp(w0, w1, (acc + l) / L) });
    acc += l;
  }
  return segs;
}

// Signed distance to the tapered strokes (negative inside the core), on a pixel grid.
function distanceField(segs, x0, y0, w, h) {
  const n = segs.length;
  const AX = new Float64Array(n);
  const AY = new Float64Array(n);
  const DX = new Float64Array(n);
  const DY = new Float64Array(n);
  const IL = new Float64Array(n);
  const WA = new Float64Array(n);
  const WB = new Float64Array(n);
  segs.forEach((s, k) => {
    AX[k] = s.ax;
    AY[k] = s.ay;
    DX[k] = s.bx - s.ax;
    DY[k] = s.by - s.ay;
    IL[k] = 1 / (DX[k] * DX[k] + DY[k] * DY[k] || 1);
    WA[k] = s.wa;
    WB[k] = s.wb;
  });
  const field = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const py = y0 + j;
    for (let i = 0; i < w; i++) {
      const px = x0 + i;
      let best = 1e9;
      for (let k = 0; k < n; k++) {
        let t = ((px - AX[k]) * DX[k] + (py - AY[k]) * DY[k]) * IL[k];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = AX[k] + DX[k] * t - px;
        const cy = AY[k] + DY[k] * t - py;
        const e = Math.sqrt(cx * cx + cy * cy) - (WA[k] + (WB[k] - WA[k]) * t);
        if (e < best) best = e;
      }
      field[j * w + i] = best;
    }
  }
  return { x0, y0, w, h, field };
}
function fieldAt(F, x, y) {
  const fx = x - F.x0;
  const fy = y - F.y0;
  if (fx < 0 || fy < 0 || fx >= F.w - 1 || fy >= F.h - 1) return 1e4;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * F.w + x0;
  const top = F.field[i] + (F.field[i + 1] - F.field[i]) * tx;
  const bottom = F.field[i + F.w] + (F.field[i + F.w + 1] - F.field[i + F.w]) * tx;
  return top + (bottom - top) * ty;
}
function segmentBounds(segs, margin) {
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  for (const s of segs) {
    minX = Math.min(minX, s.ax, s.bx);
    maxX = Math.max(maxX, s.ax, s.bx);
    minY = Math.min(minY, s.ay, s.by);
    maxY = Math.max(maxY, s.ay, s.by);
  }
  const x0 = Math.max(0, Math.floor(minX - margin));
  const y0 = Math.max(0, Math.floor(minY - margin));
  return { x0, y0, w: Math.min(W, Math.ceil(maxX + margin)) - x0, h: Math.min(H, Math.ceil(maxY + margin)) - y0 };
}

// ---------------------------------------------------------------------------
// RGBA layers (straight alpha, float), cropped and dithered on write.
// ---------------------------------------------------------------------------
function makeLayer(x0, y0, w, h) {
  return { x0, y0, w, h, data: new Float32Array(w * h * 4) };
}
function paint(L, x, y, col, a) {
  if (!(a > 0)) return; // also drops NaN, which a plain `<` would let through
  const i = ((y - L.y0) * L.w + (x - L.x0)) * 4;
  L.data[i] = col[0];
  L.data[i + 1] = col[1];
  L.data[i + 2] = col[2];
  L.data[i + 3] = a > 1 ? 1 : a;
}
function writeLayer(name, L, outPath = join(LAYERS, `${name}.png`)) {
  let minX = L.w;
  let minY = L.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < L.h; y++) {
    for (let x = 0; x < L.w; x++) {
      if (L.data[(y * L.w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`layer ${name} is empty`);
  minX = Math.max(0, minX - 2);
  minY = Math.max(0, minY - 2);
  maxX = Math.min(L.w - 1, maxX + 2);
  maxY = Math.min(L.h - 1, maxY + 2);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new Uint8Array(cw * ch * 4);
  const rng = mulberry32(name.length * 7919 + name.charCodeAt(0));
  let o = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = (y * L.w + x) * 4;
      const a = L.data[i + 3];
      if (!(a > 0)) {
        o += 4;
        continue;
      }
      const dc = (rng() + rng() - 1) / 255;
      // Alpha gets uniform (RPDF) dither: the expected coverage then equals the float value all
      // the way down to zero. Triangular dither straddles zero and would leave a 12.5% floor along
      // every alpha>0 contour, i.e. a faint line wherever a layer's tail ends.
      const da = (rng() - 0.5) / 255;
      const qa = Math.round(clamp01(a + da) * 255);
      if (qa === 0) {
        o += 4;
        continue;
      }
      out[o++] = Math.round(clamp01(L.data[i] + dc) * 255);
      out[o++] = Math.round(clamp01(L.data[i + 1] + dc) * 255);
      out[o++] = Math.round(clamp01(L.data[i + 2] + dc) * 255);
      out[o++] = qa;
    }
  }
  const file = `${name}.png`;
  writeRaster(outPath, cw, ch, out, 4);
  return { file, x: L.x0 + minX, y: L.y0 + minY, width: cw, height: ch };
}

const STAGES = {
  "bolt-leader": { core: 0.7, coreEdge: [0.8, -0.4], coreWhite: 0.6, b1: 0.35, b2: 0.1, b3: 0.03, water: 0.1 },
  "bolt-strike": { core: 1.0, coreEdge: [1.0, -0.6], coreWhite: 1.0, b1: 0.78, b2: 0.3, b3: 0.11, water: 0.75 },
  "bolt-afterglow": { core: 0.35, coreEdge: [1.5, -0.3], coreWhite: 0.3, b1: 0.5, b2: 0.45, b3: 0.25, water: 0.4 },
};

function renderBoltStage(name, F, bolt, catA) {
  const P = STAGES[name];
  const L = makeLayer(F.x0, 0, F.w, H);
  const waterX = bolt.end[0] - 30;
  const xEnd = F.x0 + F.w;
  // The bloom tails are still ~1/255 at the field margin; a 220px window takes them to exactly
  // zero at any field edge that is not a frame edge, so the layer crop never shows a line.
  const winX = new Float32Array(F.w);
  for (let i = 0; i < F.w; i++) {
    const x = F.x0 + i;
    winX[i] = (F.x0 > 0 ? smoothstep(F.x0, F.x0 + 220, x) : 1) * (xEnd < W ? smoothstep(xEnd, xEnd - 220, x) : 1);
  }
  for (let y = 0; y < H; y++) {
    const t = y < HORIZON ? 0 : (y - HORIZON) / (H - HORIZON);
    const hw = 60 + 500 * t;
    for (let x = F.x0; x < xEnd; x++) {
      const hole = (1 - catA[y * W + x]) * winX[x - F.x0];
      if (hole <= 0) continue;
      if (y < HORIZON) {
        const e = fieldAt(F, x, y);
        const core = smoothstep(P.coreEdge[0], P.coreEdge[1], e);
        const ep = e > 0 ? e : 0;
        const b1 = Math.exp(-ep / 10);
        const b2 = Math.exp(-ep / 42);
        const b3 = Math.exp(-ep / 170);
        const d = densAt(x, y);
        const veil = 1 - 0.9 * d;
        const veilB = 1 - 0.65 * d;
        const a = (P.core * core * veil + (P.b1 * b1 + P.b2 * b2 + P.b3 * b3) * veilB) * hole;
        const col = lerp3(lerp3(C.aqua, C.aquaGlow, b2), C.boltCore, Math.min(1, core * P.coreWhite + b1 * 0.35 * P.coreWhite));
        paint(L, x, y, col, a);
      } else {
        const streak = 0.55 + 0.45 * n01(noise.sea, x * 0.03 + 40, y * 0.6);
        const sp = n01(noise.sea, x * 0.09 + 200, y * 0.55 + 11);
        const sparkle = smoothstep(0.58, 0.9, sp);
        const column = Math.exp(-2 * (((x - waterX) / hw) ** 2));
        const a = P.water * column * (0.18 + 0.5 * sparkle) * Math.pow(1 - t, 1.1) * streak * hole;
        paint(L, x, y, lerp3(C.aquaGlow, C.boltCore, sparkle * 0.5), a);
      }
    }
  }
  return L;
}

function renderEarSpark(catA) {
  const rng = mulberry32(0x5a4b);
  const ex = leftEarTip.x;
  const ey = leftEarTip.y;
  const sparks = [];
  for (let i = 0; i < 6; i++) {
    const ang = ((-150 + rng() * 120) * Math.PI) / 180;
    const len = 26 + rng() * 54;
    sparks.push({ ax: ex, ay: ey, bx: ex + Math.cos(ang) * len, by: ey + Math.sin(ang) * len, wa: 1.6, wb: 0.2 });
  }
  const R = 220;
  const x0 = Math.max(0, Math.floor(ex - R));
  const y0 = Math.max(0, Math.floor(ey - R));
  const L = makeLayer(x0, y0, Math.min(W, Math.ceil(ex + R)) - x0, Math.min(H, Math.ceil(ey + R)) - y0);
  const SF = distanceField(sparks, x0, y0, L.w, L.h);
  for (let y = y0; y < y0 + L.h; y++) {
    for (let x = x0; x < x0 + L.w; x++) {
      const r = Math.hypot(x - ex, y - ey);
      const core = Math.exp(-((r / 7) ** 2));
      const bloom = 0.65 * Math.exp(-r / 24) + 0.3 * Math.exp(-r / 80);
      const spark = smoothstep(0.9, -0.5, fieldAt(SF, x, y)) * 0.9;
      const hole = 1 - 0.9 * catA[y * W + x];
      // radial window: the bloom is still ~5/255 at the square crop, so fade it to zero inside R
      const a = Math.min(1, core + bloom + spark) * hole * smoothstep(R, R - 70, r);
      paint(L, x, y, lerp3(C.aquaGlow, C.boltCore, Math.min(1, core + spark)), a);
    }
  }
  return L;
}

function renderCatGlow(catA) {
  const near = boxBlur(catA, W, H, 26, 3);
  const far = boxBlur(catA, W, H, 95, 2);
  const m = 330;
  const x0 = Math.max(0, Math.floor(catBox.x - m));
  const y0 = Math.max(0, Math.floor(catBox.y - m));
  const L = makeLayer(x0, y0, Math.min(W, Math.ceil(catBox.x + catBox.w + m)) - x0, Math.min(H, Math.ceil(catBox.y + catBox.h + m)) - y0);
  for (let y = y0; y < y0 + L.h; y++) {
    for (let x = x0; x < x0 + L.w; x++) {
      const i = y * W + x;
      const a = (0.35 * Math.pow(near[i], 1.4) + 0.3 * far[i]) * (1 - catA[i]);
      paint(L, x, y, lerp3(C.aqua, C.boltCore, near[i]), a);
    }
  }
  return L;
}

function renderSkyFlash(bolt, catA) {
  const x0 = CALM_EDGE - 500;
  // The flash also lights the water under the storm: the ambient term continues past the horizon
  // and decays to zero within SEA_REACH, instead of stopping dead on the horizon line.
  const SEA_REACH = 420;
  const L = makeLayer(x0, 0, W - x0, HORIZON + SEA_REACH);
  const CF = distanceField(polylineSegments(bolt.main, 0, 0), x0, 0, L.w, L.h);
  for (let y = 0; y < L.h; y++) {
    const sea = y >= HORIZON;
    const seaFall = sea ? Math.exp(-(y - HORIZON) / 130) * smoothstep(HORIZON + SEA_REACH, HORIZON + 160, y) : 1;
    for (let x = x0; x < W; x++) {
      const dc = Math.max(0, fieldAt(CF, x, y));
      const ramp = smoothstep(x0, CALM_EDGE + 200, x);
      const ambient = 0.08 * Math.exp(-dc / 520);
      let a;
      if (sea) {
        a = ambient * seaFall * ramp;
      } else {
        const d = densAt(x, y);
        const light = 0.7 * Math.exp(-dc / 210) + 0.2 * Math.exp(-dc / 650);
        a = (Math.min(0.72, d * light * (0.55 + 0.45 * d)) + (1 - d) * ambient) * ramp * (1 - catA[y * W + x]);
      }
      paint(L, x, y, lerp3(C.aquaGlow, C.boltCore, 0.6 * Math.exp(-dc / 140)), a);
    }
  }
  return L;
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
const t0 = Date.now();
const lap = (label) => console.log(`${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const STRIKE_ORDER = ["sky-flash", "cat-glow", "bolt-strike", "ear-spark"];
const layerInfo = {};

if (BUILD_CAT) {
  // layers/ is fully generated: wipe it so renamed or dropped layers never linger.
  rmSync(LAYERS, { recursive: true, force: true });
  mkdirSync(LAYERS, { recursive: true });
  buildClouds();
  lap("cat clouds");
  buildSky();
  lap("cat sky");
  buildSea();
  lap("cat sea");
  writeBase(BASE_NAME);
  lap(`wrote ${join(ART, BASE_NAME)}`);

  const catA = rasterizeCatAlpha();
  const bolt = makeBolt();
  const fullSegs = [...polylineSegments(bolt.main, 8.5, 2.6), ...bolt.branches.flatMap((b) => polylineSegments(b.pts, b.w0, b.w1))];
  const leaderSegs = [
    ...polylineSegments(truncate(bolt.main, 0.74), 8.5 * 0.55, 2.6 * 0.55),
    ...bolt.branches.filter((b) => b.frac < 0.5).flatMap((b) => polylineSegments(b.pts, b.w0 * 0.55, b.w1 * 0.55)),
  ];
  // Margin 700: the widest bloom (afterglow 0.25*e^(-e/170)) is ~1/255 at the field edge and
  // renderBoltStage windows the last 220px to zero. The field stops at the horizon; the water
  // part of each stage is analytic.
  const fullBounds = segmentBounds(fullSegs, 700);
  const fieldH = Math.min(fullBounds.h, HORIZON - fullBounds.y0);
  const fullField = distanceField(fullSegs, fullBounds.x0, fullBounds.y0, fullBounds.w, fieldH);
  const leaderField = distanceField(leaderSegs, fullBounds.x0, fullBounds.y0, fullBounds.w, fieldH);
  lap("bolt fields");

  layerInfo["sky-flash"] = writeLayer("sky-flash", renderSkyFlash(bolt, catA));
  layerInfo["cat-glow"] = writeLayer("cat-glow", renderCatGlow(catA));
  layerInfo["bolt-leader"] = writeLayer("bolt-leader", renderBoltStage("bolt-leader", leaderField, bolt, catA));
  layerInfo["bolt-strike"] = writeLayer("bolt-strike", renderBoltStage("bolt-strike", fullField, bolt, catA));
  layerInfo["bolt-afterglow"] = writeLayer("bolt-afterglow", renderBoltStage("bolt-afterglow", fullField, bolt, catA));
  layerInfo["ear-spark"] = writeLayer("ear-spark", renderEarSpark(catA));
  lap("layers");

  const manifest = {
    frame: { width: W, height: H },
    base: "../../backgrounds/01-nightsea-calm.png",
    blend: "source-over",
    contract: "backgrounds/02-nightsea-storm.png == base + strike layers in `order`, each drawn at its x/y",
    anchors: { catCenter: CAT_CENTER, catBox: { x: f(catBox.x), y: f(catBox.y), w: f(catBox.w), h: f(catBox.h) }, leftEarTip: { x: f(leftEarTip.x), y: f(leftEarTip.y) }, horizon: HORIZON },
    order: STRIKE_ORDER,
    layers: Object.fromEntries(
      Object.entries(layerInfo).map(([name, info]) => [name, { ...info, role: "strike", stage: name.startsWith("bolt-") ? name.slice(5) : undefined }]),
    ),
    sequence: [
      { phase: "leader", layers: ["bolt-leader"], ms: 90 },
      { phase: "strike", layers: STRIKE_ORDER, ms: 90 },
      { phase: "afterglow", layers: ["bolt-afterglow", "cat-glow"], ms: 600, easing: "OutExpo", fadeOut: true },
      { phase: "working", layers: ["cat-glow"], ms: 2400, easing: "InOutSine", loop: "breathe 0.35..0.8" },
    ],
    motionTokens: { "bolt.flash": "2 x 90ms step", "bolt.decay": "600ms OutExpo", breath: "2400ms InOutSine" },
  };
  writeFileSync(join(LAYERS, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (BUILD_OPEN) {
  buildOpenClouds();
  lap("open clouds");
  buildOpenSky();
  lap("open sky");
  buildSea({ glitter: 1.15, wash: 1.2 });
  lap("open sea");
  writeBase(OPEN_BASE_NAME);
  lap(`wrote ${join(ART, OPEN_BASE_NAME)}`);
}

// ---------------------------------------------------------------------------
// SVG masters.
// ---------------------------------------------------------------------------
const layerImage = (name) => {
  const L = layerInfo[name];
  return `<image href="layers/${L.file}" x="${L.x}" y="${L.y}" width="${L.width}" height="${L.height}"/>`;
};

function wallpaper({ withBolt }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>OmO Nightsea${withBolt ? " - moon cat with lightning" : " - calm moon cat"}</title>
  <defs>
    <clipPath id="plate-clip"><path d="${GLYPH_D}" clip-rule="evenodd"/></clipPath>
    <filter id="rim-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>

  <!-- 1. atmosphere: float-rendered, dithered raster -->
  <rect width="${W}" height="${H}" fill="${PALETTE.surface}"/>
  <image href="${BASE_NAME}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>

  <!-- 2. the moon cat: exact reference glyph, crisp plate, thin inner rim light -->
  <g id="cat" transform="${catTransform}">
    ${catGroupLit("omo-cat-moon")}
  </g>
${
  withBolt
    ? `
  <!-- 3. strike layers, same order as layers/manifest.json -->
  ${STRIKE_ORDER.map(layerImage).join("\n  ")}
`
    : ""
}</svg>
`;
}

function openWallpaper() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>OmO Nightsea - open sea</title>
  <rect width="${W}" height="${H}" fill="${PALETTE.surface}"/>
  <image href="${OPEN_BASE_NAME}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
</svg>
`;
}

function renderSvg(svg, png, width, height) {
  const result = spawnSync("rsvg-convert", ["-w", String(width), "-h", String(height), svg, "-o", png], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`rsvg-convert failed for ${svg}`);
}

function renderStorm(calmPng, stormPng) {
  const args = [calmPng];
  for (const name of STRIKE_ORDER) {
    const layer = layerInfo[name];
    args.push(join(LAYERS, layer.file), "-geometry", `+${layer.x}+${layer.y}`, "-composite");
  }
  args.push("-define", "png:compression-level=9", "-define", "png:exclude-chunks=date,time", `PNG24:${stormPng}`);
  const result = spawnSync("magick", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error("magick failed to compose the storm wallpaper");
}

function renderPlymouth() {
  const UW = 800;
  const UH = 500;
  const UX = 400;
  const UY = 230;
  const US = CAT_WIDTH / GLYPH_BBOX.w;
  const transform = `translate(${f(UX - (GLYPH_BBOX.x + GLYPH_BBOX.w / 2) * US)} ${f(UY - (GLYPH_BBOX.y + GLYPH_BBOX.h / 2) * US)}) scale(${f(US)})`;
  const halo = new Uint8Array(UW * UH * 4);
  const rng = mulberry32(0x706c796d);
  for (let y = 0, o = 0; y < UH; y++) {
    for (let x = 0; x < UW; x++, o += 4) {
      const d = Math.hypot((x - UX) / 300, (y - UY) / 230);
      const edge = smoothstep(0, 80, Math.min(x, y, UW - 1 - x, UH - 1 - y));
      const a = (0.2 * Math.exp(-2.2 * d * d) + 0.08 * Math.exp(-0.85 * d * d)) * edge;
      const dc = (rng() + rng() - 1) / 255;
      const da = (rng() - 0.5) / 255;
      halo[o] = Math.round(clamp01(C.aquaGlow[0] + dc) * 255);
      halo[o + 1] = Math.round(clamp01(C.aquaGlow[1] + dc) * 255);
      halo[o + 2] = Math.round(clamp01(C.aquaGlow[2] + dc) * 255);
      halo[o + 3] = Math.round(clamp01(a + da) * 255);
    }
  }
  const haloPath = tmpPath("png");
  const catSvgPath = tmpPath("svg");
  const catPngPath = tmpPath("png");
  writeRaster(haloPath, UW, UH, halo, 4);
  writeFileSync(
    catSvgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UW} ${UH}" width="${UW}" height="${UH}"><g transform="${transform}">${catGroup("omo-cat-moon")}</g></svg>`,
  );
  renderSvg(catSvgPath, catPngPath, UW, UH);
  const unlockPath = join(ROOT, "unlock.png");
  const composite = spawnSync(
    "magick",
    [haloPath, catPngPath, "-composite", "-define", "png:compression-level=9", "-define", "png:exclude-chunks=date,time", `PNG32:${unlockPath}`],
    { stdio: "inherit" },
  );
  rmSync(haloPath, { force: true });
  rmSync(catSvgPath, { force: true });
  rmSync(catPngPath, { force: true });
  if (composite.status !== 0) throw new Error("magick failed to write unlock.png");

  const previewSvgPath = tmpPath("svg");
  const previewPath = join(ROOT, "preview-unlock.png");
  const logoX = (1920 - UW) / 2;
  const logoY = (1080 - UH) / 2;
  const entryY = logoY + UH + 40;
  const unlockData = readFileSync(unlockPath).toString("base64");
  writeFileSync(
    previewSvgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <rect width="1920" height="1080" fill="${PALETTE.surface}"/>
  <image href="data:image/png;base64,${unlockData}" x="${logoX}" y="${logoY}" width="${UW}" height="${UH}"/>
  <g fill="none" stroke="${PALETTE.plate}" stroke-width="3" opacity="0.82">
    <rect x="817" y="${entryY}" width="285" height="47"/>
    <path d="M778 ${entryY + 12}v-8a11 11 0 0 1 22 0v8m-26 0h30v28h-30z"/>
  </g>
  <g fill="${PALETTE.plate}" opacity="0.82">
    <circle cx="840" cy="${entryY + 24}" r="4"/><circle cx="852" cy="${entryY + 24}" r="4"/>
    <circle cx="864" cy="${entryY + 24}" r="4"/><circle cx="876" cy="${entryY + 24}" r="4"/>
  </g>
</svg>`,
  );
  renderSvg(previewSvgPath, previewPath, 1920, 1080);
  rmSync(previewSvgPath, { force: true });
  lap(`rendered ${unlockPath} and ${previewPath}`);
}

const outputs = [{ svg: join(ART, "omo-cat-moon.svg"), text: catMoonSvg }];
if (SELECTED.has("calm")) outputs.push({ scene: "calm", svg: join(ART, SCENES.calm.svg), text: wallpaper({ withBolt: false }), png: join(BACKGROUNDS, SCENES.calm.png) });
if (SELECTED.has("storm")) outputs.push({ scene: "storm", svg: join(ART, SCENES.storm.svg), text: wallpaper({ withBolt: true }), png: join(BACKGROUNDS, SCENES.storm.png) });
if (SELECTED.has("open")) outputs.push({ scene: "open", svg: join(ART, SCENES.open.svg), text: openWallpaper(), png: join(BACKGROUNDS, SCENES.open.png) });
for (const out of outputs) {
  writeFileSync(out.svg, out.text);
  console.log(`wrote ${out.svg}`);
}

if (RENDER) {
  mkdirSync(BACKGROUNDS, { recursive: true });
  for (const out of outputs.filter((o) => o.png)) {
    if (out.scene === "storm") {
      let calmPng = join(BACKGROUNDS, SCENES.calm.png);
      if (!SELECTED.has("calm")) {
        const calmSvg = tmpPath("svg");
        calmPng = tmpPath("png");
        writeFileSync(calmSvg, wallpaper({ withBolt: false }));
        renderSvg(calmSvg, calmPng, W, H);
        rmSync(calmSvg, { force: true });
      }
      renderStorm(calmPng, out.png);
      if (!SELECTED.has("calm")) rmSync(calmPng, { force: true });
    } else {
      renderSvg(out.svg, out.png, W, H);
    }
    lap(`rendered ${out.png}`);
  }
  if (SELECTED.has("storm")) {
    const preview = spawnSync(
      "magick",
      [
        join(BACKGROUNDS, SCENES.storm.png),
        "-filter",
        "Lanczos",
        "-resize",
        "1600x900",
        "-define",
        "png:compression-level=9",
        "-define",
        "png:exclude-chunks=date,time",
        join(ROOT, "preview.png"),
      ],
      { stdio: "inherit" },
    );
    if (preview.status !== 0) throw new Error("magick failed to write preview.png");
    lap(`rendered ${join(ROOT, "preview.png")}`);
  }
  if (SCENE_ARGS.length === 0) renderPlymouth();
}
