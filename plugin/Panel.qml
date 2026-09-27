import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// OmO bar widget (docs/DESIGN-v3.md): the face cell — a 20 px squircle-plate
// face, a mono count badge and, on a horizontal bar, one line of Korean copy
// while a session needs eyes — plus the keyboard-driven session panel. Same
// shape as plugins/agents/Panel.qml, so shell summon/hide/toggle and the
// bar's popout coordinator treat it like a first-party panel widget.
Panel {
  id: root
  moduleName: "io.github.tmdgusya.omo"
  ipcTarget: "io.github.tmdgusya.omo"
  manageIpc: false

  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color panelForeground: Color.popups.text
  // Amber: the bar's attention color, "a human is needed".
  readonly property color urgent: bar ? bar.urgent : Color.bar.active
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false
  readonly property string barPosition: bar ? bar.position : "top"
  readonly property int barSize: bar ? bar.barSize : Style.bar.sizeHorizontal
  readonly property bool reduceMotion: Model.settingBool(settings, "reduceMotion", false)
  readonly property bool showCount: Model.settingBool(settings, "showCount", true)
  readonly property string senpiPath: Model.settingString(settings, "senpiPath") || "senpi"
  // What starts a session (새로 시작, 열기 -> resume): the launcher setting,
  // else the senpi executable, else plain `senpi` on the shell PATH.
  readonly property string launcherPath: Model.settingString(settings, "launcherPath") || senpiPath
  readonly property bool trackingInstalled: Model.settingBool(settings, "trackingInstalled", false)
  readonly property string agentDir: Model.settingString(settings, "agentDir")
    || Quickshell.env("SENPI_CODING_AGENT_DIR") || Quickshell.env("OMO_CODING_AGENT_DIR")
    || Quickshell.env("HOME") + "/.omo/agent"
  // Bundled next to this file; loaded into every session the widget launches.
  readonly property string extensionPath: Qt.resolvedUrl("omo-status.ts").toString().replace(/^file:\/\//, "")
  // What 열기 needs to decide between focus, resume and "cannot".
  readonly property var openOptions: ({
    extensionPath: extensionPath,
    launcherPath: launcherPath,
    agentDir: agentDir,
    trackingInstalled: trackingInstalled
  })

  property double nowMs: Date.now()
  property var dismissed: ({})
  property int tooltipIndex: -1
  property string launchNotice: ""

  readonly property var summary: Model.aggregate(collector.sessions, nowMs, dismissed)
  readonly property string face: collector.stale ? "idle" : Model.faceFor(summary.state, collector.sessions.length)
  readonly property bool catRunning: !collector.stale && summary.animated
  readonly property bool catGlow: !collector.stale && summary.glow
  readonly property int count: showCount && !collector.stale ? Model.badgeCount(summary) : 0
  readonly property string copy: vertical || collector.stale ? "" : Model.barCopy(face)

  // Cell geometry on the 4 px grid: a 20 px face box inset so the cell spans
  // the bar (6 px at 32, 8 px at 36); badge and copy run along the bar.
  readonly property int faceSize: Style.space(20)
  readonly property int cellInset: Math.max(Style.spacing.xxs, Math.floor((barSize - faceSize) / 2))
  readonly property real openPanelIndicatorWidth: barSize
  readonly property real openPanelIndicatorHeight: barSize

  implicitWidth: vertical ? barSize : cat.implicitWidth
  implicitHeight: vertical ? cat.implicitHeight : barSize

  // The list's cursor and the key dispatcher, for shell IPC and harnesses.
  property alias sessionList: list
  property alias keyCatcherItem: keyCatcher

  readonly property string tooltipText: {
    if (launchNotice !== "") return launchNotice
    if (tooltipIndex >= 0 && tooltipIndex < collector.sessions.length) {
      var session = collector.sessions[tooltipIndex]
      return Model.elide(session.title, 48) + " \u00b7 " + Model.stateLabelKo(Model.effectiveState(session, nowMs, dismissed))
    }
    if (collector.stale) return "OmO \u00b7 세션 정보를 읽지 못했어요 \u00b7 " + collector.staleReason
    return Model.summaryLine(summary)
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
      launchNotice = "OmO: launcherPath는 senpi, omo 또는 절대 경로여야 해요."
      return false
    }
    launchNotice = ""
    Quickshell.execDetached(command)
    root.close()
    return true
  }

  // 열기 is the one primary action: focus a verified window, resume an ended
  // session, or say why neither is possible on the card itself. Returns the
  // result text used by both the panel and focus(id) IPC.
  function openSession(session) {
    if (!session) return false
    var result = Model.openCommand(session, root.openOptions)
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
      contentRise.x = 0
      contentRise.y = 0
      collector.clearView()
    }
  }

  // Content enters from the bar edge: it drops down under a top bar and
  // flies out beside a vertical one, on top of the kit's own card fade.
  // Under reduceMotion the kit fade is the whole transition.
  readonly property real revealOffset: Style.space(8)

  ParallelAnimation {
    id: contentReveal
    NumberAnimation { target: keyCatcher; property: "opacity"; from: 0; to: 1; duration: 220; easing.type: Easing.OutCubic }
    NumberAnimation {
      target: contentRise
      property: root.vertical ? "x" : "y"
      from: root.barPosition === "bottom" || root.barPosition === "right" ? root.revealOffset : -root.revealOffset
      to: 0
      duration: 220
      easing.type: Easing.OutCubic
    }
  }

  // Fold handling: cards below the viewport are counted for the affordance,
  // and a selection change scrolls the selected card (with its actions) fully
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
    var top = list.selectedTop - root.foldTop
    var bottom = list.selectedBottom + root.foldBottom
    var target = panelFlick.contentY
    if (bottom > target + panelFlick.height) target = bottom - panelFlick.height
    if (top < target) target = top
    // The first card brings the header back with it.
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

  // Twice: once right away, once after the card has finished expanding.
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
        state: root.summary.state,
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

    Cat {
      id: cat
      anchors.top: parent.top
      anchors.left: parent.left
      size: root.faceSize
      inset: root.cellInset
      vertical: root.vertical
      face: root.face
      running: root.catRunning
      glow: root.catGlow
      stale: collector.stale
      reduceMotion: root.reduceMotion
      hovered: button.tooltipHovered || root.opened
      count: root.count
      copy: root.copy
      foreground: root.foreground
      accent: Color.accent
      attention: root.urgent
      failure: Color.urgent
      fontFamily: root.fontFamily
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

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      transform: Translate { id: contentRise }

      onMoveRequested: function(dx, dy) {
        if (dy !== 0) list.moveCursor(dy)
        if (dx !== 0) list.toggleHistory()
      }
      onActivateRequested: list.activate()
      onCloseRequested: root.close()
      onDeleteRequested: list.dismissSelected()
      onTabRequested: function(direction) { list.jumpSection(direction) }
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
          // never composite over half-faded card text.
          GradientStop { position: Math.max(0, 1 - (foldHint.implicitHeight + foldHint.anchors.bottomMargin + Style.spacing.sm) / root.foldBottom); color: Color.popups.background }
          GradientStop { position: 1.0; color: Color.popups.background }
        }

        Behavior on opacity {
          enabled: !root.reduceMotion
          NumberAnimation { duration: 160 }
        }
      }

      // Scroll affordance: how many cards wait below the fold; click pages down.
      Rectangle {
        id: foldHint
        anchors.horizontalCenter: panelFlick.horizontalCenter
        anchors.bottom: panelFlick.bottom
        anchors.bottomMargin: Style.spacing.sm
        visible: bottomFade.visible && root.rowsBelowFold > 0
        opacity: bottomFade.opacity
        implicitWidth: foldText.implicitWidth + Style.spacing.lg * 2
        implicitHeight: foldText.implicitHeight + Style.spacing.xs * 2
        radius: height / 2
        color: Style.selectedFillFor(root.panelForeground, Color.accent)

        Text {
          id: foldText
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: "\u2193 " + root.rowsBelowFold + "개 더"
          color: root.panelForeground
          font.family: Model.TOKENS.sansFamily
          font.pixelSize: Style.font.bodySmall
          font.weight: Font.Medium
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
