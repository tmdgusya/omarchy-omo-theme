#!/usr/bin/env bun
// Builds the Nightsea art from the OmO reference icon.
//
//   bun art/build-wallpapers.mjs            # art/nightsea-base.png + art/*.svg
//   bun art/build-wallpapers.mjs --render   # also backgrounds/*.png via rsvg-convert
//
// The atmosphere (sky, sea, light shafts, haze, vignette, grain) is computed in
// float precision and dithered before the 8-bit store, because cairo renders
// SVG gradients undithered and dark teal gradients band visibly at 8 bits.
// Everything with an edge (cat, bolt, stars, water streaks) stays vector.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ART = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(ART);
const BACKGROUNDS = join(ROOT, "backgrounds");

const PALETTE = {
  ink: "#041617",
  inkDark: "#071416",
  surface: "#0B1B1D",
  horizonSky: "#0F2A2C",
  horizonSea: "#0C2426",
  plate: "#F4F4F4",
  aqua: "#7FE0D4",
  aquaGlow: "#9CF0FF",
  boltCore: "#EAFBFF",
};

const W = 2560;
const H = 1440;
const HORIZON = 1123;
const CAT_CENTER = { x: 1640, y: 720 };
const CAT_WIDTH = 620;
const BASE_NAME = "nightsea-base.png";

const f = (n) => (Math.round(n * 100) / 100).toString();
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
// always read as ink no matter what glows behind the cat.
const catGroup = (id) => `<g id="${id}">
    <path d="${OUTER_D}" fill="${PALETTE.ink}"/>
    <path d="${GLYPH_D}" fill="${PALETTE.plate}" fill-rule="evenodd"/>
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

// ---------------------------------------------------------------------------
// Atmosphere raster.
// ---------------------------------------------------------------------------
const SHAFTS = [
  { x: 330, w: 210, o: 0.05 },
  { x: 620, w: 130, o: 0.035 },
  { x: 960, w: 250, o: 0.045 },
  { x: 2150, w: 170, o: 0.05 },
  { x: 2420, w: 120, o: 0.035 },
];

function buildBaseRaster() {
  const rgb = new Uint8Array(W * H * 3);
  const skyTop = hex(PALETTE.inkDark);
  const skyMid = hex(PALETTE.surface);
  const skyHorizon = hex(PALETTE.horizonSky);
  const seaTop = hex(PALETTE.horizonSea);
  const seaMid = hex(PALETTE.inkDark);
  const seaBottom = hex(PALETTE.ink);
  const aqua = hex(PALETTE.aqua);
  const aquaGlow = hex(PALETTE.aquaGlow);
  const ink = hex(PALETTE.ink);
  const rng = mulberry32(0x4e696768);
  const gaussian = () => {
    const u = 1 - rng();
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const grainSigma = 2.3 / 255;
  const col = [0, 0, 0];
  let idx = 0;
  for (let y = 0; y < H; y++) {
    const inSky = y < HORIZON;
    const t = inSky ? y / HORIZON : (y - HORIZON) / (H - HORIZON);
    for (let c = 0; c < 3; c++) {
      if (inSky) col[c] = t < 0.55 ? lerp(skyTop[c], skyMid[c], t / 0.55) : lerp(skyMid[c], skyHorizon[c], (t - 0.55) / 0.45);
      else col[c] = t < 0.35 ? lerp(seaTop[c], seaMid[c], t / 0.35) : lerp(seaMid[c], seaBottom[c], (t - 0.35) / 0.65);
    }
    const shaftFade = inSky ? (t < 0.3 ? lerp(0, 0.33, t / 0.3) : lerp(0.33, 1, (t - 0.3) / 0.7)) : 0;
    const hazeDy = (y - HORIZON) / 144;
    const glowDy = (y - (HORIZON + 30)) / 92;
    const vigDy = y - 700;
    for (let x = 0; x < W; x++) {
      let r = col[0];
      let g = col[1];
      let b = col[2];
      if (inSky) {
        for (const s of SHAFTS) {
          const d = Math.abs(x - s.x) / (s.w / 2);
          if (d < 1) {
            const a = s.o * (1 - d) * shaftFade;
            r = lerp(r, aqua[0], a);
            g = lerp(g, aqua[1], a);
            b = lerp(b, aqua[2], a);
          }
        }
      }
      const hazeD = Math.hypot((x - CAT_CENTER.x) / 900, hazeDy);
      if (hazeD < 1) {
        const a = hazeD < 0.5 ? lerp(0.16, 0.05, hazeD / 0.5) : lerp(0.05, 0, (hazeD - 0.5) / 0.5);
        r = lerp(r, aqua[0], a);
        g = lerp(g, aqua[1], a);
        b = lerp(b, aqua[2], a);
      }
      const glowD = Math.hypot((x - CAT_CENTER.x) / 420, glowDy);
      if (glowD < 1) {
        const a = 0.14 * (1 - glowD);
        r = lerp(r, aquaGlow[0], a);
        g = lerp(g, aquaGlow[1], a);
        b = lerp(b, aquaGlow[2], a);
      }
      const vigD = Math.hypot(x - 1400, vigDy) / 1750;
      if (vigD > 0.5) {
        const a = 0.42 * clamp01((vigD - 0.5) / 0.5);
        r = lerp(r, ink[0], a);
        g = lerp(g, ink[1], a);
        b = lerp(b, ink[2], a);
      }
      const grain = gaussian() * grainSigma;
      const dither = (rng() + rng() - 1) / 255;
      rgb[idx++] = Math.round(clamp01(r + grain + dither) * 255);
      rgb[idx++] = Math.round(clamp01(g + grain + dither) * 255);
      rgb[idx++] = Math.round(clamp01(b + grain + dither) * 255);
    }
  }
  const ppm = Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`, "ascii"), Buffer.from(rgb.buffer)]);
  const ppmPath = join(ART, "nightsea-base.ppm");
  writeFileSync(ppmPath, ppm);
  const result = spawnSync("magick", [ppmPath, "-define", "png:compression-level=9", join(ART, BASE_NAME)], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("magick failed to encode the base raster");
  spawnSync("rm", ["-f", ppmPath]);
}

