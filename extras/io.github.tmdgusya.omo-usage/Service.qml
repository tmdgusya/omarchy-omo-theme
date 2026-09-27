import QtQuick
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})
  property var snapshot: ({ generatedAt: "", providers: [], error: "" })
  property bool refreshing: false
  property string lastError: ""
  property string _output: ""
  property string _errorOutput: ""

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 300, 60, 3600)

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, minimum, maximum) {
    var value = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(value)) value = fallback
    return Math.max(minimum, Math.min(maximum, value))
  }

  function sourcePath() {
    return String(Qt.resolvedUrl("usage-source.js")).replace(/^file:\/\//, "")
  }

  function refresh() {
    if (refreshing || collector.running) return
    refreshing = true
    lastError = ""
    _output = ""
    _errorOutput = ""
    collector.command = ["env", "SENPI_BIN=" + setting("senpiPath", ""),
      String(setting("bunPath", "bun")), sourcePath()]
    collector.running = true
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: collector
    running: false
    command: []

    stdout: StdioCollector {
      id: stdoutCollector
      waitForEnd: true
      onStreamFinished: root._output = text
    }

    stderr: StdioCollector {
      id: stderrCollector
      waitForEnd: true
      onStreamFinished: root._errorOutput = text
    }

    onExited: function(exitCode) {
      var parsed = Model.parseSnapshot(String(stdoutCollector.text || root._output || ""))
      if (parsed.ok) {
        root.snapshot = parsed.snapshot
        if (exitCode !== 0 || parsed.snapshot.error)
          root.lastError = "Usage is unavailable right now."
      } else {
        root.lastError = parsed.error
      }
      root.refreshing = false
    }
  }
}
