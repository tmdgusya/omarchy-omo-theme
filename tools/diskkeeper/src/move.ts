import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IndexEntry, IndexStore } from "./index";
import type { Unit } from "./select";
import {
  atomicSymlink, copyFileDurably, fsyncDir, openDevInos, rmForce, sha256FileSync, treeStats, walk,
} from "./util";

export type MoveOutcome =
  | { status: "moved"; entry: IndexEntry }
  | { status: "failed"; reason: string };

export interface MoveCtx {
  archiveRoot: string;
  store: IndexStore;
  openSet?: Set<string>;
}

function targetPathFor(archiveRoot: string, orig: string): string {
  return join(archiveRoot, "mirror", orig);
}

/** The original must be byte-identical (ino, size, mtime) to the scan snapshot. */
function snapshotMatches(unit: Unit): boolean {
  let st;
  try { st = lstatSync(unit.path); } catch { return false; }
  if (st.ino !== unit.snapshot.ino || st.dev !== unit.snapshot.dev) return false;
  if (st.mtimeMs !== unit.snapshot.mtimeMs) return false;
  if (unit.kind === "file" && st.size !== unit.snapshot.size) return false;
  return true;
}

export function moveUnit(unit: Unit, ctx: MoveCtx): MoveOutcome {
  try {
    const out = unit.kind === "file" ? moveFileUnit(unit, ctx) : moveDirUnit(unit, ctx);
    if (out.status === "moved") ctx.store.append(out.entry);
    return out;
  } catch (e) {
    return { status: "failed", reason: String(e) };
  }
}

function moveFileUnit(unit: Unit, ctx: MoveCtx): MoveOutcome {
  const openSet = ctx.openSet ?? openDevInos();
  let st;
  try { st = lstatSync(unit.path); } catch { return { status: "failed", reason: "원본이 사라짐" }; }
  if (st.isSymbolicLink()) return { status: "failed", reason: "원본이 이미 symlink" };
  if (!snapshotMatches(unit)) return { status: "failed", reason: "스캔 이후 원본이 변경됨" };
  if (openSet.has(`${st.dev}:${st.ino}`)) return { status: "failed", reason: "원본이 사용 중" };

  const finalTarget = targetPathFor(ctx.archiveRoot, unit.path);
  mkdirSync(dirname(finalTarget), { recursive: true });
  if (existsSync(finalTarget)) {
    return { status: "failed", reason: `아카이브에 이미 존재: ${finalTarget}` };
  }

  const part = `${finalTarget}.omopart-${process.pid}`;
  rmForce(part);
  let copied: { sha256: string; bytes: number };
  try {
    copied = copyFileDurably(unit.path, part);
  } catch (e) {
    rmForce(part);
    return { status: "failed", reason: `복사 실패: ${String(e)}` };
  }
  if (sha256FileSync(part) !== copied.sha256) {
    rmForce(part);
    return { status: "failed", reason: "복사본 해시 불일치" };
  }
  chmodSync(part, st.mode);
  renameSync(part, finalTarget);
  fsyncDir(dirname(finalTarget));

  if (!snapshotMatches(unit)) {
    rmForce(finalTarget);
    return { status: "failed", reason: "복사 중 원본이 변경됨 — 원본 보존" };
  }

  unlinkSync(unit.path);
  atomicSymlink(finalTarget, unit.path);
  return {
    status: "moved",
    entry: {
      orig: unit.path, targetRel: join("mirror", unit.path), kind: "file",
      bytes: copied.bytes, sha256: copied.sha256, movedAt: Date.now(),
    },
  };
}

