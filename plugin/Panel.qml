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
  // What starts a session (Launch, Open->resume): the launcher setting, else
  // the senpi executable, else plain `senpi` on the shell PATH.
  readonly property string launcherPath: Model.settingString(settings, "launcherPath") || senpiPath
  readonly property bool trackingInstalled: Model.settingBool(settings, "trackingInstalled", false)
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
    var command = Model.launchCommand(cwd, root.extensionPath, root.launcherPath, root.agentDir, root.trackingInstalled)
    if (!command) {
      launchNotice = "OmO: launcherPath must be 'senpi', 'omo', or an absolute executable path"
      return false
    }
    launchNotice = ""
    Quickshell.execDetached(command)
    root.close()
    return true
  }

  // Open is the one primary action: focus a verified window, resume an ended
  // session, or say why neither is possible on the row itself. Returns false
  // only while the Model API is missing so the list can fall back; otherwise
  // returns the result text used by both the panel and focus(id) IPC.
  function openSession(session) {
    if (!session || typeof Model.openCommand !== "function") return false
    var result = Model.openCommand(session, {
      extensionPath: root.extensionPath,
      launcherPath: root.launcherPath,
      agentDir: root.agentDir,
      trackingInstalled: root.trackingInstalled
    })
    var kind = result ? String(result.kind || "") : ""
    if ((kind === "focus" || kind === "resume") && result.argv && result.argv.length > 0) {
      list.clearOpenNotice(session.id)
      Quickshell.execDetached(result.argv)
      root.close()
      return "ok"
    }
    var reason = result && result.reason ? String(result.reason) : "cannot open this session"
    list.setOpenNotice(session.id, reason)
    return reason
  }

  function openSessionById(id) {
    var sessionId = String(id || "")
    if (sessionId === "") return "session id required"
    for (var i = 0; i < collector.sessions.length; i++) {
      var session = collector.sessions[i]
      if (String(session.id || "") === sessionId) return String(root.openSession(session))
    }
    return "session not found"
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
      if (!reduceMotion) contentReveal.restart()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      contentReveal.stop()
      keyCatcher.opacity = 1
      contentRise.y = 0
      collector.clearView()
    }
  }

  // Content settles into the card: a short fade with a rise, on top of the
  // kit's own card fade. Skipped entirely under reduceMotion.
  ParallelAnimation {
    id: contentReveal
    NumberAnimation { target: keyCatcher; property: "opacity"; from: 0; to: 1; duration: 220; easing.type: Easing.OutCubic }
    NumberAnimation { target: contentRise; property: "y"; from: Style.space(8); to: 0; duration: 220; easing.type: Easing.OutCubic }
  }

  // Fold handling: rows below the viewport are counted for the affordance,
  // and a selection change scrolls the selected row (with its details) fully
  // into view instead of leaving it cut at the card edge.
  readonly property int rowsBelowFold: list.rowsBelow(panelFlick.contentY + panelFlick.height, list.implicitHeight)
  readonly property int foldTop: Style.space(28)
  readonly property int foldBottom: Style.space(56)

  function scrollTo(y) {
    var max = Math.max(0, panelFlick.contentHeight - panelFlick.height)
    var target = Math.max(0, Math.min(y, max))
    scrollAnim.stop()
    if (root.reduceMotion) {
      panelFlick.contentY = target
      return
    }
    scrollAnim.to = target
    scrollAnim.start()
  }

  function ensureSelectedVisible() {
    if (!panelFlick.interactive) return
    // Clear the fade zones, not just the row: the selected row must stay
    // fully legible, capsules included.
    var top = list.selectedTop - root.foldTop
    var bottom = list.selectedBottom + root.foldBottom
    var target = panelFlick.contentY
    if (bottom > target + panelFlick.height) target = bottom - panelFlick.height
    if (top < target) target = top
    // The first row brings the hero back with it.
    if (list.selectedIndex === 0) target = 0
    if (Math.abs(target - panelFlick.contentY) >= 1) scrollTo(target)
  }

  NumberAnimation {
    id: scrollAnim
    target: panelFlick
    property: "contentY"
    duration: 220
    easing.type: Easing.OutCubic
  }

  // Twice: once right away, once after the details have finished expanding.
  Connections {
    target: list
    function onSelectedIndexChanged() {
      Qt.callLater(root.ensureSelectedVisible)
      settleScroll.restart()
    }
  }

  Timer {
    id: settleScroll
    interval: 300
    repeat: false
    onTriggered: root.ensureSelectedVisible()
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
    function focus(id: string): string { return root.openSessionById(id) }
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
    // Hairline frame instead of the kit's 2px default; a theme border-width
    // in [popups] still wins.
    borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Style.spacing.hairline)

    // Inner sheen: a faint moonlight wash from the top edge, drawn inside the
    // hairline (the negative margin spans the card padding, not the border).
    Rectangle {
      anchors.fill: parent
      anchors.margins: -panel.padding
      radius: Style.cornerRadius
      gradient: Gradient {
        GradientStop { position: 0.0; color: Util.alpha(Color.accent, 0.08) }
        GradientStop { position: 0.38; color: Util.alpha(Color.accent, 0.0) }
      }
    }

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      transform: Translate { id: contentRise }

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

      // Fold masks: content dissolves into the card edge instead of being
      // sliced, and only while there is more to scroll in that direction.
      Rectangle {
        id: topFade
        anchors.left: panelFlick.left
        anchors.right: panelFlick.right
        anchors.top: panelFlick.top
        height: root.foldTop
        visible: opacity > 0
        opacity: panelFlick.interactive && !panelFlick.atYBeginning ? 1 : 0
        gradient: Gradient {
          GradientStop { position: 0.0; color: Color.popups.background }
          GradientStop { position: 1.0; color: Util.alpha(Color.popups.background, 0) }
        }

        Behavior on opacity {
          enabled: !root.reduceMotion
          NumberAnimation { duration: 160 }
        }
      }

      Rectangle {
        id: bottomFade
        anchors.left: panelFlick.left
        anchors.right: panelFlick.right
        anchors.bottom: panelFlick.bottom
        height: root.foldBottom
        visible: opacity > 0
        opacity: panelFlick.interactive && !panelFlick.atYEnd ? 1 : 0
        gradient: Gradient {
          GradientStop { position: 0.0; color: Util.alpha(Color.popups.background, 0) }
          // Solid card from just above the fold pill down: the pill must
          // never composite over half-faded row text.
          GradientStop { position: Math.max(0, 1 - (foldHint.implicitHeight + foldHint.anchors.bottomMargin + Style.spacing.sm) / root.foldBottom); color: Color.popups.background }
          GradientStop { position: 1.0; color: Color.popups.background }
        }

        Behavior on opacity {
          enabled: !root.reduceMotion
          NumberAnimation { duration: 160 }
        }
      }

      // Scroll affordance: how many rows wait below the fold; click pages down.
      Rectangle {
        id: foldHint
        anchors.horizontalCenter: panelFlick.horizontalCenter
        anchors.bottom: panelFlick.bottom
        anchors.bottomMargin: Style.spacing.sm
        visible: bottomFade.visible && root.rowsBelowFold > 0
        opacity: bottomFade.opacity
        implicitWidth: foldText.implicitWidth + Style.spacing.lg * 2
        implicitHeight: foldText.implicitHeight + Style.spacing.xs * 2
        radius: Style.cornerRadius
        color: Style.selectedFillFor(root.panelForeground, Color.accent)

        Text {
          id: foldText
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: "\u2193 " + root.rowsBelowFold + " more"
          color: Qt.darker(root.panelForeground, 1.25)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.scrollTo(panelFlick.contentY + panelFlick.height * 0.8)
        }
      }
    }
  }
}
