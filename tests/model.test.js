import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "..", "plugin", "Model.js"), "utf8").replace(/^\.pragma library\s*/, "")
const loaded = { exports: {} }
new Function("module", "exports", source)(loaded, loaded.exports)
const Model = loaded.exports

const NOW = Date.parse("2026-09-27T01:00:00Z")
const secondsAgo = (seconds) => new Date(NOW - seconds * 1000).toISOString()

function rawSession(overrides = {}) {
  return {
    id: "s1",
    cwdLabel: "omarchy-omo-theme",
    title: "Implement the widget",
    activityAt: secondsAgo(30),
    runtime: { kind: "unknown", working: false, status: "unknown", evidence: "no verified session process" },
    todos: { completed: 0, pending: 0, inProgress: 0, abandoned: 0, total: 0 },
    ulw: null,
    goal: null,
    runningDelegatedTasks: 0,
    sessionPath: "/home/roach/.omo/agent/sessions/--home-roach--/2026-09-27_s1.jsonl",
    cwd: "/home/roach/omarchy-omo-theme",
    ...overrides,
  }
}

const working = { kind: "live", working: true, status: "working", evidence: "senpi extension and verified process" }
const waiting = { kind: "live", working: false, status: "waiting", evidence: "senpi extension and verified process" }
const ended = { kind: "ended", working: false, status: "ended", evidence: "session_shutdown" }
const idleProcess = { kind: "idle", working: false, status: "idle", evidence: "senpi extension and verified process" }

function listOutput(sessions, error = null) {
  return JSON.stringify({ schemaVersion: 1, sessions, error })
}

function parsed(overrides = {}) {
  return Model.parseList(listOutput([rawSession(overrides)])).sessions[0]
}

describe("parseList", () => {
  test("accepts schema 1 and sorts newest activity first", () => {
    const result = Model.parseList(listOutput([
      rawSession({ id: "old", activityAt: secondsAgo(600) }),
      rawSession({ id: "new", activityAt: secondsAgo(5) }),
      rawSession({ id: "none", activityAt: "" }),
    ]))
    expect(result.ok).toBe(true)
    expect(result.partial).toBe(false)
    expect(result.sessions.map((s) => s.id)).toEqual(["new", "old", "none"])
  })

  test("marks a bounded collector list as partial without failing", () => {
    const result = Model.parseList(listOutput([rawSession()], "scan limit reached"))
    expect(result.ok).toBe(true)
    expect(result.partial).toBe(true)
    expect(result.notice).toBe("scan limit reached")
    expect(result.sessions).toHaveLength(1)
  })

  test("rejects malformed, wrong-schema, empty, and oversized output", () => {
    expect(Model.parseList("{not json").reason).toBe("collector output is not JSON")
    expect(Model.parseList(JSON.stringify({ schemaVersion: 2, sessions: [] })).reason).toBe("unsupported schemaVersion")
    expect(Model.parseList("[]").reason).toBe("collector output is not an object")
    expect(Model.parseList("   \n").reason).toBe("empty collector output")
    const small = Model.parseList(listOutput([rawSession()]), 16)
    expect(small.ok).toBe(false)
    expect(small.reason).toBe("output limit reached")
    expect(small.sessions).toEqual([])
  })

  test("caps the list at 12 and drops entries without an id", () => {
    const many = []
    for (let i = 0; i < 15; i++) many.push(rawSession({ id: "s" + i, activityAt: secondsAgo(i) }))
    many.push(rawSession({ id: "" }))
    const result = Model.parseList(listOutput(many))
    expect(result.sessions).toHaveLength(12)
    expect(result.sessions.every((s) => s.id !== "")).toBe(true)
  })

  test("sanitizes titles and refuses unsafe paths and addresses", () => {
    const s = parsed({
      title: "line one\n\u001b[31mred\u0000  two",
      sessionPath: "relative/path.jsonl",
      cwd: "/tmp/with\nnewline",
      focus: { address: "0x55aa; rm -rf /" },
    })
    expect(s.title).toBe("line one [31mred two")
    expect(s.sessionPath).toBe("")
    expect(s.cwd).toBe("")
    expect(s.focusAddress).toBe("")
    expect(parsed({ title: "" }).title).toBe("\uc81c\ubaa9 \uc5c6\uc74c")
    expect(parsed({ focus: { address: "0x5601ab" } }).focusAddress).toBe("0x5601ab")
  })

  test("absent todos stay null and partial sessions carry the flag", () => {
    const none = parsed({ todos: null })
    expect(none.todos).toBeNull()
    expect(none.partial).toBe(false)
    expect(Model.progress(none).todo).toBeNull()
    const partial = parsed({ todos: null, partial: true })
    expect(partial.partial).toBe(true)
    expect(Model.progress(partial).todo).toBeNull()
    expect(Model.evidenceLabel(partial)).toBe("partial session data \u00b7 no verified session process")
    const missing = parsed({ todos: undefined })
    expect(missing.todos).toBeNull()
    expect(parsed({ partial: "yes" }).partial).toBe(false)
    const counted = parsed({ todos: { completed: 2, pending: 1, inProgress: 0, abandoned: 0, total: 3 }, partial: false })
    expect(counted.todos).toEqual({ completed: 2, pending: 1, inProgress: 0, abandoned: 0, total: 3 })
    expect(Model.progress(counted).todo.label).toBe("todo 2/3")
  })

  test("only a live runtime can be working", () => {
    expect(parsed({ runtime: { kind: "idle", working: true, status: "working" } }).runtime.working).toBe(false)
    expect(parsed({ runtime: working }).runtime.working).toBe(true)
    expect(parsed({ runtime: { kind: "bogus" } }).runtime).toEqual({ kind: "unknown", working: false, status: "unknown", evidence: "" })
  })
})

