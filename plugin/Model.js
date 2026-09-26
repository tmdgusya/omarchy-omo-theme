.pragma library

// Pure display mapping for the OmO bar widget. No QML types, no I/O: every
// function takes plain values and returns plain values, so the same file runs
// under `bun test` (tests/model.test.js strips the pragma) and inside the
// shell via `import "Model.js" as Model`.
//
// Input contract: the JSON printed by `omo_sessions.py list` (schemaVersion 1,
// see /home/roach/omo-theme-research/bridge-implementation.md). The widget
// shows ledger values only — completed/total todos, passed/total verified
// criteria — never percentages, ETAs, or guessed progress.

var SCHEMA_VERSION = 1
var LIST_OUTPUT_LIMIT = 131072   // bytes; the collector's own list ceiling (128 KiB)
var VIEW_OUTPUT_LIMIT = 65536    // bytes kept from `view --session`
var VIEW_MAX_LINES = 24
var MAX_SESSIONS = 12            // the collector lists at most 12 top-level sessions
var POLL_MIN_MS = 2000
var POLL_MAX_MS = 60000
var SUCCESS_WINDOW_MS = 60000    // a completed goal/loop reads as "done" this long after its last activity

// Display priority, highest first. The bar cell shows the first state any
// session is in; the list chip shows each session's own state.
var STATES = ["error", "waiting", "ultrawork", "working", "success", "idle", "unknown", "ended"]
var RUNTIME_KINDS = ["live", "idle", "ended", "unknown"]
var RUNTIME_STATUSES = ["working", "waiting", "idle", "ended", "unknown"]
var FILTERS = ["all", "active", "ended", "error"]

// ---------------------------------------------------------------- primitives

function number(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

function count(value) {
  var n = Math.floor(number(value, 0))
  return n > 0 ? n : 0
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value))
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function oneOf(value, allowed, fallback) {
  return allowed.indexOf(value) >= 0 ? value : fallback
}

// Plain single-line text: control characters dropped, whitespace collapsed,
// length capped. Titles come from private session data and may carry
// anything; this is the only shape the UI ever renders or logs.
function text(value, max) {
  if (typeof value !== "string") return ""
  var s = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ")
  s = s.replace(/^\s+|\s+$/g, "")
  if (max !== undefined && s.length > max) s = s.substring(0, max)
  return s
}

// An absolute path without control characters, or "". Anything else never
// reaches an argv array.
function safePath(value) {
  if (typeof value !== "string") return ""
  if (value.charAt(0) !== "/" || value.length > 4096) return ""
  if (/[\u0000-\u001f\u007f]/.test(value)) return ""
  return value
}

function byteLength(str) {
  var bytes = 0
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

// FNV-1a over UTF-16 units, hex. Used to skip re-parsing identical collector
// output; collisions only cost one skipped refresh.
function textHash(str) {
  var s = String(str === undefined || str === null ? "" : str)
  var hash = 0x811c9dc5
  for (var i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16) + ":" + s.length
}

// --------------------------------------------------------------- CJK width

// Columns a string occupies in a monospace cell: East Asian wide/fullwidth
// and emoji count 2, combining marks and zero-width characters 0.
function charWidth(code) {
  if (code === 0) return 0
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfeff) return 0
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)) return 2
  return 1
}

function codePoints(str) {
  var out = []
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      var low = str.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        out.push({ code: ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000, text: str.substr(i, 2) })
        i++
        continue
      }
    }
    out.push({ code: code, text: str.charAt(i) })
  }
  return out
}

function displayWidth(str) {
  var points = codePoints(String(str === undefined || str === null ? "" : str))
  var width = 0
  for (var i = 0; i < points.length; i++) width += charWidth(points[i].code)
  return width
}

// Cut to `maxCols` columns with a trailing ellipsis, never splitting a wide
// character. Qt's Text.elide handles laid-out rows; this is for tooltips and
// other plain strings the widget composes itself.
function elide(str, maxCols) {
  var s = String(str === undefined || str === null ? "" : str)
  var cols = Math.max(1, Math.floor(number(maxCols, 1)))
  if (displayWidth(s) <= cols) return s
  var points = codePoints(s)
  var out = ""
  var width = 0
  for (var i = 0; i < points.length; i++) {
    var w = charWidth(points[i].code)
    if (width + w > cols - 1) break
    out += points[i].text
    width += w
  }
  return out + "\u2026"
}

// ------------------------------------------------------------- collector JSON

function failure(reason) {
  return { ok: false, sessions: [], partial: false, notice: "", reason: reason }
}

