import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Streaming sha256 without loading the file into RAM (works for multi-GB models). */
export function sha256FileSync(path: string): string {
  const h = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * Copy src -> dst with durability: write, fsync file, fsync containing dir.
 * Hashes the bytes as they are read. Returns sha256 of the bytes written.
 * dst must not exist. Throws on any error; partial dst is NOT removed here
 * (caller decides — during staging it is garbage, elsewhere caller cleans).
 */
export function copyFileDurably(src: string, dst: string): { sha256: string; bytes: number } {
  const ino = openSync(src, constants.O_RDONLY);
  const out = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const h = new Bun.CryptoHasher("sha256");
  const buf = Buffer.alloc(1 << 20);
  let bytes = 0;
  try {
    for (;;) {
      const n = readSync(ino, buf, 0, buf.length, null);
      if (n === 0) break;
      const chunk = n === buf.length ? buf : buf.subarray(0, n);
      h.update(chunk);
      writeSync(out, chunk);
      bytes += n;
    }
    fsyncSync(out);
  } finally {
    closeSync(ino);
    closeSync(out);
  }
  fsyncDir(dirname(dst));
  return { sha256: h.digest("hex"), bytes };
}

export function fsyncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Atomically replace `linkPath` with a symlink to `target` (tmp link + rename). */
export function atomicSymlink(target: string, linkPath: string): void {
  const tmp = `${linkPath}.omo-link-tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, linkPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dirname(linkPath));
}

export interface TreeEntry {
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  /** for symlinks: the raw readlink target (no validation) */
  linkTarget?: string;
}

/** Depth-first walk of a directory tree. Does NOT follow symlinks. */
export function* walk(root: string): Generator<TreeEntry> {
  const st = lstatSync(root);
  yield* walkEntry(root, st);
}

function* walkEntry(path: string, st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; atimeMs: number; ctimeMs: number; ino: number; dev: number; }): Generator<TreeEntry> {
  const base: TreeEntry = {
    path, kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other",
    size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev,
  };
  if (base.kind === "symlink") {
    try { base.linkTarget = readlinkSync(path); } catch { /* raced away */ }
    yield base;
    return;
  }
  yield base;
  if (base.kind === "dir") {
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const de of entries) {
      const child = join(path, de.name);
      let cst;
      try { cst = lstatSync(child); } catch { continue; }
      yield* walkEntry(child, cst);
    }
  }
}

export function treeStats(root: string): {
  bytes: number; fileCount: number; lastTouchMs: number;
  absoluteSymlinksInside: number; hadError: boolean;
} {
  let bytes = 0, fileCount = 0, lastTouch = 0, absInside = 0;
  for (const e of walk(root)) {
    if (e.kind === "file") {
      bytes += e.size;
      fileCount++;
      lastTouch = Math.max(lastTouch, e.mtimeMs, e.atimeMs);
    }
    if (e.kind === "symlink" && e.linkTarget?.startsWith("/")) {
      // absolute symlink pointing back INTO this tree would break after the move
      if (e.linkTarget === root || e.linkTarget.startsWith(root + "/")) absInside++;
    }
  }
  return { bytes, fileCount, lastTouchMs: lastTouch, absoluteSymlinksInside: absInside };
}

/**
 * Set of "dev:ino" strings for every file currently held open by any process
 * we can see. Built once per run; guards against moving files in active use.
 */
export function openDevInos(): Set<string> {
  const out = new Set<string>();
  let pids: string[];
  try { pids = readdirSync("/proc"); } catch { return out; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try { fds = readdirSync(join("/proc", pid, "fd")); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(join("/proc", pid, "fd", fd)); } catch { continue; }
      if (!target.startsWith("/")) continue;
      try {
        const st = statSync(target);
        out.add(`${st.dev}:${st.ino}`);
      } catch { continue; }
    }
  }
  return out;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["K", "M", "G", "T"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[i]}`;
}

export function rmForce(path: string): void {
  rmSync(path, { force: true, recursive: true });
}