describe("sessionState", () => {
  const state = (overrides) => Model.sessionState(parsed(overrides), NOW)

  test("animates only on runtime.working === true", () => {
    expect(state({ runtime: working })).toBe("working")
    expect(state({ runtime: idleProcess })).toBe("idle")
    expect(state({ runningDelegatedTasks: 3, runtime: idleProcess })).toBe("idle")
    expect(state({ todos: { completed: 1, pending: 2, inProgress: 1, abandoned: 0, total: 4 }, runtime: idleProcess })).toBe("idle")
  })

  test("an unverified runtime is unknown, never idle, error, or done", () => {
    expect(state({})).toBe("unknown")
    expect(state({ runningDelegatedTasks: 3 })).toBe("unknown")
    expect(state({ goal: { status: "blocked" } })).toBe("unknown")
    expect(state({ ulw: { passed: 0, total: 2, status: "failed" } })).toBe("unknown")
    expect(state({ goal: { status: "complete" }, activityAt: secondsAgo(20) })).toBe("unknown")
    expect(state({ runtime: { kind: "bogus", working: true } })).toBe("unknown")
  })

  test("ultrawork needs a working turn and an in_progress loop together", () => {
    const loop = { passed: 1, total: 3, status: "in_progress" }
    expect(state({ runtime: working, ulw: loop })).toBe("ultrawork")
    expect(state({ ulw: loop })).toBe("unknown")
    expect(state({ runtime: idleProcess, ulw: loop })).toBe("idle")
    expect(state({ runtime: working, ulw: { passed: 3, total: 3, status: "complete" } })).toBe("working")
  })

  test("errors, waiting, ended, and success rank as designed on verified runtimes", () => {
    expect(state({ runtime: idleProcess, goal: { status: "blocked" } })).toBe("error")
    expect(state({ runtime: idleProcess, ulw: { passed: 0, total: 2, status: "failed" } })).toBe("error")
    expect(state({ runtime: working, goal: { status: "blocked" } })).toBe("error")
    expect(state({ runtime: waiting, ulw: { passed: 0, total: 2, status: "in_progress" } })).toBe("waiting")
    expect(state({ runtime: ended, goal: { status: "blocked" } })).toBe("ended")
    expect(state({ runtime: idleProcess, goal: { status: "complete" }, activityAt: secondsAgo(20) })).toBe("success")
    expect(state({ runtime: idleProcess, goal: { status: "complete" }, activityAt: secondsAgo(120) })).toBe("idle")
    expect(state({ runtime: idleProcess, ulw: { passed: 3, total: 3, status: "complete" }, activityAt: secondsAgo(59) })).toBe("success")
  })

  test("a dismissed error falls back to what the runtime proves", () => {
    const blocked = parsed({ id: "x", runtime: working, goal: { status: "blocked" } })
    expect(Model.effectiveState(blocked, NOW, {})).toBe("error")
    expect(Model.effectiveState(blocked, NOW, { x: true })).toBe("working")
    const blockedIdle = parsed({ id: "y", runtime: idleProcess, goal: { status: "blocked" } })
    expect(Model.effectiveState(blockedIdle, NOW, {})).toBe("error")
    expect(Model.effectiveState(blockedIdle, NOW, { y: true })).toBe("idle")
  })

  test("labels and evidence describe only observed facts", () => {
    expect(Model.stateLabel("ultrawork")).toBe("ultrawork")
    expect(Model.stateLabel("success")).toBe("done")
    expect(Model.stateLabel("idle")).toBe("idle")
    expect(Model.stateLabel("unknown")).toBe("unknown")
    expect(Model.stateLabel("nonsense")).toBe("unknown")
    const s = parsed({ ulw: { passed: 1, total: 3, status: "in_progress" }, runningDelegatedTasks: 2, goal: { status: "active" } })
    expect(Model.evidenceLabel(s)).toBe("no verified session process \u00b7 delegated:2 \u00b7 ulw in_progress \u00b7 no live evidence \u00b7 goal active")
    const history = parsed({ goal: { status: "blocked" }, ulw: { passed: 0, total: 2, status: "failed" } })
    expect(Model.sessionState(history, NOW)).toBe("unknown")
    expect(Model.evidenceLabel(history)).toBe("no verified session process \u00b7 ulw failed \u00b7 goal blocked")
  })
})

