import { existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_CONFIG, configPath, expandWhitelist, loadConfig, saveConfig, stateDir, type Config,
} from "./config";
import { IndexStore } from "./index";
import { attemptUdisksMount, resolveTarget } from "./mount";
import { healIndex, moveUnit, restoreEntry } from "./move";
import { scan, type Skipped, type Unit } from "./select";
import { humanBytes } from "./util";

const TOOL_DIR = join(import.meta.dir, "..");
const ASSETS = join(TOOL_DIR, "assets");

const STR = {
  ko: {
    proposeHead: (n: number, b: string) => `OmO 정리 제안 🐱 ${n}건 ${b}`,
    doneHead: (n: number, b: string) => `OmO 정리 완료 🐱 ${n}건 ${b}`,
    proposeBody: "제안 모드다냥 — 눌러서 오늘의 후보 보기",
    doneBody: "아카이브로 옮기고 symlink 남겼다냥. 눌러서 보고서 보기",
    noDiskHead: "OmO 하루 정리 🐱",
    noDiskBody: "아카이브 디스크가 안 보인다냥 — 오늘은 쉰다냥. 원본 안전!",
    unconfiguredHead: "OmO diskkeeper",
    unconfiguredBody: "아직 대상 디스크가 설정 안 됐다냥. setup을 실행해달라냥.",
  },
  en: {
    proposeHead: (n: number, b: string) => `OmO tidy proposal 🐱 ${n} items ${b}`,
    doneHead: (n: number, b: string) => `OmO tidied up 🐱 ${n} items ${b}`,
    proposeBody: "Proposal mode — tap to see today's candidates",
    doneBody: "Moved to the archive, symlinks left behind. Tap for the report",
    noDiskHead: "OmO daily tidy 🐱",
    noDiskBody: "Archive disk not visible — resting today. Your files are safe!",
    unconfiguredHead: "OmO diskkeeper",
    unconfiguredBody: "No archive disk configured yet — run setup first.",
  },
} as const;

function strings(lang: string) {
  return STR[lang === "ko" ? "ko" : "en"];
}

interface RunRecord {
  ts: number;
  mode: Config["mode"];
  disk: { mounted: boolean; mountPoint?: string; freeBytes?: number };
  heal?: { healed: number; orphans: number; replaced: number; corrupt: number };
  proposed: Array<{ path: string; kind: string; bytes: number }>;
  moved: Array<{ path: string; bytes: number }>;
  failed: Array<{ path: string; reason: string }>;
  freedBytes: number;
  capsDropped: Array<{ path: string; bytes: number }>;
  skippedTop: Skipped[];
  cache: {
    ssdFreeBytes: number | null;
    archiveFreeBytes: number | null;
    pacmanCacheBytes: number | null;
    journalBytes: number | null;
  };
}

function runsDir(): string {
  return join(stateDir(), "runs");
}

function reportLatest(): string {
  return join(stateDir(), "report-latest.md");
}

function newStore(): IndexStore {
  return new IndexStore(join(stateDir(), "index.jsonl"));
}

