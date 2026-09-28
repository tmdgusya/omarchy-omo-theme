import { lstatSync } from "node:fs";
import type { Config, WhitelistRoot } from "./config";
import { isUnderRoots } from "./config";
import { openDevInos, treeStats, walk } from "./util";

export interface Unit {
  path: string;
  kind: "file" | "dir";
  bytes: number;
  fileCount?: number;
  lastTouchMs: number;
  snapshot: { ino: number; dev: number; size: number; mtimeMs: number };
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface ScanResult {
  units: Unit[];
  skipped: Skipped[];
  scannedRoots: WhitelistRoot[];
}

/**
 * Scan whitelist roots for archive candidates.
 * - glob roots (e.g. ~/dabd-*) become whole-directory units
 * - plain roots (e.g. ~/Downloads) are searched for large cold FILES
 * Caps (maxUnitsPerRun / maxBytesPerRun) are applied here, biggest first.
 */
export function scan(cfg: Config, roots: WhitelistRoot[], now = Date.now()): ScanResult {
  const skipped: Skipped[] = [];
  const units: Unit[] = [];
  const openSet = openDevInos();
  const coldMs = cfg.coldDays * 86400_000;

  for (const root of roots) {
    if (!root.exists) { skipped.push({ path: root.absolute, reason: "대상 없음 (아직 안 생김)" }); continue; }
    if (root.isSymlink) { skipped.push({ path: root.absolute, reason: "이미 아카이브됨 (symlink)" }); continue; }

    if (root.isGlob) {
      considerDirUnit(root.absolute, units, skipped, openSet, coldMs, cfg, now);
    } else {
      scanFilesIn(root.absolute, units, skipped, openSet, coldMs, cfg, now);
    }
  }

  // HARD GUARD: nothing outside the whitelist may ever move
  const safe = units.filter((u) => {
    if (isUnderRoots(u.path, roots)) return true;
    skipped.push({ path: u.path, reason: "화이트리스트 밖 — 코드 가드 거부" });
    return false;
  });

  safe.sort((a, b) => b.bytes - a.bytes);
  const capped: Unit[] = [];
  let budget = cfg.maxBytesPerRun;
  for (const u of safe) {
    if (capped.length >= cfg.maxUnitsPerRun) { skipped.push({ path: u.path, reason: "이번 실행 파일 수 상한" }); continue; }
    if (u.bytes > budget) { skipped.push({ path: u.path, reason: "이번 실행 용량 상한" }); continue; }
    capped.push(u);
    budget -= u.bytes;
  }
  return { units: capped, skipped, scannedRoots: roots };
}

function considerDirUnit(
  path: string, units: Unit[], skipped: Skipped[],
  openSet: Set<string>, coldMs: number, cfg: Config, now: number,
): void {
  let st;
  try { st = lstatSync(path); } catch { skipped.push({ path, reason: "stat 실패" }); return; }
  if (!st.isDirectory()) { skipped.push({ path, reason: "디렉토리 아님" }); return; }

  const t = treeStats(path);
  const age = now - t.lastTouchMs;
  if (age < coldMs) {
    skipped.push({ path, reason: `최근 사용됨 (${Math.floor(age / 86400_000)}일 전 활동 < ${cfg.coldDays}일)` });
    return;
  }
  if (t.absoluteSymlinksInside > 0) {
    skipped.push({ path, reason: `트리 안 절대경로 symlink ${t.absoluteSymlinksInside}개 (이동 시 깨짐)` });
    return;
  }
  if (t.bytes < cfg.dirMinBytes) {
    skipped.push({ path, reason: `크기 미달 (${t.bytes} < dirMinBytes)` });
    return;
  }
  if (hasOpenFile(path, openSet)) {
    skipped.push({ path, reason: "사용 중인 파일 있음" });
    return;
  }
  units.push({
    path, kind: "dir", bytes: t.bytes, fileCount: t.fileCount, lastTouchMs: t.lastTouchMs,
    snapshot: { ino: st.ino, dev: st.dev, size: t.bytes, mtimeMs: st.mtimeMs },
  });
}

function scanFilesIn(
  root: string, units: Unit[], skipped: Skipped[],
  openSet: Set<string>, coldMs: number, cfg: Config, now: number,
): void {
  for (const e of walk(root)) {
    if (e.kind !== "file") continue;
    if (e.size < cfg.fileMinBytes) continue;
    const age = now - Math.max(e.mtimeMs, e.atimeMs);
    if (age < coldMs) {
      skipped.push({ path: e.path, reason: `최근 사용됨 (${Math.floor(age / 86400_000)}일 < ${cfg.coldDays}일)` });
      continue;
    }
    if (openSet.has(`${e.dev}:${e.ino}`)) {
      skipped.push({ path: e.path, reason: "열려 있음" });
      continue;
    }
    units.push({
      path: e.path, kind: "file", bytes: e.size, lastTouchMs: Math.max(e.mtimeMs, e.atimeMs),
      snapshot: { ino: e.ino, dev: e.dev, size: e.size, mtimeMs: e.mtimeMs },
    });
  }
}

function hasOpenFile(root: string, openSet: Set<string>): boolean {
  for (const e of walk(root)) {
    if (openSet.has(`${e.dev}:${e.ino}`)) return true;
  }
  return false;
}