describe("progress", () => {
  test("shows ledger counts with labels and hides missing denominators", () => {
    const p = Model.progress(parsed({
      todos: { completed: 3, pending: 2, inProgress: 1, abandoned: 1, total: 7 },
      ulw: { passed: 2, total: 5, status: "in_progress" },
    }))
    expect(p.todo).toEqual({ completed: 3, total: 7, ratio: 3 / 7, label: "todo 3/7" })
    expect(p.ulw).toEqual({ passed: 2, total: 5, ratio: 0.4, label: "verified 2/5" })
    const none = Model.progress(parsed({ ulw: { passed: 0, total: 0, status: "in_progress" } }))
    expect(none.todo).toBeNull()
    expect(none.ulw).toBeNull()
  })

  test("never exceeds a full bar even when counts disagree", () => {
    const p = Model.progress(parsed({ todos: { completed: 9, pending: 0, inProgress: 0, abandoned: 0, total: 4 } }))
    expect(p.todo.ratio).toBe(1)
    expect(p.todo.label).toBe("todo 9/4")
  })
})

describe("aggregate", () => {
  const list = (items) => Model.parseList(listOutput(items)).sessions

  test("empty list is a quiet idle cat", () => {
    const a = Model.aggregate([], NOW, {})
    expect(a.state).toBe("idle")
    expect(a.caption).toBe("")
    expect(a.animated).toBe(false)
    expect(a.glow).toBe(false)
    expect(a.tooltip).toBe("OmO \u00b7 no senpi sessions")
  })

  test("counts active sessions and picks the highest-priority face", () => {
    const a = Model.aggregate(list([
      rawSession({ id: "a", runtime: working }),
      rawSession({ id: "b", runtime: working, ulw: { passed: 2, total: 5, status: "in_progress" } }),
      rawSession({ id: "c", runtime: waiting }),
      rawSession({ id: "d", runtime: ended }),
      rawSession({ id: "e" }),
    ]), NOW, {})
    expect(a.state).toBe("waiting")
    expect(a.active).toBe(3)
    expect(a.running).toBe(2)
    expect(a.counts.unknown).toBe(1)
    expect(a.counts.ended).toBe(1)
    expect(a.caption).toBe("3")
    expect(a.animated).toBe(true)
    expect(a.glow).toBe(true)
    expect(a.tooltip).toBe("OmO \u00b7 2 working \u00b7 1 waiting \u00b7 ulw 2/5")
  })

  test("error outranks everything, dismissal removes it, and the caption saturates", () => {
    const blocked = rawSession({ id: "err", runtime: working, goal: { status: "blocked" } })
    expect(Model.aggregate(list([blocked, rawSession({ id: "w", runtime: waiting })]), NOW, {}).state).toBe("error")
    expect(Model.aggregate(list([blocked]), NOW, { err: true }).state).toBe("working")
    const many = []
    for (let i = 0; i < 12; i++) many.push(rawSession({ id: "s" + i, runtime: working }))
    const a = Model.aggregate(list(many), NOW, {})
    expect(a.caption).toBe("9+")
    expect(a.tooltip).toBe("OmO \u00b7 12 working")
    const quiet = Model.aggregate(list([rawSession({ id: "q" }), rawSession({ id: "r", runtime: ended })]), NOW, {})
    expect(quiet.state).toBe("unknown")
    expect(quiet.tooltip).toBe("OmO \u00b7 2 sessions \u00b7 none active \u00b7 1 unverified")
    expect(quiet.caption).toBe("")
  })

  test("a loop file alone never glows or animates", () => {
    const a = Model.aggregate(list([rawSession({ id: "loop", ulw: { passed: 1, total: 3, status: "in_progress" } })]), NOW, {})
    expect(a.state).toBe("unknown")
    expect(a.glow).toBe(false)
    expect(a.animated).toBe(false)
  })

  test("historical blocked goals without a verified runtime never pin the bar to error", () => {
    const a = Model.aggregate(list([
      rawSession({ id: "old", goal: { status: "blocked" }, ulw: { passed: 0, total: 3, status: "failed" } }),
      rawSession({ id: "live", runtime: idleProcess }),
    ]), NOW, {})
    expect(a.state).toBe("idle")
    expect(a.counts.error).toBe(0)
    expect(a.counts.unknown).toBe(1)
  })
})

