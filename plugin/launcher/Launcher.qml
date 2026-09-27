import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import "../Model.js" as Model

// OmO launcher (DESIGN-v3 "Launcher (SUPER+ALT+O)"): one key, one sentence.
// A centered squircle plate card with the official face and a single-line
// input. Enter starts omo in Ghostty with the typed sentence as ONE argv
// element (argv array through Quickshell.execDetached, never a shell string);
// empty Enter starts plain omo; Escape or a click outside closes.
//
// Properties:
//   settings    the plugin's bar entry (launcherPath, senpiPath, agentDir,
//               trackingInstalled, reduceMotion), same keys as Panel.qml
//   screenName  pin to one output by name; empty = focused Hyprland monitor
// IPC target "omoLauncher": open(), close(), toggle().
Scope {
  id: root

  property var settings: ({})
  property string screenName: ""

  readonly property bool reduceMotion: Model.settingBool(settings, "reduceMotion", false)
  readonly property string senpiPath: Model.settingString(settings, "senpiPath") || "senpi"
  readonly property string launcherPath: Model.settingString(settings, "launcherPath") || senpiPath
  readonly property bool trackingInstalled: Model.settingBool(settings, "trackingInstalled", false)
  readonly property string agentDir: Model.settingString(settings, "agentDir")
    || Quickshell.env("SENPI_CODING_AGENT_DIR") || Quickshell.env("OMO_CODING_AGENT_DIR")
    || Quickshell.env("HOME") + "/.omo/agent"
  readonly property string extensionPath: Qt.resolvedUrl("../omo-status.ts").toString().replace(/^file:\/\//, "")

  // Design tokens (DESIGN-v3 "Tokens").
  readonly property color plate: "#F4F4F4"
  readonly property color ink: "#041617"
  readonly property color backdrop: "#071416"
  readonly property color muted: "#5F7A7B"
  readonly property color coral: "#F08A8A"

  property bool opened: false
  // 0 = hidden, 1 = shown. Animated from its current value in both
  // directions, so a toggle mid-flight never restarts from frame 0.
  property real shown: 0
  property string notice: ""
  property string targetScreen: ""

  function focusedScreenName() {
    var monitor = Hyprland.focusedMonitor
    return monitor ? String(monitor.name || "") : ""
  }

  function open() {
    if (opened) return
    targetScreen = screenName !== "" ? screenName : focusedScreenName()
    notice = ""
    input.text = ""
    opened = true
    animate(1)
    Qt.callLater(function() { input.forceActiveFocus() })
  }

  function close() {
    if (!opened) return
    opened = false
    animate(0)
  }

  function toggle() {
    if (opened) close()
    else open()
  }

  function animate(target) {
    showAnim.stop()
    if (shown === target) return
    showAnim.to = target
    showAnim.easing.type = target > shown ? Easing.OutCubic : Easing.InCubic
    showAnim.start()
  }

  // argv for Ghostty -> [env SENPI_CODING_AGENT_DIR=...] omo [-e ext] [text].
  // Returns null for an unsafe launcherPath (same rule as the bar panel).
  function commandFor(text) {
    var argv = Model.launchCommand("", root.extensionPath, root.launcherPath, root.agentDir, root.trackingInstalled)
    if (!argv) return null
    if (text !== "") argv.push(text)
    return argv
  }

  function submit() {
    if (!opened) return false
    var text = String(input.text).trim()
    var argv = commandFor(text)
    if (!argv) {
      notice = "launcherPath는 senpi, omo, 또는 절대 경로여야 해요."
      return false
    }
    Quickshell.execDetached(argv)
    close()
    return true
  }

  NumberAnimation {
    id: showAnim
    target: root
    property: "shown"
    duration: 180
  }

  IpcHandler {
    target: "omoLauncher"
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  PanelWindow {
    id: window

    screen: {
      var list = Quickshell.screens
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === root.targetScreen) return list[i]
      }
      return list.length > 0 ? list[0] : null
    }
    visible: root.opened || root.shown > 0
    color: "transparent"
    anchors { top: true; bottom: true; left: true; right: true }
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "omo-launcher"
    WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

    // Scrim: darker Nightsea backdrop, no blur, no shadow. Click closes.
    Rectangle {
      anchors.fill: parent
      color: root.backdrop
      opacity: 0.56 * root.shown
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.close()
    }

    Rectangle {
      id: card

      readonly property int cardHeight: 64

      width: 560
      height: cardHeight
      anchors.horizontalCenter: parent.horizontalCenter
      // Slightly above center: the optical center of a screen.
      y: Math.round(parent.height * 0.38 - height / 2)
      // Squircle: 22.5% of the short side, 1px ink monoline.
      radius: Math.round(cardHeight * 0.225)
      color: root.plate
      border.color: root.ink
      border.width: 1
      opacity: root.shown
      scale: root.reduceMotion ? 1 : 0.96 + 0.04 * root.shown
      transformOrigin: Item.Center

      // Swallow clicks so the scrim does not close under the card.
      MouseArea {
        anchors.fill: parent
        onClicked: input.forceActiveFocus()
      }

      Image {
        id: face
        width: 48
        height: 48
        anchors.left: parent.left
        anchors.leftMargin: 8
        anchors.verticalCenter: parent.verticalCenter
        sourceSize.width: 96
        sourceSize.height: 96
        smooth: true
        // The art lane's shared face asset when present, else the bundled
        // official icon.
        source: Qt.resolvedUrl("../assets/face/omo-face-idle.svg")
        onStatusChanged: if (status === Image.Error) source = Qt.resolvedUrl("omo-face.svg")
      }

      TextInput {
        id: input
        anchors.left: face.right
        anchors.leftMargin: 8
        anchors.right: enterHint.left
        anchors.rightMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        color: root.ink
        selectionColor: root.ink
        selectedTextColor: root.plate
        font.family: "Noto Sans CJK KR"
        font.pixelSize: 20
        font.weight: Font.Normal
        clip: true
        focus: root.opened
        activeFocusOnPress: true

        Keys.onReturnPressed: function(event) { event.accepted = true; root.submit() }
        Keys.onEnterPressed: function(event) { event.accepted = true; root.submit() }
        Keys.onEscapePressed: function(event) { event.accepted = true; root.close() }

        Text {
          anchors.fill: parent
          verticalAlignment: Text.AlignVCenter
          visible: input.text === ""
          text: root.notice !== "" ? root.notice : "할 일을 말하세요."
          color: root.notice !== "" ? root.coral : root.muted
          font: input.font
          elide: Text.ElideRight
          textFormat: Text.PlainText
        }
      }

      // Return-key hint: a small ring-marked squircle chip, ink monoline.
      Rectangle {
        id: enterHint
        width: 32
        height: 24
        radius: Math.round(height * 0.225)
        anchors.right: parent.right
        anchors.rightMargin: 16
        anchors.verticalCenter: parent.verticalCenter
        color: "transparent"
        border.color: root.ink
        border.width: 1
        opacity: 0.55

        Text {
          anchors.centerIn: parent
          text: "\u21b5"
          color: root.ink
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 14
          textFormat: Text.PlainText
        }
      }
    }
  }
}
