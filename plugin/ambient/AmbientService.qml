import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import ".." as Plugin
import "../Model.js" as Model
import "Lease.js" as Lease

Item {
  id: root

  property string pluginId: "io.github.tmdgusya.omo"
  property string shellConfigPath: Quickshell.env("HOME") + "/.config/omarchy/shell.json"
  property string currentBackgroundLink: Quickshell.env("HOME") + "/.local/state/omarchy/current/background"
  property var shellConfig: ({})
  property string currentBackground: ""
  property var fullscreenByMonitor: ({})
  property string lastBorderResult: ""
  property string lastBorderError: ""
  property bool fullscreenRefreshPending: false
  property string pendingBorderAction: ""

  readonly property var ambientSettings: Lease.pluginSettings(shellConfig, pluginId)
  readonly property bool ambientBorder: ambientSettings.ambientBorder
  readonly property bool ambientOverlay: ambientSettings.ambientOverlay
  readonly property bool reduceMotion: ambientSettings.reduceMotion
  readonly property bool storm: !collector.stale && hasStorm(collector.sessions)
  readonly property bool borderDesired: storm && ambientBorder && !reduceMotion
  readonly property bool backgroundMatches: Lease.backgroundMatches(currentBackground)
  readonly property bool allMonitorsFullscreen: monitorsAllFullscreen()
  readonly property string borderScript: Qt.resolvedUrl("border-lease.sh").toString().replace(/^file:\/\//, "")

  function hasStorm(sessions) {
    var list = Array.isArray(sessions) ? sessions : []
    for (var i = 0; i < list.length; i++) {
      if (Model.sessionState(list[i], Date.now()) === "ultrawork") return true
    }
    return false
  }

  function monitorsAllFullscreen() {
    var monitors = Hyprland.monitors && Hyprland.monitors.values ? Hyprland.monitors.values : []
    if (!monitors || monitors.length === 0) return false
    for (var i = 0; i < monitors.length; i++) {
      var name = String(monitors[i].name || "")
      if (!fullscreenByMonitor[name]) return false
    }
    return true
  }

  function loadShellConfig(raw) {
    try {
      var parsed = JSON.parse(String(raw || ""))
      shellConfig = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : ({})
    } catch (error) {
      shellConfig = ({})
    }
  }

  function refreshBackground() {
    if (!backgroundProbe.running) backgroundProbe.running = true
  }

  function refreshFullscreen() {
    if (fullscreenProbe.running) {
      fullscreenRefreshPending = true
      return
    }
    fullscreenProbe.running = true
  }

  function requestBorder(action) {
    if (borderLease.running) {
      pendingBorderAction = action
      return
    }
    pendingBorderAction = ""
    borderLease.command = ["bash", borderScript, action]
    borderLease.running = true
  }

  function handleFullscreenEvent(event) {
    var name = String(event && event.name ? event.name : "")
    if (name === "fullscreen") {
      var monitor = Hyprland.focusedMonitor
      var monitorName = monitor ? String(monitor.name || "") : ""
      if (monitorName !== "") {
        var next = ({})
        for (var key in fullscreenByMonitor) next[key] = fullscreenByMonitor[key]
        next[monitorName] = String(event.data || "") === "1"
        fullscreenByMonitor = next
      }
    }
    if (name === "fullscreen" || name === "focusedmon" || name === "workspace"
      || name === "openwindow" || name === "closewindow" || name === "movewindow") {
      Qt.callLater(root.refreshFullscreen)
    }
  }

  onBorderDesiredChanged: requestBorder(borderDesired ? "apply" : "restore")

  Component.onCompleted: {
    shellConfigFile.reload()
    refreshBackground()
    refreshFullscreen()
    requestBorder("restore")
  }

  Component.onDestruction: {
    borderLease.running = false
    fullscreenProbe.running = false
    backgroundProbe.running = false
    Quickshell.execDetached(["bash", borderScript, "restore"])
  }

  Plugin.Collector {
    id: collector
    active: true
  }

  FileView {
    id: shellConfigFile
    path: root.shellConfigPath
    watchChanges: true
    preload: true
    printErrors: false
    onLoaded: root.loadShellConfig(text())
    onLoadFailed: root.loadShellConfig("")
    onFileChanged: reload()
  }

  FileView {
    path: root.currentBackgroundLink
    watchChanges: true
    preload: false
    printErrors: false
    onFileChanged: root.refreshBackground()
  }

  Process {
    id: backgroundProbe
    command: ["readlink", "-f", root.currentBackgroundLink]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.currentBackground = String(text || "").trim()
    }
  }

  Process {
    id: fullscreenProbe
    command: ["bash", "-lc",
      "printf '{\"clients\":'; hyprctl -j clients; printf ',\"monitors\":'; hyprctl -j monitors; printf '}'"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var parsed = JSON.parse(String(text || ""))
          root.fullscreenByMonitor = Lease.fullscreenMonitors(parsed.clients, parsed.monitors)
        } catch (error) {
          root.fullscreenByMonitor = ({})
        }
      }
    }
    onRunningChanged: {
      if (!running && root.fullscreenRefreshPending) {
        root.fullscreenRefreshPending = false
        Qt.callLater(root.refreshFullscreen)
      }
    }
  }

  Process {
    id: borderLease
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.lastBorderResult = String(text || "").trim()
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.lastBorderError = String(text || "").trim()
    }
    onRunningChanged: {
      if (!running && root.pendingBorderAction !== "") {
        var next = root.pendingBorderAction
        root.pendingBorderAction = ""
        Qt.callLater(function() { root.requestBorder(next) })
      }
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) { root.handleFullscreenEvent(event) }
  }

  Overlay {
    id: overlay
    overlayEnabled: root.ambientOverlay
    storm: root.storm
    reduceMotion: root.reduceMotion
    currentBackground: root.currentBackground
    fullscreenByMonitor: root.fullscreenByMonitor
    allMonitorsFullscreen: root.allMonitorsFullscreen
  }

  IpcHandler {
    target: "omo-ambient"

    function status(): string {
      return JSON.stringify({
        storm: root.storm,
        ambientBorder: root.ambientBorder,
        ambientOverlay: root.ambientOverlay,
        reduceMotion: root.reduceMotion,
        background: root.currentBackground,
        backgroundMatches: root.backgroundMatches,
        fullscreen: root.fullscreenByMonitor,
        motion: overlay.motionAllowed,
        phase: overlay.phase,
        strikes: overlay.strikes,
        borderDesired: root.borderDesired,
        borderResult: root.lastBorderResult,
        borderError: root.lastBorderError
      })
    }
  }
}
