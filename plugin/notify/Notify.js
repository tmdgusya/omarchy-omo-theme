.pragma library

// Pure transition logic for OmO desktop notifications (DESIGN-v3 face table).
// No QML types, no I/O, no clock: every function takes plain values and
// returns plain values, so the same file runs under `bun test`
// (tests/notify.test.js strips the pragma) and inside the shell via
// `import "Notify.js" as Notify`.
//
// Input: sessions already normalized by Model.parseList, plus Model's own
// state function (Model.effectiveState) passed in by the caller. This file
// never derives a state itself: it only reacts to edges between the states
// Model reports. Four edges send a card; a session leaving the state its card
// describes takes that card down again.

var SENDER = "/usr/share/omarchy/bin/omarchy-notification-send"
var DISMISSER = "/usr/share/omarchy/bin/omarchy-notification-dismiss"
var SHELL_IPC = "/usr/share/omarchy/bin/omarchy-shell"
var IPC_TARGET = "io.github.tmdgusya.omo"
var APP_NAME = "OmO"
var FACE_DIR = "face"
var SUPPRESS_MS = 30000     // at most one card per session per 30 s (error exempt)
var MAX_TRACKED = 12        // Model.MAX_SESSIONS; memory never grows past the listed sessions

// kind -> card. timeoutMs 0 = persistent (critical cards never expire).
// `keep`: the Model states in which the card is still true; in any other
// state it is stale. A finished turn has no face-table row and reads as done.
var EVENTS = {
  waiting: { face: "waiting", urgency: "normal", timeoutMs: 12000, headline: "OmO? One decision needed.", keep: ["waiting"] },
  finished: { face: "done", urgency: "low", timeoutMs: 5000, headline: "^m^ Done. Ready for your review.", keep: ["idle", "success"] },
  complete: { face: "done", urgency: "normal", timeoutMs: 8000, headline: "^m^ Done. Ready for your review.", keep: ["success", "idle"] },
  error: { face: "error", urgency: "critical", timeoutMs: 0, headline: ">m< We hit a blocker.", keep: ["error"] }
}

var UNTITLED = "Untitled"

// The stock notification server takes a card off the screen only by summary
// substring (omarchy-notification-dismiss -> `notifications dismiss`); a D-Bus
// CloseNotification drops the server object but leaves the toast up. So every
// OmO summary ends in an invisible per-session tag: WORD JOINER, then the
// session id's 32-bit FNV-1a hash as 16 base-4 digits from U+2061..U+2064.
// All five are default-ignorable format characters (zero width, no bidi or
// shaping effect), and the fixed length means one tag never matches inside
// another, so dismissing by the tag removes exactly this session's card and
// never another session's card with the same headline.
var TAG_MARK = "\u2060"
var TAG_DIGITS = ["\u2061", "\u2062", "\u2063", "\u2064"]