// ---------------------------------------------------------------------------
// Vector layers.
// ---------------------------------------------------------------------------
function stars() {
  const rng = mulberry32(20260927);
  const out = [];
  const placed = [];
  while (placed.length < 11) {
    const x = 1380 + rng() * 1120;
    const y = 70 + rng() * 480;
    const nearBolt = x > 1140 && x < 1440 && y < 470;
    const nearCat = x > catBox.x - 60 && x < catBox.x + catBox.w + 60 && y > catBox.y - 80;
    const tooClose = placed.some((p) => Math.hypot(p.x - x, p.y - y) < 130);
    if (nearBolt || nearCat || tooClose) continue;
    placed.push({ x, y });
    const r = 1.3 + rng() * 1.7;
    const o = 0.26 + rng() * 0.26;
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${PALETTE.plate}" fill-opacity="${f(o)}"/>`);
    if (r > 2.4) out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 6)}" fill="url(#star-glow)"/>`);
  }
  return out.join("\n    ");
}

function moonPath() {
  const rng = mulberry32(7);
  const lines = [];
  for (let i = 0; i < 64; i++) {
    const t = Math.pow(rng(), 1.6);
    const y = HORIZON + 4 + t * 250;
    const spread = 50 + t * 320;
    const cx = CAT_CENTER.x + (rng() - 0.5) * spread;
    const len = 30 + rng() * 120 + t * 260;
    const o = 0.22 * (1 - t) * (0.45 + rng() * 0.55);
    const h = 1.2 + t * 2.2;
    lines.push(`<rect x="${f(cx - len / 2)}" y="${f(y)}" width="${f(len)}" height="${f(h)}" fill="url(#streak)" opacity="${f(o)}"/>`);
  }
  return lines.join("\n    ");
}

function ripples() {
  const rng = mulberry32(99);
  const lines = [];
  for (let i = 0; i < 26; i++) {
    const t = rng();
    const y = HORIZON + 4 + t * t * 300;
    const len = 240 + rng() * 900;
    const x = 60 + rng() * (W - len - 80);
    const o = 0.045 * (1 - t) + 0.01;
    lines.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(len)}" height="1.5" rx="0.75" fill="${PALETTE.aqua}" fill-opacity="${f(o)}"/>`);
  }
  return lines.join("\n    ");
}