describe("filters", () => {
  const sessions = Model.parseList(listOutput([
    rawSession({ id: "w", runtime: working }),
    rawSession({ id: "x", runtime: waiting }),
    rawSession({ id: "e", runtime: ended }),
    rawSession({ id: "b", runtime: idleProcess, goal: { status: "blocked" } }),
    rawSession({ id: "i" }),
  ])).sessions

  test("selects by display state", () => {
    expect(Model.filterSessions(sessions, "all", NOW, {}).map((s) => s.id)).toEqual(["w", "x", "e", "b", "i"])
    expect(Model.filterSessions(sessions, "active", NOW, {}).map((s) => s.id)).toEqual(["w", "x"])
    expect(Model.filterSessions(sessions, "ended", NOW, {}).map((s) => s.id)).toEqual(["e"])
    expect(Model.filterSessions(sessions, "error", NOW, {}).map((s) => s.id)).toEqual(["b"])
    expect(Model.filterSessions(sessions, "error", NOW, { b: true })).toEqual([])
  })

  test("cycles filters in both directions and clamps the cursor", () => {
    expect(Model.nextFilter("all", 1)).toBe("active")
    expect(Model.nextFilter("all", -1)).toBe("error")
    expect(Model.nextFilter("bogus", 1)).toBe("active")
    expect(Model.filterLabel("active")).toBe("Active")
    expect(Model.clampIndex(7, 3)).toBe(2)
    expect(Model.clampIndex(-1, 3)).toBe(0)
    expect(Model.clampIndex(2, 0)).toBe(0)
  })
})

describe("text width", () => {
  test("counts CJK as two columns and elides without splitting a wide glyph", () => {
    const title = "인증 미들웨어 리팩터링 및 회귀 테스트 추가"
    expect(Model.displayWidth("abc")).toBe(3)
    expect(Model.displayWidth("인증")).toBe(4)
    expect(Model.displayWidth(title)).toBe(18 * 2 + 6)
    expect(Model.elide(title, 9)).toBe("인증 미\u2026")
    expect(Model.displayWidth(Model.elide(title, 9))).toBeLessThanOrEqual(9)
    expect(Model.elide("short", 9)).toBe("short")
    expect(Model.elide("exactly9c", 9)).toBe("exactly9c")
    expect(Model.elide("exactly10c", 9)).toBe("exactly1\u2026")
  })

  test("emoji count two and combining marks count zero", () => {
    expect(Model.displayWidth("\u{1F408}")).toBe(2)
    expect(Model.displayWidth("e\u0301")).toBe(1)
    expect(Model.elide("\u{1F408}\u{1F408}\u{1F408}", 4)).toBe("\u{1F408}\u2026")
  })
})

describe("time and polling", () => {
  test("relative time is deterministic against a fixed now", () => {
    expect(Model.relativeTime(NOW - 10 * 1000, NOW)).toBe("just now")
    expect(Model.relativeTime(NOW - 5 * 60 * 1000, NOW)).toBe("5 min ago")
    expect(Model.relativeTime(NOW - 3 * 3600 * 1000, NOW)).toBe("3 h ago")
    expect(Model.relativeTime(NOW - 2 * 86400 * 1000, NOW)).toBe("2 d ago")
    expect(Model.relativeTime(0, NOW)).toBe("")
    expect(Model.relativeTime(NOW + 5000, NOW)).toBe("just now")
  })

  test("poll interval slows without active sessions and backs off within bounds", () => {
    expect(Model.pollInterval(true, 5000, 15000, 0)).toBe(5000)
    expect(Model.pollInterval(false, 5000, 15000, 0)).toBe(15000)
    expect(Model.pollInterval(true, 5000, 15000, 3)).toBe(40000)
    expect(Model.pollInterval(true, 5000, 15000, 4)).toBe(60000)
    expect(Model.pollInterval(true, 500, 15000, 0)).toBe(2000)
    expect(Model.pollInterval(false, 5000, 900000, 0)).toBe(60000)
  })

  test("settings coerce strings and clamp ranges", () => {
    const settings = { pollMs: "7000", reduceMotion: "yes", agentDir: "  /fixture/agent " }
    expect(Model.settingInt(settings, "pollMs", 5000, 2000, 30000)).toBe(7000)
    expect(Model.settingInt({ pollMs: "nope" }, "pollMs", 5000, 2000, 30000)).toBe(5000)
    expect(Model.settingInt({ pollMs: 999999 }, "pollMs", 5000, 2000, 30000)).toBe(30000)
    expect(Model.settingBool(settings, "reduceMotion", false)).toBe(true)
    expect(Model.settingBool({}, "reduceMotion", false)).toBe(false)
    expect(Model.settingString(settings, "agentDir")).toBe("/fixture/agent")
  })
})

