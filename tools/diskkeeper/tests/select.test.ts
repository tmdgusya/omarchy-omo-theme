import { describe, expect, test } from "bun:test";
import { lutimesSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import { expandWhitelist, isUnderRoots } from "../src/config";
import { scan } from "../src/select";
import { rmForce } from "../src/util";

const DAY = 86400_000;

function makeCfg(home: string, over: Partial<Config> = {}): Config {
  return {
    target: { uuid: "x", fstype: "ext4", label: "T", archiveRoot: "omo-archive" },
    whitelist: [`${home}/Downloads`, `${home}/dabd-*`],
    fileMinBytes: 1000,
    dirMinBytes: 4000,
    coldDays: 14,
    maxBytesPerRun: 10 * 1000 * 1000,
    maxUnitsPerRun: 200,
    freeReserveBytes: 0,
    mode: "propose",
    reportLang: "ko",
    notifyBin: "x",
    ...over,
  };
}

function fakeHome(): string {
  const d = `/tmp/omo-dk-sel-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(join(d, "Downloads"), { recursive: true });
  mkdirSync(join(d, "models"), { recursive: true });
  return d;
}

function cold(p: string, daysAgo = 20) {
  const t = new Date(Date.now() - daysAgo * DAY);
  utimesSync(p, t, t);
}

describe("scan selection", () => {
  test("picks cold big files, skips warm/small, caps applied", () => {
    const home = fakeHome();
    writeFileSync(join(home, "Downloads", "big-cold.bin"), Buffer.alloc(2000));
    cold(join(home, "Downloads", "big-cold.bin"));
    writeFileSync(join(home, "Downloads", "big-warm.bin"), Buffer.alloc(2000));
    writeFileSync(join(home, "Downloads", "small-cold.bin"), Buffer.alloc(10));
    cold(join(home, "Downloads", "small-cold.bin"));
    writeFileSync(join(home, "Downloads", "big-cold-2.bin"), Buffer.alloc(2500));
    cold(join(home, "Downloads", "big-cold-2.bin"));

    const cfg = makeCfg(home, { maxUnitsPerRun: 1 });
    const roots = expandWhitelist(cfg, home);
    const r = scan(cfg, roots);
    expect(r.units).toHaveLength(1);
    expect(r.units[0].path).toBe(join(home, "Downloads", "big-cold-2.bin"));
    expect(r.skipped.some((s) => s.path.endsWith("big-warm.bin") && s.reason.includes("최근"))).toBe(true);
    expect(r.skipped.some((s) => s.path.endsWith("big-cold.bin") && s.reason.includes("상한"))).toBe(true);
    expect(r.units.some((u) => u.path.endsWith("small-cold.bin"))).toBe(false);
    rmForce(home);
  });

  test("glob roots become whole-dir units only when entirely cold and big", () => {
    const home = fakeHome();
    const coldDir = join(home, "dabd-alpha");
    mkdirSync(join(coldDir, "src"), { recursive: true });
    writeFileSync(join(coldDir, "a.bin"), Buffer.alloc(3000));
    writeFileSync(join(coldDir, "src", "b.bin"), Buffer.alloc(3000));
    for (const p of [join(coldDir, "a.bin"), join(coldDir, "src", "b.bin"), coldDir, join(coldDir, "src")]) cold(p);

    const freshDir = join(home, "dabd-beta");
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, "c.bin"), Buffer.alloc(3000));
    cold(join(freshDir, "c.bin"));
    writeFileSync(join(freshDir, "touched-now.bin"), Buffer.alloc(10));

    const smallDir = join(home, "dabd-small");
    mkdirSync(smallDir, { recursive: true });
    writeFileSync(join(smallDir, "d.bin"), Buffer.alloc(10));
    cold(join(smallDir, "d.bin"));
    cold(smallDir);

    const cfg = makeCfg(home);
    const r = scan(cfg, expandWhitelist(cfg, home));
    const dirs = r.units.filter((u) => u.kind === "dir");
    expect(dirs.map((u) => u.path)).toEqual([coldDir]);
    expect(dirs[0].bytes).toBe(6000);
    expect(r.skipped.some((s) => s.path === freshDir && s.reason.includes("최근 사용됨"))).toBe(true);
    expect(r.skipped.some((s) => s.path === smallDir && s.reason.includes("미달"))).toBe(true);
    rmForce(home);
  });

  test("absolute symlink inside a dir unit disqualifies it; already-archived symlink root is skipped", () => {
    const home = fakeHome();
    const dir = join(home, "dabd-abs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.bin"), Buffer.alloc(5000));
    cold(join(dir, "a.bin"));
    cold(dir);
    symlinkSync(join(dir, "a.bin"), join(dir, "self-abs"));
    cold(dir, 20);
    const t20 = new Date(Date.now() - 20 * DAY);
    lutimesSync(join(dir, "self-abs"), t20, t20);

    const archived = join(home, "dabd-done");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "z.bin"), Buffer.alloc(5000));
    cold(join(archived, "z.bin"));
    cold(archived);
    rmForce(archived);
    symlinkSync("/mnt/archive/mirror/dabd-done", archived);

    const cfg = makeCfg(home);
    const r = scan(cfg, expandWhitelist(cfg, home));
    expect(r.units.filter((u) => u.kind === "dir")).toHaveLength(0);
    expect(r.skipped.some((s) => s.path === dir && s.reason.includes("절대경로 symlink"))).toBe(true);
    expect(r.skipped.some((s) => s.path === archived && s.reason.includes("아카이브됨"))).toBe(true);
    rmForce(home);
  });

  test("whitelist guard rejects anything outside roots", () => {
    const home = fakeHome();
    const outside = join(home, "elsewhere", "x.bin");
    mkdirSync(join(home, "elsewhere"), { recursive: true });
    writeFileSync(outside, Buffer.alloc(5000));
    cold(outside);
    const cfg = makeCfg(home);
    const roots = expandWhitelist(cfg, home);
    expect(isUnderRoots(outside, roots)).toBe(false);
    const r = scan(cfg, roots);
    expect(r.units.some((u) => u.path === outside)).toBe(false);
    rmForce(home);
  });
});
