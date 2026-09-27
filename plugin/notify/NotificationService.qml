import QtQuick
import Quickshell
import Quickshell.Io
import ".."
import "../Model.js" as Model
import "Notify.js" as Notify

// OmO notification service (DESIGN-v3 face table). Watches the bundled
// collector and sends one Omarchy card per verified state edge through
// omarchy-notification-send; the stock omarchy.notifications server renders
// it, applies DND, and runs the whole-card click (`focus <id>` over IPC).
// When a session leaves the state its card describes, the card is taken down
// through omarchy-notification-dismiss (see Notify.cardTag).
//
// Properties:
//   notifyEnabled default: the bar entry's `notifyEnabled` (true when absent)
//   settings     the plugin's bar entry from ~/.config/omarchy/shell.json
//   assetDir     absolute plugin assets directory (face icons under face/)
//   pendingCount queued sends and dismissals not yet handed to the process
// Bounded: one collector poller, one sender/dismisser process at a time
// (killed after 5 s), a queue of at most Notify.MAX_TRACKED items, no timers
// of its own while disabled.
Item {
  id: root

  property var settings: Notify.barSettings(shellJson.text(), Notify.IPC_TARGET)
  property bool notifyEnabled: Model.settingBool(settings, "notifyEnabled", true)
  readonly property string assetDir: Qt.resolvedUrl("../assets").toString().replace(/^file:\/\//, "")
  readonly property int pendingCount: queue.length

  property var memory: Notify.emptyMemory()
  property var queue: []
  property var inFlight: null

  onNotifyEnabledChanged: {
    memory = Notify.emptyMemory()
    queue = []
  }

  // Queue items are { sessionId, event }: an event sends (or replaces) the
  // session's card, a null event dismisses its stale card. A newer item for a
  // session supersedes its queued older one.
  function observe(sessions) {
    if (!notifyEnabled) return
    var result = Notify.step(memory, sessions, Date.now(), Model.effectiveState)
    memory = result.memory
    var items = []
    for (var s = 0; s < result.stale.length; s++) items.push({ sessionId: result.stale[s], event: null })
    for (var e = 0; e < result.events.length; e++) items.push({ sessionId: result.events[e].sessionId, event: result.events[e] })
    if (items.length === 0) return
    var next = []
    for (var i = 0; i < queue.length; i++) {
      var superseded = false
      for (var j = 0; j < items.length; j++)
        if (items[j].sessionId === queue[i].sessionId) superseded = true
      if (!superseded) next.push(queue[i])
    }
    for (var k = 0; k < items.length; k++) next.push(items[k])
    queue = next.slice(Math.max(0, next.length - Notify.MAX_TRACKED))
    sendNext()
  }

  function sendNext() {
    if (sender.running || queue.length === 0) return
    var item = queue[0]
    queue = queue.slice(1)
    var argv = item.event
      ? Notify.sendArgs(item.event, assetDir, memory.replaceIds[item.sessionId])
      : Notify.dismissArgs(item.sessionId)
    if (!argv) {
      console.warn("omo notify: unusable asset path, card dropped")
      Qt.callLater(root.sendNext)
      return
    }
    inFlight = item
    sender.timedOut = false
    sender.streamDone = false
    sender.exitDone = false
    sender.exitCode = -1
    sender.command = argv
    sender.running = true
  }

  function finishSend() {
    if (!inFlight) return
    if (!sender.timedOut && (!sender.streamDone || !sender.exitDone)) return
    var item = inFlight
    var code = sender.exitCode
    inFlight = null
    if (code !== 0 || sender.timedOut)
      console.warn("omo notify: " + (item.event ? "sender" : "dismiss") + " failed (" + (sender.timedOut ? "timeout" : "exit " + code) + ")")
    else if (item.event)
      memory = Notify.rememberReplaceId(memory, item.sessionId, senderOut.text)
    Qt.callLater(root.sendNext)
  }

  Component.onDestruction: {
    senderDeadline.stop()
    sender.running = false
  }

  FileView {
    id: shellJson
    path: Quickshell.env("HOME") ? Quickshell.env("HOME") + "/.config/omarchy/shell.json" : ""
    watchChanges: true
    preload: true
    printErrors: false
    onFileChanged: reload()
  }

  Collector {
    id: collector
    settings: root.settings
    active: root.notifyEnabled
    onUpdated: root.observe(collector.sessions)
  }

  Timer {
    id: senderDeadline
    interval: 5000
    onTriggered: {
      if (!sender.running) return
      sender.timedOut = true
      sender.running = false
    }
  }

  Process {
    id: sender
    property bool timedOut: false
    running: false
    command: []
    property bool streamDone: false
    property bool exitDone: false
    property int exitCode: -1
    onRunningChanged: running ? senderDeadline.restart() : senderDeadline.stop()
    stdout: StdioCollector {
      id: senderOut
      waitForEnd: true
      onStreamFinished: {
        sender.streamDone = true
        root.finishSend()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
    }
    onExited: function(code) {
      sender.exitDone = true
      sender.exitCode = code
      root.finishSend()
    }
  }
}
