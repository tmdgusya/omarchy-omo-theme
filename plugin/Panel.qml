import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// OmO bar widget: a compact cat cell with the active session count and a
// keyboard-driven session panel. Same shape as plugins/agents/Panel.qml, so
// shell summon/hide/toggle and the bar's popout coordinator treat it like a
// first-party panel widget.
Panel {
  id: root
  moduleName: "io.github.tmdgusya.omo"
  ipcTarget: "io.github.tmdgusya.omo"
  manageIpc: false

  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color panelForeground: Color.popups.text
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: bar ? bar.barSize : Style.bar.sizeHorizontal
  readonly property bool reduceMotion: Model.settingBool(settings, "reduceMotion", false)
  readonly property bool showCount: Model.settingBool(settings, "showCount", true)
  readonly property string senpiPath: Model.settingString(settings, "senpiPath") || "senpi"
  readonly property string agentDir: Model.settingString(settings, "agentDir")
    || Quickshell.env("SENPI_CODING_AGENT_DIR") || Quickshell.env("OMO_CODING_AGENT_DIR")
    || Quickshell.env("HOME") + "/.omo/agent"

  property double nowMs: Date.now()
  property var dismissed: ({})
  property int tooltipIndex: -1
  property string launchNotice: ""

  // Bundled next to this file; loaded into every session the widget launches.
  readonly property string extensionPath: Qt.resolvedUrl("omo-status.ts").toString().replace(/^file:\/\//, "")

  readonly property var summary: Model.aggregate(collector.sessions, nowMs, dismissed)
  readonly property string face: collector.stale ? "idle" : summary.state
  readonly property bool catRunning: !collector.stale && summary.animated
  readonly property bool catGlow: !collector.stale && summary.glow
  readonly property string caption: showCount && !collector.stale ? summary.caption : ""

  // Fixed cell geometry so the bar never reflows: vertical 28x40 (cat cell on
  // top, caption slot below), horizontal 40x26 (caption slot to the right).
  readonly property int cell: barSize
  readonly property int captionSlot: vertical ? Style.spacing.xxl : Style.spacing.xxxl
  readonly property int characterSize: Math.round(barSize * 0.86)
  readonly property real openPanelIndicatorWidth: cell
  readonly property real openPanelIndicatorHeight: cell

  implicitWidth: vertical ? cell : cell + captionSlot
  implicitHeight: vertical ? cell + captionSlot : cell

  readonly property string tooltipText: {
    if (launchNotice !== "") return launchNotice
    if (tooltipIndex >= 0 && tooltipIndex < collector.sessions.length) {
      var session = collector.sessions[tooltipIndex]
      return Model.elide(session.title, 48) + " \u00b7 " + Model.stateLabel(Model.effectiveState(session, nowMs, dismissed))
    }
    if (collector.stale) return "OmO \u00b7 session data unavailable \u00b7 " + collector.staleReason
    return summary.tooltip
  }

  function refresh() {
    nowMs = Date.now()
    collector.refresh()
  }

  function latestCwd() {
    return collector.sessions.length > 0 ? collector.sessions[0].cwd : ""
  }

  function launch(cwd) {
    var command = Model.launchCommand(cwd, root.extensionPath, root.senpiPath, root.agentDir)
    if (!command) {
      launchNotice = "OmO: senpiPath must be 'senpi' or an absolute executable path"
      return false
    }
    launchNotice = ""
    Quickshell.execDetached(command)
    root.close()
    return true
  }

  function focusSession(session) {
    var command = Model.focusCommand(session ? session.focusAddress : "")
    if (!command) return false
    Quickshell.execDetached(command)
    root.close()
    return true
  }

  function dismiss(id) {
    var next = ({})
    for (var key in dismissed) next[key] = dismissed[key]
    next[String(id)] = true
    dismissed = next
  }

  function cycleTooltip(delta) {
    var n = collector.sessions.length
    if (n === 0) return
    var step = delta < 0 ? 1 : -1
    tooltipIndex = ((tooltipIndex + step) % n + n) % n
    if (root.bar) root.bar.showTooltip(button, root.tooltipText)
  }

  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      tooltipIndex = -1
      list.reset()
      collector.refresh()
      if (panelFlick) panelFlick.contentY = 0
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      collector.clearView()
    }
  }

  Collector {
    id: collector
    settings: root.settings
    onPolled: root.nowMs = Date.now()
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(); return "ok" }
    function launch(): string { return root.launch(root.latestCwd()) ? "ok" : root.launchNotice }
    function status(): string {
      return JSON.stringify({
        face: root.face,
        active: root.summary.active,
        sessions: collector.sessions.length,
        stale: collector.stale,
        partial: collector.partial,
        pollMs: collector.intervalMs
      })
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.implicitWidth
    fixedHeight: root.implicitHeight
    tooltipText: root.tooltipText
    useActiveColor: false
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) root.launch(root.latestCwd())
      else root.toggle()
    }
    onWheelMoved: function(delta) { if (!root.opened) root.cycleTooltip(delta) }
    onTooltipHoveredChanged: if (!tooltipHovered) root.tooltipIndex = -1

    Item {
      id: cellArea
      width: root.cell
      height: root.cell
      anchors.top: parent.top
      anchors.left: parent.left

      Cat {
        id: cat
        anchors.centerIn: parent
        size: root.characterSize
        face: root.face
        stale: collector.stale
        running: root.catRunning
        glow: root.catGlow
        reduceMotion: root.reduceMotion
        accent: Color.accent
        attention: root.urgent
        failure: Color.urgent
      }
    }

    Text {
      id: captionLabel
      textFormat: Text.PlainText
      visible: root.caption !== ""
      anchors.top: root.vertical ? cellArea.bottom : parent.top
      anchors.left: root.vertical ? parent.left : cellArea.right
      width: root.vertical ? root.cell : root.captionSlot
      height: root.vertical ? root.captionSlot : root.cell
      text: root.caption
      color: root.summary.waiting > 0 ? root.urgent : root.foreground
      opacity: root.summary.waiting > 0 ? 1 : 0.7
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      renderType: Text.NativeRendering
      horizontalAlignment: Text.AlignHCenter
      verticalAlignment: Text.AlignVCenter
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(list.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dy !== 0) list.moveCursor(dy)
        if (dx !== 0) list.cycleFilter(dx)
      }
      onActivateRequested: list.activate()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { list.cycleFilter(direction) }
      onTextKey: function(text) {
        if (text === "v" || text === "V") list.viewSelected()
        else if (text === "n" || text === "N") root.launch(list.selectedCwd())
        else if (text === "d" || text === "D") list.dismissSelected()
        else if (text === "r" || text === "R") root.refresh()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: list.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        SessionList {
          id: list
          width: panelFlick.width
          panel: root
          collector: collector
        }
      }
    }
  }
}