describe("commands", () => {
  const script = "/home/roach/.config/omarchy/plugins/io.github.tmdgusya.omo/omo_sessions.py"

  test("list and view commands are argv arrays with optional fixture roots", () => {
    expect(Model.listCommand(script, "", "")).toEqual(["python3", "-B", script, "list"])
    expect(Model.listCommand(script, "/fx/agent", "/fx/task")).toEqual(["python3", "-B", script, "--agent-dir", "/fx/agent", "--task-dir", "/fx/task", "list"])
    expect(Model.listCommand(script, "relative", "")).toEqual(["python3", "-B", script, "list"])
    expect(Model.listCommand("omo_sessions.py", "", "")).toBeNull()
    const path = "/home/roach/.omo/agent/sessions/x/2026_s1.jsonl"
    expect(Model.viewCommand(script, "/fx/agent", path)).toEqual(["python3", "-B", script, "--agent-dir", "/fx/agent", "view", "--session", path])
    expect(Model.viewCommand(script, "", "/etc/passwd")).toBeNull()
    expect(Model.viewCommand(script, "", "sessions/x.jsonl")).toBeNull()
  })

  test("launch opens a fresh ghostty running senpi with the live-state extension, without resume", () => {
    const extension = "/home/roach/.config/omarchy/plugins/io.github.tmdgusya.omo/omo-status.ts"
    expect(Model.launchCommand("/home/roach/omarchy-omo-theme", extension)).toEqual([
      "ghostty", "--gtk-single-instance=false", "--working-directory=/home/roach/omarchy-omo-theme",
      "-e", "senpi", "-e", extension,
    ])
    expect(Model.launchCommand("", extension)).toEqual(["ghostty", "--gtk-single-instance=false", "-e", "senpi", "-e", extension])
    expect(Model.launchCommand("relative/dir", extension)).toEqual(["ghostty", "--gtk-single-instance=false", "-e", "senpi", "-e", extension])
    expect(Model.launchCommand("/tmp", "omo-status.ts")).toEqual(["ghostty", "--gtk-single-instance=false", "--working-directory=/tmp", "-e", "senpi"])
    expect(Model.launchCommand("/tmp", "/etc/passwd")).toEqual(["ghostty", "--gtk-single-instance=false", "--working-directory=/tmp", "-e", "senpi"])
    expect(Model.launchCommand("/tmp")).toEqual(["ghostty", "--gtk-single-instance=false", "--working-directory=/tmp", "-e", "senpi"])
  })

  test("launch uses a configured executable outside desktop PATH as one argv element", () => {
    const extension = "/opt/omo widget/omo-status.ts"
    const executable = "/opt/other bin/senpi"
    expect(Model.launchCommand("/tmp/project", extension, executable)).toEqual([
      "ghostty", "--gtk-single-instance=false", "--working-directory=/tmp/project",
      "-e", executable, "-e", extension,
    ])
    expect(Model.launchCommand("/tmp", extension, "relative/senpi")).toBeNull()
  })

  test("focus exists only for a proven hyprland address", () => {
    expect(Model.focusCommand("0x5601abcdef")).toEqual(["hyprctl", "eval", "hl.dispatch(hl.dsp.focus({ window = 'address:0x5601abcdef' }))"])
    expect(Model.focusCommand("")).toBeNull()
    expect(Model.focusCommand("0x'); os.exit(")).toBeNull()
    expect(Model.focusCommand(undefined)).toBeNull()
  })

  test("launch uses the collector profile rather than an empty default profile", () => {
    expect(Model.launchCommand("/tmp", "/opt/omo-status.ts", "/opt/senpi", "/home/user/omo profile")).toEqual([
      "ghostty", "--gtk-single-instance=false", "--working-directory=/tmp",
      "-e", "env", "SENPI_CODING_AGENT_DIR=/home/user/omo profile",
      "/opt/senpi", "-e", "/opt/omo-status.ts",
    ])
  })

  test("open focuses a verified window and blocks an unaddressable running session", () => {
    const options = { extensionPath: "/opt/omo-status.ts", launcherPath: "/opt/omo", agentDir: "/tmp/agent" }
    expect(Model.openCommand(parsed({ runtime: working, focus: { address: "0xabc1" } }), options)).toEqual({
      kind: "focus", argv: Model.focusCommand("0xabc1"), reason: "",
    })
    expect(Model.openCommand(parsed({ runtime: idleProcess }), options)).toEqual({
      kind: "blocked", argv: null, reason: "running elsewhere",
    })
    expect(Model.openCommand(parsed({ runtime: { kind: "unknown", status: "recent", working: false } }), options)).toEqual({
      kind: "blocked", argv: null, reason: "running elsewhere",
    })
  })

  test("open resumes an ended session with the same launcher and agent directory", () => {
    const options = { extensionPath: "/opt/omo-status.ts", launcherPath: "/opt/omo", agentDir: "/tmp/agent" }
    expect(Model.openCommand(parsed({ runtime: ended }), options)).toEqual({
      kind: "resume",
      argv: ["ghostty", "--gtk-single-instance=false", "--working-directory=/home/roach/omarchy-omo-theme",
        "-e", "env", "SENPI_CODING_AGENT_DIR=/tmp/agent", "/opt/omo", "--session",
        "/home/roach/.omo/agent/sessions/--home-roach--/2026-09-27_s1.jsonl", "-e", "/opt/omo-status.ts"],
      reason: "",
    })
    expect(Model.openCommand(parsed({ runtime: ended, sessionPath: "relative.jsonl" }), options).kind).toBe("blocked")
    expect(Model.launchCommand("/tmp", "/opt/omo-status.ts", "/opt/omo", "/tmp/agent")).toContain("/opt/omo")
    const tracked = Model.openCommand(parsed({ runtime: ended }), { ...options, trackingInstalled: true })
    expect(tracked.argv).not.toContain("/opt/omo-status.ts")
    expect(Model.launchCommand("/tmp", "/opt/omo-status.ts", "/opt/omo", "/tmp/agent", true)).not.toContain("/opt/omo-status.ts")
  })
})

