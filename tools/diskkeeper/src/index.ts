import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface IndexEntry {
  /** absolute original path on the SSD (now a symlink) */
  orig: string;
  /** path relative to the archive root, e.g. "mirror/home/roach/..." */
  targetRel: string;
  kind: "file" | "dir";
  bytes: number;
  fileCount?: number;
  sha256?: string;
  movedAt: number;
}

export class IndexStore {
  constructor(private path: string) {}

  read(): { entries: IndexEntry[]; corrupt: number } {
    if (!existsSync(this.path)) return { entries: [], corrupt: 0 };
    const entries: IndexEntry[] = [];
    let corrupt = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.orig === "string" && typeof e.targetRel === "string") entries.push(e);
        else corrupt++;
      } catch { corrupt++; }
    }
    return { entries, corrupt };
  }

  append(entry: IndexEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(entry) + "\n", { flag: "a" });
  }

  rewrite(entries: IndexEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
    renameSync(tmp, this.path);
  }

  remove(orig: string): { entries: IndexEntry[]; removed: boolean } {
    const { entries } = this.read();
    const kept = entries.filter((e) => e.orig !== orig);
    if (kept.length !== entries.length) this.rewrite(kept);
    return { entries: kept, removed: kept.length !== entries.length };
  }
}
