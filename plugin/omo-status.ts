/** Optional senpi extension: process-bound, per-session turn state without transcript data. */
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@code-yeongyu/senpi";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,100}$/;

async function processStart(): Promise<string> {
  const line = await readFile(`/proc/${process.pid}/stat`, "utf8");
  return line.slice(line.lastIndexOf(") ") + 2).split(" ")[19] ?? "";
}

export default function (pi: ExtensionAPI): void {
  const runtime = process.env.XDG_RUNTIME_DIR;
  let directory: string | undefined;
  let sessionId: string | undefined;
  let start: string | undefined;
  let state: "live" | "idle" | "ended" = "idle";
  let waiting = false;

  async function save(): Promise<void> {
    if (!runtime || !directory || !sessionId || !start) return;
    const path = join(directory, `${sessionId}.json`);
    const temporary = join(directory, `.${sessionId}.${process.pid}.${crypto.randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify({
        version: 1, sessionId, pid: process.pid, processStart: start,
        state, waiting,
      }), { mode: 0o600 });
      await rename(temporary, path);
      await writeFile(`${temporary}.signal`, crypto.randomUUID(), { mode: 0o600 });
      await rename(`${temporary}.signal`, join(runtime, "omo-session-state.changed"));
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(`${temporary}.signal`, { force: true }).catch(() => {});
      // Desktop integration is optional; never interrupt the agent.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionId = undefined;
    directory = undefined;
    if (!runtime) return;
    const id = ctx.sessionManager.getSessionId();
    // Fresh sessions allocate their file lazily, after session_start.
    if (!ID.test(id)) return;
    try {
      const info = await lstat(runtime);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return;
      const dir = join(runtime, "omo-session-state");
      await mkdir(dir, { mode: 0o700, recursive: true });
      const dirInfo = await lstat(dir);
      if (!dirInfo.isDirectory() || dirInfo.uid !== process.getuid?.()
          || (dirInfo.mode & 0o077) !== 0) return;
      start = await processStart();
      if (!start || !/^\d+$/.test(start)) return;
      directory = dir;
      sessionId = id;
      state = "idle";
      waiting = false;
      await save();
    } catch {
      // Missing runtime dir or /proc: collector will report unknown.
    }
  });
  pi.on("agent_start", async () => {
    state = "live";
    waiting = false;
    await save();
  });
  pi.on("agent_settled", async () => {
    state = "idle";
    waiting = false;
    await save();
  });
  pi.on("session_abort", async () => {
    state = "idle";
    waiting = false;
    await save();
  });
  pi.on("ui_prompt_start", async () => {
    waiting = true;
    await save();
  });
  pi.on("ui_prompt_end", async () => {
    waiting = false;
    await save();
  });
  pi.on("session_shutdown", async () => {
    state = "ended";
    waiting = false;
    await save();
    sessionId = undefined;
  });
}
