.pragma library

// Pure transition logic for OmO desktop notifications (concept.md §4.4).
// No QML types, no I/O, no clock: every function takes plain values and
// returns plain values, so the same file runs under `bun test`
// (tests/notify.test.js strips the pragma) and inside the shell via
// `import "Notify.js" as Notify`.
//
// Input: sessions already normalized by Model.parseList, plus Model's own
// state function (Model.effectiveState) passed in by the caller. This file
// never derives a state itself — it only reacts to edges between the states
// Model reports, and only for the four events below.

var SENDER = "/usr/share/omarchy/bin/omarchy-notification-send"
var SHELL_IPC = "/usr/share/omarchy/bin/omarchy-shell"
var IPC_TARGET = "io.github.tmdgusya.omo"
var APP_NAME = "OmO"
var SUPPRESS_MS = 30000     // at most one card per session per 30 s (error exempt)
var MAX_TRACKED = 12        // Model.MAX_SESSIONS; memory never grows past the listed sessions

// kind -> card. timeoutMs 0 = persistent (critical cards never expire).
var EVENTS = {
  waiting: { face: "waiting", urgency: "normal", timeoutMs: 12000, headline: "OmO is waiting" },
  finished: { face: "idle", urgency: "low", timeoutMs: 5000, headline: "Turn finished" },
  complete: { face: "success", urgency: "normal", timeoutMs: 8000, headline: "Goal complete" },
  error: { face: "error", urgency: "critical", timeoutMs: 0, headline: "Needs a decision" }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function emptyMemory() {
  return { baselined: false, states: {}, lastSentMs: {}, replaceIds: {} }
}

// The event for one observed edge, or "" for none. Only these four edges
// notify; unknown/recent/ended and every edge into idle other than a
// finished turn stay silent.
function eventKind(previous, current) {
  if (previous === current) return ""
  if (current === "waiting") return "waiting"
  if (current === "error") return "error"
  if (current === "success") return "complete"
  if (current === "idle" && (previous === "working" || previous === "ultrawork")) return "finished"
  return ""
}

// One poll. Returns { memory, events }; `memory` is a fresh object (the
// input is not mutated). The first call only records a baseline, and a
// session seen for the first time is baselined the same way — an edge needs
// two observations of the same session.
function step(memory, sessions, nowMs, stateOf) {
  var prev = record(memory)
  var prevStates = record(prev.states)
  var prevSent = record(prev.lastSentMs)
  var prevReplace = record(prev.replaceIds)
  var list = Array.isArray(sessions) ? sessions : []
  var now = Number(nowMs) || 0
  var next = { baselined: true, states: {}, lastSentMs: {}, replaceIds: {} }
  var events = []
  for (var i = 0; i < list.length && i < MAX_TRACKED; i++) {
    var s = record(list[i])
    var id = typeof s.id === "string" ? s.id : ""
    if (id === "") continue
    var state = String(stateOf(s, now, null))
    next.states[id] = state
    if (prevSent[id] !== undefined) next.lastSentMs[id] = prevSent[id]
    if (prevReplace[id] !== undefined) next.replaceIds[id] = prevReplace[id]
    if (prev.baselined !== true || prevStates[id] === undefined) continue
    var kind = eventKind(prevStates[id], state)
    if (kind === "") continue
    var last = next.lastSentMs[id]
    if (kind !== "error" && last !== undefined && now - last >= 0 && now - last < SUPPRESS_MS) continue
    next.lastSentMs[id] = now
    events.push(makeEvent(kind, id, s.title))
  }
  return { memory: next, events: events }
}

function makeEvent(kind, sessionId, title) {
  var card = EVENTS[kind]
  return {
    kind: kind,
    sessionId: sessionId,
    face: card.face,
    urgency: card.urgency,
    timeoutMs: card.timeoutMs,
    headline: card.headline,
    body: typeof title === "string" && title !== "" ? title : "Untitled"
  }
}

// Session ids go to the IPC `focus <id>` call as one argv element; anything
// outside this shape gets a card without the click action.
function safeSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)
}

// argv for omarchy-notification-send, exactly the §4.4 shape:
//   --app-name OmO -i file://<assets>/omo-cat-<face>.svg -u <u> -t <ms> -p [-r <id>]
//   <headline> <session title> --exec omarchy-shell io.github.tmdgusya.omo focus <id>
// `assetDir` must be an absolute directory path; returns null otherwise.
function sendArgs(event, assetDir, replaceId) {
  var e = record(event)
  var card = EVENTS[e.kind]
  if (!card) return null
  if (typeof assetDir !== "string" || assetDir.charAt(0) !== "/" || /[\u0000-\u001f\u007f]/.test(assetDir)) return null
  var dir = assetDir.replace(/\/+$/, "")
  var args = [SENDER, "--app-name", APP_NAME,
    "-i", "file://" + encodeURI(dir + "/omo-cat-" + card.face + ".svg"),
    "-u", card.urgency, "-t", String(card.timeoutMs), "-p"]
  var rid = Number(replaceId)
  if (isFinite(rid) && rid > 0 && Math.floor(rid) === rid) args.push("-r", String(rid))
  args.push(card.headline, typeof e.body === "string" && e.body !== "" ? e.body : "Untitled")
  if (safeSessionId(e.sessionId)) args.push("--exec", SHELL_IPC, IPC_TARGET, "focus", e.sessionId)
  return args
}

// The sender prints the notification id with -p; store it so the session's
// next card replaces this one. Returns a fresh memory.
function rememberReplaceId(memory, sessionId, stdout) {
  var m = record(memory)
  var next = { baselined: m.baselined === true, states: record(m.states), lastSentMs: record(m.lastSentMs), replaceIds: {} }
  var ids = record(m.replaceIds)
  for (var k in ids) next.replaceIds[k] = ids[k]
  var match = /^\s*(\d+)\s*$/.exec(String(stdout === undefined || stdout === null ? "" : stdout))
  if (match && next.states[sessionId] !== undefined) {
    var n = parseInt(match[1], 10)
    if (n > 0) next.replaceIds[sessionId] = n
  }
  return next
}

// The bar entry of this plugin in ~/.config/omarchy/shell.json holds its
// settings flat on the layout item (`{ "id": ..., "notifyEnabled": ... }`).
// Services get no settings injection, so the service reads them here.
function barSettings(shellJsonText, pluginId) {
  var parsed
  try {
    parsed = JSON.parse(String(shellJsonText || ""))
  } catch (e) {
    return {}
  }
  var layout = record(record(record(parsed).bar).layout)
  var sections = ["left", "center", "right"]
  for (var i = 0; i < sections.length; i++) {
    var items = layout[sections[i]]
    if (!Array.isArray(items)) continue
    for (var j = 0; j < items.length; j++) {
      var item = record(items[j])
      if (item.id === pluginId) return item
    }
  }
  return {}
}

var exportsObject = {
  SENDER: SENDER,
  SHELL_IPC: SHELL_IPC,
  IPC_TARGET: IPC_TARGET,
  APP_NAME: APP_NAME,
  SUPPRESS_MS: SUPPRESS_MS,
  MAX_TRACKED: MAX_TRACKED,
  EVENTS: EVENTS,
  emptyMemory: emptyMemory,
  eventKind: eventKind,
  step: step,
  safeSessionId: safeSessionId,
  sendArgs: sendArgs,
  rememberReplaceId: rememberReplaceId,
  barSettings: barSettings
}

if (typeof module !== "undefined" && module.exports) module.exports = exportsObject
