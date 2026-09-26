import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Bounded bridge to `omo_sessions.py`. One short-lived list process at a
// time, killed after 6 s; output over 128 KiB or any parse failure marks the
// data stale instead of guessing. Polls every `pollMs` while a session is
// active, `pollIdleMs` otherwise, doubling after failures or two slow runs
// (capped at 60 s). Nothing here writes files.
Item {
  id: root

  property var settings: ({})
  property bool active: true

  readonly property string scriptPath: Qt.resolvedUrl("omo_sessions.py").toString().replace(/^file:\/\//, "")
  readonly property string agentDir: Model.settingString(settings, "agentDir")
  readonly property string taskDir: Model.settingString(settings, "taskDir")
  readonly property int pollMs: Model.settingInt(settings, "pollMs", 5000, 2000, 30000)
  readonly property int pollIdleMs: Model.settingInt(settings, "pollIdleMs", 15000, 5000, 60000)
  readonly property int deadlineMs: 6000

  property var sessions: []
  property bool partial: false
  property string notice: ""
  property bool stale: false
  property string staleReason: ""
  property bool scanning: false
  property double lastOkMs: 0
  property int backoffLevel: 0
  property int slowRuns: 0
  property string lastHash: ""
  readonly property bool hasActive: Model.aggregate(sessions, 0, null).active > 0
  readonly property int intervalMs: Model.pollInterval(hasActive, pollMs, pollIdleMs, backoffLevel)

  property string viewPath: ""
  property string viewOutput: ""
  property string viewError: ""
  property bool viewing: false
  property string pendingViewPath: ""
  property bool refreshPending: false

  signal updated()
  signal polled()

  function refresh() {
    if (listProc.running || viewProc.running) {
      refreshPending = true
      return
    }
    var command = Model.listCommand(scriptPath, agentDir, taskDir)
    if (!command) {
      markStale("collector script path is not usable")
      return
    }
    listProc.reset()
    listProc.command = command
    scanning = true
    listProc.running = true
  }

  function resumeRefresh() {
    if (!refreshPending) return
    refreshPending = false
    Qt.callLater(root.refresh)
  }

  FileView {
    path: Quickshell.env("XDG_RUNTIME_DIR")
      ? Quickshell.env("XDG_RUNTIME_DIR") + "/omo-session-state.changed" : ""
    watchChanges: true
    preload: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.refresh()
  }

  function markStale(reason) {
    scanning = false
    stale = true
    staleReason = reason
    slowRuns = 0
    backoffLevel = Math.min(backoffLevel + 1, 8)
  }

  function noteSpeed(elapsedMs) {
    if (elapsedMs > 1000) {
      slowRuns += 1
      if (slowRuns >= 2) {
        slowRuns = 0
        backoffLevel = Math.min(backoffLevel + 1, 8)
      }
    } else {
      slowRuns = 0
      backoffLevel = 0
    }
  }

  function finishList() {
    if (!listProc.streamDone || !listProc.exitDone || listProc.timedOut) return
    resumeRefresh()
    var elapsed = Date.now() - listProc.startedMs
    scanning = false
    if (listProc.exitCode !== 0) {
      markStale("collector exited with status " + listProc.exitCode)
      return
    }
    var text = listOut.text
    var hash = Model.textHash(text)
    if (hash === lastHash && !stale) {
      lastOkMs = Date.now()
      noteSpeed(elapsed)
      polled()
      return
    }
    var result = Model.parseList(text, Model.LIST_OUTPUT_LIMIT)
    if (!result.ok) {
      markStale(result.reason)
      return
    }
    lastHash = hash
    sessions = result.sessions
    partial = result.partial
    notice = result.notice
    stale = false
    staleReason = ""
    lastOkMs = Date.now()
    noteSpeed(elapsed)
    updated()
    polled()
  }

  function requestView(sessionPath) {
    var path = Model.safePath(sessionPath)
    if (path === "") return
    if (listProc.running) {
      pendingViewPath = path
      return
    }
    startView(path)
  }

  function startView(path) {
    pendingViewPath = ""
    var command = Model.viewCommand(scriptPath, agentDir, path)
    if (!command) {
      viewPath = path
      viewOutput = ""
      viewError = "no details available"
      return
    }
    if (viewProc.running) viewProc.running = false
    viewProc.reset()
    viewProc.command = command
    viewPath = path
    viewOutput = ""
    viewError = ""
    viewing = true
    viewProc.running = true
  }

  function finishView() {
    if (!viewProc.streamDone || !viewProc.exitDone || viewProc.timedOut) return
    resumeRefresh()
    viewing = false
    if (viewProc.exitCode !== 0) {
      viewOutput = ""
      viewError = "no details available"
      return
    }
    var text = Model.viewText(viewOut.text, Model.VIEW_OUTPUT_LIMIT, Model.VIEW_MAX_LINES)
    viewOutput = text
    viewError = text === "" ? "no details available" : ""
  }

  function clearView() {
    pendingViewPath = ""
    if (viewProc.running) {
      viewProc.timedOut = true
      viewProc.running = false
    }
    viewing = false
    viewPath = ""
    viewOutput = ""
    viewError = ""
  }

  function runPendingView() {
    if (pendingViewPath !== "") startView(pendingViewPath)
  }

  Component.onDestruction: {
    poll.stop()
    listDeadline.stop()
    viewDeadline.stop()
    listProc.running = false
    viewProc.running = false
  }

  Timer {
    id: poll
    interval: root.intervalMs
    running: root.active
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: listDeadline
    interval: root.deadlineMs
    onTriggered: {
      if (!listProc.running) return
      listProc.timedOut = true
      listProc.running = false
      root.markStale("collector timed out after " + Math.round(root.deadlineMs / 1000) + " s")
      root.runPendingView()
    }
  }

  Timer {
    id: viewDeadline
    interval: root.deadlineMs
    onTriggered: {
      if (!viewProc.running) return
      viewProc.timedOut = true
      viewProc.running = false
      root.viewing = false
      root.viewOutput = ""
      root.viewError = "no details (collector timed out)"
    }
  }

  Process {
    id: listProc
    property bool timedOut: false
    property bool streamDone: false
    property bool exitDone: false
    property int exitCode: -1
    property double startedMs: 0

    function reset() {
      timedOut = false
      streamDone = false
      exitDone = false
      exitCode = -1
      startedMs = Date.now()
    }

    running: false
    command: []
    onRunningChanged: running ? listDeadline.restart() : listDeadline.stop()
    stdout: StdioCollector {
      id: listOut
      waitForEnd: true
      onStreamFinished: {
        listProc.streamDone = true
        root.finishList()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
    }
    onExited: function(code) {
      listProc.exitDone = true
      listProc.exitCode = code
      root.finishList()
      root.runPendingView()
    }
  }

  Process {
    id: viewProc
    property bool timedOut: false
    property bool streamDone: false
    property bool exitDone: false
    property int exitCode: -1

    function reset() {
      timedOut = false
      streamDone = false
      exitDone = false
      exitCode = -1
    }

    running: false
    command: []
    onRunningChanged: running ? viewDeadline.restart() : viewDeadline.stop()
    stdout: StdioCollector {
      id: viewOut
      waitForEnd: true
      onStreamFinished: {
        viewProc.streamDone = true
        root.finishView()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
    }
    onExited: function(code) {
      viewProc.exitDone = true
      viewProc.exitCode = code
      root.finishView()
    }
  }
}
