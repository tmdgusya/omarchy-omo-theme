import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  target: { uuid: string; fstype: string; label: string; archiveRoot: string };
  /** whitelist entries. entries containing glob chars are whole-directory units;
   *  plain entries are scanned recursively for large cold FILES. */
  whitelist: string[];
  fileMinBytes: number;
  dirMinBytes: number;
  coldDays: number;
  maxBytesPerRun: number;
  maxUnitsPerRun: number;
  /** target free space must stay above this */
  freeReserveBytes: number;
  /** "propose" = report only, "execute" = actually move */
  mode: "propose" | "execute";
  reportLang: string;
  notifyBin: string;
}

export const DEFAULT_CONFIG: Config = {
  target: {
    uuid: "",
    fstype: "ext4",
    label: "",
    archiveRoot: "omo-archive",
  },
  whitelist: ["~/Downloads", "~/Videos"],
  fileMinBytes: 100 * 1024 * 1024,
  dirMinBytes: 500 * 1024 * 1024,
  coldDays: 14,
  maxBytesPerRun: 50 * 1024 * 1024 * 1024,
  maxUnitsPerRun: 200,
  freeReserveBytes: 20 * 1024 * 1024 * 1024,
  mode: "propose",
  reportLang: "en",
  notifyBin: "/usr/share/omarchy/bin/omarchy-notification-send",
};

export function configPath(): string {
  return join(homedir(), ".config/omo-diskkeeper/config.json");
}

export function stateDir(): string {
  return join(homedir(), ".local/state/omo-diskkeeper");
}

export function loadConfig(p = configPath()): Config {
  if (!existsSync(p)) throw new Error(`config not found at ${p} — run \`init\` first`);
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return { ...DEFAULT_CONFIG, ...raw, target: { ...DEFAULT_CONFIG.target, ...(raw.target ?? {}) } };
}

export function saveConfig(cfg: Config, p = configPath()): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

/** Expand whitelist entries to absolute paths; glob entries keep their pattern. */
export interface WhitelistRoot {
  pattern: string;
  absolute: string;
  isGlob: boolean;
  exists: boolean;
  isSymlink: boolean;
}

export function expandWhitelist(cfg: Config, home = homedir()): WhitelistRoot[] {
  const out: WhitelistRoot[] = [];
  for (const entry of cfg.whitelist) {
    const pat = entry.startsWith("~/") ? join(home, entry.slice(2)) : entry;
    const isGlob = /[*?[]/.test(pat);
    const base = isGlob ? pat.slice(0, pat.search(/[*?[]/)) : pat;
    // hard guard: everything must live under the user's home
    if (!(base === home || base.startsWith(home + "/"))) {
      throw new Error(`whitelist entry outside HOME is not allowed: ${entry}`);
    }
    if (isGlob) {
      const dir = base.slice(0, base.lastIndexOf("/")) || "/";
      const frag = pat.slice(base.lastIndexOf("/") + 1);
      if (!existsSync(dir)) continue;
      const g = new Bun.Glob(frag);
      let matched = false;
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names.sort()) {
        if (!g.match(name)) continue;
        const abs = join(dir, name);
        matched = true;
        const lst = safeLstat(abs);
        out.push({ pattern: entry, absolute: abs, isGlob: true, exists: !!lst, isSymlink: lst?.isSymbolicLink() ?? false });
      }
      if (!matched) out.push({ pattern: entry, absolute: pat, isGlob: true, exists: false, isSymlink: false });
    } else {
      const lst = safeLstat(pat);
      out.push({ pattern: entry, absolute: pat, isGlob: false, exists: !!lst, isSymlink: lst?.isSymbolicLink() ?? false });
    }
  }
  return out;
}

function safeLstat(p: string) {
  try { return lstatSync(p); } catch { return undefined; }
}

/** Validate that `path` (absolute, no symlinked prefix games) is under one of the expanded roots. */
export function isUnderRoots(path: string, roots: WhitelistRoot[]): boolean {
  for (const r of roots) {
    if (r.isGlob && path === r.absolute) return true;
    if (!r.isGlob && (path === r.absolute || path.startsWith(r.absolute + "/"))) return true;
  }
  return false;
}
