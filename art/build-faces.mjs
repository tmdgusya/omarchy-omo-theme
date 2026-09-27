#!/usr/bin/env bun
// Builds the v3 face asset set from the official OmO icon.
//
//   bun art/build-faces.mjs            # writes plugin/assets/face/*.svg (deterministic; stale omo-*.svg are removed)
//
// Contract: docs/DESIGN-v3.md "Faces". Every asset keeps the icon's silhouette, ear lines and inner
// hood monoline verbatim (the glyph's own cubics, re-based into the 64 box); only the eyes and the
// mouth change per state, and ultrawork adds one cute aqua bolt at the right ear.
//
//   omo-face-<state>.svg      viewBox 0 0 64 64: the icon's squircle plate with the ink head on it
//   omo-head-<state>.svg      viewBox 0 0 64 64, transparent: plate head with ink lines, for dark backdrops
//   omo-face-run-<1..4>.svg   the working run cycle on the plate (contact, recoil, passing, apex)
//   omo-ws-<state>.svg        viewBox 0 0 16 16: ring markers for workspaces
//
// Legibility rule (contract): at 20 logical px = 32 physical px the ring eyes keep an inner hole
// >= 3 px and the m keeps its two humps. The icon's own eyes (hole 97 / ring 18 canvas px) and its
// filled m (14 px strokes) collapse there, so the v3 expressions are redrawn in the same vocabulary
// at a 26 canvas px line: rings hole 104 / ring 26 (4.0 / 1.0 px at 32 px), pushed 10 px outward
// so the m clears them, and the m as a stroked two-hump path 104 px wide (humps 2 px apart at 32 px).
//
// The module is also imported by art/build-wallpapers-v3.mjs (icon geometry, expressions, cat markup).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ART = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(ART);
export const FACE_DIR = join(ROOT, "plugin", "assets", "face");

// Tokens (docs/DESIGN-v3.md). Nothing else is used.
export const TOKENS = {
  plate: "#F4F4F4",
  ink: "#041617",
  aqua: "#7FE0D4",
  coral: "#F08A8A",
  muted: "#5F7A7B",
};

export const FACE_STATES = ["idle", "sleep", "working", "ultrawork", "waiting", "done", "error"];
export const HEAD_STATES = ["idle", "sleep", "waiting", "done", "error"];
export const WS_STATES = ["empty", "active", "occupied", "urgent"];

// ---------------------------------------------------------------------------
// Geometry. Segments: {type:"M"|"L"|"C"|"Q"|"Z", pt, c1, c2}; a subpath is {segments}.
// Affines use the SVG matrix order [a, b, c, d, e, f].
// ---------------------------------------------------------------------------
export const fmt = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return (r === 0 ? 0 : r).toString();
};
export const IDENTITY = [1, 0, 0, 1, 0, 0];
export const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const rotate = (deg) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
// compose(A, B, C) applies C first, then B, then A: the same order as transform="A B C".
export const compose = (...ms) =>
  ms.reduce((A, B) => [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ]);
export const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
// Length factor of an affine (geometric mean of its axis scales); stroke widths follow it.
export const lengthScale = (M) => Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));

const seg = {
  M: (x, y) => ({ type: "M", pt: [x, y] }),
  L: (x, y) => ({ type: "L", pt: [x, y] }),
  C: (x1, y1, x2, y2, x, y) => ({ type: "C", c1: [x1, y1], c2: [x2, y2], pt: [x, y] }),
  Q: (x1, y1, x, y) => ({ type: "Q", c1: [x1, y1], pt: [x, y] }),
  Z: () => ({ type: "Z" }),
};

function transformSegment(s, M) {
  const out = { type: s.type };
  if (s.pt) out.pt = apply(M, s.pt);
  if (s.c1) out.c1 = apply(M, s.c1);
  if (s.c2) out.c2 = apply(M, s.c2);
  return out;
}
export const transformSubpaths = (subpaths, M) => subpaths.map((sp) => ({ segments: sp.segments.map((s) => transformSegment(s, M)) }));

