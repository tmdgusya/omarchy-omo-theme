import { describe, expect, test } from "bun:test";
import { closeSync, constants, lutimesSync, mkdirSync, openSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicSymlink, copyFileDurably, openDevInos, rmForce, sha256FileSync, treeStats,
} from "../src/util";

const tmp = () => {
  const d = `/tmp/omo-dk-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(d, { recursive: true });
  return d;
};

describe("sha256FileSync", () => {
  test("known vector", () => {
    const d = tmp();
    const p = join(d, "v.txt");
    writeFileSync(p, "abc");
    expect(sha256FileSync(p)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    rmForce(d);
  });

  test("multi-chunk file hashes identical to single read", () => {
    const d = tmp();
    const p = join(d, "big.bin");
    const data = Buffer.alloc(3_000_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    writeFileSync(p, data);
    const h = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    expect(sha256FileSync(p)).toBe(h);
    rmForce(d);
  });
});

describe("copyFileDurably", () => {
  test("exact bytes, sha of written data, rejects overwriting existing dst", () => {
    const d = tmp();
    const src = join(d, "s.bin");
    const dst = join(d, "d.bin");
    const data = Buffer.alloc(2_500_000, 7);
    writeFileSync(src, data);
    const r = copyFileDurably(src, dst);
    expect(r.bytes).toBe(data.length);
    expect(r.sha256).toBe(new Bun.CryptoHasher("sha256").update(data).digest("hex"));
    expect(Bun.file(dst).size).toBe(data.length);
    expect(() => copyFileDurably(src, dst)).toThrow();
    rmForce(d);
  });
});

describe("atomicSymlink", () => {
  test("creates link and atomically replaces an existing path", () => {
    const d = tmp();
    const link = join(d, "orig");
    writeFileSync(link, "old");
    atomicSymlink("/some/target", link);
    expect(readlinkSync(link)).toBe("/some/target");
    atomicSymlink("/other/target", link);
    expect(readlinkSync(link)).toBe("/other/target");
    rmForce(d);
  });
});

describe("treeStats", () => {
  test("bytes, file count, cold touch, absolute-inside symlink detection", () => {
    const d = tmp();
    writeFileSync(join(d, "a.bin"), Buffer.alloc(1000));
    writeFileSync(join(d, "b.bin"), Buffer.alloc(3000));
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "c.bin"), Buffer.alloc(2000));
    symlinkSync(join(d, "a.bin"), join(d, "inside-abs"));
    symlinkSync("../a.bin", join(d, "rel-link"));
    const now = Date.now();
    const old = new Date(now - 20 * 86400_000);
    for (const p of [join(d, "a.bin"), join(d, "b.bin"), join(d, "sub", "c.bin"), join(d, "sub"), d]) {
      utimesSync(p, old, old);
    }
    lutimesSync(join(d, "inside-abs"), old, old);
    lutimesSync(join(d, "rel-link"), old, old);
    const t = treeStats(d);
    expect(t.bytes).toBe(6000);
    expect(t.fileCount).toBe(3);
    expect(t.absoluteSymlinksInside).toBe(1);
    expect(now - t.lastTouchMs).toBeGreaterThan(15 * 86400_000);
    rmForce(d);
  });
});

describe("openDevInos", () => {
  test("sees a file held open by this process", () => {
    const d = tmp();
    const p = join(d, "held.bin");
    writeFileSync(p, "x");
    const fd = openSync(p, constants.O_RDONLY);
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const fstat = fs.fstatSync(fd);
      expect(openDevInos().has(`${fstat.dev}:${fstat.ino}`)).toBe(true);
    } finally {
      closeSync(fd);
      rmForce(d);
    }
  });
});