function focusAddress(value) {
  var address = record(value).address
  return typeof address === "string" && /^0x[0-9a-fA-F]+$/.test(address) ? address : ""
}

function normalizeRuntime(value) {
  var r = record(value)
  var kind = oneOf(r.kind, RUNTIME_KINDS, "unknown")
  var working = r.working === true && kind === "live"
  var fallbackStatus = kind === "live" ? (working ? "working" : "waiting") : kind
  return {
    kind: kind,
    working: working,
    status: oneOf(r.status, RUNTIME_STATUSES, fallbackStatus),
    evidence: text(r.evidence, 80)
  }
}

function normalizeSession(item) {
  var s = record(item)
  var id = text(s.id, 128)
  if (id === "") return null
  // `todos: null` means the collector could not certify the active branch
  // (or the session never recorded one); it stays null so no zero is shown.
  var todos = null
  if (s.todos !== null && s.todos !== undefined && typeof s.todos === "object" && !Array.isArray(s.todos)) {
    var t = record(s.todos)
    todos = {
      completed: count(t.completed),
      pending: count(t.pending),
      inProgress: count(t.inProgress),
      abandoned: count(t.abandoned),
      total: count(t.total)
    }
  }
  var activityAt = text(s.activityAt, 40)
  var activityMs = activityAt === "" ? 0 : number(Date.parse(activityAt), 0)
  var ulw = null
  if (s.ulw !== null && s.ulw !== undefined && typeof s.ulw === "object") {
    var u = record(s.ulw)
    ulw = { passed: count(u.passed), total: count(u.total), status: text(u.status, 32) }
  }
  var goal = null
  if (s.goal !== null && s.goal !== undefined && typeof s.goal === "object") {
    goal = { status: text(record(s.goal).status, 32) }
  }
  var title = text(s.title, 200)
  return {
    id: id,
    cwdLabel: text(s.cwdLabel, 64),
    title: title === "" ? "Untitled" : title,
    activityAt: activityAt,
    activityMs: activityMs > 0 ? activityMs : 0,
    runtime: normalizeRuntime(s.runtime),
    todos: todos,
    partial: s.partial === true,
    ulw: ulw,
    goal: goal,
    runningDelegatedTasks: count(s.runningDelegatedTasks),
    sessionPath: safePath(s.sessionPath),
    cwd: safePath(s.cwd),
    focusAddress: focusAddress(s.focus)
  }
}

// Parse `omo_sessions.py list` stdout. `ok:false` means the data cannot be
// trusted (stale cat); `partial:true` means the collector hit a ceiling and
// returned a bounded list (face unchanged, notice in the panel header).
function parseList(raw, limitBytes) {
  var s = String(raw === undefined || raw === null ? "" : raw)
  var cap = limitBytes === undefined ? LIST_OUTPUT_LIMIT : limitBytes
  if (byteLength(s) > cap) return failure("output limit reached")
  if (s.replace(/\s+/g, "") === "") return failure("empty collector output")
  var parsed
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return failure("collector output is not JSON")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return failure("collector output is not an object")
  if (parsed.schemaVersion !== SCHEMA_VERSION) return failure("unsupported schemaVersion")
  var list = Array.isArray(parsed.sessions) ? parsed.sessions : []
  var sessions = []
  for (var i = 0; i < list.length && sessions.length < MAX_SESSIONS; i++) {
    var session = normalizeSession(list[i])
    if (session) sessions.push(session)
  }
  var partial = typeof parsed.error === "string" && parsed.error !== ""
  return {
    ok: true,
    sessions: sortSessions(sessions),
    partial: partial,
    notice: partial ? text(parsed.error, 80) : "",
    reason: ""
  }
}

// Newest activity first; unknown activity last. Stable for equal keys.
function sortSessions(sessions) {
  var list = Array.isArray(sessions) ? sessions.slice() : []
  var indexed = []
  for (var i = 0; i < list.length; i++) indexed.push({ session: list[i], index: i })
  indexed.sort(function(a, b) {
    var delta = (b.session.activityMs || 0) - (a.session.activityMs || 0)
    return delta !== 0 ? delta : a.index - b.index
  })
  var out = []
  for (var j = 0; j < indexed.length; j++) out.push(indexed[j].session)
  return out
}

// ------------------------------------------------------------------- states

