pragma ComponentBehavior: Bound
import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Panel content: header, filter tabs, one row per session, the selected
// row's ledger progress and actions, and the key legend. Progress is shown
// as counts only (todo completed/total, verified passed/total); state chips
// carry only what the collector could prove.
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
  readonly property string fontFamily: panel ? panel.fontFamily : Style.font.family
  readonly property bool reduceMotion: panel ? panel.reduceMotion : false
  readonly property double nowMs: panel ? panel.nowMs : 0
  readonly property var dismissed: panel ? panel.dismissed : ({})
  readonly property var summary: panel ? panel.summary : Model.aggregate([], 0, null)
  readonly property var sessions: collector ? collector.sessions : []
  readonly property bool stale: collector ? collector.stale : false
  readonly property bool partial: collector ? collector.partial : false
  readonly property bool scanning: collector ? collector.scanning : false
  // Filter membership never depends on the clock (only the success/idle chip
  // does), so rows are rebuilt on data, filter, or dismissal changes alone.
  readonly property var rows: Model.filterSessions(sessions, filter, 0, dismissed)
  readonly property int selectedIndex: Model.clampIndex(cursor, rows.length)
  readonly property var selected: rows.length > 0 ? rows[selectedIndex] : null
  readonly property color track: Style.selectedFillFor(fg, Color.accent)

  readonly property string statusLine: {
    if (stale) return "session data unavailable \u00b7 " + (collector ? collector.staleReason : "")
    if (scanning && sessions.length === 0) return "Scanning\u2026"
    if (sessions.length === 0) return "no senpi sessions"
    var parts = []
    if (summary.running > 0) parts.push(summary.running + " working")
    if (summary.waiting > 0) parts.push(summary.waiting + " waiting")
    if (summary.counts.error > 0) parts.push(summary.counts.error + " error")
    if (parts.length === 0) parts.push(sessions.length + (sessions.length === 1 ? " session" : " sessions") + " \u00b7 none active")
    if (summary.counts.unknown > 0) parts.push(summary.counts.unknown + " unverified")
    return parts.join(" \u00b7 ")
  }

  spacing: Style.spacing.xxl

  function reset() {
    cursor = 0
    cursorActive = false
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

  function chipColor(state) {
    if (state === "error") return Color.urgent
    if (state === "waiting") return attention
    if (state === "working" || state === "ultrawork" || state === "success") return Color.accent
    return dim
  }

  function selectedCwd() {
    if (selected && selected.cwd !== "") return selected.cwd
    return panel ? panel.latestCwd() : ""
  }

  function viewSelected() {
    if (selected && collector) collector.requestView(selected.sessionPath)
  }

  function activate() {
    if (!selected) return
    if (panel && panel.focusSession(selected)) return
    viewSelected()
  }

  function dismissSelected() {
    if (selected && panel && stateOf(selected) === "error") panel.dismiss(selected.id)
  }

  function countFor(which) {
    return Model.filterSessions(sessions, which, 0, dismissed).length
  }

  // ---------- header
  Item {
    width: parent.width
    implicitHeight: Math.max(headerCat.height, headerText.implicitHeight)

    Cat {
      id: headerCat
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      size: Style.font.display
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

    Column {
      id: headerText
      anchors.left: headerCat.right
      anchors.leftMargin: Style.space(14)
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: "Sessions"
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.statusLine
        color: root.stale ? Color.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }
  }

  // ---------- filter tabs
  Row {
    id: tabs
    width: parent.width
    spacing: Style.spacing.md
    visible: root.sessions.length > 0

    readonly property real cellWidth: (width - spacing * (Model.FILTERS.length - 1)) / Model.FILTERS.length

    Repeater {
      model: Model.FILTERS

      Button {
        required property string modelData
        required property int index
        width: tabs.cellWidth
        text: Model.filterLabel(modelData) + " " + root.countFor(modelData)
        selected: root.filter === modelData
        bordered: true
        foreground: root.fg
        accent: Color.accent
        fontFamily: root.fontFamily
        fontSize: Style.font.caption
        verticalPadding: Style.spacing.xs
        horizontalPadding: Style.spacing.sm
        onClicked: {
          root.filter = modelData
          root.cursor = 0
        }
      }
    }
  }

  // ---------- notices
  Text {
    textFormat: Text.PlainText
    visible: root.partial && !root.stale && root.collector && root.collector.notice !== ""
    width: parent.width
    text: "partial list \u00b7 " + (root.collector ? root.collector.notice : "")
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
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
        readonly property var ledger: Model.progress(modelData)
        readonly property bool showsView: root.collector && root.collector.viewPath !== "" && root.collector.viewPath === modelData.sessionPath
          && (root.collector.viewing || root.collector.viewOutput !== "" || root.collector.viewError !== "")

        width: rowList.width
        spacing: 0

        // Two lines per row: the title owns the full width; project, state,
        // and time sit underneath. The selected title wraps to three lines.
        Rectangle {
          id: rowSurface
          width: parent.width
          height: rowContent.implicitHeight + Style.spacing.md * 2
          radius: Style.cornerRadius
          color: row.isSelected
            ? Style.selectedFillFor(root.fg, Color.accent)
            : (rowHover.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : "transparent")

          Behavior on color {
            enabled: !root.reduceMotion
            ColorAnimation { duration: 120 }
          }

          Behavior on height {
            enabled: !root.reduceMotion
            NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
          }

          Cat {
            id: rowFace
            anchors.left: parent.left
            anchors.leftMargin: Style.spacing.lg
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
            opacity: row.rowState === "ended" || row.rowState === "unknown" ? 0.6 : 1
          }

          Column {
            id: rowContent
            anchors.left: rowFace.right
            anchors.leftMargin: Style.spacing.lg
            anchors.right: parent.right
            anchors.rightMargin: Style.spacing.lg
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.xxs

            Text {
              id: titleText
              textFormat: Text.PlainText
              width: parent.width
              text: row.modelData.title
              color: root.fg
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

              Text {
                id: projectText
                textFormat: Text.PlainText
                visible: row.modelData.cwdLabel !== ""
                width: Math.min(implicitWidth, Math.floor(meta.width * 0.55))
                text: row.modelData.cwdLabel
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }

              Text {
                textFormat: Text.PlainText
                text: Model.stateLabel(row.rowState)
                color: root.chipColor(row.rowState)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: row.rowState === "error" || row.rowState === "waiting"
              }

              Text {
                textFormat: Text.PlainText
                visible: text !== ""
                text: Model.relativeTime(row.modelData.activityMs, root.nowMs)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                textFormat: Text.PlainText
                visible: row.modelData.partial === true
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
            NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
          }

          Column {
            id: details
            width: parent.width
            leftPadding: Style.spacing.lg
            rightPadding: Style.spacing.lg
            topPadding: Style.spacing.md
            bottomPadding: Style.spacing.md
            spacing: Style.spacing.md

            readonly property real innerWidth: width - leftPadding - rightPadding

            ProgressLine {
              visible: !!row.ledger.todo
              width: details.innerWidth
              label: row.ledger.todo ? row.ledger.todo.label : ""
              done: row.ledger.todo ? row.ledger.todo.completed : 0
              total: row.ledger.todo ? row.ledger.todo.total : 0
              ratio: row.ledger.todo ? row.ledger.todo.ratio : 0
            }

            ProgressLine {
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

            Row {
              spacing: Style.spacing.md

              ActionCapsule {
                visible: row.modelData.focusAddress !== ""
                text: "Focus"
                onClicked: if (root.panel) root.panel.focusSession(row.modelData)
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

  // Count label plus a segment bar: one segment per ledger item when the
  // denominator is small enough to read, a plain ratio bar otherwise.
  component ProgressLine: Column {
    id: line
    property string label: ""
    property int done: 0
    property int total: 0
    property real ratio: 0
    readonly property bool discrete: total > 0 && total <= 24

    spacing: Style.spacing.xs

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
            color: index < line.done ? Color.accent : root.track
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
          width: parent.width * Math.max(0, Math.min(1, line.ratio))
          radius: Style.cornerRadius
          color: Color.accent
        }
      }
    }
  }

  component ActionCapsule: Button {
    bordered: true
    foreground: root.fg
    accent: Color.accent
    fontFamily: root.fontFamily
    fontSize: Style.font.caption
    verticalPadding: Style.spacing.xs
    horizontalPadding: Style.spacing.lg
  }
}
