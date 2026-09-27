import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
function load(rel) {
  const source = readFileSync(join(here, "..", "plugin", rel), "utf8").replace(/^\.pragma library\s*/, "")
  const loaded = { exports: {} }
  new Function("module", "exports", source)(loaded, loaded.exports)
  return loaded.exports
}
const Model = load("Model.js")
const Notify = load("notify/Notify.js")

const NOW = Date.parse("2026-09-27T01:00:00Z")
const iso = (ms) => new Date(ms).toISOString()

const RUNTIME = {
  working: { kind: "live", working: true, status: "working", evidence: "extension" },
  waiting: { kind: "live", working: false, status: "waiting", evidence: "extension" },
  idle: { kind: "idle", working: false, status: "idle", evidence: "extension" },
  unknown: { kind: "unknown", working: false, status: "unknown", evidence: "no verified session process" },
  recent: { kind: "unknown", working: false, status: "recent", evidence: "recent write" },
  ended: { kind: "ended", working: false, status: "ended", evidence: "process gone" },
}

function raw(id, runtime, extra = {}, at = NOW) {
  return { id, title: "Session " + id, activityAt: iso(at), runtime: RUNTIME[runtime], ulw: null, goal: null, ...extra }
}

function parse(...sessions) {
  const result = Model.parseList(JSON.stringify({ schemaVersion: 1, sessions }))
  expect(result.ok).toBe(true)
  return result.sessions
}

function run(memory, sessions, now = NOW) {
  return Notify.step(memory, sessions, now, Model.effectiveState)
}

function edge(before, after, now = NOW) {
  const first = run(Notify.emptyMemory(), parse(before), now - 60000)
  return run(first.memory, parse(after), now).events
}

describe("baseline", () => {
  test("the first poll records states and sends nothing", () => {
    const sessions = parse(raw("a", "waiting"), raw("b", "idle", { goal: { status: "blocked" } }), raw("c", "working"))
    const result = run(Notify.emptyMemory(), sessions)
    expect(result.events).toEqual([])
    expect(result.memory.baselined).toBe(true)
    expect(result.memory.states).toEqual({ a: "waiting", b: "error", c: "working" })
  })

  test("a session first seen after the baseline is baselined too", () => {
    const first = run(Notify.emptyMemory(), parse(raw("a", "idle")))
    const second = run(first.memory, parse(raw("a", "idle"), raw("b", "waiting")))
    expect(second.events).toEqual([])
    expect(second.memory.states.b).toBe("waiting")
  })
})

describe("four transitions", () => {
  test("-> waiting", () => {
    const [e] = edge(raw("a", "working"), raw("a", "waiting"))
    expect(e).toMatchObject({ kind: "waiting", face: "waiting", urgency: "normal", timeoutMs: 12000, headline: "OmO is waiting", body: "Session a" })
  })

  test("working and ultrawork -> idle is a finished turn", () => {
    const ulw = { ulw: { passed: 1, total: 3, status: "in_progress" } }
    for (const before of [raw("a", "working"), raw("a", "working", ulw)]) {
      const [e] = edge(before, raw("a", "idle", {}, NOW - 120000))
      expect(e).toMatchObject({ kind: "finished", face: "idle", urgency: "low", timeoutMs: 5000, headline: "Turn finished" })
    }
  })

  test("goal complete inside the 60 s window", () => {
    const [e] = edge(raw("a", "working"), raw("a", "idle", { goal: { status: "complete" } }, NOW - 10000))
    expect(e).toMatchObject({ kind: "complete", face: "success", urgency: "normal", timeoutMs: 8000, headline: "Goal complete" })
  })

  test("blocked / failed is a persistent critical card", () => {
    for (const extra of [{ goal: { status: "blocked" } }, { ulw: { passed: 0, total: 2, status: "failed" } }]) {
      const [e] = edge(raw("a", "working"), raw("a", "idle", extra))
      expect(e).toMatchObject({ kind: "error", face: "error", urgency: "critical", timeoutMs: 0, headline: "Needs a decision" })
    }
  })
})