// One session's display state. Only a verified live turn animates:
// `runtime.working === true` comes from the senpi extension plus a process
// identity check (live-state.md); goals, todos, loop files, and delegated
// tasks never promote a session to working. Without a verified runtime the
// session is `unknown`: its goal/loop files are history, shown in the
// evidence line only, and never pin an error or success face.
function sessionState(session, nowMs) {
  var s = record(session)
  var r = record(s.runtime)
  var ulwStatus = s.ulw ? String(s.ulw.status || "") : ""
  var goalStatus = s.goal ? String(s.goal.status || "") : ""
  if (r.kind === "ended") return "ended"
  if (r.kind !== "live" && r.kind !== "idle") return "unknown"
  if (goalStatus === "blocked" || ulwStatus === "failed" || ulwStatus === "blocked") return "error"
  if (r.status === "waiting") return "waiting"
  if (r.working === true) return ulwStatus === "in_progress" ? "ultrawork" : "working"
  var complete = goalStatus === "complete" || ulwStatus === "complete" || ulwStatus === "completed"
  var now = number(nowMs, 0)
  if (complete && now > 0 && s.activityMs > 0 && now - s.activityMs >= 0 && now - s.activityMs <= SUCCESS_WINDOW_MS) return "success"
  return "idle"
}

// The state shown for a session after the user dismissed its error.
function effectiveState(session, nowMs, dismissed) {
  var state = sessionState(session, nowMs)
  if (state === "error" && dismissed && dismissed[record(session).id] === true) {
    var r = record(record(session).runtime)
    if (r.status === "waiting") return "waiting"
    return r.working === true ? "working" : "idle"
  }
  return state
}

function stateLabel(state) {
  switch (state) {
  case "error": return "error"
  case "waiting": return "waiting"
  case "ultrawork": return "ultrawork"
  case "working": return "working"
  case "success": return "done"
  case "ended": return "ended"
  case "idle": return "idle"
  default: return "unknown"
  }
}

function isActiveState(state) {
  return state === "working" || state === "ultrawork" || state === "waiting"
}

// Short evidence line under a selected row: what the collector could prove,
// plus the honest caveat when a loop file claims progress nothing is running.
function evidenceLabel(session) {
  var s = record(session)
  var r = record(s.runtime)
  var parts = []
  if (s.partial === true) parts.push("partial session data")
  if (r.evidence) parts.push(r.evidence)
  if (s.runningDelegatedTasks > 0) parts.push("delegated:" + s.runningDelegatedTasks)
  if (s.ulw && s.ulw.status === "in_progress" && r.working !== true) parts.push("ulw in_progress \u00b7 no live evidence")
  else if (s.ulw && s.ulw.status) parts.push("ulw " + s.ulw.status)
  if (s.goal && s.goal.status) parts.push("goal " + s.goal.status)
  return parts.join(" \u00b7 ")
}

// Ledger values only. A missing ledger or denominator hides the number.
function progress(session) {
  var s = record(session)
  var todos = s.todos !== null && s.todos !== undefined && typeof s.todos === "object" ? record(s.todos) : null
  var todo = null
  if (todos && count(todos.total) > 0) {
    todo = {
      completed: count(todos.completed),
      total: count(todos.total),
      ratio: clamp(count(todos.completed) / count(todos.total), 0, 1),
      label: "todo " + count(todos.completed) + "/" + count(todos.total)
    }
  }
  var ulw = null
  if (s.ulw && count(s.ulw.total) > 0) {
    ulw = {
      passed: count(s.ulw.passed),
      total: count(s.ulw.total),
      ratio: clamp(count(s.ulw.passed) / count(s.ulw.total), 0, 1),
      label: "verified " + count(s.ulw.passed) + "/" + count(s.ulw.total)
    }
  }
  return { todo: todo, ulw: ulw }
}

function captionText(active) {
  var n = count(active)
  if (n <= 0) return ""
  return n > 9 ? "9+" : String(n)
}

function countSegment(n, word) {
  return n > 0 ? n + " " + word : ""
}

