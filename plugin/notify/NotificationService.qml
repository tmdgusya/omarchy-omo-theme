import QtQuick
import Quickshell
import Quickshell.Io
import ".."
import "../Model.js" as Model
import "Notify.js" as Notify

// OmO notification service (concept.md §4.4). Watches the bundled collector
// and sends one Omarchy card per verified state edge through
// omarchy-notification-send; the stock omarchy.notifications server renders
// it, applies DND, and runs the whole-card click (`focus <id>` over IPC).
//
// Properties:
//   notifyEnabled default: the bar entry's `notifyEnabled` (true when absent)
//   settings     the plugin's bar entry from ~/.config/omarchy/shell.json
//   assetDir     absolute plugin assets directory used for the cat icons
//   pendingCount queued cards not yet handed to the sender
// Bounded: one collector poller, one sender process at a time (killed after
// 5 s), a queue of at most Notify.MAX_TRACKED cards, no timers of its own
// while disabled.
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

  function observe(sessions) {
    if (!notifyEnabled) return
    var result = Notify.step(memory, sessions, Date.now(), Model.effectiveState)
    memory = result.memory
    if (result.events.length === 0) return
    var next = []
    for (var i = 0; i < queue.length; i++) {
      var superseded = false
      for (var j = 0; j < result.events.length; j++)
        if (result.events[j].sessionId === queue[i].sessionId) superseded = true
      if (!superseded) next.push(queue[i])
    }
    for (var k = 0; k < result.events.length; k++) next.push(result.events[k])
    queue = next.slice(Math.max(0, next.length - Notify.MAX_TRACKED))
    sendNext()
  }

  function sendNext() {
    if (sender.running || queue.length === 0) return
    var event = queue[0]
    queue = queue.slice(1)
    var argv = Notify.sendArgs(event, assetDir, memory.replaceIds[event.sessionId])
    if (!argv) {
      console.warn("omo notify: unusable asset path, card dropped")
      Qt.callLater(root.sendNext)
      return
    }
    inFlight = event
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
    var event = inFlight
    var code = sender.exitCode
    inFlight = null
    if (code === 0 && !sender.timedOut)
      memory = Notify.rememberReplaceId(memory, event.sessionId, senderOut.text)
    else if (event)
      console.warn("omo notify: sender failed (" + (sender.timedOut ? "timeout" : "exit " + code) + ")")
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