describe("suppression", () => {
  test("one card per session per 30 s, error exempt, other sessions unaffected", () => {
    let m = run(Notify.emptyMemory(), parse(raw("a", "working"), raw("b", "working")), NOW).memory
    let r = run(m, parse(raw("a", "waiting"), raw("b", "working")), NOW + 1000)
    expect(r.events.map((e) => e.kind)).toEqual(["waiting"])
    r = run(r.memory, parse(raw("a", "working"), raw("b", "waiting")), NOW + 5000)
    expect(r.events.map((e) => [e.sessionId, e.kind])).toEqual([["b", "waiting"]])
    r = run(r.memory, parse(raw("a", "idle", {}, NOW - 120000), raw("b", "waiting")), NOW + 10000)
    expect(r.events).toEqual([])
    r = run(r.memory, parse(raw("a", "idle", { goal: { status: "blocked" } }), raw("b", "waiting")), NOW + 12000)
    expect(r.events.map((e) => e.kind)).toEqual(["error"])
    r = run(r.memory, parse(raw("a", "working"), raw("b", "waiting")), NOW + 50000)
    r = run(r.memory, parse(raw("a", "waiting"), raw("b", "waiting")), NOW + 52000)
    expect(r.events.map((e) => e.kind)).toEqual(["waiting"])
  })
})

describe("no inferred states", () => {
  test("unverified, recent, and ended sessions never notify", () => {
    const history = { ulw: { passed: 0, total: 2, status: "failed" }, goal: { status: "blocked" } }
    const pairs = [
      [raw("a", "working"), raw("a", "unknown", history)],
      [raw("a", "working"), raw("a", "recent")],
      [raw("a", "working"), raw("a", "ended", history)],
      [raw("a", "unknown", { ulw: { passed: 0, total: 2, status: "in_progress" } }), raw("a", "unknown", { goal: { status: "complete" } })],
      [raw("a", "waiting"), raw("a", "idle", {}, NOW - 120000)],
      [raw("a", "unknown"), raw("a", "idle", {}, NOW - 120000)],
    ]
    for (const [before, after] of pairs) expect(edge(before, after)).toEqual([])
  })

  test("a stale goal outside the success window is not a completion", () => {
    expect(edge(raw("a", "working"), raw("a", "idle", { goal: { status: "complete" } }, NOW - 120000)).map((e) => e.kind)).toEqual(["finished"])
  })
})

describe("argv and replace ids", () => {
  const assets = "/home/u/.config/omarchy/plugins/io.github.tmdgusya.omo/assets"

  test("exact §4.4 argv", () => {
    const [e] = edge(raw("s-1", "working"), raw("s-1", "waiting"))
    expect(Notify.sendArgs(e, assets, undefined)).toEqual([
      "/usr/share/omarchy/bin/omarchy-notification-send", "--app-name", "OmO",
      "-i", "file://" + assets + "/omo-cat-waiting.svg", "-u", "normal", "-t", "12000", "-p",
      "OmO is waiting", "Session s-1",
      "--exec", "/usr/share/omarchy/bin/omarchy-shell", "io.github.tmdgusya.omo", "focus", "s-1",
    ])
    expect(Notify.sendArgs(e, assets, 42)).toContain("-r")
    expect(Notify.sendArgs(e, assets, 42).slice(10, 12)).toEqual(["-r", "42"])
    expect(Notify.sendArgs(e, "relative/assets", 0)).toBeNull()
  })

  test("an id that is not a plain token gets no click action", () => {
    const [e] = edge(raw("a b", "working"), raw("a b", "waiting"))
    expect(Notify.sendArgs(e, assets, 0)).not.toContain("--exec")
  })

  test("the printed id replaces the session's next card; gone sessions are forgotten", () => {
    let m = run(Notify.emptyMemory(), parse(raw("a", "working"))).memory
    m = Notify.rememberReplaceId(m, "a", "17\n")
    expect(m.replaceIds).toEqual({ a: 17 })
    expect(Notify.rememberReplaceId(m, "a", "error").replaceIds).toEqual({ a: 17 })
    const r = run(m, parse(raw("a", "waiting")), NOW + 1000)
    expect(Notify.sendArgs(r.events[0], assets, r.memory.replaceIds.a).slice(10, 12)).toEqual(["-r", "17"])
    expect(run(r.memory, parse(raw("b", "idle")), NOW + 2000).memory).toMatchObject({ states: { b: "idle" }, replaceIds: {}, lastSentMs: {} })
  })
})

describe("settings", () => {
  test("reads the plugin's bar entry from shell.json", () => {
    const json = JSON.stringify({ bar: { layout: { left: [{ id: "roach.workspaces" }, { id: "io.github.tmdgusya.omo", notifyEnabled: false }] } } })
    expect(Model.settingBool(Notify.barSettings(json, "io.github.tmdgusya.omo"), "notifyEnabled", true)).toBe(false)
    expect(Notify.barSettings("{not json", "io.github.tmdgusya.omo")).toEqual({})
    expect(Model.settingBool(Notify.barSettings("{}", "io.github.tmdgusya.omo"), "notifyEnabled", true)).toBe(true)
  })
})