// Tapered stroke around a polyline as one nonzero path: a trapezoid per
// segment plus a round joint per vertex, so sharp zigzags never self-intersect.
function taperedPolygon(points, widths) {
  const parts = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const wa = widths[i] / 2;
    const wb = widths[i + 1] / 2;
    parts.push(
      `M${f(ax + nx * wa)} ${f(ay + ny * wa)} L${f(bx + nx * wb)} ${f(by + ny * wb)} L${f(bx - nx * wb)} ${f(by - ny * wb)} L${f(ax - nx * wa)} ${f(ay - ny * wa)} Z`,
    );
  }
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const r = widths[i] / 2;
    parts.push(`M${f(x - r)} ${f(y)} A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)} A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)} Z`);
  }
  return parts.join(" ");
}

function bolt() {
  const spine = [
    [1214, -40],
    [1238, 72],
    [1208, 152],
    [1266, 236],
    [1250, 294],
    [1314, 350],
    [1308, 392],
    [1348, 420],
    [leftEarTip.x + 1, leftEarTip.y - 3],
  ];
  const spineW = [9, 8.5, 7.5, 6.5, 5.5, 4.5, 3.5, 2.4, 1.0];
  const branchA = [[1238, 72], [1274, 120], [1286, 164]];
  const branchB = [[1250, 294], [1218, 338], [1212, 376]];
  const spineD = taperedPolygon(spine, spineW);
  const branchAD = taperedPolygon(branchA, [3, 1.6, 0.4]);
  const branchBD = taperedPolygon(branchB, [2.4, 1.2, 0.3]);
  const centerline = spine.map((p, i) => `${i === 0 ? "M" : "L"}${f(p[0])} ${f(p[1])}`).join(" ");
  return `<g id="bolt" mask="url(#bolt-fade)">
    <path d="${centerline}" fill="none" stroke="${PALETTE.aquaGlow}" stroke-width="46" stroke-linecap="round" stroke-linejoin="round" opacity="0.17" filter="url(#blur-26)"/>
    <path d="${spineD}" fill="${PALETTE.aquaGlow}" opacity="0.6" filter="url(#blur-9)"/>
    <path d="${branchAD}" fill="${PALETTE.aquaGlow}" opacity="0.5" filter="url(#blur-4)"/>
    <path d="${branchBD}" fill="${PALETTE.aquaGlow}" opacity="0.5" filter="url(#blur-4)"/>
    <path d="${branchAD}" fill="${PALETTE.boltCore}" opacity="0.8"/>
    <path d="${branchBD}" fill="${PALETTE.boltCore}" opacity="0.8"/>
    <path d="${spineD}" fill="${PALETTE.boltCore}" opacity="0.96"/>
    <circle cx="${f(leftEarTip.x)}" cy="${f(leftEarTip.y)}" r="96" fill="url(#spark)"/>
  </g>`;
}

