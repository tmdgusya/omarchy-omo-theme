import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { IndexStore } from "../src/index";
import { healIndex, moveUnit, restoreEntry } from "../src/move";
import type { Unit } from "../src/select";
import { rmForce, sha256FileSync } from "../src/util";

const DAY = 86400_000;

function sandbox() {
  const id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const src = `/tmp/omo-dk-mv-${id}/home`;
  const archive = `/tmp/omo-dk-mv-${id}/archive`;
  mkdirSync(join(src, "Downloads"), { recursive: true });
  mkdirSync(archive, { recursive: true });
  const storePath = `/tmp/omo-dk-mv-${id}/index.jsonl`;
  return { src, archive, store: new IndexStore(storePath), storePath, base: `/tmp/omo-dk-mv-${id}` };
}

function fileUnit(p: string, bytes: number, coldDays = 20): Unit {
  writeFileSync(p, Buffer.alloc(bytes, 3));
  const t = new Date(Date.now() - coldDays * DAY);
  utimesSync(p, t, t);
  const st = lstatSync(p);
  return {
    path: p, kind: "file", bytes, lastTouchMs: t.getTime(),
    snapshot: { ino: st.ino, dev: st.dev, size: bytes, mtimeMs: st.mtimeMs },
  };
}

describe("file move transaction", () => {
  test("end-to-end: verified copy, symlink swap, index entry", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "model.gguf");
    const unit = fileUnit(p, 100_000);
    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });

    expect(r.status).toBe("moved");
    const target = join(s.archive, "mirror", p);
    expect(statSync(target).size).toBe(100_000);
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
    expect(readlinkSync(p)).toBe(target);
    const { entries } = new IndexStore(s.storePath).read();
    expect(entries).toHaveLength(1);
    expect(entries[0].orig).toBe(p);
    expect(entries[0].sha256).toBe(sha256FileSync(target));
    rmForce(s.base);
  });

  test("original modified after scan → refused, original preserved", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "changed.gguf");
    const unit = fileUnit(p, 100_000);
    writeFileSync(p, Buffer.alloc(100_000, 9));

    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toContain("변경됨");
    expect(lstatSync(p).isFile()).toBe(true);
    expect(new IndexStore(s.storePath).read().entries).toHaveLength(0);
    rmForce(s.base);
  });

  test("target already exists → refused, nothing deleted", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "dup.gguf");
    const unit = fileUnit(p, 100_000);
    const target = join(s.archive, "mirror", p);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "old");

    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toContain("이미 존재");
    expect(lstatSync(p).isFile()).toBe(true);
    rmForce(s.base);
  });
});

describe("dir move transaction", () => {
  function dirUnit(root: string, files: [string, number][]): Unit {
    for (const [rel, bytes] of files) {
      const fp = join(root, rel);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, Buffer.alloc(bytes, 5));
      const t = new Date(Date.now() - 20 * DAY);
      utimesSync(fp, t, t);
    }
    const { treeStats } = require("../src/util") as typeof import("../src/util");
    const t = treeStats(root);
    const st = lstatSync(root);
    return {
      path: root, kind: "dir", bytes: t.bytes, fileCount: t.fileCount, lastTouchMs: t.lastTouchMs,
      snapshot: { ino: st.ino, dev: st.dev, size: t.bytes, mtimeMs: st.mtimeMs },
    };
  }

  test("end-to-end with nested dirs and internal symlinks", () => {
    const s = sandbox();
    const wt = join(s.src, "dabd-old");
    const unit = dirUnit(wt, [["a.bin", 3000], ["src/deep/b.bin", 4000]]);
    symlinkSync("../a.bin", join(wt, "src", "rel-link"));

    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    expect(r.status).toBe("moved");
    const target = join(s.archive, "mirror", wt);
    expect(statSync(join(target, "a.bin")).size).toBe(3000);
    expect(statSync(join(target, "src/deep/b.bin")).size).toBe(4000);
    expect(readlinkSync(join(target, "src", "rel-link"))).toBe("../a.bin");
    expect(lstatSync(wt).isSymbolicLink()).toBe(true);
    expect(statSync(join(wt, "src", "rel-link")).size).toBe(3000);
    const { entries } = new IndexStore(s.storePath).read();
    expect(entries[0].kind).toBe("dir");
    expect(entries[0].fileCount).toBe(2);
    rmForce(s.base);
  });

  test("tree grows after scan → refused", () => {
    const s = sandbox();
    const wt = join(s.src, "dabd-changed");
    const unit = dirUnit(wt, [["a.bin", 3000]]);
    writeFileSync(join(wt, "new.bin"), Buffer.alloc(10));

    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    expect(r.status).toBe("failed");
    expect(lstatSync(wt).isDirectory()).toBe(true);
    rmForce(s.base);
  });
});

describe("restore + heal", () => {
  test("restore returns a real file with matching hash and drops the index entry", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "model.gguf");
    const unit = fileUnit(p, 100_000);
    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    if (r.status !== "moved") throw new Error("move failed");

    const back = restoreEntry(r.entry, { archiveRoot: s.archive, store: s.store });
    expect(back.status).toBe("restored");
    expect(lstatSync(p).isFile()).toBe(true);
    expect(sha256FileSync(p)).toBe(r.entry.sha256);
    expect(new IndexStore(s.storePath).read().entries).toHaveLength(0);
    rmForce(s.base);
  });

  test("restore refuses when a real file already sits at the original path", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "model.gguf");
    const unit = fileUnit(p, 100_000);
    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    if (r.status !== "moved") throw new Error("move failed");
    rmSync(p);
    writeFileSync(p, "user made this");

    const back = restoreEntry(r.entry, { archiveRoot: s.archive, store: s.store });
    expect(back.status).toBe("failed");
    rmForce(s.base);
  });

  test("heal rewrites dangling symlinks toward the current archive mount", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "model.gguf");
    const unit = fileUnit(p, 100_000);
    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    if (r.status !== "moved") throw new Error("move failed");

    const archive2 = `${s.base}/archive-moved`;
    mkdirSync(archive2, { recursive: true });
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(s.archive, join(archive2, "omo-archive"));
    const newRoot = join(archive2, "omo-archive");

    expect(() => statSync(p)).toThrow();
    const h = healIndex({ archiveRoot: newRoot, store: s.store });
    expect(h.healed).toHaveLength(1);
    expect(statSync(p).size).toBe(100_000);
    expect(h.orphans).toHaveLength(0);
    rmForce(s.base);
  });

  test("heal reports orphans when the archive copy is gone", () => {
    const s = sandbox();
    const p = join(s.src, "Downloads", "gone.gguf");
    const unit = fileUnit(p, 100_000);
    const r = moveUnit(unit, { archiveRoot: s.archive, store: s.store, openSet: new Set() });
    if (r.status !== "moved") throw new Error("move failed");
    rmForce(join(s.archive, "mirror"));

    const h = healIndex({ archiveRoot: s.archive, store: s.store });
    expect(h.healed).toHaveLength(0);
    expect(h.orphans).toHaveLength(1);
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
    rmForce(s.base);
  });
});
