#!/usr/bin/env bun
// Builds the v3 "OmO day" wallpaper set: the icon becomes the desktop.
//
//   bun art/build-wallpapers-v3.mjs            # backgrounds/01-omo-day.png, preview.png, unlock.png, preview-unlock.png
//   bun art/build-wallpapers-v3.mjs --no-plymouth
//
// Contract: docs/DESIGN-v3.md "Wallpaper": bright icon tone over a softened Nightsea backdrop, the
// plate-white official cat plus small decorative cats with expression-only variation (sleeping,
// peeking, stretching), the left third (x < 900) calm for terminals. Storm (02) and open sea (03)
// stay as they are; 04-nightsea-calm.png is the v2 default kept as a variant.
//
// Pipeline (same technique as art/build-wallpapers.mjs, reduced): the backdrop is a float raster
// (sky gradient, faint nebulosity, thin high cloud, three star magnitudes, the moon halo, sea with
// a wobbling reflection and the glitter path, vignette, grain), TPDF-dithered before the 8-bit
// store, written through ImageMagick as PNG24 without date/tIME chunks. The cats are vector: the
// verbatim icon geometry from art/build-faces.mjs, composed over the backdrop by rsvg. Every
// intermediate lives in a temp dir; only the four deliverables are written into the repository.
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ICON, TOKENS, PLATE_M, catMarkup, boltMarkup, pathD, compose, translate, scale, rotate, fmt } from "./build-faces.mjs";

const ART = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(ART);
const BACKGROUNDS = join(ROOT, "backgrounds");
const ARGS = process.argv.slice(2);
const PLYMOUTH = !ARGS.includes("--no-plymouth");

// Tokens. colors.toml names in the comments; the cats use TOKENS from build-faces.mjs.
const PALETTE = {
  ink: "#041617", // darker_background
  inkDark: "#071416", // dark_background
  surface: "#0B1B1D", // background
  lifted: "#12292C", // lighter_background
  muted: "#3B5658", // muted
  horizonSky: "#0F2A2C",
  horizonSea: "#0C2426",
  plate: "#F4F4F4", // bright_foreground
  aqua: "#7FE0D4", // accent
  aquaGlow: "#9CF0FF", // bright_cyan
};

// Composition (2560x1440). The big cat is the moon; the small cats are placed on the right two
// thirds only. CALM_EDGE keeps x < 900 free of cats, halo and glitter.
const W = 2560;
const H = 1440;
const HORIZON = 1010;
const CALM_EDGE = 900;
const BIG = { x: 1790, y: 560, width: 560 };
// The crew: head width in px and an expression from build-faces.mjs. "peek" hides behind the big
// cat's right cheek (drawn under it) and looks at it; "sleep" and "yawn" (stretching) sit on the
// water line, chins just below the horizon, one on each side of the glitter path.
const SMALL = [
  { name: "peek", x: 2104, y: 690, width: 176, expression: "peek-left", rot: 10, behind: true },
  { name: "sleep", x: 1345, width: 132, expression: "sleep", onWater: true },
  { name: "yawn", x: 2330, width: 112, expression: "yawn", rot: -5, onWater: true },
];
// Water-line cats: the chin sits 2 px under the horizon, so the head rests on the line.
const REFLECTION = { opacity: 0.2, blur: 2.5 };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const C = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hex(v)]));

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

const noise = { cloud: makePerlin(0x11), warp: makePerlin(0x23), sea: makePerlin(0x41), neb: makePerlin(0x61) };

// ---------------------------------------------------------------------------
// Raster I/O through ImageMagick. No date/tIME chunks: a rebuild must be byte-identical.
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "omo-day-"));
const tmpPath = (name) => join(TMP, name);
const PNG_DEFINES = ["-define", "png:compression-level=9", "-define", "png:exclude-chunks=date,time"];