function wallpaper({ withBolt }) {
  const reflectionScale = 0.32;
  const reflectionY = HORIZON + 14 + (catBox.y + catBox.h) * reflectionScale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>OmO Nightsea${withBolt ? " - moon cat with lightning" : " - calm moon cat"}</title>
  <defs>
    <radialGradient id="halo" cx="${CAT_CENTER.x}" cy="${CAT_CENTER.y}" r="${f(CAT_WIDTH * 1.4)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PALETTE.aquaGlow}" stop-opacity="${withBolt ? 0.16 : 0.11}"/>
      <stop offset="0.4" stop-color="${PALETTE.aqua}" stop-opacity="${withBolt ? 0.07 : 0.05}"/>
      <stop offset="1" stop-color="${PALETTE.aqua}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="spark" r="0.5">
      <stop offset="0" stop-color="${PALETTE.boltCore}" stop-opacity="0.55"/>
      <stop offset="0.35" stop-color="${PALETTE.aquaGlow}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${PALETTE.aquaGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="star-glow" r="0.5">
      <stop offset="0" stop-color="${PALETTE.plate}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${PALETTE.plate}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="streak" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${PALETTE.plate}" stop-opacity="0"/>
      <stop offset="0.5" stop-color="${PALETTE.plate}" stop-opacity="1"/>
      <stop offset="1" stop-color="${PALETTE.plate}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bolt-fade-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000"/>
      <stop offset="0.12" stop-color="#fff"/>
    </linearGradient>
    <mask id="bolt-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
      <rect x="0" y="0" width="${W}" height="${H}" fill="url(#bolt-fade-gradient)"/>
    </mask>
    <linearGradient id="reflection-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="reflection-mask" maskUnits="userSpaceOnUse" x="0" y="${HORIZON}" width="${W}" height="${H - HORIZON}">
      <rect x="0" y="${HORIZON}" width="${W}" height="220" fill="url(#reflection-fade)"/>
    </mask>
    <filter id="blur-1" x="-5%" y="-50%" width="110%" height="200%"><feGaussianBlur stdDeviation="0.8"/></filter>
    <filter id="blur-4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="blur-9" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="blur-26" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="blur-44" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="44"/></filter>
    <filter id="blur-60" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="60"/></filter>
  </defs>

  <!-- 1. atmosphere: float-rendered, dithered raster (sky, sea, shafts, haze, vignette, grain) -->
  <rect width="${W}" height="${H}" fill="${PALETTE.surface}"/>
  <image href="${BASE_NAME}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
  <rect x="0" y="${HORIZON}" width="${W}" height="1" fill="${PALETTE.aqua}" fill-opacity="0.10"/>

  <!-- 2. moon reflection: mirrored, squashed, blurred silhouette under the horizon -->
  <g mask="url(#reflection-mask)" opacity="0.10">
    <g transform="translate(0 ${f(reflectionY)}) scale(1 -${reflectionScale}) translate(0 -${f(catBox.y + catBox.h)})">
      <g transform="translate(${f(catTx)} ${f(catTy)}) scale(${f(catScale)})">
        <path d="${OUTER_D}" fill="${PALETTE.plate}" filter="url(#blur-60)"/>
      </g>
    </g>
  </g>

  <!-- 3. sea ripples and the moon path under the cat -->
  <g id="ripples">
    ${ripples()}
  </g>
  <g id="moon-path" filter="url(#blur-1)">
    ${moonPath()}
  </g>

  <!-- 4. stars, upper right only -->
  <g id="stars">
    ${stars()}
  </g>

  <!-- 5. halo, rim glow, lightning and the moon cat -->
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <g transform="translate(${f(catTx)} ${f(catTy)}) scale(${f(catScale)})">
    <path d="${OUTER_D}" fill="${PALETTE.aquaGlow}" opacity="${withBolt ? 0.22 : 0.16}" filter="url(#blur-44)"/>
  </g>
  ${withBolt ? bolt() : ""}
  <g id="cat" transform="translate(${f(catTx)} ${f(catTy)}) scale(${f(catScale)})">
    ${catGroup("omo-cat-moon")}
  </g>
</svg>
`;
}

const outputs = [
  { svg: join(ART, "omo-cat-moon.svg"), text: catMoonSvg },
  { svg: join(ART, "wallpaper-nightsea-cat.svg"), text: wallpaper({ withBolt: true }), png: join(BACKGROUNDS, "01-nightsea-cat.png") },
  { svg: join(ART, "wallpaper-nightsea-calm.svg"), text: wallpaper({ withBolt: false }), png: join(BACKGROUNDS, "02-nightsea-calm.png") },
];

buildBaseRaster();
console.log(`wrote ${join(ART, BASE_NAME)}`);
for (const out of outputs) {
  writeFileSync(out.svg, out.text);
  console.log(`wrote ${out.svg}`);
}

if (process.argv.includes("--render")) {
  mkdirSync(BACKGROUNDS, { recursive: true });
  for (const out of outputs.filter((o) => o.png)) {
    const result = spawnSync("rsvg-convert", ["-w", String(W), "-h", String(H), out.svg, "-o", out.png], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`rsvg-convert failed for ${out.svg}`);
    console.log(`rendered ${out.png}`);
  }
}
