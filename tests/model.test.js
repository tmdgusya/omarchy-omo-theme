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
    expect(parsed({ title: "" }).title).toBe("Untitled")
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