function run(cmd, args, what) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${what}`);
}
function writeRaster(pngPath, w, h, bytes, channels) {
  const header = channels === 4 ? `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n` : `P6\n${w} ${h}\n255\n`;
  const tmp = tmpPath(`raster-${w}x${h}-${channels}.${channels === 4 ? "pam" : "ppm"}`);
  writeFileSync(tmp, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]));
  run("magick", [tmp, ...PNG_DEFINES, `${channels === 4 ? "PNG32" : "PNG24"}:${pngPath}`], `encode ${pngPath}`);
  rmSync(tmp, { force: true });
}
function renderSvg(svgPath, pngPath, w, h) {
  run("rsvg-convert", ["-w", String(w), "-h", String(h), svgPath, "-o", pngPath], `render ${svgPath}`);
}

// ---------------------------------------------------------------------------
// Backdrop raster: the v2 Nightsea, softened. No storm bank, no rays, no lightning: a quiet sky
// with thin high cloud, a wide soft halo around the big cat, stars, and a calm sea with the moon
// glitter path under the cat. Everything that reads as "weather" fades out before CALM_EDGE.
// ---------------------------------------------------------------------------
const HW = W >> 1;
const HH = (HORIZON >> 1) + 4;
const dens = new Float32Array(HW * HH);
function buildClouds() {
  const FREQ = 1 / 520;
  for (let hy = 0; hy < HH; hy++) {
    const y = hy * 2;
    const bx = CALM_EDGE + 150 + 260 * noise.warp(y * 0.0025 + 7.7, 3.3);
    // Two thin high-cloud bands, one above the cat and one low near the horizon.
    const bands = 0.55 * Math.exp(-(((y - 300) / 150) ** 2)) + 0.45 * Math.exp(-(((y - 900) / 70) ** 2));
    for (let hx = 0; hx < HW; hx++) {
      const x = hx * 2;
      const nx = x * FREQ * 0.55;
      const ny = y * FREQ * 2.4;
      const qx = fbm(noise.warp, nx, ny, 3);
      const qy = fbm(noise.warp, nx + 5.2, ny + 1.3, 3);
      const v = fbm01(noise.cloud, nx + 0.4 * qx, ny + 0.4 * qy, 5);
      const cx = (x - BIG.x) / 420;
      const cy = (y - BIG.y) / 330;
      const clearing = 1 - 0.85 * Math.exp(-(cx * cx + cy * cy));
      const cov = clamp01(smoothstep(bx - 400, bx + 400, x) * bands * clearing);
      dens[hy * HW + hx] = 0.55 * smoothstep(0.62 - 0.3 * cov, 0.9 - 0.2 * cov, v) * Math.min(1, cov * 1.5);
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

// Cat exclusion for stars: no star behind or right next to any cat.
const catZones = [{ x: BIG.x, y: BIG.y, r: BIG.width * 0.62 }, ...SMALL.map((c) => ({ x: c.x, y: c.y, r: c.width * 0.8 }))];
const nearCat = (x, y) => catZones.some((z) => Math.hypot(x - z.x, y - z.y) < z.r);

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
      if (nearCat(x, y)) continue;
      const rr = Math.hypot(x - BIG.x, y - BIG.y);
      const wash = 1 - 0.8 * Math.exp(-rr / 380);
      stars.push({ x, y, r: lerp(rMin, rMax, rng()), i: lerp(iMin, iMax, rng()) * (1 - d * 2.5) * wash, tint: rng() < 0.3, glow });
      n++;
    }
  };
  add(1000, 0.55, 1.0, 0.1, 0.32, false);
  add(150, 1.0, 1.7, 0.3, 0.6, false);
  add(16, 1.8, 2.6, 0.7, 1.0, true);
  return stars;
}

const sky = new Float32Array(W * HORIZON * 3);
const seaBuf = new Float32Array(W * (H - HORIZON) * 3);

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
      const rx = x - BIG.x;
      const ry = y - BIG.y;
      const rr = Math.sqrt(rx * rx + ry * ry);
      const moonL = Math.exp(-rr / 600);
      const nebWin = smoothstep(120, 420, x);
      if (nebWin > 0) {
        const neb = fbm01(noise.neb, x / 1200 + 2.2, y / 450 + 1.1, 3);
        mixTo(C.lifted, 0.09 * neb * nebWin);
        mixTo(C.muted, 0.02 * neb * neb * nebWin);
      }
      if (d > 0.001) {
        const a = d * 0.9;
        const body = [lerp(lerp(g0, C.lifted[0], 0.85), C.muted[0], moonL * 0.7), lerp(lerp(g1, C.lifted[1], 0.85), C.muted[1], moonL * 0.7), lerp(lerp(g2, C.lifted[2], 0.85), C.muted[2], moonL * 0.7)];
        col[0] = lerp(col[0], body[0], a);
        col[1] = lerp(col[1], body[1], a);
        col[2] = lerp(col[2], body[2], a);
      }
      // Wide, soft halo: the cat is the light of the scene. Fades out toward the calm edge.
      const haloWin = smoothstep(CALM_EDGE - 400, CALM_EDGE + 300, x);
      const halo = 0.2 * Math.exp(-rr / 260) + 0.1 * Math.exp(-rr / 820);
      mixTo(C.aquaGlow, Math.min(1, halo * (1 + 0.6 * d)) * haloWin);
      mixTo(C.aqua, 0.08 * hzSky * Math.exp(-(((x - BIG.x) / 900) ** 2)));
      sky[idx] = col[0];
      sky[idx + 1] = col[1];
      sky[idx + 2] = col[2];
    }
  }
}

function buildSea() {
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
    const reflW = 0.4 * Math.pow(1 - t, 1.6);
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
      const glitWin = smoothstep(CALM_EDGE - 200, CALM_EDGE + 400, x);
      const gl = Math.exp(-2 * (((x - BIG.x) / hw) ** 2));
      const sp = n01(noise.sea, x * (0.075 - 0.045 * t) + 200, y * (0.6 - 0.25 * t) + 11);
      const sp2 = n01(noise.sea, x * 0.16 + 300, y * 1.1 + 90);
      const sparkle = smoothstep(0.6, 0.9, sp) * (0.55 + 0.45 * smoothstep(0.4, 0.8, sp2));
      const glitter = gl * (sparkle * 0.5 + 0.1) * Math.pow(1 - t, 0.8) * (0.5 + 0.5 * streak);
      mixTo(lerp3(C.aquaGlow, C.plate, sparkle), Math.min(1, glitter * 0.8) * glitWin);
      mixTo(C.aquaGlow, 0.1 * Math.exp(-(((x - BIG.x) / (150 + 320 * t)) ** 2)) * Math.pow(1 - t, 2.2) * (0.7 + 0.3 * streak) * glitWin);
      const rip = noise.sea(x * 0.015 + 500, y * 0.8 + 5) * 0.05 * (1 - t);
      col[0] += C.aqua[0] * rip;
      col[1] += C.aqua[1] * rip;
      col[2] += C.aqua[2] * rip;
      mixTo(C.aqua, 0.08 * hzSea * Math.exp(-(((x - BIG.x) / 800) ** 2)));
      const idx = ((y - HORIZON) * W + x) * 3;
      seaBuf[idx] = col[0];
      seaBuf[idx + 1] = col[1];
      seaBuf[idx + 2] = col[2];
    }
  }
}

function writeBase(pngPath) {
  const rgb = new Uint8Array(W * H * 3);
  const rng = mulberry32(0x4e696768);
  const gaussian = () => {
    const u = 1 - rng();
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const grainSigma = 2.0 / 255;
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
        const a = 0.4 * clamp01((vd - 0.5) / 0.5);
        r = lerp(r, C.ink[0], a);
        g = lerp(g, C.ink[1], a);
        b = lerp(b, C.ink[2], a);
      }
      if (x < 240) {
        const a = 0.18 * (1 - smoothstep(0, 240, x));
        r = lerp(r, C.ink[0], a);
        g = lerp(g, C.ink[1], a);
        b = lerp(b, C.ink[2], a);
      }
      if (y === HORIZON) {
        r = lerp(r, C.aqua[0], 0.08);
        g = lerp(g, C.aqua[1], 0.08);
        b = lerp(b, C.aqua[2], 0.08);
      }
      const grain = gaussian() * grainSigma;
      const dither = (rng() + rng() - 1) / 255;
      rgb[o++] = Math.round(clamp01(r + grain + dither) * 255);
      rgb[o++] = Math.round(clamp01(g + grain + dither) * 255);
      rgb[o++] = Math.round(clamp01(b + grain + dither) * 255);
    }
  }
  writeRaster(pngPath, W, H, rgb, 3);
}

// ---------------------------------------------------------------------------
// Vector cats. Canvas (1024) -> frame: the head is `width` px wide with its centre at (x, y).
// ---------------------------------------------------------------------------
const hb = ICON.headBox;
const headHeight = (width) => (width * hb.h) / hb.w;
const catY = (cat) => (cat.onWater ? HORIZON + 2 - headHeight(cat.width) / 2 : cat.y);
function catAt(cat) {
  const s = cat.width / hb.w;
  return compose(translate(cat.x, catY(cat)), rotate(cat.rot ?? 0), scale(s), translate(-hb.cx, -hb.cy));
}
function catGroup(cat) {
  const M = catAt(cat);
  const parts = catMarkup({ M, tone: "plate-on-ink", expression: cat.expression });
  const out = [];
  if (cat.onWater) {
    // Faint reflection: the head mirrored about the horizon, blurred, clipped to the sea.
    const chin = HORIZON + 2;
    out.push(
      `<g clip-path="url(#sea)" transform="translate(0 ${fmt(2 * chin)}) scale(1 -1)" opacity="${REFLECTION.opacity}" filter="url(#reflection-blur)">\n    ${parts.join("\n    ")}\n  </g>`,
    );
  }
  out.push(`<g id="cat-${cat.name}">\n    ${parts.join("\n    ")}\n  </g>`);
  return out.join("\n  ");
}
function wallpaperSvg(basePng) {
  const big = { name: "moon", x: BIG.x, y: BIG.y, width: BIG.width, expression: "official" };
  const behind = SMALL.filter((c) => c.behind);
  const front = SMALL.filter((c) => !c.behind);
  // An ink gap between a hidden cat and the big cat's plate, so the two white shapes never merge:
  // the big silhouette stroked in ink, clipped to the hidden cats' own silhouettes.
  const gap = behind.length
    ? `<path fill="none" stroke="${TOKENS.ink}" stroke-width="16" clip-path="url(#behind)" d="${pathD([ICON.outer], catAt(big))}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>OmO day - the plate-white cat over the Nightsea with its small crew</title>
  <defs>
    <clipPath id="sea"><rect x="0" y="${HORIZON}" width="${W}" height="${H - HORIZON}"/></clipPath>
    <clipPath id="behind">${behind.map((c) => `<path d="${pathD([ICON.outer], catAt(c))}"/>`).join("")}</clipPath>
    <filter id="reflection-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${REFLECTION.blur}"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${PALETTE.surface}"/>
  <image href="${basePng}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
  ${behind.map(catGroup).join("\n  ")}
  ${gap}
  ${catGroup(big)}
  ${front.map(catGroup).join("\n  ")}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Plymouth: unlock.png (800x500 RGBA) is the sleeping face on the squircle plate over a soft