describe("recent runtime", () => {
  test("shows recent in Active and caption without animation", () => {
    const session = parsed({ runtime: { kind: "unknown", status: "recent", working: false } })
    expect(Model.sessionState(session, NOW)).toBe("recent")
    expect(Model.filterSessions([session], "active", NOW, {})).toEqual([session])
    const summary = Model.aggregate([session], NOW, {})
    expect(summary.caption).toBe("1")
    expect(summary.animated).toBe(false)
    expect(summary.glow).toBe(false)
    expect(Model.stateLabel("recent")).toBe("recent")
  })
})

describe("v3 faces and copy", () => {
  test("faceFor maps display states to the face vocabulary and sleeps without sessions", () => {
    expect(Model.faceFor("working", 2)).toBe("working")
    expect(Model.faceFor("ultrawork", 1)).toBe("ultrawork")
    expect(Model.faceFor("waiting", 1)).toBe("waiting")
    expect(Model.faceFor("error", 1)).toBe("error")
    expect(Model.faceFor("success", 1)).toBe("done")
    expect(Model.faceFor("idle", 3)).toBe("idle")
    expect(Model.faceFor("unknown", 1)).toBe("idle")
    expect(Model.faceFor("idle", 0)).toBe("sleep")
    expect(Model.faceFor("ended", 4)).toBe("sleep")
  })

  test("every face has a text form and one line of Korean copy", () => {
    const seen = new Set()
    for (const face of Model.FACES) {
      expect(Model.textFace(face)).not.toBe("")
      expect(Model.copyFor(face)).toMatch(/\uc694\.$/)
      seen.add(Model.copyFor(face))
    }
    expect(seen.size).toBe(Model.FACES.length)
    expect(Model.textFace("ultrawork")).toBe("OmO\u26a1")
    expect(Model.textFace("sleep")).toBe("-m-")
    expect(Model.textFace("bogus")).toBe("OmO")
    expect(Model.copyFor("bogus")).toBe(Model.copyFor("idle"))
  })

  test("the bar shows copy only while a session needs eyes", () => {
    expect(Model.barCopy("working")).toBe(Model.copyFor("working"))
    expect(Model.barCopy("ultrawork")).toBe(Model.copyFor("ultrawork"))
    expect(Model.barCopy("waiting")).toBe(Model.copyFor("waiting"))
    expect(Model.barCopy("error")).toBe(Model.copyFor("error"))
    expect(Model.barCopy("idle")).toBe("")
    expect(Model.barCopy("sleep")).toBe("")
    expect(Model.barCopy("done")).toBe("")
  })

  test("the badge counts live sessions and blocked ones alike", () => {
    const list = (items) => Model.parseList(listOutput(items)).sessions
    expect(Model.badgeCount(Model.aggregate([], NOW, {}))).toBe(0)
    const blocked = rawSession({ id: "err", runtime: working, goal: { status: "blocked" } })
    expect(Model.badgeCount(Model.aggregate(list([blocked]), NOW, {}))).toBe(1)
    expect(Model.badgeCount(Model.aggregate(list([blocked, rawSession({ id: "w", runtime: waiting }), rawSession({ id: "e", runtime: ended })]), NOW, {}))).toBe(2)
    expect(Model.badgeCount(Model.aggregate(list([blocked]), NOW, { err: true }))).toBe(1)
  })

  test("accents are earned by state only", () => {
    expect(Model.accentFor("working")).toBe("aqua")
    expect(Model.accentFor("ultrawork")).toBe("aqua")
    expect(Model.accentFor("waiting")).toBe("amber")
    expect(Model.accentFor("error")).toBe("coral")
    expect(Model.accentFor("done")).toBe("")
    expect(Model.accentFor("idle")).toBe("")
    expect(Model.accentFor("sleep")).toBe("")
  })

  test("Korean state labels cover every display state", () => {
    const labels = Model.STATES.map((state) => Model.stateLabelKo(state))
    expect(labels.every((label) => label !== "")).toBe(true)
    expect(new Set(labels).size).toBe(Model.STATES.length)
    expect(Model.stateLabelKo("nonsense")).toBe(Model.stateLabelKo("unknown"))
  })

  test("age labels are Korean and deterministic against a fixed now", () => {
    expect(Model.ageLabel(NOW - 10 * 1000, NOW)).toBe("\ubc29\uae08")
    expect(Model.ageLabel(NOW - 5 * 60 * 1000, NOW)).toBe("5\ubd84 \uc804")
    expect(Model.ageLabel(NOW - 3 * 3600 * 1000, NOW)).toBe("3\uc2dc\uac04 \uc804")
    expect(Model.ageLabel(NOW - 2 * 86400 * 1000, NOW)).toBe("2\uc77c \uc804")
    expect(Model.ageLabel(0, NOW)).toBe("")
  })

  test("open reasons are spoken in the panel's voice", () => {
    expect(Model.reasonKo("running elsewhere")).toBe("\ub2e4\ub978 \ud130\ubbf8\ub110\uc5d0\uc11c \uc5f4\ub824 \uc788\uc5b4\uc694.")
    expect(Model.reasonKo("invalid session path or agent directory")).toBe("\uc138\uc158 \ud30c\uc77c\uc744 \ucc3e\uc9c0 \ubabb\ud588\uc5b4\uc694.")
    expect(Model.reasonKo("")).toBe("\uc774 \uc138\uc158\uc740 \uc5f4 \uc218 \uc5c6\uc5b4\uc694.")
    expect(Model.reasonKo("custom reason")).toBe("custom reason")
  })

  test("summary line counts by need and stays quiet when nothing runs", () => {
    const list = (items) => Model.parseList(listOutput(items)).sessions
    expect(Model.summaryLine(Model.aggregate([], NOW, {}))).toBe("OmO \u00b7 \uc138\uc158 \uc5c6\uc74c")
    const busy = Model.aggregate(list([
      rawSession({ id: "a", runtime: working }),
      rawSession({ id: "b", runtime: working, ulw: { passed: 1, total: 3, status: "in_progress" } }),
      rawSession({ id: "c", runtime: waiting }),
      rawSession({ id: "d", runtime: idleProcess, goal: { status: "blocked" } }),
      rawSession({ id: "e", runtime: idleProcess, goal: { status: "complete" }, activityAt: secondsAgo(10) }),
    ]), NOW, {})
    expect(Model.summaryLine(busy)).toBe("OmO \u00b7 \uc77c\ud558\ub294 \uc911 2 \u00b7 \uacb0\uc815 \ud544\uc694 2 \u00b7 \uc644\ub8cc 1")
    const quiet = Model.aggregate(list([rawSession({ id: "q", runtime: idleProcess }), rawSession({ id: "r", runtime: ended })]), NOW, {})
    expect(Model.summaryLine(quiet)).toBe("OmO \u00b7 \uc138\uc158 2 \u00b7 \uc26c\ub294 \uc911")
  })

  test("squircle path draws four cubic corners inside the box at the icon ratio", () => {
    const path = Model.squirclePath(40, 20)
    expect(path.startsWith("M4.5 0")).toBe(true)
    expect(path.endsWith("Z")).toBe(true)
    expect(path.match(/C/g)).toHaveLength(4)
    const numbers = path.match(/-?\d+(\.\d+)?/g).map(Number)
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0)
    expect(numbers.filter((n, i) => i % 2 === 0).every((x) => x <= 40)).toBe(true)
    expect(numbers.filter((n, i) => i % 2 === 1).every((y) => y <= 20)).toBe(true)
    expect(Model.squirclePath(20, 20, 100).startsWith("M10 0")).toBe(true)
    expect(Model.squirclePath(20, 20, 2).startsWith("M2 0")).toBe(true)
  })
})