export function pathD(subpaths, M = IDENTITY) {
  const P = (p) => {
    const q = apply(M, p);
    return `${fmt(q[0])} ${fmt(q[1])}`;
  };
  return subpaths
    .map((sp) =>
      sp.segments
        .map((s) => {
          if (s.type === "M") return `M${P(s.pt)}`;
          if (s.type === "L") return `L${P(s.pt)}`;
          if (s.type === "C") return `C${P(s.c1)} ${P(s.c2)} ${P(s.pt)}`;
          if (s.type === "Q") return `Q${P(s.c1)} ${P(s.pt)}`;
          return "Z";
        })
        .join(" "),
    )
    .join(" ");
}

// Absolute/relative M, L, C, Z path data -> subpaths, mapping every coordinate through `map`.
function parsePath(d, map = (p) => p) {
  const tokens = d.replace(/\s+/g, " ").trim().match(/[MmCcLlZz]|-?\d*\.?\d+/g);
  const subpaths = [];
  let current = null;
  let cmd = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[MmCcLlZz]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        current.segments.push(seg.Z());
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
      current = { segments: [{ type: "M", pt: map([x, y]) }] };
      subpaths.push(current);
      cmd = cmd === "m" ? "l" : "L";
    } else if (cmd === "C" || cmd === "c") {
      const rel = cmd === "c";
      const n = [num(), num(), num(), num(), num(), num()];
      const c1 = rel ? [x + n[0], y + n[1]] : [n[0], n[1]];
      const c2 = rel ? [x + n[2], y + n[3]] : [n[2], n[3]];
      const end = rel ? [x + n[4], y + n[5]] : [n[4], n[5]];
      current.segments.push({ type: "C", c1: map(c1), c2: map(c2), pt: map(end) });
      [x, y] = end;
    } else if (cmd === "L" || cmd === "l") {
      const nx = num();
      const ny = num();
      x = cmd === "l" ? x + nx : nx;
      y = cmd === "l" ? y + ny : ny;
      current.segments.push({ type: "L", pt: map([x, y]) });
    } else {
      throw new Error(`unsupported path command ${cmd}`);
    }
  }
  return subpaths;
}

