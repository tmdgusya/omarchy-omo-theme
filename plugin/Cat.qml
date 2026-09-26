import QtQuick
import QtQuick.Effects
import qs.Commons

// The vector OmO cat. One SVG per face (two brand inks baked in), an ear mask
// tinted with the shell accent for the ultrawork glow, and a bolt mask for
// the strike. Only opacity and transforms animate, and every timer or loop
// runs solely while its effect is visible; with `reduceMotion` the cat holds
// a still face and a steady glow.
Item {
  id: root

  property string face: "idle"
  property bool stale: false
  property bool running: false
  property bool glow: false
  property bool reduceMotion: false
  property bool showDot: true
  property real size: Style.space(24)
  property color accent: Color.accent
  property color attention: Color.urgent
  property color failure: Color.urgent

  implicitWidth: size
  implicitHeight: size

  readonly property real unit: size / 24
  readonly property real dpr: Screen.devicePixelRatio > 1 ? Screen.devicePixelRatio : 2
  readonly property int texturePx: Math.ceil(size * dpr)

  readonly property bool cycling: running && !reduceMotion && !stale && visible
  readonly property bool breathing: glow && !reduceMotion && !stale && visible
  readonly property bool canBlink: !reduceMotion && !stale && visible && (face === "idle" || face === "unknown" || face === "ended")
  property bool blinking: false
  property int frame: 0
  property double lastStrikeMs: 0
  property bool boltLoaded: false

  readonly property var bobY: [0, -1, -2, -1, 0, 1]
  readonly property var squash: [1.0, 0.98, 0.95, 0.98, 1.0, 1.04]

  readonly property string dotKind: stale ? ""
    : (face === "error" ? "square" : (face === "waiting" ? "ring" : (face === "success" ? "circle" : "")))

  function faceSource(name) {
    switch (name) {
    case "working":
    case "ultrawork":
      return "assets/omo-cat-working.svg"
    case "waiting":
      return "assets/omo-cat-waiting.svg"
    case "success":
      return "assets/omo-cat-success.svg"
    case "error":
      return "assets/omo-cat-error.svg"
    default:
      return "assets/omo-cat-idle.svg"
    }
  }

  readonly property string currentSource: stale
    ? "assets/omo-cat-plate.svg"
    : (blinking ? "assets/omo-cat-blink.svg" : faceSource(face))

  function strike() {
    if (reduceMotion || stale || !visible) return
    var now = Date.now()
    if (now - lastStrikeMs < 30000) return
    lastStrikeMs = now
    boltLoaded = true
    strikeAnimation.restart()
  }

  onCyclingChanged: if (!cycling) frame = 0
  onGlowChanged: if (glow) strike()
  onCanBlinkChanged: if (!canBlink) blinking = false
  Component.onDestruction: {
    strikeAnimation.stop()
    breathAnimation.stop()
  }

  Timer {
    id: frameTimer
    interval: 140
    repeat: true
    running: root.cycling
    onTriggered: root.frame = (root.frame + 1) % 6
  }

  Timer {
    id: blinkWait
    interval: 4000 + Math.floor(Math.random() * 3000)
    repeat: false
    running: root.canBlink && !root.blinking
    onTriggered: root.blinking = true
  }

  Timer {
    id: blinkHold
    interval: 120
    repeat: false
    running: root.blinking
    onTriggered: {
      root.blinking = false
      blinkWait.interval = 4000 + Math.floor(Math.random() * 3000)
    }
  }

  Rectangle {
    id: wash
    anchors.fill: parent
    color: root.accent
    opacity: 0
    visible: opacity > 0
  }

  Item {
    id: body
    width: parent.width
    height: parent.height
    y: root.cycling ? Math.round(root.bobY[root.frame] * root.unit) : 0
    transform: Scale {
      origin.x: body.width / 2
      origin.y: body.height
      xScale: root.cycling ? 2 - root.squash[root.frame] : 1
      yScale: root.cycling ? root.squash[root.frame] : 1
    }

    Image {
      id: sprite
      anchors.fill: parent
      source: Qt.resolvedUrl(root.currentSource)
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      mipmap: false
      cache: true
      opacity: root.stale ? 0.5 : 1

      Behavior on opacity {
        NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
      }
    }

    Image {
      id: glowMask
      anchors.fill: parent
      source: root.glow ? Qt.resolvedUrl("assets/omo-cat-glow.svg") : ""
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      visible: false
    }

    MultiEffect {
      id: glowTint
      anchors.fill: glowMask
      source: glowMask
      colorization: 1.0
      colorizationColor: root.accent
      visible: root.glow && !root.stale
      opacity: 0
    }
  }

  Binding {
    target: glowTint
    property: "opacity"
    value: root.glow ? 0.45 : 0
    when: !root.breathing
  }

  SequentialAnimation {
    id: breathAnimation
    running: root.breathing
    loops: Animation.Infinite

    NumberAnimation { target: glowTint; property: "opacity"; from: 0.35; to: 0.60; duration: 1200; easing.type: Easing.InOutSine }
    NumberAnimation { target: glowTint; property: "opacity"; from: 0.60; to: 0.35; duration: 1200; easing.type: Easing.InOutSine }
  }

  Image {
    id: boltMask
    width: Math.round(root.size * 0.55)
    height: width
    anchors.top: parent.top
    anchors.right: parent.right
    anchors.topMargin: -Math.round(root.unit * 2)
    anchors.rightMargin: -Math.round(root.unit * 3)
    source: root.boltLoaded ? Qt.resolvedUrl("assets/omo-bolt.svg") : ""
    sourceSize.width: Math.ceil(width * root.dpr)
    sourceSize.height: Math.ceil(height * root.dpr)
    fillMode: Image.PreserveAspectFit
    smooth: true
    visible: false
  }

  MultiEffect {
    id: bolt
    anchors.fill: boltMask
    source: boltMask
    colorization: 1.0
    colorizationColor: root.accent
    opacity: 0
    visible: opacity > 0
  }

  SequentialAnimation {
    id: strikeAnimation

    ParallelAnimation {
      SequentialAnimation {
        PropertyAction { target: bolt; property: "opacity"; value: 1 }
        PauseAnimation { duration: 90 }
        PropertyAction { target: bolt; property: "opacity"; value: 0.4 }
        PauseAnimation { duration: 90 }
        PropertyAction { target: bolt; property: "opacity"; value: 1 }
        NumberAnimation { target: bolt; property: "opacity"; to: 0; duration: 600; easing.type: Easing.OutExpo }
      }
      SequentialAnimation {
        PropertyAction { target: wash; property: "opacity"; value: 0.08 }
        NumberAnimation { target: wash; property: "opacity"; to: 0; duration: 600; easing.type: Easing.OutExpo }
      }
    }
  }

  Rectangle {
    id: dot
    visible: root.showDot && root.dotKind !== ""
    width: Style.spacing.sm
    height: width
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.margins: Style.spacing.xxs
    radius: root.dotKind === "square" ? 0 : width / 2
    color: root.dotKind === "ring" ? "transparent" : (root.dotKind === "square" ? root.failure : root.accent)
    border.width: root.dotKind === "ring" ? 1 : 0
    border.color: root.attention
  }
}
