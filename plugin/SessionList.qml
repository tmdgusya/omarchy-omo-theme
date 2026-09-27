pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Effects
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Panel content: a hero (cat + live summary pills), a segmented filter, one
// row per session with verified-working rows pinned on top, the selected
// row's ledger progress and actions, and the key legend. Progress is shown
// as counts only (todo completed/total, verified passed/total); state chips
// carry only what the collector could prove. Every animation is gated on
// `reduceMotion`, and nothing moves for idle, unknown, ended, or stale rows:
// the accent line and its breathing exist solely for runtime.working.
Column {
  id: root

  property var panel: null
  property var collector: null
  property string filter: "all"
  property int cursor: 0
  property bool cursorActive: false

  readonly property color fg: Color.popups.text
  readonly property color dim: Qt.darker(fg, 1.55)
  readonly property color attention: panel ? panel.urgent : Color.urgent
  // Moonlight: the accent lifted one step, used only for glows.
  readonly property color glowTint: Qt.lighter(Color.accent, 1.12)
  readonly property string fontFamily: panel ? panel.fontFamily : Style.font.family
  readonly property bool reduceMotion: panel ? panel.reduceMotion : false
  readonly property bool opened: panel ? panel.opened === true : true
  readonly property double nowMs: panel ? panel.nowMs : 0
  readonly property var dismissed: panel ? panel.dismissed : ({})
  readonly property var summary: panel ? panel.summary : Model.aggregate([], 0, null)
  readonly property var sessions: collector ? collector.sessions : []
  readonly property bool stale: collector ? collector.stale : false
  readonly property bool partial: collector ? collector.partial : false
  readonly property bool scanning: collector ? collector.scanning : false
  // Filter membership and pinning never depend on the clock (only the
  // success/idle chip does), so rows are rebuilt on data, filter, or
  // dismissal changes alone.
  readonly property var rows: pinRunning(Model.filterSessions(sessions, filter, 0, dismissed))
  readonly property int selectedIndex: Model.clampIndex(cursor, rows.length)
  readonly property var selected: rows.length > 0 ? rows[selectedIndex] : null
  readonly property color track: Style.selectedFillFor(fg, Color.accent)

  readonly property int unverified: summary.counts ? summary.counts.unknown : 0
  readonly property int errors: summary.counts ? summary.counts.error : 0
  readonly property int recent: summary.counts && summary.counts.recent ? summary.counts.recent : 0

  // Why Open could not act, per session id; shown on that row until the
  // panel reopens or a later Open succeeds. Reassigned as a whole so
  // bindings re-evaluate.
  property var openNotices: ({})

  function setOpenNotice(id, text) {
    var next = ({})
    for (var key in openNotices) next[key] = openNotices[key]
    next[String(id)] = String(text)
    openNotices = next
  }

  function clearOpenNotice(id) {
    if (!(String(id) in openNotices)) return
    var next = ({})
    for (var key in openNotices) if (key !== String(id)) next[key] = openNotices[key]
    openNotices = next
  }

  // Model reasons are terse machine strings; the row shows plain UI copy.
  function openReasonText(reason) {
    var r = String(reason || "")
    if (r === "running elsewhere") return "Running in another terminal"
    if (r === "") return "Cannot open this session"
    return r.charAt(0).toUpperCase() + r.slice(1)
  }

  // Live summary line under the title; the colored pills break it down.
  readonly property string headerLine: {
    if (stale) return "session data unavailable \u00b7 " + (collector ? collector.staleReason : "")
    if (scanning && sessions.length === 0) return "Scanning\u2026"
    if (sessions.length === 0) return "no senpi sessions"
    var line = sessions.length + (sessions.length === 1 ? " session" : " sessions")
    if (summary.active === 0) line += " \u00b7 none active"
    return line
  }

  // Sliding selection card: the selected delegate reports its geometry here
  // and the single highlight rectangle animates between rows.
  property real highlightY: 0
  property real highlightHeight: 0

  // Fold bookkeeping for the panel: where the selected row will end once its
  // details have expanded (list coordinates), and how many rows sit below a
  // given viewport bottom. `layoutTick` only exists so a binding re-runs when
  // the list relayouts.
  property real selectedTargetHeight: 0
  readonly property real selectedTop: settledTop(selectedIndex, rowList.implicitHeight)
  readonly property real selectedBottom: selectedTop + selectedTargetHeight

  // Where row `index` will sit once every other row has collapsed: only one
  // row is ever expanded, so the settled layout is the collapsed heights of
  // the rows above it. Delegates are created in index order.
  function settledTop(index, layoutTick) {
    var y = rowArea.y
    var seen = 0
    for (var i = 0; i < rowList.children.length; i++) {
      var child = rowList.children[i]
      if (!child || child.collapsedHeight === undefined) continue
      if (seen === index) return y
      y += child.collapsedHeight + rowList.spacing
      seen += 1
    }
    return y
  }

  function rowsBelow(viewportBottom, layoutTick) {
    var n = 0
    var base = rowArea.y + rowList.y
    for (var i = 0; i < rowList.children.length; i++) {
      var child = rowList.children[i]
      if (!child || !(child.height > 0)) continue
      if (base + child.y + child.height > viewportBottom + 1) n += 1
    }
    return n
  }

  // Open reveal: rows created (or already present) while the panel is opening
  // stagger in once per open. `revealSerial` replays existing delegates,
  // `revealArmed` lets delegates rebuilt by a refresh during the first
  // moments join the same timeline instead of starting a second one.
  property bool revealArmed: false
  property int revealSerial: 0
  property double revealStartMs: 0

  spacing: Style.spacing.xxl

  onOpenedChanged: {
    if (opened && !reduceMotion) {
      revealArmed = true
      revealStartMs = Date.now()
      revealSerial += 1
      revealTimer.restart()
    } else {
      revealArmed = false
    }
  }

  Timer {
    id: revealTimer
    interval: 900
    repeat: false
    onTriggered: root.revealArmed = false
  }

  function reset() {
    cursor = 0
    cursorActive = false
    openNotices = ({})
  }

  function moveCursor(dy) {
    if (rows.length === 0) return
    cursorActive = true
    cursor = Model.clampIndex(selectedIndex + dy, rows.length)
  }

  function cycleFilter(step) {
    filter = Model.nextFilter(filter, step)
    cursor = 0
  }

  function stateOf(session) {
    return Model.effectiveState(session, nowMs, dismissed)
  }

  function isRunningState(state) {
    return state === "working" || state === "ultrawork"
  }

  // Verified-working sessions first, everything else in collector order.
  // Stable: the collector already sorts by activity.
  function pinRunning(list) {
    var running = []
    var rest = []
    for (var i = 0; i < list.length; i++) {
      if (isRunningState(Model.effectiveState(list[i], 0, dismissed))) running.push(list[i])
      else rest.push(list[i])
    }
    return running.concat(rest)
  }

  function chipColor(state) {
    if (state === "error") return Color.urgent
    if (state === "waiting") return attention
    if (state === "working" || state === "ultrawork" || state === "success") return Color.accent
    return dim
  }

  function isPillState(state) {
    return state === "error" || state === "waiting" || state === "working" || state === "ultrawork" || state === "success"
  }

  function selectedCwd() {
    if (selected && selected.cwd !== "") return selected.cwd
    return panel ? panel.latestCwd() : ""
  }

  function viewSelected() {
    if (selected && collector) collector.requestView(selected.sessionPath)
  }

  // Enter, double-click, and the Open capsule all land here.
  function activate() {
    if (!selected) return
    openSession(selected)
  }

  function openSession(session) {
    if (!session) return
    if (panel && typeof panel.openSession === "function" && panel.openSession(session)) return
    // Before the Model API lands: focus a verified window, else show details.
    if (panel && panel.focusSession(session)) return
    if (collector) collector.requestView(session.sessionPath)
  }

  function dismissSelected() {
    if (selected && panel && stateOf(selected) === "error") panel.dismiss(selected.id)
  }

  function countFor(which) {
    return Model.filterSessions(sessions, which, 0, dismissed).length
  }

  // ---------- hero
  Item {
    id: hero
    width: parent.width
    implicitHeight: Math.max(heroCatFrame.height, heroText.implicitHeight)

    readonly property string topState: root.stale ? "idle" : root.summary.state
    readonly property color tone: topState === "error" ? Color.urgent
      : (topState === "waiting" ? root.attention : root.glowTint)
    readonly property bool lit: !root.stale && (root.summary.running > 0 || topState === "waiting" || topState === "error")

    Item {
      id: heroCatFrame
      width: Style.space(44)
      height: width
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter

      // Moonlight disc behind the cat while something needs eyes: aqua for
      // verified work, butter for a waiting human, coral for a failure.
      Rectangle {
        id: heroGlowSource
        anchors.centerIn: parent
        width: Style.space(30)
        height: width
        radius: width / 2
        color: hero.tone
        visible: false
      }

      MultiEffect {
        id: heroGlow
        anchors.fill: heroGlowSource
        source: heroGlowSource
        blurEnabled: true
        blur: 1.0
        blurMax: 32
        opacity: hero.lit ? 0.55 : 0
        visible: opacity > 0

        Behavior on opacity {
          enabled: !root.reduceMotion
          NumberAnimation { duration: 320; easing.type: Easing.OutCubic }
        }
      }

      Cat {
        id: headerCat
        anchors.centerIn: parent
        size: Style.space(40)
        face: root.panel ? root.panel.face : "idle"
        stale: root.stale
        running: root.panel ? root.panel.catRunning : false
        glow: root.panel ? root.panel.catGlow : false
        reduceMotion: root.reduceMotion
        showDot: false
        accent: Color.accent
        attention: root.attention
        failure: Color.urgent
      }
    }

    Column {
      id: heroText
      anchors.left: heroCatFrame.right
      anchors.leftMargin: Style.spacing.xxl
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.spacing.sm

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: "Sessions"
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        elide: Text.ElideRight
      }

      Flow {
        width: parent.width
        spacing: Style.spacing.sm

        // Padded to pill height so the line and the pills share a baseline.
        Text {
          id: heroMeta
          textFormat: Text.PlainText
          width: Math.min(implicitWidth, parent.width)
          text: root.headerLine
          color: root.stale ? Color.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
          topPadding: Style.spacing.xs
          bottomPadding: Style.spacing.xs
          elide: Text.ElideRight
        }

        SummaryPill { count: root.stale ? 0 : root.summary.running; word: "working"; tone: Color.accent }
        SummaryPill { count: root.stale ? 0 : root.summary.waiting; word: "waiting"; tone: root.attention }
        SummaryPill { count: root.stale ? 0 : root.errors; word: "error"; tone: Color.urgent }
        SummaryPill { count: root.stale ? 0 : root.recent; word: "recent"; tone: root.dim; quiet: true }
        SummaryPill { count: root.stale ? 0 : root.unverified; word: "unverified"; tone: root.dim; quiet: true }
      }
    }
  }

  // ---------- segmented filter
  Rectangle {
    id: tabs
    width: parent.width
    implicitHeight: tabRow.implicitHeight + pad * 2
    visible: root.sessions.length > 0
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.fg, Color.accent)

    readonly property int pad: Style.spacing.xxs
    readonly property real cellWidth: (width - pad * 2) / Model.FILTERS.length
    readonly property int activeIndex: Math.max(0, Model.FILTERS.indexOf(root.filter))

    Rectangle {
      id: thumb
      x: tabs.pad + tabs.activeIndex * tabs.cellWidth
      y: tabs.pad
      width: tabs.cellWidth
      height: tabs.height - tabs.pad * 2
      radius: Style.cornerRadius
      color: Style.selectedFillFor(root.fg, Color.accent)

      Behavior on x {
        enabled: !root.reduceMotion
        NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
      }
    }

    Row {
      id: tabRow
      x: tabs.pad
      y: tabs.pad

      Repeater {
        model: Model.FILTERS

        SegmentTab {
          required property string modelData
          which: modelData
          width: tabs.cellWidth
        }
      }
    }
  }

  // ---------- notices: a quiet one-line info chip
  Rectangle {
    id: notice
    visible: root.partial && !root.stale && root.collector && root.collector.notice !== ""
    width: Math.min(parent.width, noticeText.implicitWidth + Style.spacing.lg * 2)
    implicitHeight: noticeText.implicitHeight + Style.spacing.xs * 2
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.fg, Color.accent)

    Text {
      id: noticeText
      textFormat: Text.PlainText
      anchors.fill: parent
      anchors.leftMargin: Style.spacing.lg
      anchors.rightMargin: Style.spacing.lg
      verticalAlignment: Text.AlignVCenter
      text: "partial list \u00b7 " + (root.collector ? root.collector.notice : "")
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  // ---------- empty state
  Column {
    visible: root.rows.length === 0
    width: parent.width
    spacing: Style.spacing.sm
    topPadding: Style.space(8)
    bottomPadding: Style.space(8)

    Text {
      textFormat: Text.PlainText
      width: parent.width
      text: root.stale
        ? "The collector did not answer; showing nothing rather than a guess."
        : (root.sessions.length === 0 ? "No senpi sessions found" : "No " + Model.filterLabel(root.filter).toLowerCase() + " sessions")
      color: root.fg
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      text: "n  launch a new senpi session (with live state)"
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      horizontalAlignment: Text.AlignHCenter
    }
  }

  // ---------- rows
  Item {
    id: rowArea
    width: parent.width
    implicitHeight: rowList.implicitHeight
    visible: root.rows.length > 0

    // One highlight card for the whole list; it slides to the selected row
    // and grows with that row's details.
    Rectangle {
      id: highlight
      x: 0
      width: parent.width
      y: root.highlightY
      height: root.highlightHeight
      radius: Style.cornerRadius
      color: Style.selectedFillFor(root.fg, Color.accent)
      visible: height > 0

      Behavior on y {
        enabled: !root.reduceMotion
        NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
      }
    }

    Column {
      id: rowList
      width: parent.width
      spacing: Style.spacing.xxs

      Repeater {
        model: root.rows

        Column {
          id: row
          required property var modelData
          required property int index

          readonly property bool isSelected: index === root.selectedIndex
          readonly property string rowState: root.stateOf(modelData)
          readonly property bool isRunning: root.isRunningState(rowState)
          readonly property bool quiet: rowState === "ended" || rowState === "unknown"
          readonly property var ledger: Model.progress(modelData)
          readonly property bool showsView: root.collector && root.collector.viewPath !== "" && root.collector.viewPath === modelData.sessionPath
            && (root.collector.viewing || root.collector.viewOutput !== "" || root.collector.viewError !== "")
          // Height of this row with its details closed (the settled height
          // of every unselected row).
          readonly property real collapsedHeight: rowContent.implicitHeight + Style.spacing.md * 2

          width: rowList.width
          spacing: 0
          transform: Translate { id: shift }

          function syncHighlight() {
            if (!isSelected) return
            root.highlightY = y
            root.highlightHeight = height
            root.selectedTargetHeight = collapsedHeight + details.implicitHeight
          }

          function playReveal() {
            if (root.reduceMotion) return
            var elapsed = root.revealArmed ? Date.now() - root.revealStartMs : 0
            var wait = Math.min(index, 7) * 32 - elapsed
            if (wait + 220 <= 0) return
            reveal.stop()
            revealPause.duration = Math.max(0, wait)
            opacity = 0
            shift.y = Style.space(10)
            reveal.start()
          }

          function replayProgress() {
            if (!isSelected) return
            todoLine.replay()
            ulwLine.replay()
          }

          onIsSelectedChanged: {
            syncHighlight()
            if (isSelected) replayProgress()
          }
          onYChanged: syncHighlight()
          onHeightChanged: syncHighlight()
          Component.onCompleted: {
            syncHighlight()
            if (root.revealArmed) {
              playReveal()
              replayProgress()
            }
          }

          Connections {
            target: root
            function onRevealSerialChanged() {
              row.playReveal()
              row.replayProgress()
            }
          }

          SequentialAnimation {
            id: reveal

            PauseAnimation { id: revealPause; duration: 0 }
            ParallelAnimation {
              NumberAnimation { target: row; property: "opacity"; to: 1; duration: 220; easing.type: Easing.OutCubic }
              NumberAnimation { target: shift; property: "y"; to: 0; duration: 320; easing.type: Easing.OutCubic }
            }
          }

          // Two lines per row: the title owns the full width; chip, project,
          // and time sit underneath. The selected title wraps to three lines.
          Rectangle {
            id: rowSurface
            width: parent.width
            height: rowContent.implicitHeight + Style.spacing.md * 2
            radius: Style.cornerRadius
            color: rowHover.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"

            Behavior on color {
              enabled: !root.reduceMotion
              ColorAnimation { duration: 120 }
            }

            Behavior on height {
              enabled: !root.reduceMotion
              NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
            }

            // Verified work only: a hairline of accent with a soft moonlight
            // halo that breathes. Never shown for waiting, idle, unknown,
            // ended, or error rows; it holds still and dims when the
            // collector data itself is stale.
            Item {
              id: accentLine
              visible: row.isRunning
              anchors.left: parent.left
              anchors.top: parent.top
              anchors.bottom: parent.bottom
              anchors.topMargin: Style.spacing.md
              anchors.bottomMargin: Style.spacing.md
              width: Style.space(16)
              opacity: root.stale ? 0.35 : 0.85

              SequentialAnimation on opacity {
                running: row.isRunning && !root.reduceMotion && root.opened && !root.stale
                loops: Animation.Infinite
                NumberAnimation { from: 0.55; to: 1.0; duration: 1400; easing.type: Easing.InOutSine }
                NumberAnimation { from: 1.0; to: 0.55; duration: 1400; easing.type: Easing.InOutSine }
              }

              Rectangle {
                anchors.fill: parent
                gradient: Gradient {
                  orientation: Gradient.Horizontal
                  GradientStop { position: 0.0; color: Util.alpha(root.glowTint, 0.30) }
                  GradientStop { position: 1.0; color: Util.alpha(root.glowTint, 0.0) }
                }
              }

              Rectangle {
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: Style.spacing.xxs
                radius: Style.cornerRadius
                color: Color.accent
              }
            }

            Cat {
              id: rowFace
              anchors.left: parent.left
              anchors.leftMargin: Style.spacing.xl
              anchors.top: parent.top
              anchors.topMargin: Style.spacing.md + Math.max(0, Math.round((titleText.height - height) / 2))
              size: Style.space(16)
              face: row.rowState
              running: false
              glow: false
              reduceMotion: true
              showDot: false
              accent: Color.accent
              attention: root.attention
              failure: Color.urgent
              opacity: row.quiet ? 0.55 : 1
            }

            Column {
              id: rowContent
              anchors.left: rowFace.right
              anchors.leftMargin: Style.spacing.lg
              anchors.right: parent.right
              anchors.rightMargin: Style.spacing.lg
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.spacing.xs

              Text {
                id: titleText
                textFormat: Text.PlainText
                width: parent.width
                text: row.modelData.title
                color: root.fg
                opacity: row.quiet ? 0.8 : 1
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
                wrapMode: row.isSelected ? Text.Wrap : Text.NoWrap
                maximumLineCount: row.isSelected ? 3 : 1
              }

              Row {
                id: meta
                width: parent.width
                spacing: Style.spacing.md

                StateChip {
                  kind: row.rowState
                  anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                  id: projectText
                  textFormat: Text.PlainText
                  visible: row.modelData.cwdLabel !== ""
                  anchors.verticalCenter: parent.verticalCenter
                  width: Math.min(implicitWidth, Math.floor(meta.width * 0.5))
                  text: row.modelData.cwdLabel
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }

                Text {
                  textFormat: Text.PlainText
                  visible: text !== ""
                  anchors.verticalCenter: parent.verticalCenter
                  text: Model.relativeTime(row.modelData.activityMs, root.nowMs)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  textFormat: Text.PlainText
                  visible: row.modelData.partial === true
                  anchors.verticalCenter: parent.verticalCenter
                  text: "partial"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.italic: true
                }
              }
            }

            MouseArea {
              id: rowHover
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: {
                root.cursorActive = true
                root.cursor = row.index
              }
              onDoubleClicked: {
                root.cursor = row.index
                root.activate()
              }
            }
          }

          Item {
            id: expansion
            width: parent.width
            height: row.isSelected ? details.implicitHeight : 0
            clip: true

            Behavior on height {
              enabled: !root.reduceMotion
              NumberAnimation { duration: 260; easing.type: Easing.OutCubic }
            }

            Column {
              id: details
              width: parent.width
              leftPadding: Style.spacing.xl
              rightPadding: Style.spacing.xl
              topPadding: Style.spacing.sm
              bottomPadding: Style.spacing.xl
              spacing: Style.spacing.lg
              opacity: row.isSelected ? 1 : 0

              readonly property real innerWidth: width - leftPadding - rightPadding

              Behavior on opacity {
                enabled: !root.reduceMotion
                NumberAnimation { duration: 200; easing.type: Easing.OutCubic }
              }

              ProgressLine {
                id: todoLine
                visible: !!row.ledger.todo
                width: details.innerWidth
                label: row.ledger.todo ? row.ledger.todo.label : ""
                done: row.ledger.todo ? row.ledger.todo.completed : 0
                total: row.ledger.todo ? row.ledger.todo.total : 0
                ratio: row.ledger.todo ? row.ledger.todo.ratio : 0
              }

              ProgressLine {
                id: ulwLine
                visible: !!row.ledger.ulw
                width: details.innerWidth
                label: row.ledger.ulw ? row.ledger.ulw.label : ""
                done: row.ledger.ulw ? row.ledger.ulw.passed : 0
                total: row.ledger.ulw ? row.ledger.ulw.total : 0
                ratio: row.ledger.ulw ? row.ledger.ulw.ratio : 0
              }

              Text {
                textFormat: Text.PlainText
                visible: text !== ""
                width: details.innerWidth
                text: Model.evidenceLabel(row.modelData)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }

              // Why the last Open on this row could not act.
              Text {
                textFormat: Text.PlainText
                visible: text !== ""
                width: details.innerWidth
                text: root.openNotices[row.modelData.id] !== undefined ? root.openReasonText(root.openNotices[row.modelData.id]) : ""
                color: root.attention
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }

              Row {
                spacing: Style.spacing.md

                ActionCapsule {
                  primary: true
                  text: "Open"
                  onClicked: root.openSession(row.modelData)
                }

                ActionCapsule {
                  visible: row.modelData.sessionPath !== ""
                  text: "Details"
                  onClicked: if (root.collector) root.collector.requestView(row.modelData.sessionPath)
                }

                ActionCapsule {
                  text: "Launch"
                  onClicked: if (root.panel) root.panel.launch(row.modelData.cwd)
                }

                ActionCapsule {
                  visible: row.rowState === "error"
                  text: "Dismiss"
                  onClicked: if (root.panel) root.panel.dismiss(row.modelData.id)
                }
              }

              // Collector summary of the session file (id, title, directory,
              // activity, runtime, ledgers) — not a transcript.
              Rectangle {
                visible: row.showsView
                width: details.innerWidth
                implicitHeight: viewColumn.implicitHeight + Style.spacing.lg * 2
                radius: Style.cornerRadius
                color: Style.normalFillFor(root.fg, Color.accent)

                Column {
                  id: viewColumn
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.top: parent.top
                  anchors.margins: Style.spacing.lg
                  spacing: Style.spacing.xs

                  PanelSectionHeader {
                    width: parent.width
                    text: "SESSION DETAILS"
                    foreground: root.fg
                    fontFamily: root.fontFamily
                  }

                  Text {
                    id: viewText
                    textFormat: Text.PlainText
                    width: parent.width
                    text: root.collector && root.collector.viewing
                      ? "Loading\u2026"
                      : (root.collector && root.collector.viewOutput !== "" ? root.collector.viewOutput : (root.collector ? root.collector.viewError : ""))
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.WrapAnywhere
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ---------- key legend
  Text {
    textFormat: Text.PlainText
    width: parent.width
    text: "\u2191\u2193 j/k move \u00b7 \u23ce open \u00b7 v details \u00b7 n new\nd dismiss \u00b7 r refresh \u00b7 tab filter \u00b7 esc close"
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
    lineHeight: 1.25
  }

  // Count pill for the hero: tonal wash of its state color; `quiet` is the
  // low-key variant for the unverified count.
  component SummaryPill: Rectangle {
    id: pill
    property int count: 0
    property string word: ""
    property color tone: Color.accent
    property bool quiet: false

    visible: count > 0
    implicitWidth: pillText.implicitWidth + Style.spacing.lg * 2
    implicitHeight: pillText.implicitHeight + Style.spacing.xs * 2
    radius: Style.cornerRadius
    color: quiet ? Style.normalFillFor(root.fg, Color.accent) : Util.alpha(tone, 0.16)

    Text {
      id: pillText
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: pill.count + " " + pill.word
      color: pill.quiet ? root.dim : pill.tone
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: !pill.quiet
    }
  }

  // Row state: a soft pill for states that need eyes, a quiet tonal pill for
  // `recent` (activity in the last minutes, process unverified: never
  // animated), quiet text for idle and ended, nothing for unknown (the hero
  // counts them as unverified and the details line names the missing
  // evidence).
  component StateChip: Rectangle {
    id: chip
    // Not `state`: that name is Item's own States property.
    property string kind: "idle"
    readonly property bool pill: root.isPillState(kind)
    readonly property bool quietPill: kind === "recent"
    readonly property bool padded: pill || quietPill
    readonly property color tone: root.chipColor(kind)

    visible: kind !== "unknown"
    implicitWidth: chipText.implicitWidth + (padded ? Style.spacing.md * 2 : 0)
    implicitHeight: chipText.implicitHeight + (padded ? Style.spacing.xxs * 2 : 0)
    radius: Style.cornerRadius
    color: pill ? Util.alpha(tone, kind === "ultrawork" ? 0.24 : 0.15)
      : (quietPill ? Style.normalFillFor(root.fg, Color.accent) : "transparent")

    Text {
      id: chipText
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: Model.stateLabel(chip.kind)
      color: chip.pill ? chip.tone : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: chip.pill
    }
  }

  // One cell of the segmented filter. The moving thumb lives in `tabs`.
  component SegmentTab: Item {
    id: tab
    property string which: "all"
    readonly property bool active: root.filter === which

    implicitHeight: tabLabel.implicitHeight + Style.spacing.xs * 2 + Style.spacing.xxs

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: tabHover.containsMouse && !tab.active ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"

      Behavior on color {
        enabled: !root.reduceMotion
        ColorAnimation { duration: 120 }
      }
    }

    Text {
      id: tabLabel
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: Model.filterLabel(tab.which) + " " + root.countFor(tab.which)
      color: tab.active ? root.fg : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: tab.active

      Behavior on color {
        enabled: !root.reduceMotion
        ColorAnimation { duration: 160 }
      }
    }

    MouseArea {
      id: tabHover
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: {
        root.filter = tab.which
        root.cursor = 0
      }
    }
  }

  // Count label plus a segment bar: one segment per ledger item when the
  // denominator is small enough to read, a plain ratio bar otherwise. The
  // fill sweeps in when a row is selected or the panel opens.
  component ProgressLine: Column {
    id: line
    property string label: ""
    property int done: 0
    property int total: 0
    property real ratio: 0
    property real shown: ratio
    readonly property bool discrete: total > 0 && total <= 24
    readonly property int lit: Math.round(Math.max(0, Math.min(1, shown)) * total)

    spacing: Style.spacing.xs

    function replay() {
      if (root.reduceMotion || !visible) return
      fillAnim.restart()
    }

    Behavior on shown {
      enabled: !root.reduceMotion && !fillAnim.running
      NumberAnimation { duration: 400; easing.type: Easing.OutCubic }
    }

    NumberAnimation {
      id: fillAnim
      target: line
      property: "shown"
      from: 0
      to: line.ratio
      duration: 560
      easing.type: Easing.OutCubic
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      text: line.label
      color: root.fg
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    Item {
      width: parent.width
      implicitHeight: Style.spacing.sm

      Row {
        visible: line.discrete
        anchors.fill: parent
        spacing: Style.spacing.xxs

        Repeater {
          model: line.discrete ? line.total : 0

          Rectangle {
            required property int index
            width: Math.max(1, (line.width - Style.spacing.xxs * (line.total - 1)) / line.total)
            height: Style.spacing.sm
            radius: Style.cornerRadius
            color: index < line.lit ? Color.accent : root.track

            Behavior on color {
              enabled: !root.reduceMotion
              ColorAnimation { duration: 140 }
            }
          }
        }
      }

      Rectangle {
        visible: !line.discrete
        anchors.fill: parent
        radius: Style.cornerRadius
        color: root.track

        Rectangle {
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: parent.width * Math.max(0, Math.min(1, line.shown))
          radius: Style.cornerRadius
          color: Color.accent
        }
      }
    }
  }

  // Tonal capsule: no rest border, a quiet fill, the kit's hover/pressed
  // states on top. `primary` tints the one action worth reaching for first.
  component ActionCapsule: Button {
    property bool primary: false
    bordered: false
    foreground: primary ? Color.accent : root.fg
    accent: Color.accent
    background: primary ? Util.alpha(Color.accent, Style.hoverFillAlpha) : Util.alpha(root.fg, Style.hoverFillAlpha)
    fontFamily: root.fontFamily
    fontSize: Style.font.caption
    verticalPadding: Style.spacing.xs
    horizontalPadding: Style.spacing.lg
  }
}
