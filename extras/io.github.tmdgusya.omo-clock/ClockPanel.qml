import QtQuick
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "io.github.tmdgusya.omo-clock"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property date today: new Date()
  readonly property var barIdentity: hostWidget || root
  readonly property var weekdayNames: [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
  ]
  readonly property color contentColor: bar ? bar.foreground : Color.foreground
  readonly property string monoFamily: bar ? bar.fontFamily : Style.font.family

  function refresh() {
    today = new Date()
  }

  function open() {
    refresh()
    controller.show()
  }

  function close() {
    controller.hide()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(224)
    contentHeight: panel.fittedContentHeight(dateColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()

      Column {
        id: dateColumn
        anchors.centerIn: parent
        spacing: 8

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          text: Qt.formatDate(root.today, "yyyy.MM.dd")
          color: root.contentColor
          font.family: root.monoFamily
          font.pixelSize: 20
          font.weight: Font.Bold
          renderType: Text.NativeRendering
        }

        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          width: 32
          height: 1
          color: root.contentColor
          opacity: 0.28
        }

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          text: root.weekdayNames[root.today.getDay()]
          color: root.contentColor
          font.family: "Noto Sans CJK KR"
          font.pixelSize: 12
          font.weight: Font.Medium
          renderType: Text.NativeRendering
        }
      }
    }
  }
}
