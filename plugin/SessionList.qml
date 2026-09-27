pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Shapes
import qs.Commons
import "Model.js" as Model

// Panel content (docs/DESIGN-v3.md): a header (official cat, copy, New session),
// the sections Working / Needs you / Done with one squircle card per session
// (face 24, title, project + age, ledger bars, Open / Details / Close on the
// selected card), a collapsed History fold, and the key legend. Progress is
// ledger counts only. Every looping motion lives in the bar cell; here only
// selection, hover and the card fold move, and `reduceMotion` reduces those
// to opacity swaps.
Column {
  id: root

  property var panel: null
  property var collector: null
  property int cursor: 0
  property bool historyOpen: false
  // Why Open could not act, per session id; shown on that card until the
  // panel reopens or a later Open succeeds. Reassigned whole so bindings
  // re-evaluate.
  property var openNotices: ({})

  readonly property color fg: Color.popups.text
  readonly property color muted: Model.TOKENS.muted
  readonly property color plate: Model.TOKENS.plate
  readonly property color ink: Model.TOKENS.ink
  readonly property color attention: panel ? panel.urgent : Color.bar.active
  readonly property string fontFamily: panel ? panel.fontFamily : Style.font.family
  readonly property string sansFamily: Model.TOKENS.sansFamily
  readonly property bool reduceMotion: panel ? panel.reduceMotion : false
  readonly property double nowMs: panel ? panel.nowMs : 0
  readonly property int cardPadding: Style.space(16)
  readonly property int cardRadius: Style.space(14)
  readonly property int detailLabelWidth: Style.space(76)
  readonly property var dismissed: panel ? panel.dismissed : ({})
  readonly property var summary: panel ? panel.summary : Model.aggregate([], 0, null)
  readonly property var sessions: collector ? collector.sessions : []
  readonly property bool stale: collector ? collector.stale : false
  readonly property bool partial: collector ? collector.partial : false
  readonly property bool empty: !stale && sessions.length === 0
  readonly property string face: stale ? "sleep" : (panel ? panel.face : "sleep")

  // Sizes from the contract: 11 / 12 / 14 / 20.
  readonly property int fontCaption: Style.font.bodySmall
  readonly property int fontBody: Style.font.body
  readonly property int fontTitle: Style.font.title
  readonly property int fontFace: Style.fontPx(20 / 12)

  // Sections never depend on the clock: a complete ledger is Done whenever it
  // was completed; the fresh done blink is the bar's.
  readonly property var grouped: Model.flattenSections(Model.groupSections(sessions, 0, dismissed))
  readonly property var mainRows: grouped.main
  readonly property var historyRows: grouped.history
  readonly property int historyCount: historyRows.length
  readonly property int visibleCount: mainRows.length + (historyOpen ? historyRows.length : 0)
  readonly property int selectedIndex: Model.clampIndex(cursor, visibleCount)
  readonly property var selectedRow: rowAt(selectedIndex)
  readonly property var selected: selectedRow ? selectedRow.session : null

  // Sliding selection plate: the selected card reports its geometry here and
  // the single highlight moves between cards.
  property real highlightY: 0
  property real highlightHeight: 0
  // Fold bookkeeping for the panel (list coordinates, settled).
  property real selectedTop: 0
  property real selectedBottom: 0

  spacing: Style.spacing.xxl

  function toneFor(accentName, fallback) {
    if (accentName === "aqua") return Color.accent
    if (accentName === "amber") return attention
    if (accentName === "coral") return Color.urgent
    return fallback
  }

  function rowAt(index) {
    if (index < mainRows.length) return mainRows[index]
    var i = index - mainRows.length
    return historyOpen && i >= 0 && i < historyRows.length ? historyRows[i] : null
  }

  function metaLine(session) {
    var parts = []
    if (session.cwdLabel !== "") parts.push(session.cwdLabel)
    var age = Model.ageLabel(session.activityMs, nowMs)
    if (age !== "") parts.push(age)
    return parts.join(" \u00b7 ")
  }

  function valueOrNone(value) {
    if (value === undefined || value === null) return "Not recorded"
    var stringValue = String(value)
    return stringValue === "" ? "Not recorded" : stringValue
  }

  function statusLabel(status) {
    switch (String(status || "")) {
    case "active": return "Working"
    case "complete":
    case "completed": return "Done"
    case "blocked": return "Blocked"
    case "failed": return "Failed"
    case "in_progress": return "Working"
    case "working": return "Working"
    case "waiting": return "Needs you"
    case "idle": return "Idle"
    case "ended": return "Ended"
    case "recent": return "Recent"
    case "unknown": return "Unverified"
    default: return valueOrNone(status)
    }
  }

  function activityDetail(session) {
    if (!session || session.activityAt === "") return "Not recorded"
    var age = Model.ageLabel(session.activityMs, nowMs)
    return age === "" ? session.activityAt : age + " \u00b7 " + session.activityAt
  }

  function runtimeDetail(session, state) {
    if (!session || !session.runtime) return Model.stateLabelKo(state)
    var parts = [Model.stateLabelKo(state)]
    if (session.runtime.kind === "live") parts.push("Live process")
    else if (session.runtime.kind === "idle") parts.push("Idle process")
    else if (session.runtime.kind === "ended") parts.push("Ended")
    else if (session.runtime.kind === "unknown") parts.push("Runtime unverified")
    return parts.join(" \u00b7 ")
  }

  function todosDetail(session) {
    if (!session || !session.todos) return "Not recorded"
    return "Done " + session.todos.completed
      + " \u00b7 In progress " + session.todos.inProgress
      + " \u00b7 Pending " + session.todos.pending
      + " \u00b7 Dropped " + session.todos.abandoned
      + " \u00b7 Total " + session.todos.total
  }

  function goalDetail(session) {
    return session && session.goal ? statusLabel(session.goal.status) : "Not recorded"
  }

  function ulwDetail(session) {
    if (!session || !session.ulw) return "Not recorded"
    var parts = []
    if (session.ulw.total > 0) parts.push("Verified " + session.ulw.passed + "/" + session.ulw.total)
    if (session.ulw.status !== "") parts.push(statusLabel(session.ulw.status))
    return parts.length > 0 ? parts.join(" \u00b7 ") : "Not recorded"
  }

  function reset() {
    cursor = 0
    historyOpen = false
    openNotices = ({})
  }

  function moveCursor(dy) {
    if (visibleCount === 0) return
    cursor = Model.clampIndex(selectedIndex + dy, visibleCount)
  }

  // Tab: the first card of the next section; landing on History opens it.
  function jumpSection(direction) {
    var starts = []
    for (var i = 0; i < mainRows.length; i++) if (mainRows[i].first) starts.push(i)
    if (historyCount > 0) starts.push(mainRows.length)
    if (starts.length === 0) return
    var current = 0
    for (var j = 0; j < starts.length; j++) if (starts[j] <= selectedIndex) current = j
    var next = (current + (direction < 0 ? -1 : 1) + starts.length) % starts.length
    if (starts[next] >= mainRows.length) historyOpen = true
    cursor = starts[next]
  }

  function toggleHistory() {
    if (historyCount === 0) return
    historyOpen = !historyOpen
    if (!historyOpen && cursor >= mainRows.length) cursor = Math.max(0, mainRows.length - 1)
  }

  function selectedCwd() {
    if (selected && selected.cwd !== "") return selected.cwd
    return panel ? panel.latestCwd() : ""
  }

  // Enter, double-click and Open land here.
  function activate() {
    if (selected) openSession(selected)
  }

  function openSession(session) {
    if (!session) return
    if (panel) panel.openSession(session)
    else if (collector) collector.requestView(session.sessionPath)
  }

  function viewSession(session) {
    if (session && collector) collector.requestView(session.sessionPath)
  }

  function viewSelected() {
    viewSession(selected)
  }

  function dismissSelected() {
    if (selectedRow && panel && selectedRow.state === "error") panel.dismiss(selectedRow.session.id)
  }

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

  // How many cards sit below a viewport bottom (list coordinates).
  // `layoutTick` only exists so a binding re-runs when the list relayouts.
  function rowsBelow(viewportBottom, layoutTick) {
    var n = 0
    for (var i = 0; i < stack.children.length; i++) {
      var child = stack.children[i]
      if (!child || child.isCard !== true || !(child.height > 0)) continue
      var p = child.mapToItem(root, 0, 0)
      if (p.y + child.height > viewportBottom + 1) n += 1
    }
    return n
  }

  // ---------- header: official cat, copy, meta, New session
  Item {
    id: header
    visible: !root.empty
    width: parent.width
    implicitHeight: Math.max(headerText.implicitHeight, newButton.implicitHeight, headerCat.implicitHeight) + root.cardPadding * 2

    Shape {
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer

      ShapePath {
        strokeWidth: -1
        fillColor: root.plate
        PathSvg { path: Model.squirclePath(header.width, header.height, root.cardRadius) }
      }
    }

    Cat {
      id: headerCat
      anchors.left: parent.left
      anchors.leftMargin: root.cardPadding
      anchors.verticalCenter: parent.verticalCenter
      size: Style.space(32)
      inset: 0
      face: root.face
      glow: root.face === "ultrawork"
      stale: root.stale
      reduceMotion: true
      foreground: root.ink
      accent: Color.accent
      attention: root.attention
      failure: Color.urgent
      fontFamily: root.fontFamily
    }

    Column {
      id: headerText
      anchors.left: headerCat.right
      anchors.leftMargin: Style.spacing.lg
      anchors.right: newButton.left
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.spacing.xxs

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.stale ? "Couldn't load sessions." : Model.copyFor(root.face)
        color: root.ink
        font.family: root.sansFamily
        font.pixelSize: root.fontTitle
        font.weight: Font.Medium
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.stale
          ? (root.collector ? root.collector.staleReason : "")
          : Model.summaryLine(root.summary).replace(/^OmO \u00b7 /, "")
        color: Util.alpha(root.ink, 0.66)
        font.family: root.fontFamily
        font.pixelSize: root.fontCaption
        elide: Text.ElideRight
      }
    }

    PlateButton {
      id: newButton
      anchors.right: parent.right
      anchors.rightMargin: root.cardPadding
      anchors.verticalCenter: parent.verticalCenter
      onPlate: true
      text: "New session"
      onClicked: if (root.panel) root.panel.launch(root.selectedCwd())
    }
  }

  // ---------- notice: the collector hit a ceiling and returned a bounded list
  Text {
    visible: root.partial && !root.stale && root.collector && root.collector.notice !== ""
    textFormat: Text.PlainText
    width: parent.width
    text: "Showing partial results \u00b7 " + (root.collector ? root.collector.notice : "")
    color: root.muted
    font.family: root.sansFamily
    font.pixelSize: root.fontCaption
    elide: Text.ElideRight
  }

  // ---------- empty state: sleep face, one sentence, one button
  Column {
    visible: root.empty
    width: parent.width
    spacing: Style.spacing.xl
    topPadding: Style.space(20)
    bottomPadding: Style.space(8)

    Cat {
      anchors.horizontalCenter: parent.horizontalCenter
      size: Style.space(40)
      inset: 0
      face: "sleep"
      reduceMotion: true
      fontFamily: root.fontFamily
    }

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      textFormat: Text.PlainText
      text: Model.copyFor("idle")
      color: root.fg
      font.family: root.sansFamily
      font.pixelSize: root.fontTitle
      font.weight: Font.Medium
    }

    PlateButton {
      anchors.horizontalCenter: parent.horizontalCenter
      primary: true
      text: "New session"
      onClicked: if (root.panel) root.panel.launch(root.panel.latestCwd())
    }
  }

  // ---------- sections and cards
  Item {
    id: rowArea
    visible: root.mainRows.length > 0 || root.historyCount > 0
    width: parent.width
    implicitHeight: stack.implicitHeight

    // One selection plate for the whole list; it slides to the selected card
    // and follows that card's height as its actions fold open.
    Shape {
      id: highlight
      x: 0
      y: root.highlightY
      width: parent.width
      height: root.highlightHeight
      preferredRendererType: Shape.CurveRenderer
      visible: root.visibleCount > 0 && height > 0

      ShapePath {
        strokeWidth: -1
        fillColor: Style.selectedFillFor(root.fg, Color.accent)
        PathSvg { path: Model.squirclePath(highlight.width, highlight.height, root.cardRadius) }
      }

      Behavior on y {
        enabled: !root.reduceMotion
        NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
      }
    }

    Column {
      id: stack
      width: parent.width
      spacing: Style.spacing.xxs

      Repeater {
        model: root.mainRows
        SessionCard {}
      }

      // History: ended and unverified sessions, folded until asked for.
      Item {
        id: fold
        readonly property bool isCard: false
        visible: root.historyCount > 0
        width: parent.width
        implicitHeight: foldRow.height + (root.mainRows.length > 0 ? Style.spacing.xl : 0)

        Item {
          id: foldRow
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: Style.space(28)

          Shape {
            id: foldPlate
            anchors.fill: parent
            preferredRendererType: Shape.CurveRenderer
            opacity: foldArea.containsMouse ? 1 : 0
            visible: opacity > 0

            ShapePath {
              strokeWidth: -1
              fillColor: Style.hoverFillFor(root.fg, Color.accent)
              PathSvg { path: Model.squirclePath(foldPlate.width, foldPlate.height) }
            }

            Behavior on opacity {
              enabled: !root.reduceMotion
              NumberAnimation { duration: 140 }
            }
          }

          Row {
            anchors.left: parent.left
            anchors.leftMargin: Style.spacing.lg
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.md

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: Model.SECTIONS[3].title
              color: root.muted
              font.family: root.sansFamily
              font.pixelSize: root.fontCaption
              font.weight: Font.Medium
            }

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: root.historyCount
              color: root.muted
              font.family: root.fontFamily
              font.pixelSize: root.fontCaption
            }
          }

          Text {
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.rightMargin: Style.spacing.lg
            anchors.verticalCenter: parent.verticalCenter
            text: "\u203a"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: root.fontBody
            rotation: root.historyOpen ? 90 : 0

            Behavior on rotation {
              enabled: !root.reduceMotion
              NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
            }
          }

          MouseArea {
            id: foldArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.toggleHistory()
          }
        }
      }

      Repeater {
        model: root.historyOpen ? root.historyRows : []
        SessionCard { indexOffset: root.mainRows.length }
      }
    }
  }

  // ---------- key legend
  Text {
    visible: !root.empty
    textFormat: Text.PlainText
    width: parent.width
    text: "\u2191\u2193 Move \u00b7 \u23ce Open \u00b7 v Details \u00b7 n New session \u00b7 d Close \u00b7 tab Section \u00b7 \u2190\u2192 History \u00b7 esc Close panel"
    color: root.muted
    font.family: root.sansFamily
    font.pixelSize: root.fontCaption
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
    lineHeight: 1.25
  }

  // Squircle button. `primary` is the plate itself (light plate, ink text);
  // the secondary form is a monoline ring.
  component PlateButton: Item {
    id: btn
    property string text: ""
    property bool primary: false
    property bool onPlate: false
    signal clicked()
    readonly property bool hot: btnArea.containsMouse

    implicitWidth: btnLabel.implicitWidth + Style.spacing.xl * 2
    implicitHeight: Style.space(24)

    Shape {
      id: btnPlate
      anchors.fill: parent
      anchors.margins: btn.primary ? 0 : 0.5
      preferredRendererType: Shape.CurveRenderer

      ShapePath {
        strokeWidth: btn.primary ? -1 : Style.spacing.hairline
        strokeColor: Util.alpha(btn.onPlate ? root.ink : root.fg, btn.hot ? 0.7 : 0.4)
        fillColor: btn.primary
          ? (btnArea.pressed ? Util.alpha(root.plate, 0.8) : (btn.hot ? root.plate : Util.alpha(root.plate, 0.92)))
          : (btnArea.pressed
            ? Util.alpha(btn.onPlate ? root.ink : root.fg, 0.14)
            : (btn.hot
              ? Util.alpha(btn.onPlate ? root.ink : root.fg, 0.08)
              : Util.alpha(btn.onPlate ? root.ink : root.fg, 0)))
        PathSvg { path: Model.squirclePath(btnPlate.width, btnPlate.height) }

        Behavior on fillColor {
          enabled: !root.reduceMotion
          ColorAnimation { duration: 140 }
        }
      }
    }

    Text {
      id: btnLabel
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: btn.text
      color: btn.primary || btn.onPlate ? root.ink : root.fg
      font.family: root.sansFamily
      font.pixelSize: root.fontBody
      font.weight: Font.Medium
    }

    MouseArea {
      id: btnArea
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: btn.clicked()
    }
  }

  // Ledger line: label, count, and one segment per item (a ratio bar when
  // the denominator is too large to read).
  component ProgressLine: Item {
    id: line
    property string label: ""
    property int done: 0
    property int total: 0
    property real ratio: 0
    property color tone: root.fg
    readonly property bool discrete: total > 0 && total <= 24
    readonly property int lit: Math.round(Math.max(0, Math.min(1, ratio)) * total)

    implicitHeight: Math.max(lineLabel.implicitHeight, Style.space(12))

    Text {
      id: lineLabel
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(28)
      text: line.label
      color: root.muted
      font.family: root.sansFamily
      font.pixelSize: root.fontCaption
    }

    Text {
      id: lineCount
      textFormat: Text.PlainText
      anchors.left: lineLabel.right
      anchors.leftMargin: Style.spacing.sm
      anchors.verticalCenter: parent.verticalCenter
      width: Math.max(implicitWidth, Style.space(32))
      text: line.done + "/" + line.total
      color: root.fg
      font.family: root.fontFamily
      font.pixelSize: root.fontCaption
    }

    Item {
      id: track
      anchors.left: lineCount.right
      anchors.leftMargin: Style.spacing.lg
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      height: Style.spacing.sm

      Row {
        visible: line.discrete
        anchors.fill: parent
        spacing: Style.spacing.xxs

        Repeater {
          model: line.discrete ? line.total : 0

          Rectangle {
            required property int index
            width: Math.max(1, (track.width - Style.spacing.xxs * (line.total - 1)) / line.total)
            height: track.height
            radius: Style.spacing.hairline
            color: index < line.lit ? line.tone : Util.alpha(root.fg, 0.16)

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
        radius: Style.spacing.hairline
        color: Util.alpha(root.fg, 0.16)

        Rectangle {
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: parent.width * Math.max(0, Math.min(1, line.ratio))
          radius: parent.radius
          color: line.tone

          Behavior on width {
            enabled: !root.reduceMotion
            NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
          }
        }
      }
    }
  }

  // One Korean key/value row. The value owns the remaining width and can
  // break an unspaced UUID or path at any character without widening the card.
  component DetailRow: Item {
    id: detailRow
    property string label: ""
    property string value: ""
    property bool monoValue: false

    width: parent ? parent.width : 0
    height: implicitHeight
    implicitHeight: Math.max(detailLabel.implicitHeight, detailValue.implicitHeight)

    Text {
      id: detailLabel
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.top: parent.top
      width: root.detailLabelWidth
      text: detailRow.label
      color: root.muted
      font.family: root.sansFamily
      font.pixelSize: root.fontCaption
      font.weight: Font.Medium
    }

    Text {
      id: detailValue
      textFormat: Text.PlainText
      anchors.left: detailLabel.right
      anchors.leftMargin: Style.spacing.lg
      anchors.right: parent.right
      anchors.top: parent.top
      text: detailRow.value
      color: root.fg
      font.family: detailRow.monoValue ? root.fontFamily : root.sansFamily
      font.pixelSize: root.fontCaption
      wrapMode: Text.Wrap
      lineHeight: 1.25
    }
  }

  // One session: its section header when it opens a section, then the card.
  component SessionCard: Column {
    id: card
    required property var modelData
    required property int index
    property int indexOffset: 0
    readonly property bool isCard: true
    readonly property int flatIndex: index + indexOffset
    readonly property var session: modelData.session
    readonly property string rowState: modelData.state
    readonly property string face: modelData.face
    readonly property bool inHistory: modelData.section === "history"
    readonly property bool isSelected: flatIndex === root.selectedIndex
    readonly property var ledger: Model.progress(session)
    // Open only exists when it can act: focus a proven window or resume an
    // ended session. Otherwise the card says why.
    readonly property var plan: root.panel
      ? Model.openCommand(session, root.panel.openOptions)
      : ({ kind: "blocked", argv: null, reason: "" })
    readonly property bool canOpen: plan.kind === "focus" || plan.kind === "resume"
    readonly property string notice: root.openNotices[session.id] !== undefined
      ? Model.reasonKo(root.openNotices[session.id])
      : (plan.kind === "blocked" ? Model.reasonKo(plan.reason) : "")
    readonly property bool hasActions: canOpen || session.sessionPath !== "" || rowState === "error"
    readonly property bool showsView: root.collector && root.collector.viewPath !== "" && root.collector.viewPath === session.sessionPath
      && (root.collector.viewing || root.collector.viewOutput !== "" || root.collector.viewError !== "")
    readonly property color tone: root.toneFor(Model.accentFor(face), root.muted)
    property bool technicalOpen: false
    // Height once the fold has settled (only the selected card is open).
    readonly property real settledHeight: surface.height - expansion.height + (isSelected ? details.implicitHeight : 0)

    width: parent.width
    spacing: 0

    function syncHighlight() {
      if (!isSelected) return
      var p = surface.mapToItem(rowArea, 0, 0)
      root.highlightY = p.y
      root.highlightHeight = surface.height
      root.selectedTop = rowArea.y + p.y
      root.selectedBottom = root.selectedTop + settledHeight
    }

    onIsSelectedChanged: {
      syncHighlight()
      if (!isSelected) technicalOpen = false
    }
    onYChanged: syncHighlight()
    onHeightChanged: syncHighlight()
    Component.onCompleted: syncHighlight()

    // Section header: title, count, hairline.
    Item {
      visible: card.modelData.first && !card.inHistory
      width: parent.width
      implicitHeight: sectionRow.implicitHeight + Style.spacing.sm + (card.flatIndex === 0 ? 0 : Style.spacing.xl)

      Row {
        id: sectionRow
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.bottomMargin: Style.spacing.sm
        spacing: Style.spacing.md

        Text {
          id: sectionTitle
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          text: card.modelData.title
          color: root.muted
          font.family: root.sansFamily
          font.pixelSize: root.fontCaption
          font.weight: Font.Medium
        }

        Text {
          id: sectionCount
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          text: card.modelData.count
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: root.fontCaption
        }

        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(0, sectionRow.width - sectionTitle.width - sectionCount.width - sectionRow.spacing * 2)
          height: Style.spacing.hairline
          color: Util.alpha(root.fg, 0.12)
        }
      }
    }

    Item {
      id: surface
      width: parent.width
      height: body.implicitHeight + root.cardPadding * 2

      // Rest and hover wash; the selection plate slides in from the list.
      Shape {
        id: wash
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        opacity: card.isSelected ? 0 : 1
        visible: opacity > 0

        ShapePath {
          strokeWidth: -1
          fillColor: cardArea.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : Style.normalFillFor(root.fg, Color.accent)
          PathSvg { path: Model.squirclePath(wash.width, wash.height, root.cardRadius) }

          Behavior on fillColor {
            enabled: !root.reduceMotion
            ColorAnimation { duration: 140 }
          }
        }

        Behavior on opacity {
          enabled: !root.reduceMotion
          NumberAnimation { duration: 160 }
        }
      }

      MouseArea {
        id: cardArea
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.cursor = card.flatIndex
        onDoubleClicked: {
          root.cursor = card.flatIndex
          root.activate()
        }
      }

      Column {
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: root.cardPadding
        spacing: Style.spacing.sm
        opacity: card.inHistory ? 0.7 : 1

        Row {
          id: head
          width: parent.width
          spacing: Style.spacing.lg

          Cat {
            id: faceIcon
            y: card.isSelected ? 0 : Math.max(0, Math.round((textBlock.implicitHeight - height) / 2))
            size: Style.space(24)
            inset: 0
            face: card.face
            glow: card.face === "ultrawork"
            reduceMotion: true
            fontFamily: root.fontFamily
          }

          Column {
            id: textBlock
            width: head.width - faceIcon.width - head.spacing
            spacing: Style.spacing.xxs

            // The selected title wraps to three lines; others stay on one.
            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: card.session.title
              color: root.fg
              font.family: root.sansFamily
              font.pixelSize: root.fontBody
              font.weight: Font.Medium
              elide: Text.ElideRight
              wrapMode: card.isSelected ? Text.Wrap : Text.NoWrap
              maximumLineCount: card.isSelected ? 3 : 1
            }

            Row {
              width: parent.width
              spacing: Style.spacing.md

              Text {
                id: faceTag
                textFormat: Text.PlainText
                text: Model.textFace(card.face)
                color: card.tone
                font.family: root.fontFamily
                font.pixelSize: root.fontCaption
                font.weight: Font.Medium
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width - faceTag.width - parent.spacing
                text: root.metaLine(card.session)
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: root.fontCaption
                elide: Text.ElideRight
              }
            }
          }
        }

        // Ledger values only; nothing shows without a denominator.
        Column {
          id: ledgerBlock
          visible: !!card.ledger.todo || !!card.ledger.ulw
          width: parent.width
          leftPadding: faceIcon.width + head.spacing
          spacing: Style.spacing.xs

          ProgressLine {
            visible: !!card.ledger.todo
            width: ledgerBlock.width - ledgerBlock.leftPadding
            label: "Todos"
            done: card.ledger.todo ? card.ledger.todo.completed : 0
            total: card.ledger.todo ? card.ledger.todo.total : 0
            ratio: card.ledger.todo ? card.ledger.todo.ratio : 0
            tone: root.plate
          }

          ProgressLine {
            visible: !!card.ledger.ulw
            width: ledgerBlock.width - ledgerBlock.leftPadding
            label: "Verified"
            done: card.ledger.ulw ? card.ledger.ulw.passed : 0
            total: card.ledger.ulw ? card.ledger.ulw.total : 0
            ratio: card.ledger.ulw ? card.ledger.ulw.ratio : 0
            tone: Color.accent
          }
        }

        // Selected card only: why Open cannot act, the actions, the details.
        Item {
          id: expansion
          width: parent.width
          height: card.isSelected ? details.implicitHeight : 0
          clip: true

          Behavior on height {
            enabled: !root.reduceMotion
            NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
          }

          Column {
            id: details
            width: parent.width
            topPadding: Style.spacing.xs
            spacing: Style.spacing.lg
            opacity: card.isSelected ? 1 : 0

            Behavior on opacity {
              enabled: !root.reduceMotion
              NumberAnimation { duration: 160 }
            }

            Text {
              visible: text !== ""
              textFormat: Text.PlainText
              width: parent.width
              text: card.notice
              color: Util.alpha(root.fg, 0.8)
              font.family: root.sansFamily
              font.pixelSize: root.fontCaption
              wrapMode: Text.Wrap
            }

            Row {
              visible: card.hasActions
              x: faceIcon.width + head.spacing
              spacing: Style.spacing.md

              PlateButton {
                visible: card.canOpen
                primary: true
                text: "Open"
                onClicked: root.openSession(card.session)
              }

              PlateButton {
                visible: card.session.sessionPath !== ""
                text: card.technicalOpen ? "Hide details" : "Details"
                onClicked: {
                  card.technicalOpen = !card.technicalOpen
                  if (card.technicalOpen) root.viewSession(card.session)
                }
              }

              PlateButton {
                visible: card.rowState === "error"
                text: "Close"
                onClicked: if (root.panel) root.panel.dismiss(card.session.id)
              }
            }

            Column {
              id: detailRows
              width: parent.width
              spacing: Style.spacing.sm

              DetailRow {
                label: "Session"
                value: root.valueOrNone(card.session.id)
                monoValue: true
              }

              DetailRow {
                label: "Title"
                value: root.valueOrNone(card.session.title)
              }

              DetailRow {
                label: "Directory"
                value: root.valueOrNone(card.session.cwd)
                monoValue: true
              }

              DetailRow {
                label: "Last activity"
                value: root.activityDetail(card.session)
                monoValue: true
              }

              DetailRow {
                label: "Runtime"
                value: root.runtimeDetail(card.session, card.rowState)
              }

              DetailRow {
                label: "Todos"
                value: root.todosDetail(card.session)
              }

              DetailRow {
                label: "Goal"
                value: root.goalDetail(card.session)
              }

              DetailRow {
                label: "Ultrawork"
                value: root.ulwDetail(card.session)
              }
            }

            // The collector's bounded technical summary stays available, but
            // no longer replaces the readable session-object detail above.
            Column {
              id: technicalDetails
              visible: card.technicalOpen && card.session.sessionPath !== ""
              width: parent.width
              spacing: Style.spacing.sm

              Rectangle {
                width: parent.width
                height: Style.spacing.hairline
                color: Util.alpha(root.fg, 0.12)
              }

              Text {
                textFormat: Text.PlainText
                text: "Technical details"
                color: root.muted
                font.family: root.sansFamily
                font.pixelSize: root.fontCaption
                font.weight: Font.Medium
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.collector && root.collector.viewing
                  ? "Loading\u2026"
                  : (card.showsView && root.collector.viewOutput !== ""
                    ? root.collector.viewOutput
                    : (card.showsView && root.collector.viewError !== "" ? "No technical details available." : "Loading technical details\u2026"))
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: root.fontCaption
                wrapMode: Text.WrapAnywhere
                lineHeight: 1.25
              }
            }
          }
        }
      }
    }
  }
}