function parseBytes(s: string): number | null {
  const m = s.match(/([\d.]+)\s*(B|K|M|G|T)?/i);
  if (!m) return null;
  const mult = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function cacheStats(archiveFree: number | null): RunRecord["cache"] {
  const ssdFree = (() => {
    try { const f = statfsSync(homedir()); return Number(f.bavail) * Number(f.bsize); } catch { return null; }
  })();
  const pacman = (() => {
    const r = Bun.spawnSync(["du", "-sb", "/var/cache/pacman/pkg"]);
    const n = parseInt(r.stdout.toString().split(/\s+/)[0] ?? "", 10);
    return n || null;
  })();
  const journal = (() => {
    const r = Bun.spawnSync(["journalctl", "--disk-usage"]);
    const m = r.stdout.toString().match(/take up ([\d.]+[KMGT]?) /i);
    return m ? parseBytes(m[1]) : null;
  })();
  return { ssdFreeBytes: ssdFree, archiveFreeBytes: archiveFree, pacmanCacheBytes: pacman, journalBytes: journal };
}

function trimToBudget(units: Unit[], freeBytes: number, reserve: number): { keep: Unit[]; dropped: Unit[] } {
  const keep = [...units];
  const dropped: Unit[] = [];
  const budget = freeBytes - reserve;
  let total = keep.reduce((a, u) => a + u.bytes, 0);
  while (keep.length && (total > budget || budget < keep[keep.length - 1].bytes)) {
    const u = keep.pop()!;
    dropped.push(u);
    total -= u.bytes;
  }
  return { keep, dropped };
}

function templateReport(rec: RunRecord, lang: string): string {
  const ko = lang === "ko";
  const d = new Date(rec.ts);
  const lines: string[] = [];
  const totalProposed = rec.proposed.reduce((a, u) => a + u.bytes, 0);
  lines.push(ko
    ? `# 🐱 OmO 하루 정리 보고 — ${d.toLocaleDateString("ko-KR")}`
    : `# 🐱 OmO daily tidy report — ${d.toLocaleDateString("en-US")}`);
  lines.push("");
  if (!rec.disk.mounted) {
    lines.push(ko
      ? `**오늘은 아카이브 디스크가 안 보여서 쉰다냥.** (UUID 확인 실패 — 마운트되면 내일 다시 한다냥)`
      : `**The archive disk is not visible today, so I'm resting.** (UUID check failed — I'll try again tomorrow.)`);
    lines.push("", ko ? "아무 것도 지우거나 옮기지 않았다냥. 원본은 그대로다냥." : "Nothing was moved or deleted. Your originals are untouched.");
  } else if (rec.mode === "propose") {
    lines.push(ko
      ? `**제안 모드다냥** — 오늘은 옮기지 않고 후보만 골랐다냥. \`go\` 하면 내일부턴 진짜 옮긴다냥.`
      : `**Proposal mode** — nothing was moved today, candidates only. Run \`go\` to start moving for real.`);
    lines.push("");
    lines.push(ko ? `## 후보 ${rec.proposed.length}건 · ${humanBytes(totalProposed)}` : `## Candidates: ${rec.proposed.length} · ${humanBytes(totalProposed)}`);
    for (const u of rec.proposed.slice(0, 25)) lines.push(`- ${humanBytes(u.bytes).padStart(6)} ${u.path}`);
    if (rec.proposed.length > 25) lines.push(ko ? `- … 외 ${rec.proposed.length - 25}건` : `- … and ${rec.proposed.length - 25} more`);
  } else {
    lines.push(ko
      ? `**${rec.moved.length}건 · ${humanBytes(rec.freedBytes)}를 아카이브로 옮겼다냥.** 원래 자리엔 symlink를 남겼다냥.`
      : `**Moved ${rec.moved.length} items (${humanBytes(rec.freedBytes)}) to the archive.** Symlinks were left at the original paths.`);
    lines.push("");
    for (const u of rec.moved.slice(0, 25)) lines.push(`- ${humanBytes(u.bytes).padStart(6)} ${u.path}`);
    if (rec.failed.length) {
      lines.push("", ko ? `## 안 옮긴 것 ${rec.failed.length}건` : `## Not moved: ${rec.failed.length}`);
      for (const f of rec.failed.slice(0, 10)) lines.push(`- ${f.path} — ${f.reason}`);
    }
  }
  if (rec.heal && (rec.heal.healed || rec.heal.orphans)) {
    lines.push("", ko ? `## symlink 진료 결과` : `## Symlink repairs`);
    if (rec.heal.healed) lines.push(ko ? `- 고침 ${rec.heal.healed}건` : `- repaired ${rec.heal.healed}`);
    if (rec.heal.orphans) lines.push(ko
      ? `- 원본 symlink가 사라진 아카이브 항목 ${rec.heal.orphans}건 (데이터는 아카이브에 안전)`
      : `- ${rec.heal.orphans} archived items whose original symlink is gone (data is safe in the archive)`);
  }
  const c = rec.cache;
  lines.push("", ko ? `## 디스크 상황` : `## Disk situation`);
  if (c.ssdFreeBytes != null) lines.push(ko ? `- SSD 여유: ${humanBytes(c.ssdFreeBytes)}` : `- SSD free: ${humanBytes(c.ssdFreeBytes)}`);
  if (c.archiveFreeBytes != null) lines.push(ko ? `- 아카이브 여유: ${humanBytes(c.archiveFreeBytes)}` : `- Archive free: ${humanBytes(c.archiveFreeBytes)}`);
  if (c.pacmanCacheBytes != null && c.pacmanCacheBytes > 500 * 1024 * 1024) {
    lines.push(ko
      ? `- 💡 pacman 캐시 ${humanBytes(c.pacmanCacheBytes)} — \`sudo paccache -rk2\` 하면 대폭 줄인다냥`
      : `- 💡 pacman cache ${humanBytes(c.pacmanCacheBytes)} — \`sudo paccache -rk2\` would shrink it a lot`);
  }
  if (c.journalBytes != null && c.journalBytes > 500 * 1024 * 1024) {
    lines.push(ko
      ? `- 💡 저널 ${humanBytes(c.journalBytes)} — \`sudo journalctl --vacuum-size=500M\` 추천이다냥`
      : `- 💡 journal ${humanBytes(c.journalBytes)} — \`sudo journalctl --vacuum-size=500M\` recommended`);
  }
  if (rec.skippedTop.length) {
    lines.push("", ko ? `## 건너뛴 이유 (상위)` : `## Why things were skipped (top)`);
    for (const s of rec.skippedTop.slice(0, 15)) lines.push(`- ${s.path} — ${s.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function agentReport(runJsonPath: string, lang: string): Promise<string | null> {
  const ko = lang === "ko";
  const prompt = ko
    ? [
      "너는 오모(OmO), 사용자 roach의 데스크탑 고양이다. 방금 하루 디스크 정리를 마쳤다.",
      `오늘의 실행 기록 JSON을 읽고(${runJsonPath}) 하루 보고서를 한국어 마크다운으로 써라.`,
      "규칙: 반말에 ~다냥 말투를 자연스럽게. 사실은 JSON 기반으로만(숫자 조작 금지). 40줄 이내.",
      "구성: ## 오늘의 요약 / ## ${mode==='propose' ? '옮길 후보' : '오늘 옮긴 것'} / ## 건너뛴 것과 이유(재미있게) / ## roach에게 추천 (pacman·저널 정리는 직접 실행 못 하니 명령어 제안) / ## 내일 예고.",
      "파일 경로 외의 어떤 파일도 읽지 마라. 출력은 보고서 본문만.",
    ].join("\n")
    : [
      "You are OmO, the user's desktop cat. The daily disk tidy just finished.",
      `Read today's run record JSON (${runJsonPath}) and write the daily report in English markdown.`,
      "Rules: a light cat personality, occasional '~nya' is fine. Facts only from the JSON — never invent numbers. Max 40 lines.",
      "Sections: ## Summary / ## ${mode==='propose' ? 'Candidates to move' : 'Moved today'} / ## Skipped, and why (have fun with it) / ## Recommendations (pacman/journal cleanup needs sudo, so suggest commands) / ## Tomorrow.",
      "Read no file other than the run record. Output only the report body.",
    ].join("\n");
  let proc;
  try {
    proc = Bun.spawn(["senpi", "-p", "--no-session", "--mode", "text", "--tools", "read"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch { return null; }
  const killer = setTimeout(() => proc.kill(), 150_000);
  try {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && out.trim().length > 80) return out.trim();
    return null;
  } catch { return null; } finally { clearTimeout(killer); }
}

function notify(headline: string, body: string, report: string | null, face: "idle" | "done" | "waiting" = "idle", lang = "en"): void {
  void lang;
  const icon = join(ASSETS, `omo-face-${face}.svg`);
  const args = ["/usr/share/omarchy/bin/omarchy-notification-send", "--app-name", "omo-diskkeeper", "-i", icon, "-u", "normal", headline, body];
  if (report) args.push("--exec", "foot", "-e", "bat", report);
  const r = Bun.spawnSync(args);
  if ((r.exitCode ?? r.status ?? 0) !== 0) {
    Bun.spawnSync(["notify-send", "-a", "omo-diskkeeper", headline, body]);
  }
}

async function runDaily(cfg: Config): Promise<void> {
  mkdirSync(runsDir(), { recursive: true });
  const ts = Date.now();
  const s = strings(cfg.reportLang);
  const rec: RunRecord = {
    ts, mode: cfg.mode, disk: { mounted: false },
    proposed: [], moved: [], failed: [], freedBytes: 0, capsDropped: [], skippedTop: [],
    cache: cacheStats(null),
  };

  if (!cfg.target.uuid) {
    await finishRun(rec, cfg);
    notify(s.unconfiguredHead, s.unconfiguredBody, null, "waiting");
    return;
  }

  let target = resolveTarget(cfg.target.uuid, cfg.target.fstype);
  if (!target) {
    attemptUdisksMount(cfg.target.uuid);
    for (let i = 0; i < 6 && !target; i++) {
      await Bun.sleep(1000);
      target = resolveTarget(cfg.target.uuid, cfg.target.fstype);
    }
  }

  if (!target) {
    rec.cache = cacheStats(null);
    await finishRun(rec, cfg);
    notify(s.noDiskHead, s.noDiskBody, reportLatest(), "waiting");
    return;
  }

  rec.disk = { mounted: true, mountPoint: target.mountPoint, freeBytes: target.freeBytes };
  const archiveRoot = join(target.mountPoint, cfg.target.archiveRoot);
  const store = newStore();

  const heal = healIndex({ archiveRoot, store });
  rec.heal = { healed: heal.healed.length, orphans: heal.orphans.length, replaced: heal.replaced.length, corrupt: heal.corrupt };

  const roots = expandWhitelist(cfg);
  const sr = scan(cfg, roots);
  const { keep, dropped } = trimToBudget(sr.units, target.freeBytes, cfg.freeReserveBytes);
  rec.proposed = keep.map((u) => ({ path: u.path, kind: u.kind, bytes: u.bytes }));
  rec.capsDropped = dropped.map((u) => ({ path: u.path, bytes: u.bytes }));
  rec.skippedTop = sr.skipped.slice(0, 60);

  if (cfg.mode === "execute") {
    for (const u of keep) {
      const out = moveUnit(u, { archiveRoot, store });
      if (out.status === "moved") {
        rec.moved.push({ path: u.path, bytes: out.entry.bytes });
        rec.freedBytes += out.entry.bytes;
      } else {
        rec.failed.push({ path: u.path, reason: out.reason });
      }
    }
  }

  const freshFree = resolveTarget(cfg.target.uuid, cfg.target.fstype);
  rec.cache = cacheStats(freshFree?.freeBytes ?? null);
  await finishRun(rec, cfg);
  const totalProposed = rec.proposed.reduce((a, u) => a + u.bytes, 0);
  if (cfg.mode === "execute") {
    notify(s.doneHead(rec.moved.length, humanBytes(rec.freedBytes)), s.doneBody, reportLatest(), "done", cfg.reportLang);
  } else {
    notify(s.proposeHead(rec.proposed.length, humanBytes(totalProposed)), s.proposeBody, reportLatest(), "idle", cfg.reportLang);
  }
}

async function finishRun(rec: RunRecord, cfg: Config): Promise<string> {
  const stamp = new Date(rec.ts).toISOString().replace(/[:.]/g, "-");
  const runJsonPath = join(runsDir(), `${stamp}.json`);
  writeFileSync(runJsonPath, JSON.stringify(rec, null, 2));
  let body = templateReport(rec, cfg.reportLang);
  const agent = await agentReport(runJsonPath, cfg.reportLang);
  if (agent) body = agent;
  writeFileSync(join(runsDir(), `${stamp}.md`), body);
  writeFileSync(reportLatest(), body);
  return runJsonPath;
}

function cmdInit(): void {
  if (existsSync(configPath())) {
    console.log(`config already exists: ${configPath()}`);
  } else {
    saveConfig(DEFAULT_CONFIG);
    console.log(`config created: ${configPath()}`);
    console.log("Next: pick your archive disk with `setup` (or config-set --uuid ...).");
  }
  mkdirSync(runsDir(), { recursive: true });
}

interface DiskCandidate {
  device: string;
  uuid: string;
  fstype: string;
  target: string;
  sizeLabel: string;
}

function listDiskCandidates(): DiskCandidate[] {
  const r = Bun.spawnSync(["lsblk", "-rno", "PATH,TYPE,FSTYPE,UUID,MOUNTPOINTS,SIZE"]);
  const out = r.stdout.toString();
  const seen = new Set<string>();
  const cands: DiskCandidate[] = [];
  for (const line of out.split("\n")) {
    const [path, type, fstype, uuid, mount, size] = line.trim().split(/\s+/);
    if (type !== "part" || !fstype || !uuid || !mount) continue;
    if (!["ext4", "btrfs", "ntfs", "exfat", "vfat", "f2fs"].includes(fstype)) continue;
    if (["/", "/boot", "/boot/efi", "/home", "/var", "/srv"].includes(mount)) continue;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    cands.push({ device: path, uuid, fstype, target: mount, sizeLabel: size ?? "" });
  }
  return cands;
}

function cmdSetup(): void {
  const cands = listDiskCandidates();
  if (!cands.length) {
    console.error("No removable/archive-looking disks found. Plug the disk in and retry, or set the UUID manually:");
    console.error("  bun src/cli.ts config-set --uuid <uuid> --fstype <fstype> --label <label>");
    process.exit(1);
  }
  console.log("Archive disk candidates:");
  cands.forEach((c, i) => console.log(`  ${i + 1}) ${c.device}  ${c.fstype}  ${c.sizeLabel}  mounted at ${c.target}  uuid=${c.uuid}`));
  process.stdout.write("Which one should OmO move cold files to? [1]: ");
  const buf = Buffer.alloc(16);
  const fd = openSync("/dev/stdin", "r");
  const bytes = readSync(fd, buf, 0, 16);
  if (bytes === 0) {
    console.error("\nNo interactive input — not touching disk choice. Set it with:");
    console.error("  bun src/cli.ts config-set --uuid <uuid> --fstype <fstype> --label <label>");
    process.exit(1);
  }
  const answer = buf.subarray(0, bytes).toString().trim();
  const idx = parseInt(answer || "1", 10) - 1;
  const pick = cands[idx];
  if (!pick) { console.error("Invalid choice."); process.exit(1); }
  applyTarget(pick);
}

function applyTarget(pick: DiskCandidate): void {
  const cfg = existsSync(configPath()) ? loadConfig() : { ...DEFAULT_CONFIG };
  cfg.target = { ...cfg.target, uuid: pick.uuid, fstype: pick.fstype, label: pick.target };
  saveConfig(cfg);
  console.log(`Archive disk set: ${pick.device} (${pick.fstype}) uuid=${pick.uuid}`);
  console.log("Daily run stays in PROPOSAL mode until you run `go`.");
}

function cmdConfigSet(args: string[]): void {
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const uuid = get("uuid"), fstype = get("fstype"), label = get("label"), lang = get("lang");
  const cfg = existsSync(configPath()) ? loadConfig() : { ...DEFAULT_CONFIG };
  if (uuid) cfg.target = { ...cfg.target, uuid };
  if (fstype) cfg.target = { ...cfg.target, fstype };
  if (label) cfg.target = { ...cfg.target, label };
  if (lang === "ko" || lang === "en") cfg.reportLang = lang;
  saveConfig(cfg);
  console.log(`config updated: ${configPath()} (uuid=${cfg.target.uuid || "-"}, fstype=${cfg.target.fstype}, lang=${cfg.reportLang})`);
}

function cmdConfigGet(key: string): void {
  const cfg = loadConfig();
  if (key === "uuid") console.log(cfg.target.uuid);
  else if (key === "fstype") console.log(cfg.target.fstype);
  else if (key === "label") console.log(cfg.target.label);
  else if (key === "mode") console.log(cfg.mode);
  else if (key === "lang") console.log(cfg.reportLang);
  else { console.error(`unknown key: ${key}`); process.exit(1); }
}

function cmdStatus(): void {
  const cfg = loadConfig();
  if (!cfg.target.uuid) {
    console.log("status: NOT CONFIGURED — run `setup` or `config-set --uuid ...`");
    return;
  }
  const t = resolveTarget(cfg.target.uuid, cfg.target.fstype);
  const { entries } = newStore().read();
  const archivedBytes = entries.reduce((a, e) => a + e.bytes, 0);
  console.log(`mode:            ${cfg.mode}`);
  console.log(`archive disk:    ${t ? `${t.mountPoint} (${humanBytes(t.freeBytes)} free)` : "NOT MOUNTED"}`);
  console.log(`archived units:  ${entries.length} (${humanBytes(archivedBytes)})`);
  console.log(`whitelist:       ${cfg.whitelist.join(", ")}`);
  console.log(`report:          ${reportLatest()}`);
}

function cmdRestore(pathInput: string): void {
  const cfg = loadConfig();
  if (!cfg.target.uuid) { console.error("Not configured."); process.exit(1); }
  const target = resolveTarget(cfg.target.uuid, cfg.target.fstype);
  if (!target) { console.error("Archive disk is not mounted."); process.exit(1); }
  const store = newStore();
  const { entries } = store.read();
  const p = pathInput.startsWith("/") ? pathInput : join(homedir(), pathInput);
  const hits = entries.filter((e) => e.orig === p || e.orig.startsWith(p.endsWith("/") ? p : p + "/"));
  if (!hits.length) { console.error(`Not in the index: ${p}`); process.exit(1); }
  const archiveRoot = join(target.mountPoint, cfg.target.archiveRoot);
  for (const e of hits) {
    const r = restoreEntry(e, { archiveRoot, store });
    console.log(r.status === "restored" ? `restored: ${e.orig} (${humanBytes(e.bytes)})` : `failed: ${e.orig} — ${r.reason}`);
  }
}

function cmdInstall(): void {
  const unitDir = join(homedir(), ".config/systemd/user");
  mkdirSync(unitDir, { recursive: true });
  const bunBin = Bun.which("bun") ?? process.execPath;
  const cliPath = join(TOOL_DIR, "src", "cli.ts");
  const service = [
    "[Unit]",
    "Description=OmO diskkeeper daily run",
    "After=graphical-session.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${bunBin} ${cliPath} daily`,
    "TimeoutStartSec=3600",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Run OmO diskkeeper daily at 10:30",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 10:30:00",
    "Persistent=true",
    "RandomizedDelaySec=600",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  writeFileSync(join(unitDir, "omo-diskkeeper.service"), service);
  writeFileSync(join(unitDir, "omo-diskkeeper.timer"), timer);
  for (const c of [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "omo-diskkeeper.timer"],
  ]) {
    const r = Bun.spawnSync(c);
    if ((r.exitCode ?? r.status ?? 0) !== 0) console.error(`${c.join(" ")} → ${r.stderr.toString().trim()}`);
  }
  console.log(`Timer installed (daily 10:30, jitter ±10m). bun: ${bunBin}`);
}

function cmdUninstallTimer(): void {
  for (const c of [
    ["systemctl", "--user", "disable", "--now", "omo-diskkeeper.timer"],
  ]) {
    const r = Bun.spawnSync(c);
    if ((r.exitCode ?? r.status ?? 0) !== 0) console.error(`${c.join(" ")} → ${r.stderr.toString().trim()}`);
  }
  for (const f of ["omo-diskkeeper.service", "omo-diskkeeper.timer"]) {
    try { rmSync(join(homedir(), ".config/systemd/user", f)); } catch { }
  }
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
  console.log("Timer removed. Config, index and reports were kept (~/.local/state/omo-diskkeeper) so `restore` still works.");
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "init": cmdInit(); return;
    case "setup": cmdSetup(); return;
    case "config-set": cmdConfigSet(args); return;
    case "config-get": if (!args[0]) { console.error("usage: config-get <uuid|fstype|label|mode|lang>"); process.exit(1); } cmdConfigGet(args[0]); return;
    case "daily": await runDaily(loadConfig()); return;
    case "scan": { const cfg = { ...loadConfig(), mode: "propose" as const }; await runDaily(cfg); return; }
    case "go": { const cfg = loadConfig(); cfg.mode = "execute"; saveConfig(cfg); console.log("EXECUTE mode on. Next run moves files for real."); return; }
    case "propose-only": { const cfg = loadConfig(); cfg.mode = "propose"; saveConfig(cfg); console.log("PROPOSE mode on."); return; }
    case "status": cmdStatus(); return;
    case "restore": if (!args[0]) { console.error("usage: restore <original-path>"); process.exit(1); } cmdRestore(args[0]); return;
    case "install": cmdInstall(); return;
    case "uninstall-timer": cmdUninstallTimer(); return;
    default:
      console.log("commands: init | setup | config-set | daily | scan | go | propose-only | status | restore <path> | install | uninstall-timer");
      process.exit(cmd ? 1 : 0);
  }
}

await main();
