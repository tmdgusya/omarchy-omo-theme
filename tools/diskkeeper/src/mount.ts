import { statfsSync, statSync } from "node:fs";

export interface ResolvedTarget {
  mountPoint: string;
  freeBytes: number;
}

/**
 * Resolve the archive disk by UUID. Returns null when the disk is absent or
 * mounted with an unexpected filesystem — the caller must then do NOTHING
 * except report "HDD not visible".
 */
export function resolveTarget(uuid: string, expectedFstype: string): ResolvedTarget | null {
  const dev = `/dev/disk/by-uuid/${uuid}`;
  try { statSync(dev); } catch { return null; }
  const res = Bun.spawnSync(["findmnt", "-rn", "-S", dev, "-o", "TARGET,FSTYPE"]);
  const code = res.exitCode ?? res.status ?? 0;
  if (code !== 0) return null;
  const line = res.stdout.toString().trim();
  if (!line) return null;
  const [target, fstype] = line.split(/\s+/);
  if (!target || fstype !== expectedFstype) return null;
  let freeBytes = 0;
  try {
    const fs = statfsSync(target);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
  return { mountPoint: target, freeBytes };
}

/** Best-effort automount via udisks2; mounting is asynchronous — poll resolveTarget afterwards. */
export function attemptUdisksMount(uuid: string): boolean {
  const dev = `/dev/disk/by-uuid/${uuid}`;
  const res = Bun.spawnSync(["udisksctl", "mount", "-b", dev, "--no-user-interaction"]);
  return (res.exitCode ?? res.status ?? 0) === 0;
}

/** Disk free bytes for any mounted path (used for SSD-side suggestions). */
export function freeBytesOf(path: string): number | null {
  try {
    const fs = statfsSync(path);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch { return null; }
}
