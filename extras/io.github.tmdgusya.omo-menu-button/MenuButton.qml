import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "io.github.tmdgusya.omo-menu-button"

  implicitWidth: barSize
  implicitHeight: barSize

  Rectangle {
    anchors.centerIn: parent
    width: 24
    height: 24
    radius: width * 0.225
    color: mouse.containsMouse ? Qt.rgba(0.957, 0.957, 0.957, 0.10) : "transparent"

    Behavior on color {
      ColorAnimation { duration: 140; easing.type: Easing.OutCubic }
    }
  }

  Image {
    anchors.centerIn: parent
    width: 24
    height: 24
    source: Qt.resolvedUrl("assets/omo-head-idle.svg")
    fillMode: Image.PreserveAspectFit
    smooth: true
    sourceSize.width: 48
    sourceSize.height: 48
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor
    onClicked: event => {
      if (root.bar)
        root.bar.run(event.button === Qt.RightButton
          ? "omarchy menu summon omo"
          : "omarchy-shell omoLauncher toggle")
    }
  }
}