function moveDirUnit(unit: Unit, ctx: MoveCtx): MoveOutcome {
  let st;
  try { st = lstatSync(unit.path); } catch { return { status: "failed", reason: "원본이 사라짐" }; }
  if (st.isSymbolicLink()) return { status: "failed", reason: "원본이 이미 symlink" };
  if (st.ino !== unit.snapshot.ino || st.dev !== unit.snapshot.dev) {
    return { status: "failed", reason: "스캔 이후 원본이 변경됨" };
  }
  const before = treeStats(unit.path);
  if (before.bytes !== unit.snapshot.size || before.fileCount !== unit.fileCount) {
    return { status: "failed", reason: "스캔 이후 트리가 변경됨" };
  }

  const finalTarget = targetPathFor(ctx.archiveRoot, unit.path);
  if (existsSync(finalTarget)) {
    return { status: "failed", reason: `아카이브에 이미 존재: ${finalTarget}` };
  }
  mkdirSync(dirname(finalTarget), { recursive: true });

  const staging = join(ctx.archiveRoot, ".staging", `${process.pid}-${Date.now()}`);
  rmForce(staging);
  mkdirSync(staging, { recursive: true });
  try {
    for (const e of walk(unit.path)) {
      const rel = e.path.slice(unit.path.length + 1);
      const dst = join(staging, rel);
      if (e.kind === "dir") {
        mkdirSync(dst, { recursive: true });
        chmodSync(dst, 0o755);
      } else if (e.kind === "file") {
        const copied = copyFileDurably(e.path, dst);
        if (sha256FileSync(dst) !== copied.sha256) {
          throw new Error(`복사본 해시 불일치: ${rel}`);
        }
        chmodSync(dst, 0o644);
      } else if (e.kind === "symlink" && e.linkTarget) {
        symlinkSync(e.linkTarget, dst);
      }
    }
    const after = treeStats(unit.path);
    if (after.bytes !== before.bytes || after.fileCount !== before.fileCount) {
      throw new Error("복사 중 트리가 변경됨 — 원본 보존");
    }
    renameSync(staging, finalTarget);
    fsyncDir(dirname(finalTarget));
  } catch (e) {
    rmForce(staging);
    return { status: "failed", reason: `디렉토리 복사 실패: ${String(e)}` };
  }

  rmSync(unit.path, { recursive: true, force: true });
  atomicSymlink(finalTarget, unit.path);
  return {
    status: "moved",
    entry: {
      orig: unit.path, targetRel: join("mirror", unit.path), kind: "dir",
      bytes: before.bytes, fileCount: before.fileCount, movedAt: Date.now(),
    },
  };
}

export type RestoreOutcome =
  | { status: "restored"; entry: IndexEntry }
  | { status: "failed"; reason: string };

export function restoreEntry(entry: IndexEntry, ctx: { archiveRoot: string; store: IndexStore }): RestoreOutcome {
  const src = join(ctx.archiveRoot, entry.targetRel);
  if (!existsSync(src)) return { status: "failed", reason: `아카이브에 없음: ${src}` };
  let lst;
  try { lst = lstatSync(entry.orig); } catch { lst = undefined; }
  if (lst && !lst.isSymbolicLink()) {
    return { status: "failed", reason: `원본 위치에 symlink가 아닌 실제 항목이 있음: ${entry.orig}` };
  }
  if (lst?.isSymbolicLink()) unlinkSync(entry.orig);

  try {
    if (entry.kind === "file") {
      const part = `${entry.orig}.omopart-${process.pid}`;
      const copied = copyFileDurably(src, part);
      if (sha256FileSync(part) !== copied.sha256) throw new Error("복원 해시 불일치");
      if (entry.sha256 && copied.sha256 !== entry.sha256) throw new Error("인덱스 해시와 불일치");
      renameSync(part, entry.orig);
      fsyncDir(dirname(entry.orig));
    } else {
      const staging = join(dirname(entry.orig), `.${entry.orig.split("/").pop()}.omorestore-${process.pid}`);
      rmForce(staging);
      mkdirSync(staging, { recursive: true });
      for (const e of walk(src)) {
        const rel = e.path.slice(src.length + 1);
        const dst = join(staging, rel);
        if (e.kind === "dir") mkdirSync(dst, { recursive: true });
        else if (e.kind === "file") copyFileDurably(e.path, dst);
        else if (e.kind === "symlink" && e.linkTarget) symlinkSync(e.linkTarget, dst);
      }
      renameSync(staging, entry.orig);
      fsyncDir(dirname(entry.orig));
    }
  } catch (e) {
    return { status: "failed", reason: `복원 실패: ${String(e)}` };
  }
  ctx.store.remove(entry.orig);
  return { status: "restored", entry };
}

export interface HealResult {
  healed: IndexEntry[];
  orphans: IndexEntry[];
  replaced: IndexEntry[];
  corrupt: number;
}

/**
 * Repair dangling symlinks after the archive disk remounts somewhere else.
 * Never touches archive data; only rewrites symlinks at original locations.
 */
export function healIndex(ctx: { archiveRoot: string; store: IndexStore }): HealResult {
  const { entries, corrupt } = ctx.store.read();
  const healed: IndexEntry[] = [], orphans: IndexEntry[] = [], replaced: IndexEntry[] = [];
  for (const e of entries) {
    let lst;
    try { lst = lstatSync(e.orig); } catch { lst = undefined; }
    if (!lst) { orphans.push(e); continue; }
    if (!lst.isSymbolicLink()) { replaced.push(e); continue; }
    let resolved: string;
    try { resolved = readlinkSync(e.orig); } catch { orphans.push(e); continue; }
    let live = false;
    try { statSync(resolved); live = true; } catch { }
    if (live) continue;
    const fresh = join(ctx.archiveRoot, e.targetRel);
    if (existsSync(fresh)) {
      try {
        atomicSymlink(fresh, e.orig);
        healed.push(e);
      } catch { orphans.push(e); }
    } else {
      orphans.push(e);
    }
  }
  return { healed, orphans, replaced, corrupt };
}
