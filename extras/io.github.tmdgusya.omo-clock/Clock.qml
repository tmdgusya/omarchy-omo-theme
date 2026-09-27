import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "io.github.tmdgusya.omo-clock"

  property date displayDate: clock.date
  readonly property var weekdayNames: ["일", "월", "화", "수", "목", "금", "토"]
  readonly property string timeText: Qt.formatDateTime(displayDate, "HH:mm")
  readonly property string hourText: Qt.formatDateTime(displayDate, "HH")
  readonly property string minuteText: Qt.formatDateTime(displayDate, "mm")
  readonly property string weekdayText: weekdayNames[displayDate.getDay()]
  readonly property bool opened: panelLoader.item
    ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  implicitWidth: vertical ? barSize : horizontalClock.implicitWidth + 12
  implicitHeight: vertical ? 28 : barSize

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: root.displayDate = date
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("ClockPanel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  Item {
    id: button
    anchors.fill: parent

    RowLayout {
      id: horizontalClock
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: 4

      Text {
        text: root.timeText
        color: root.bar ? root.bar.barForeground : Color.foreground
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: 12
        font.weight: Font.Medium
        renderType: Text.NativeRendering
      }

      Text {
        text: root.weekdayText
        color: root.bar ? root.bar.barForeground : Color.foreground
        opacity: 0.72
        font.family: "Noto Sans CJK KR"
        font.pixelSize: 11
        font.weight: Font.Medium
        renderType: Text.NativeRendering
      }
    }

    Column {
      visible: root.vertical
      anchors.centerIn: parent
      spacing: 0

      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: root.hourText
        color: root.bar ? root.bar.barForeground : Color.foreground
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: 11
        font.weight: Font.Medium
        renderType: Text.NativeRendering
      }

      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: root.minuteText
        color: root.bar ? root.bar.barForeground : Color.foreground
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: 11
        font.weight: Font.Medium
        renderType: Text.NativeRendering
      }
    }

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: root.togglePanel()
    }
  }
}
