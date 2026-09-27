import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "io.github.tmdgusya.omo-usage"

  readonly property color plate: "#F4F4F4"
  readonly property color coral: "#F08A8A"
  readonly property var providers: service.snapshot.providers || []
  readonly property var highestLimit: Model.highestUsage(providers)
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
    if ("usageService" in target) target.usageService = service
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

  implicitWidth: vertical ? 36 : horizontalContent.implicitWidth + 12
  implicitHeight: vertical ? 36 : barSize

  onBarChanged: injectPanel()
  onSettingsChanged: {
    service.settings = root.settings
    injectPanel()
  }

  Service {
    id: service
    settings: root.settings
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("UsagePanel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  Item {
    id: button
    anchors.fill: parent

    Rectangle {
      anchors.centerIn: parent
      width: root.vertical ? 28 : horizontalContent.implicitWidth + 8
      height: root.vertical ? 32 : 24
      radius: Math.min(width, height) * 0.225
      color: mouse.containsMouse ? Qt.rgba(0.957, 0.957, 0.957, 0.10) : "transparent"

      Behavior on color {
        ColorAnimation { duration: 140; easing.type: Easing.OutCubic }
      }
    }

    RowLayout {
      id: horizontalContent
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: 4

      Image {
        source: Qt.resolvedUrl("assets/omo-head-idle.svg")
        Layout.preferredWidth: 24
        Layout.preferredHeight: 24
        sourceSize.width: 48
        sourceSize.height: 48
        fillMode: Image.PreserveAspectFit
      }

      Text {
        text: String(root.providers.length)
        color: service.lastError ? root.coral : (root.bar ? root.bar.barForeground : root.plate)
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: 12
        font.weight: Font.Bold
        renderType: Text.NativeRendering
      }

      Text {
        text: root.highestLimit ? "· " + Model.percent(root.highestLimit.usedPercent) : "· —"
        color: service.lastError ? root.coral : (root.bar ? root.bar.barForeground : root.plate)
        opacity: 0.76
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: 11
        renderType: Text.NativeRendering
      }
    }

    Column {
      visible: root.vertical
      anchors.centerIn: parent
      spacing: 0

      Image {
        anchors.horizontalCenter: parent.horizontalCenter
        width: 24
        height: 24
        source: Qt.resolvedUrl("assets/omo-head-idle.svg")
        sourceSize.width: 48
        sourceSize.height: 48
        fillMode: Image.PreserveAspectFit
      }

      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: String(root.providers.length)
        color: service.lastError ? root.coral : (root.bar ? root.bar.barForeground : root.plate)
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: 11
        font.weight: Font.Bold
        renderType: Text.NativeRendering
      }
    }

    MouseArea {
      id: mouse
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
      cursorShape: Qt.PointingHandCursor
      onClicked: event => {
        if (event.button === Qt.LeftButton) root.togglePanel()
        else service.refresh()
      }
    }
  }
}