// Bar-level summary of every listed session.
function aggregate(sessions, nowMs, dismissed) {
  var list = Array.isArray(sessions) ? sessions : []
  var counts = { error: 0, waiting: 0, ultrawork: 0, working: 0, success: 0, idle: 0, unknown: 0, ended: 0 }
  var top = "idle"
  var topRank = STATES.length
  var ulwSummary = ""
  for (var i = 0; i < list.length; i++) {
    var state = effectiveState(list[i], nowMs, dismissed)
    counts[state] += 1
    var rank = STATES.indexOf(state)
    if (rank < topRank) { topRank = rank; top = state }
    if (state === "ultrawork" && ulwSummary === "") {
      var p = progress(list[i])
      if (p.ulw) ulwSummary = "ulw " + p.ulw.passed + "/" + p.ulw.total
    }
  }
  if (list.length === 0) top = "idle"
  var running = counts.working + counts.ultrawork
  var active = running + counts.waiting
  var segments = []
  var seg
  seg = countSegment(running, "working"); if (seg) segments.push(seg)
  seg = countSegment(counts.waiting, "waiting"); if (seg) segments.push(seg)
  seg = countSegment(counts.error, "error"); if (seg) segments.push(seg)
  if (ulwSummary) segments.push(ulwSummary)
  var tooltip
  if (list.length === 0) tooltip = "OmO \u00b7 no senpi sessions"
  else if (segments.length === 0) {
    tooltip = "OmO \u00b7 " + list.length + (list.length === 1 ? " session" : " sessions") + " \u00b7 none active"
    if (counts.unknown > 0) tooltip += " \u00b7 " + counts.unknown + " unverified"
  } else tooltip = "OmO \u00b7 " + segments.join(" \u00b7 ")
  return {
    state: top,
    counts: counts,
    total: list.length,
    active: active,
    running: running,
    waiting: counts.waiting,
    glow: counts.ultrawork > 0,
    animated: running > 0,
    caption: captionText(active),
    tooltip: tooltip
  }
}

function filterSessions(sessions, filter, nowMs, dismissed) {
  var list = Array.isArray(sessions) ? sessions : []
  var which = oneOf(filter, FILTERS, "all")
  if (which === "all") return list.slice()
  var out = []
  for (var i = 0; i < list.length; i++) {
    var state = effectiveState(list[i], nowMs, dismissed)
    if (which === "active" && isActiveState(state)) out.push(list[i])
    else if (which === "ended" && state === "ended") out.push(list[i])
    else if (which === "error" && state === "error") out.push(list[i])
  }
  return out
}

function nextFilter(current, step) {
  var index = FILTERS.indexOf(current)
  if (index < 0) index = 0
  var delta = number(step, 1) < 0 ? -1 : 1
  return FILTERS[(index + delta + FILTERS.length) % FILTERS.length]
}

function filterLabel(filter) {
  switch (filter) {
  case "active": return "Active"
  case "ended": return "Ended"
  case "error": return "Error"
  default: return "All"
  }
}

function clampIndex(index, length) {
  if (!(length > 0)) return 0
  return clamp(Math.floor(number(index, 0)), 0, length - 1)
}

// -------------------------------------------------------------------- time

function relativeTime(activityMs, nowMs) {
  var at = number(activityMs, 0)
  var now = number(nowMs, 0)
  if (!(at > 0) || !(now > 0)) return ""
  var sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return "just now"
  if (sec < 3600) return Math.round(sec / 60) + " min ago"
  if (sec < 86400) return Math.round(sec / 3600) + " h ago"
  return Math.round(sec / 86400) + " d ago"
}

// ------------------------------------------------------------------ polling

// Base interval by activity, doubled per backoff level, always inside
// [POLL_MIN_MS, POLL_MAX_MS]. The collector is a short-lived process; the
// widget never polls faster than 2 s and never slower than a minute.
function pollInterval(hasActive, liveMs, idleMs, backoffLevel) {
  var base = hasActive ? number(liveMs, 5000) : number(idleMs, 15000)
  base = clamp(base, POLL_MIN_MS, POLL_MAX_MS)
  var level = clamp(Math.floor(number(backoffLevel, 0)), 0, 8)
  return Math.round(clamp(base * Math.pow(2, level), POLL_MIN_MS, POLL_MAX_MS))
}

// ----------------------------------------------------------------- settings

function settingString(settings, key) {
  var value = record(settings)[key]
  return typeof value === "string" ? value.replace(/^\s+|\s+$/g, "") : ""
}

function settingInt(settings, key, fallback, minimum, maximum) {
  var value = record(settings)[key]
  var n = parseInt(String(value === undefined || value === null ? fallback : value), 10)
  if (!isFinite(n)) n = fallback
  return clamp(n, minimum, maximum)
}

function settingBool(settings, key, fallback) {
  var value = record(settings)[key]
  if (value === true || value === false) return value
  if (typeof value === "string") {
    var s = value.replace(/^\s+|\s+$/g, "").toLowerCase()
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true
    if (s === "false" || s === "0" || s === "no" || s === "off") return false
  }
  return fallback
}

// ------------------------------------------------------------------ commands
//
// Every command is an argv array; nothing is ever joined into a shell string.

function collectorArgs(scriptPath, agentDir, taskDir) {
  var script = safePath(scriptPath)
  if (script === "") return null
  var args = ["python3", "-B", script]
  var agent = safePath(agentDir)
  var task = safePath(taskDir)
  if (agent !== "") args.push("--agent-dir", agent)
  if (task !== "") args.push("--task-dir", task)
  return args
}