// dithered halo; omarchy-plymouth-set streams it in as logo.png and draws it 1:1 centred, with
// the password entry 40px below its bottom edge. preview-unlock.png mirrors that boot screen at
// 1920x1080 on colors.toml's background (#0B1B1D), the colour omarchy-plymouth-set-by-theme applies.
// ---------------------------------------------------------------------------
function renderPlymouth() {
  const UW = 800;
  const UH = 500;
  const PLATE = 380;
  const px = (UW - PLATE) / 2;
  const py = (UH - PLATE) / 2 - 10;
  const halo = new Uint8Array(UW * UH * 4);
  const rng = mulberry32(0x706c796d);
  for (let y = 0, o = 0; y < UH; y++) {
    for (let x = 0; x < UW; x++, o += 4) {
      const d = Math.hypot((x - UW / 2) / 300, (y - (py + PLATE / 2)) / 260);
      const edge = smoothstep(0, 80, Math.min(x, y, UW - 1 - x, UH - 1 - y));
      const a = (0.16 * Math.exp(-2.2 * d * d) + 0.06 * Math.exp(-0.85 * d * d)) * edge;
      const dc = (rng() + rng() - 1) / 255;
      const da = (rng() - 0.5) / 255;
      halo[o] = Math.round(clamp01(C.aquaGlow[0] + dc) * 255);
      halo[o + 1] = Math.round(clamp01(C.aquaGlow[1] + dc) * 255);
      halo[o + 2] = Math.round(clamp01(C.aquaGlow[2] + dc) * 255);
      halo[o + 3] = Math.round(clamp01(a + da) * 255);
    }
  }
  const haloPath = tmpPath("halo.png");
  writeRaster(haloPath, UW, UH, halo, 4);
  const M = compose(translate(px, py), scale(PLATE / 64), PLATE_M);
  const faceSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UW} ${UH}" width="${UW}" height="${UH}">
  <path fill="${TOKENS.plate}" d="${pathD(ICON.plate, M)}"/>
  ${catMarkup({ M, tone: "ink-on-plate", expression: "sleep" }).join("\n  ")}