// Tight bounding box of subpaths (curves sampled), optionally through an affine.
export function bbox(subpaths, M = IDENTITY) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = ([px, py]) => {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  };
  for (const sp of subpaths) {
    let prev = null;
    for (const s of sp.segments) {
      if (s.type === "M" || s.type === "L") {
        prev = apply(M, s.pt);
        add(prev);
      } else if (s.type === "C" || s.type === "Q") {
        const c1 = apply(M, s.c1);
        const c2 = s.type === "C" ? apply(M, s.c2) : c1;
        const pt = apply(M, s.pt);
        for (let k = 1; k <= 24; k++) {
          const t = k / 24;
          const u = 1 - t;
          add(
            s.type === "C"
              ? [
                  u * u * u * prev[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * pt[0],
                  u * u * u * prev[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * pt[1],
                ]
              : [u * u * prev[0] + 2 * u * t * c1[0] + t * t * pt[0], u * u * prev[1] + 2 * u * t * c1[1] + t * t * pt[1]],
          );
        }
        prev = pt;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

const KAPPA = 0.5522847498;
export function circle(cx, cy, r) {
  const k = KAPPA * r;
  return {
    segments: [
      seg.M(cx + r, cy),
      seg.C(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
      seg.C(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
      seg.C(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
      seg.C(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
      seg.Z(),
    ],
  };
}

// ---------------------------------------------------------------------------
// The reference icon (1024 canvas). The plate is absolute path data; the glyph nests in
// scale(0.5) translate(0,2048) scale(0.05,-0.05), so X = 0.025x and Y = 1024 - 0.025y.
// Glyph subpaths, in file order: 0 outer head + inner hood contour, 1/2 ear lines, 3 face oval,
// 4/5 ring eye outers, 6 the m, 7/8 ring eye inners.
// ---------------------------------------------------------------------------
export const ICON = loadIcon();

function loadIcon() {
  const svg = readFileSync(join(ART, "reference", "omo-icon-light.svg"), "utf8");
  const plateMatch = svg.match(/<path fill="#F4F4F4" d="([^"]+)"/);
  const glyphMatch = svg.match(/<path fill="#041617" fill-rule="evenodd" d="([^"]+)"/);
  if (!plateMatch || !glyphMatch) throw new Error("reference icon paths not found");
  const plate = parsePath(plateMatch[1]);
  const glyph = parsePath(glyphMatch[1], ([x, y]) => [x * 0.025, 1024 - y * 0.025]);
  if (glyph.length !== 9) throw new Error(`expected 9 glyph subpaths, got ${glyph.length}`);
  const [head, earL, earR, face, eyeLo, eyeRo, mouth] = glyph;
  const outer = outerSilhouette(head);
  const eyeL = bbox([eyeLo]);
  const eyeR = bbox([eyeRo]);
  const mouthBox = bbox([mouth]);
  return {
    plate,
    plateBox: bbox(plate),
    glyph,
    eyeless: [head, earL, earR, face],
    outer,
    headBox: bbox([outer]),
    mouth,
    // Where the icon puts its own features: the face vocabulary is drawn around these points.
    anatomy: {
      eyeL: [eyeL.cx, (eyeL.cy + eyeR.cy) / 2],
      eyeR: [eyeR.cx, (eyeL.cy + eyeR.cy) / 2],
      mouth: [mouthBox.cx, mouthBox.cy],
      earTipL: head.segments[0].pt,
    },
  };
}

// Subpath 0 walks the outer head, curls inward at the left chin tip, traces the inner hood
// contour and returns via the right chin tip (layout M C* L L C* L L C* Z). Keeping only the
// two outer C* runs and bridging the chin tips yields the closed outer silhouette.
function outerSilhouette(head) {
  const segs = head.segments;
  const lineIdx = segs.map((s, idx) => (s.type === "L" ? idx : -1)).filter((idx) => idx >= 0);
  if (lineIdx.length !== 4) throw new Error(`expected 4 chin line segments, got ${lineIdx.length}`);
  const leftTipEnd = lineIdx[1];
  const rightTipEnd = lineIdx[3];
  return { segments: [...segs.slice(0, leftTipEnd + 1), { type: "L", pt: segs[rightTipEnd].pt }, ...segs.slice(rightTipEnd + 1)] };
}

// ---------------------------------------------------------------------------
// Expressions (canvas units). A mark is {kind:"fill"|"stroke", subpaths, w?, base?}: fills and
// strokes are drawn in the line colour, `base` fills in the head colour (the holes of the rings).
// ---------------------------------------------------------------------------
export const LINE = 26; // one line weight for every mark: 1.0 px at 32 px on the face plate
export const EYE = { ri: 52, ro: 78 }; // hole 104 canvas px = 4.0 px at 32 px; ring 26
export const EYE_SPREAD = 10; // rings sit 10 canvas px further out than the icon's, so the m clears them
// The m: three round-capped stems joined by two half-circle humps, 104 wide, 58 tall, centred a
// little lower than the icon's filled m (its top would otherwise touch the larger rings).
export const M_SHAPE = { w: 120, h: 58, cy: 622 };

const fill = (subpath, base = false) => ({ kind: "fill", subpaths: [subpath], base });
const stroke = (segments, w = LINE) => ({ kind: "stroke", subpaths: [{ segments }], w });

// Ring eye: outer disc in the line colour, hole in the head colour; the hole may look around.
export const ring = ([cx, cy], ri, ro, holeDx = 0, holeDy = 0) => [fill(circle(cx, cy, ro)), fill(circle(cx + holeDx, cy + holeDy, ri), true)];
const bar = ([cx, cy], len) => stroke([seg.M(cx - len / 2, cy), seg.L(cx + len / 2, cy)]);
// Happy arc (^): a hump over the eye centre.
const arc = ([cx, cy], len, rise) => stroke([seg.M(cx - len / 2, cy + rise * 0.35), seg.C(cx - len / 5, cy - rise * 1.25, cx + len / 5, cy - rise * 1.25, cx + len / 2, cy + rise * 0.35)]);
// Chevron pointing to +x when dir = 1 (">"), to -x when dir = -1 ("<").
const chevron = ([cx, cy], dir, size) => stroke([seg.M(cx - dir * size * 0.5, cy - size), seg.L(cx + dir * size * 0.5, cy), seg.L(cx - dir * size * 0.5, cy + size)]);
// Half circle from (xa, y) over the top to (xb, y), as two quarter cubics (affine-safe).
function hump(xa, xb, y) {
  const r = (xb - xa) / 2;
  const k = KAPPA * r;
  const xm = xa + r;
  return [seg.C(xa, y - k, xm - k, y - r, xm, y - r), seg.C(xm + k, y - r, xb, y - k, xb, y)];
}
// Stroked m around (cx, cy): stems at cx - w/2, cx, cx + w/2 from the hump line down to the base.
function mStroke([cx, cy], { w, h } = M_SHAPE) {
  const r = w / 4;
  const top = cy - h / 2 + r;
  const base = cy + h / 2;
  const x1 = cx - w / 2;
  const x3 = cx + w / 2;
  return stroke([seg.M(x1, base), seg.L(x1, top), ...hump(x1, cx, top), seg.L(cx, base), seg.M(cx, top), ...hump(cx, x3, top), seg.L(x3, base)]);
}
const scaleAbout = (subpath, [cx, cy], s) => transformSubpaths([subpath], compose(translate(cx, cy), scale(s), translate(-cx, -cy)))[0];

export function expression(name, { eye = EYE, mScale = 1 } = {}) {
  const { eyeL, eyeR, mouth } = ICON.anatomy;
  const L = [eyeL[0] - EYE_SPREAD, eyeL[1]];
  const R = [eyeR[0] + EYE_SPREAD, eyeR[1]];
  const both = (fn) => [...fn(L, 1), ...fn(R, -1)];
  const mCentre = [mouth[0], M_SHAPE.cy];
  const m = () => {
    const mk = mStroke(mCentre);
    return [mScale === 1 ? mk : { ...mk, subpaths: [scaleAbout(mk.subpaths[0], mCentre, mScale)], w: mk.w * mScale }];
  };
  const lid = 12; // closed lids sit a little below the ring centre
  switch (name) {
    case "idle":
    case "working":
    case "ultrawork":
      return [...both((c) => ring(c, eye.ri, eye.ro)), ...m()];
    case "sleep":
      return [...both((c) => [bar([c[0], c[1] + lid], 130)]), ...m()];
    case "waiting":
      // rings looking up: ring raised, hole raised further; small o mouth
      return [...both((c) => ring([c[0], c[1] - 16], eye.ri, eye.ro, 0, -6)), ...ring(mCentre, 20, 42)];
    case "done":
      return [...both((c) => [arc([c[0], c[1] + lid], 150, 40)]), ...m()];
    case "error":
      return [...both((c, dir) => [chevron(c, dir, 50)]), ...m()];
    // Wallpaper-only decorative expressions (same eyes/mouth vocabulary).
    case "peek-left":
      return [...both((c) => ring(c, eye.ri, eye.ro, -12, 4)), ...m()];
    case "peek-right":
      return [...both((c) => ring(c, eye.ri, eye.ro, 12, 4)), ...m()];
    case "yawn":
      return [...both((c) => [arc([c[0], c[1] + lid], 150, 40)]), ...ring([mCentre[0], mCentre[1] + 10], 26, 48)];
    default:
      throw new Error(`unknown expression ${name}`);
  }
}

export function marksMarkup(marks, M, lineColor, headColor) {
  return marks.map((mk) => {
    if (mk.kind === "fill") return `<path fill="${mk.base ? headColor : lineColor}" d="${pathD(mk.subpaths, M)}"/>`;
    return `<path fill="none" stroke="${lineColor}" stroke-width="${fmt(mk.w * lengthScale(M))}" stroke-linecap="round" stroke-linejoin="round" d="${pathD(mk.subpaths, M)}"/>`;
  });
}

// One cat head through affine M (canvas -> target units).
//   tone "ink-on-plate": the icon's own look, ink head with plate lines (for use on the plate)
//   tone "plate-on-ink": the inverse, plate head with ink lines (for dark backdrops)
//   expression "official": the untouched glyph (verbatim eyes and m); otherwise a v3 expression
//   backing: also fill the silhouette in the line colour first, so anything drawn under the head
//   (legs) never shows through the hood line
export function catMarkup({ M, tone, expression: name, eye, mScale, backing = false }) {
  const inverse = tone === "plate-on-ink";
  const headColor = inverse ? TOKENS.plate : TOKENS.ink;
  const lineColor = inverse ? TOKENS.ink : TOKENS.plate;
  const parts = [];
  if (inverse || backing) parts.push(`<path fill="${lineColor}" d="${pathD([ICON.outer], M)}"/>`);
  if (name === "official") {
    parts.push(`<path fill="${headColor}" fill-rule="evenodd" d="${pathD(ICON.glyph, M)}"/>`);
  } else {
    parts.push(`<path fill="${headColor}" fill-rule="evenodd" d="${pathD(ICON.eyeless, M)}"/>`);
    parts.push(...marksMarkup(expression(name, { eye, mScale }), M, lineColor, headColor));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Assets.
// ---------------------------------------------------------------------------
const DERIVED_DESC =
  "Derived from the oh-my-openagent OmO icon (https://github.com/code-yeongyu/oh-my-openagent, .github/assets/omo-icon-light.svg); retains the upstream Sustainable Use License 1.0 (see repository LICENSE). Not covered by the plugin code's MIT grant. Generated by art/build-faces.mjs; edit the generator, not this file.";
const ORIGINAL_DESC = "Original shape for the OmO Omarchy plugin; licensed MIT with the plugin code (see repository LICENSE). Generated by art/build-faces.mjs; edit the generator, not this file.";

const svgFile = (size, title, desc, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">\n  <title>${title}</title>\n  <desc>${desc}</desc>\n  ${body.join("\n  ")}\n</svg>\n`;

const FACE_TITLES = {
  idle: "ring eyes and m",
  sleep: "closed eyes and m",
  working: "ring eyes and m (still frame of the run cycle)",
  ultrawork: "ring eyes, m and the bolt at the ear",
  waiting: "rings looking up and a small o",
  done: "happy arcs and m",
  error: "chevrons and m",
};

// The plate fills the 64 box exactly (icon plate 100.5..923.5 -> 0..64).
export const PLATE_M = compose(scale(64 / ICON.plateBox.w), translate(-ICON.plateBox.x, -ICON.plateBox.y));

// The ultrawork bolt: the shape of plugin/assets/omo-bolt.svg (512 box), 19 of the 64 units tall
// (30% of the box), worn on the right ear tip. Rounded corners come from round joins on a same
// colour stroke; an ink monoline around it keeps it a separate object on the ink ear and reads as
// the plate's own line weight at 32 px.
const BOLT_POINTS = [
  [318, 4],
  [64, 300],
  [214, 300],
  [150, 508],
  [452, 184],
  [296, 184],
];
export const BOLT = { height: 17, round: 1.0, outline: 1.0, at: [52, 16.5] }; // 64-box units; `at` is the bolt's centre, on the right ear, inside the plate
export function boltMarkup(M = IDENTITY) {
  const s = BOLT.height / 504;
  const local = compose(translate(BOLT.at[0] - 258 * s, BOLT.at[1] - 256 * s), scale(s));
  const d = pathD([{ segments: [...BOLT_POINTS.map((p, i) => (i === 0 ? seg.M(...p) : seg.L(...p))), seg.Z()] }], compose(M, local));
  const u = lengthScale(M);
  return [
    `<path fill="${TOKENS.ink}" stroke="${TOKENS.ink}" stroke-width="${fmt(2 * (BOLT.round + BOLT.outline) * u)}" stroke-linejoin="round" d="${d}"/>`,
    `<path fill="${TOKENS.aqua}" stroke="${TOKENS.aqua}" stroke-width="${fmt(2 * BOLT.round * u)}" stroke-linejoin="round" d="${d}"/>`,
  ];
}

function faceSvg(state) {
  const body = [`<path fill="${TOKENS.plate}" d="${pathD(ICON.plate, PLATE_M)}"/>`, ...catMarkup({ M: PLATE_M, tone: "ink-on-plate", expression: state })];
  if (state === "ultrawork") body.push(...boltMarkup());
  return svgFile(64, `OmO face, ${state}: ${FACE_TITLES[state]} on the squircle plate`, DERIVED_DESC, body);
}

// Head only: the silhouette fills 62 of the 64 units, centred.
const HEAD_M = (() => {
  const hb = ICON.headBox;
  const s = 62 / hb.w;
  return compose(translate(1 - hb.x * s, (64 - hb.h * s) / 2 - hb.y * s), scale(s));
})();
function headSvg(state) {
  return svgFile(64, `OmO head, ${state}: ${FACE_TITLES[state]}, plate head with ink lines`, DERIVED_DESC, catMarkup({ M: HEAD_M, tone: "plate-on-ink", expression: state }));
}

// Run cycle, derived from plugin/assets/omo-cat-run-{1..4}.svg (684 box, head 0.74 x 0.70 with
// its chin at (346, 544.5)). Everything is expressed relative to that neutral chin: per-frame
// chin bob, tilt and squash, leg vectors and the tail's three points. The head is 44 of the 64
// units wide (0.88 of the still face), the legs are shortened to 0.55 of their v2 length and the
// tail's reach is 0.75, so the whole cycle sits inside the plate; the union of the four frames is
// centred once, so the bob is preserved between frames.
const RUN_FRAMES = [
  { name: "contact", chin: [0, 0], rot: 6, sx: 0.74, sy: 0.7, legs: [[[-56, -30], [-136, 53.5]], [[56, -30], [151, 115.5]]], tail: [[-170, -40], [-340, 14.5], [-328, -125]] },
  { name: "recoil", chin: [-4, 11.5], rot: 5, sx: 0.77, sy: 0.67, legs: [[[-56, -30], [-46, 34]], [[56, -30], [86, 104]]], tail: [[-170, -40], [-340, 19], [-328, -110]] },
  { name: "passing", chin: [6, -16.1], rot: 8, sx: 0.71, sy: 0.73, legs: [[[-56, -30], [19, 87.6]], [[56, -30], [11, 125.6]]], tail: [[-170, -40], [-340, 8.2], [-328, -146]] },
  { name: "apex", chin: [14, -34.5], rot: 10, sx: 0.68, sy: 0.76, legs: [[[-56, -30], [44, 138]], [[56, -30], [-39, 110]]], tail: [[-170, -40], [-340, 1], [-328, -170]] },
];
const RUN = { headWidth: 44, leg: 0.55, tailReach: 0.75, legStroke: 76, tailStroke: 40, chinAnchor: [512, 796] };
const RUN_U = RUN.headWidth / (ICON.headBox.w * RUN_FRAMES[0].sx); // 684-box px -> 64-box units

function runFrameGeometry(frame, origin) {
  const u = RUN_U;
  const chin = [origin[0] + frame.chin[0] * u, origin[1] + frame.chin[1] * u];
  const at = ([dx, dy]) => [chin[0] + dx * u, chin[1] + dy * u];
  const legs = frame.legs.map(([a, b]) => [at(a), at([a[0] + (b[0] - a[0]) * RUN.leg, a[1] + (b[1] - a[1]) * RUN.leg])]);
  const [root, ctrl, tip] = frame.tail.map(([dx, dy], k) => (k === 0 ? at([dx, dy]) : at([root0(frame)[0] + (dx - root0(frame)[0]) * RUN.tailReach, dy])));
  const headM = compose(translate(chin[0], chin[1]), rotate(frame.rot), scale(frame.sx * u, frame.sy * u), translate(-RUN.chinAnchor[0], -RUN.chinAnchor[1]));
  return { chin, legs, tail: [root, ctrl, tip], headM, legStroke: RUN.legStroke * u, tailStroke: RUN.tailStroke * u };
}
const root0 = (frame) => frame.tail[0];

// Union of the four frames (strokes included) around an origin at (0, 0), then the offset that
// centres it in the 64 box.
const RUN_ORIGIN = (() => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of RUN_FRAMES) {
    const g = runFrameGeometry(frame, [0, 0]);
    const head = bbox([ICON.outer], g.headM);
    const pts = [
      [head.x, head.y],
      [head.x + head.w, head.y + head.h],
      ...g.legs.flatMap(([a, b]) => [[a[0] - g.legStroke / 2, a[1] - g.legStroke / 2], [b[0] + g.legStroke / 2, b[1] + g.legStroke / 2], [b[0] - g.legStroke / 2, b[1]]]),
      ...bboxOfQuad(g.tail, g.tailStroke / 2),
    ];
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { origin: [32 - (minX + maxX) / 2, 32 - (minY + maxY) / 2], size: [maxX - minX, maxY - minY] };
})();
function bboxOfQuad([a, c, b], pad) {
  const b0 = bbox([{ segments: [seg.M(...a), seg.Q(c[0], c[1], b[0], b[1])] }]);
  return [
    [b0.x - pad, b0.y - pad],
    [b0.x + b0.w + pad, b0.y + b0.h + pad],
  ];
}

function runSvg(index) {
  const frame = RUN_FRAMES[index - 1];
  const g = runFrameGeometry(frame, RUN_ORIGIN.origin);
  const [root, ctrl, tip] = g.tail;
  const body = [
    `<path fill="${TOKENS.plate}" d="${pathD(ICON.plate, PLATE_M)}"/>`,
    `<path fill="none" stroke="${TOKENS.ink}" stroke-width="${fmt(g.tailStroke)}" stroke-linecap="round" d="M${fmt(root[0])} ${fmt(root[1])} Q${fmt(ctrl[0])} ${fmt(ctrl[1])} ${fmt(tip[0])} ${fmt(tip[1])}"/>`,
    ...g.legs.map(([a, b]) => `<path fill="none" stroke="${TOKENS.ink}" stroke-width="${fmt(g.legStroke)}" stroke-linecap="round" d="M${fmt(a[0])} ${fmt(a[1])} L${fmt(b[0])} ${fmt(b[1])}"/>`),
    ...catMarkup({ M: g.headM, tone: "ink-on-plate", expression: "working", backing: true }),
  ];
  return svgFile(64, `OmO face, run cycle frame ${index} of 4: ${frame.name}, ring eyes kept, on the squircle plate`, DERIVED_DESC, body);
}

// Workspace ring markers (16 box, 1 unit monoline): empty ring = available, filled ring = active,
// ring with a dot = has windows, coral ring with a dot = urgent (coral is the only attention colour;
// amber is reserved for a human decision).
function wsSvg(state) {
  const ringOf = (color) => `<circle cx="8" cy="8" r="5" fill="none" stroke="${color}" stroke-width="1"/>`;
  const dotOf = (color) => `<circle cx="8" cy="8" r="1.75" fill="${color}"/>`;
  const body = {
    empty: [ringOf(TOKENS.muted)],
    active: [`<circle cx="8" cy="8" r="5.5" fill="${TOKENS.plate}"/>`],
    occupied: [ringOf(TOKENS.plate), dotOf(TOKENS.plate)],
    urgent: [ringOf(TOKENS.coral), dotOf(TOKENS.coral)],
  }[state];
  const titles = { empty: "empty ring, workspace available", active: "filled ring, active workspace", occupied: "ring with a dot, workspace has windows", urgent: "coral ring with a dot, a window wants attention" };
  return svgFile(16, `OmO workspace marker, ${state}: ${titles[state]}`, ORIGINAL_DESC, body);
}

export function buildFaces() {
  mkdirSync(FACE_DIR, { recursive: true });
  const files = new Map();
  for (const state of FACE_STATES) files.set(`omo-face-${state}.svg`, faceSvg(state));
  for (const state of HEAD_STATES) files.set(`omo-head-${state}.svg`, headSvg(state));
  for (let k = 1; k <= RUN_FRAMES.length; k++) files.set(`omo-face-run-${k}.svg`, runSvg(k));
  for (const state of WS_STATES) files.set(`omo-ws-${state}.svg`, wsSvg(state));
  for (const name of readdirSync(FACE_DIR)) {
    if (/^omo-.*\.svg$/.test(name) && !files.has(name)) rmSync(join(FACE_DIR, name));
  }
  for (const name of [...files.keys()].sort()) writeFileSync(join(FACE_DIR, name), files.get(name));
  return [...files.keys()].sort();
}

if (import.meta.main) {
  const names = buildFaces();
  const [w, h] = RUN_ORIGIN.size;
  console.log(`run cycle union ${fmt(w)} x ${fmt(h)} units, origin ${RUN_ORIGIN.origin.map(fmt).join(" ")}`);
  console.log(`wrote ${names.length} files to ${FACE_DIR}`);
}