describe("v3 sections", () => {
  const list = (items) => Model.parseList(listOutput(items)).sessions
  const sessions = list([
    rawSession({ id: "idle-plain", runtime: idleProcess, activityAt: secondsAgo(5) }),
    rawSession({ id: "work", runtime: working, activityAt: secondsAgo(10) }),
    rawSession({ id: "ulw", runtime: working, ulw: { passed: 1, total: 3, status: "in_progress" }, activityAt: secondsAgo(20) }),
    rawSession({ id: "recent", runtime: { kind: "unknown", status: "recent", working: false }, activityAt: secondsAgo(30) }),
    rawSession({ id: "ask", runtime: waiting, activityAt: secondsAgo(40) }),
    rawSession({ id: "blocked", runtime: working, goal: { status: "blocked" }, activityAt: secondsAgo(50) }),
    rawSession({ id: "fresh-done", runtime: idleProcess, goal: { status: "complete" }, activityAt: secondsAgo(30) }),
    rawSession({ id: "old-done", runtime: idleProcess, ulw: { passed: 3, total: 3, status: "complete" }, activityAt: secondsAgo(900) }),
    rawSession({ id: "gone", runtime: ended, activityAt: secondsAgo(1000) }),
    rawSession({ id: "mystery", activityAt: secondsAgo(2000) }),
  ])

  test("groups by need, pins verified work first, and keeps collector order otherwise", () => {
    const sections = Model.groupSections(sessions, NOW, {})
    expect(sections.map((s) => s.key)).toEqual(["active", "decide", "done", "history"])
    expect(sections.map((s) => s.title)).toEqual(["\uc9c4\ud589 \uc911", "\uacb0\uc815 \ud544\uc694", "\uc644\ub8cc", "\uc774\uc804 \uae30\ub85d"])
    const ids = (key) => sections.find((s) => s.key === key).rows.map((r) => r.session.id)
    expect(ids("active")).toEqual(["work", "ulw", "idle-plain", "recent"])
    expect(ids("decide")).toEqual(["ask", "blocked"])
    expect(ids("done")).toEqual(["fresh-done", "old-done"])
    expect(ids("history")).toEqual(["gone", "mystery"])
  })

  test("rows carry the state and the face the card shows", () => {
    const sections = Model.groupSections(sessions, NOW, {})
    const row = (id) => sections.flatMap((s) => s.rows).find((r) => r.session.id === id)
    expect(row("ulw")).toMatchObject({ state: "ultrawork", face: "ultrawork", section: "active" })
    expect(row("blocked")).toMatchObject({ state: "error", face: "error", section: "decide" })
    expect(row("fresh-done")).toMatchObject({ state: "success", face: "done" })
    expect(row("old-done")).toMatchObject({ state: "idle", face: "done", section: "done" })
    expect(row("gone")).toMatchObject({ state: "ended", face: "sleep" })
    expect(row("mystery")).toMatchObject({ state: "unknown", face: "idle", section: "history" })
  })

  test("a dismissed block returns to the section its runtime proves", () => {
    const sections = Model.groupSections(sessions, NOW, { blocked: true })
    expect(sections.find((s) => s.key === "decide").rows.map((r) => r.session.id)).toEqual(["ask"])
    expect(sections.find((s) => s.key === "active").rows.map((r) => r.session.id)).toEqual(["work", "ulw", "blocked", "idle-plain", "recent"])
  })

  test("flattening keeps the main sections in order and parks history separately", () => {
    const flat = Model.flattenSections(Model.groupSections(sessions, NOW, {}))
    expect(flat.main.map((r) => r.session.id)).toEqual(["work", "ulw", "idle-plain", "recent", "ask", "blocked", "fresh-done", "old-done"])
    expect(flat.main.map((r) => r.first)).toEqual([true, false, false, false, true, false, true, false])
    expect(flat.main[4]).toMatchObject({ title: "\uacb0\uc815 \ud544\uc694", count: 2, section: "decide" })
    expect(flat.history.map((r) => r.session.id)).toEqual(["gone", "mystery"])
    expect(flat.history[0]).toMatchObject({ first: true, count: 2, title: "\uc774\uc804 \uae30\ub85d" })
    const empty = Model.flattenSections(Model.groupSections([], NOW, {}))
    expect(empty.main).toEqual([])
    expect(empty.history).toEqual([])
  })
})

describe("view text", () => {
  test("bounds lines and bytes and strips control characters", () => {
    const lines = []
    for (let i = 1; i <= 30; i++) lines.push("line " + i)
    const out = Model.viewText(lines.join("\r\n") + "\n\n")
    const outLines = out.split("\n")
    expect(outLines).toHaveLength(25)
    expect(outLines[0]).toBe("line 1")
    expect(outLines[23]).toBe("line 24")
    expect(outLines[24]).toBe("\u2026")
    expect(Model.viewText("a\u001b[0mb\tc")).toBe("a[0mb\tc")
    expect(Model.viewText("x".repeat(100), 10)).toBe("x".repeat(10) + "\n\u2026")
    expect(Model.viewText("")).toBe("")
  })

  test("hashes are stable and distinguish outputs", () => {
    expect(Model.textHash("abc")).toBe(Model.textHash("abc"))
    expect(Model.textHash("abc")).not.toBe(Model.textHash("abd"))
    expect(Model.textHash("")).toBe(Model.textHash(null))
  })
})