function cardTag(sessionId) {
  var id = String(sessionId)
  var h = 0x811c9dc5
  for (var i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  var tag = TAG_MARK
  for (var d = 0; d < 16; d++) {
    tag += TAG_DIGITS[h & 3]
    h >>>= 2
  }
  return tag
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function emptyMemory() {
  return { baselined: false, states: {}, lastSentMs: {}, replaceIds: {}, cards: {} }
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

// One poll. Returns { memory, events, stale }; `memory` is a fresh object (the
// input is not mutated). The first call only records a baseline, and a
// session seen for the first time is baselined the same way: an edge needs
// two observations of the same session. `stale` lists the sessions whose card
// stopped being true (state outside the card's `keep`, or the session left
// the list) without a new card to replace it; each is reported once.
function step(memory, sessions, nowMs, stateOf) {
  var prev = record(memory)
  var prevStates = record(prev.states)
  var prevSent = record(prev.lastSentMs)
  var prevReplace = record(prev.replaceIds)
  var prevCards = record(prev.cards)
  var list = Array.isArray(sessions) ? sessions : []
  var now = Number(nowMs) || 0
  var next = { baselined: true, states: {}, lastSentMs: {}, replaceIds: {}, cards: {} }
  var events = []
  var stale = []
  for (var i = 0; i < list.length && i < MAX_TRACKED; i++) {
    var s = record(list[i])
    var id = typeof s.id === "string" ? s.id : ""
    if (id === "") continue
    var state = String(stateOf(s, now, null))
    next.states[id] = state
    if (prevSent[id] !== undefined) next.lastSentMs[id] = prevSent[id]
    if (prevReplace[id] !== undefined) next.replaceIds[id] = prevReplace[id]
    var card = prevCards[id]
    var kind = prev.baselined === true && prevStates[id] !== undefined ? eventKind(prevStates[id], state) : ""
    var last = next.lastSentMs[id]
    if (kind !== "" && (kind === "error" || last === undefined || now - last < 0 || now - last >= SUPPRESS_MS)) {
      next.lastSentMs[id] = now
      events.push(makeEvent(kind, id, s.title))
      card = kind
    }
    if (card === undefined) continue
    if (EVENTS[card] && EVENTS[card].keep.indexOf(state) !== -1) next.cards[id] = card
    else stale.push(id)
  }
  for (var gone in prevCards) {
    if (next.states[gone] === undefined) stale.push(gone)
  }
  return { memory: next, events: events, stale: stale }
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
    body: typeof title === "string" && title !== "" ? title : UNTITLED
  }
}

// Session ids go to the IPC `focus <id>` call as one argv element; anything
// outside this shape gets a card without the click action.
function safeSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)
}

// argv for omarchy-notification-send:
//   --app-name OmO -i file://<assets>/face/omo-face-<face>.svg -u <u> -t <ms> -p [-r <id>]
//   <headline><tag> <session title> --exec omarchy-shell io.github.tmdgusya.omo focus <id>
// `assetDir` must be an absolute directory path; returns null otherwise.
function sendArgs(event, assetDir, replaceId) {
  var e = record(event)
  var card = EVENTS[e.kind]
  if (!card) return null
  if (typeof assetDir !== "string" || assetDir.charAt(0) !== "/" || /[\u0000-\u001f\u007f]/.test(assetDir)) return null
  var dir = assetDir.replace(/\/+$/, "")
  var args = [SENDER, "--app-name", APP_NAME,
    "-i", "file://" + encodeURI(dir + "/" + FACE_DIR + "/omo-face-" + card.face + ".svg"),
    "-u", card.urgency, "-t", String(card.timeoutMs), "-p"]
  var rid = Number(replaceId)
  if (isFinite(rid) && rid > 0 && Math.floor(rid) === rid) args.push("-r", String(rid))
  args.push(card.headline + cardTag(e.sessionId), typeof e.body === "string" && e.body !== "" ? e.body : UNTITLED)
  if (safeSessionId(e.sessionId)) args.push("--exec", SHELL_IPC, IPC_TARGET, "focus", e.sessionId)
  return args
}

// argv that takes a stale session's card off the screen. A card that already
// expired or was dismissed by hand matches nothing, and the call is a no-op.
function dismissArgs(sessionId) {
  return [DISMISSER, cardTag(sessionId)]
}

// The sender prints the notification id with -p; store it so the session's
// next card replaces this one. Returns a fresh memory.
function rememberReplaceId(memory, sessionId, stdout) {
  var m = record(memory)
  var next = { baselined: m.baselined === true, states: record(m.states), lastSentMs: record(m.lastSentMs), replaceIds: {}, cards: record(m.cards) }
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
  DISMISSER: DISMISSER,
  SHELL_IPC: SHELL_IPC,
  IPC_TARGET: IPC_TARGET,
  APP_NAME: APP_NAME,
  FACE_DIR: FACE_DIR,
  SUPPRESS_MS: SUPPRESS_MS,
  MAX_TRACKED: MAX_TRACKED,
  EVENTS: EVENTS,
  UNTITLED: UNTITLED,
  cardTag: cardTag,
  emptyMemory: emptyMemory,
  eventKind: eventKind,
  step: step,
  safeSessionId: safeSessionId,
  sendArgs: sendArgs,
  dismissArgs: dismissArgs,
  rememberReplaceId: rememberReplaceId,
  barSettings: barSettings
}

if (typeof module !== "undefined" && module.exports) module.exports = exportsObject