function listCommand(scriptPath, agentDir, taskDir) {
  var args = collectorArgs(scriptPath, agentDir, taskDir)
  if (!args) return null
  args.push("list")
  return args
}

function viewCommand(scriptPath, agentDir, sessionPath) {
  var path = safePath(sessionPath)
  if (path === "" || !/\.jsonl$/.test(path)) return null
  var args = collectorArgs(scriptPath, agentDir, "")
  if (!args) return null
  args.push("view", "--session", path)
  return args
}

// A fresh senpi in a new Ghostty window, bypassing the Ghostty daemon so the
// window exists even when the single instance is busy. `--working-directory`
// is only passed when the collector gave an absolute path. The bundled
// live-state extension (`omo-status.ts`, see live-state.md) is loaded with
// `senpi -e` so the new session reports real working/waiting state; sessions
// started without it stay `unknown`.
function launchCommand(cwd, extensionPath, senpiPath, agentDir) {
  var executable = senpiPath === undefined || senpiPath === "" ? "senpi" : senpiPath
  if (executable !== "senpi" && safePath(executable) === "") return null
  var args = ["ghostty", "--gtk-single-instance=false"]
  var dir = safePath(cwd)
  if (dir !== "") args.push("--working-directory=" + dir)
  args.push("-e")
  var profile = safePath(agentDir)
  if (profile !== "") args.push("env", "SENPI_CODING_AGENT_DIR=" + profile)
  args.push(executable)
  var extension = safePath(extensionPath)
  if (extension !== "" && /\.(ts|js|mjs)$/.test(extension)) args.push("-e", extension)
  return args
}

// Focus is only offered for a collector-proven Hyprland address.
function focusCommand(address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]+$/.test(address)) return null
  return ["hyprctl", "eval", "hl.dispatch(hl.dsp.focus({ window = 'address:" + address + "' }))"]
}

// ----------------------------------------------------------------- view text

// Plain-text session details from `view --session` (collector summary, never
// a transcript), bounded for the panel.
function viewText(raw, limitBytes, maxLines) {
  var s = String(raw === undefined || raw === null ? "" : raw)
  var cap = limitBytes === undefined ? VIEW_OUTPUT_LIMIT : limitBytes
  var truncated = false
  if (byteLength(s) > cap) {
    s = s.substring(0, cap)
    truncated = true
  }
  s = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  var lines = s.split("\n")
  while (lines.length > 0 && lines[lines.length - 1].replace(/\s+/g, "") === "") lines.pop()
  var limit = maxLines === undefined ? VIEW_MAX_LINES : Math.max(1, Math.floor(number(maxLines, VIEW_MAX_LINES)))
  if (lines.length > limit) {
    lines = lines.slice(0, limit)
    truncated = true
  }
  if (truncated) lines.push("\u2026")
  return lines.join("\n")
}

var exportsObject = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  LIST_OUTPUT_LIMIT: LIST_OUTPUT_LIMIT,
  VIEW_OUTPUT_LIMIT: VIEW_OUTPUT_LIMIT,
  VIEW_MAX_LINES: VIEW_MAX_LINES,
  MAX_SESSIONS: MAX_SESSIONS,
  POLL_MIN_MS: POLL_MIN_MS,
  POLL_MAX_MS: POLL_MAX_MS,
  SUCCESS_WINDOW_MS: SUCCESS_WINDOW_MS,
  STATES: STATES,
  FILTERS: FILTERS,
  text: text,
  safePath: safePath,
  byteLength: byteLength,
  textHash: textHash,
  displayWidth: displayWidth,
  elide: elide,
  normalizeSession: normalizeSession,
  parseList: parseList,
  sortSessions: sortSessions,
  sessionState: sessionState,
  effectiveState: effectiveState,
  stateLabel: stateLabel,
  isActiveState: isActiveState,
  evidenceLabel: evidenceLabel,
  progress: progress,
  captionText: captionText,
  aggregate: aggregate,
  filterSessions: filterSessions,
  nextFilter: nextFilter,
  filterLabel: filterLabel,
  clampIndex: clampIndex,
  relativeTime: relativeTime,
  pollInterval: pollInterval,
  settingString: settingString,
  settingInt: settingInt,
  settingBool: settingBool,
  listCommand: listCommand,
  viewCommand: viewCommand,
  launchCommand: launchCommand,
  focusCommand: focusCommand,
  viewText: viewText
}

if (typeof module !== "undefined" && module.exports) module.exports = exportsObject