</svg>`;
  const faceSvgPath = tmpPath("unlock-face.svg");
  const facePngPath = tmpPath("unlock-face.png");
  writeFileSync(faceSvgPath, faceSvg);
  renderSvg(faceSvgPath, facePngPath, UW, UH);
  const unlockPath = join(ROOT, "unlock.png");
  run("magick", [haloPath, facePngPath, "-composite", ...PNG_DEFINES, `PNG32:${unlockPath}`], "write unlock.png");

  const previewPath = join(ROOT, "preview-unlock.png");
  const logoX = (1920 - UW) / 2;
  const logoY = (1080 - UH) / 2;
  const entryY = logoY + UH + 40;
  const unlockData = readFileSync(unlockPath).toString("base64");
  const previewSvgPath = tmpPath("preview-unlock.svg");
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
  return [unlockPath, previewPath];
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
const t0 = Date.now();
const lap = (label) => console.log(`${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
try {
  buildClouds();
  buildSky();
  lap("sky");
  buildSea();
  lap("sea");
  const basePng = tmpPath("omo-day-base.png");
  writeBase(basePng);
  lap("backdrop raster");

  mkdirSync(BACKGROUNDS, { recursive: true });
  const svgPath = tmpPath("omo-day.svg");
  writeFileSync(svgPath, wallpaperSvg(basePng));
  const dayPng = join(BACKGROUNDS, "01-omo-day.png");
  const dayRaw = tmpPath("omo-day-raw.png");
  renderSvg(svgPath, dayRaw, W, H);
  run("magick", [dayRaw, ...PNG_DEFINES, `PNG24:${dayPng}`], "write 01-omo-day.png");
  lap(`rendered ${dayPng}`);

  run("magick", [dayPng, "-filter", "Lanczos", "-resize", "1600x900", ...PNG_DEFINES, `PNG24:${join(ROOT, "preview.png")}`], "write preview.png");
  lap(`rendered ${join(ROOT, "preview.png")}`);

  if (PLYMOUTH) {
    const [unlockPath, previewPath] = renderPlymouth();
    lap(`rendered ${unlockPath} and ${previewPath}`);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
