import QtQuick
import QtQuick.Shapes
import qs.Commons
import "Model.js" as Model

// The OmO face cell (docs/DESIGN-v3.md).
//
// One squircle-plate face from `assets/face/omo-face-<face>.svg` (the official
// icon with only the eyes and mouth changed) at `size` logical px, plus an
// optional count badge (mono 12 in a monoline ring) and an optional one-line
// Korean copy beside it. Cards and the empty state use the face alone.
//
// Motion: a verified working session steps the four run frames from a Timer;
// a verified ultrawork loop adds one bolt reward (the bolt-at-ear face, an
// aqua wash and a small jolt, 560 ms) every 4-7 s; arriving at the done face
// blinks aqua once. Everything else is a still. Between events nothing
// renders (0 fps), no
// timer runs while the item is hidden, and `reduceMotion` keeps every face
// still with opacity-only crossfades.
Item {
  id: root

  // A v3 face (idle, sleep, working, ultrawork, waiting, done, error). Model
  // display states (success, ended, unknown, recent) are accepted and mapped.
  property string face: "idle"
  property bool running: false
  property bool glow: false
  property bool stale: false
  property bool reduceMotion: false
  // Badge below the face (vertical bar) instead of beside it.
  property bool vertical: false
  // Draws the hover plate: a squircle wash of plate at 10 %.
  property bool hovered: false
  property int count: 0
  property string copy: ""
  property real size: Style.space(20)
  // Space around the face box; the bar passes (barSize - face) / 2.
  property real inset: Style.space(6)
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color attention: Color.bar.active
  property color failure: Color.urgent
  property string fontFamily: Style.font.family
  property string sansFamily: Model.TOKENS.sansFamily

  readonly property real dpr: Screen.devicePixelRatio > 1 ? Screen.devicePixelRatio : 2
  readonly property int texturePx: Math.ceil(size * dpr)
  readonly property int gap: Style.spacing.md
  readonly property int badgeHeight: Style.space(16)

  readonly property string shownFace: Model.FACES.indexOf(face) >= 0 ? face : Model.faceFor(face, 1)
  readonly property string accentName: Model.accentFor(shownFace)
  readonly property color tone: accentName === "aqua" ? accent
    : (accentName === "amber" ? attention : (accentName === "coral" ? failure : foreground))
  readonly property bool showBadge: count > 0 && !stale
  readonly property bool showCopy: copy !== "" && !vertical && !stale

  // Motion gates. `running` and `glow` already mean "a session is verifiably
  // working" (Model.js reports ultrawork only for a working turn).
  readonly property bool live: visible && !stale
  readonly property bool motion: live && !reduceMotion
  // The run frames show only while they step; reduceMotion keeps the still.
  readonly property bool cycling: running && motion
  readonly property bool canReward: glow && cycling

  property int frame: 0
  property bool rewarding: false
  // Set around blink and reward swaps so they cut instead of crossfading.
  property bool instantSwap: false
  property string lastStill: ""
  property int rewardGapMs: rewardGapMinMs + Math.floor(Math.random() * rewardGapJitterMs)

  readonly property int frameCount: 4
  readonly property int frameMs: 110
  readonly property int rewardMs: 560
  readonly property int rewardGapMinMs: 4000
  readonly property int rewardGapJitterMs: 3000

  function faceSource(name) {
    return "assets/face/omo-face-" + name + ".svg"
  }

  // The still under (or instead of) the run frames: the bolt face during a
  // reward, otherwise the face itself. While the frames cycle the still is
  // the working face, hidden until a crossfade.
  readonly property string stillFace: rewarding ? "ultrawork"
    : (cycling && glow ? "working" : shownFace)
  readonly property string stillSource: faceSource(stillFace)
  readonly property string runSource: "assets/face/omo-face-run-" + (frame + 1) + ".svg"
  readonly property bool framesShown: cycling && !rewarding

  clip: true
  implicitWidth: vertical
    ? inset * 2 + size
    : inset * 2 + size + (showBadge ? gap + badge.width : 0) + (showCopy ? gap + copyText.implicitWidth : 0)
  implicitHeight: vertical
    ? inset * 2 + size + (showBadge ? gap + badgeHeight : 0)
    : inset * 2 + size

  // The cell grows or shrinks with its badge and copy in one motion.
  Behavior on implicitWidth {
    enabled: !root.reduceMotion
    NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
  }

  Behavior on implicitHeight {
    enabled: !root.reduceMotion
    NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
  }

  function swapInstantly(apply) {
    instantSwap = true
    apply()
    instantSwap = false
  }

  onCyclingChanged: if (!cycling) frame = 0
  onCanRewardChanged: {
    if (canReward) {
      rewardGapMs = rewardGapMinMs + Math.floor(Math.random() * rewardGapJitterMs)
    } else {
      swapInstantly(function() { root.rewarding = false })
      rewardFlash.stop()
      flash.opacity = 0
      jolt.xScale = 1
      jolt.yScale = 1
    }
  }
  // A face change crossfades from the previous still; reward swaps cut.
  onStillSourceChanged: {
    var previous = lastStill
    lastStill = stillSource
    if (instantSwap || previous === "" || framesShown) return
    ghost.source = Qt.resolvedUrl(previous)
    ghostFade.restart()
  }
  onShownFaceChanged: if (shownFace === "done" && motion) doneBlink.restart()
  Component.onCompleted: lastStill = stillSource
  Component.onDestruction: {
    rewardFlash.stop()
    doneBlink.stop()
    ghostFade.stop()
  }

  Timer {
    id: frameTimer
    interval: root.frameMs
    repeat: true
    running: root.cycling
    onTriggered: root.frame = (root.frame + 1) % root.frameCount
  }

  // One reward every 4-7 s while ultrawork remains verified.
  Timer {
    id: rewardWait
    interval: root.rewardGapMs
    repeat: false
    running: root.canReward && !root.rewarding
    onTriggered: {
      root.swapInstantly(function() { root.rewarding = true })
      rewardFlash.restart()
      root.rewardGapMs = root.rewardGapMinMs + Math.floor(Math.random() * root.rewardGapJitterMs)
    }
  }

  Timer {
    id: rewardHold
    interval: root.rewardMs
    repeat: false
    running: root.rewarding
    onTriggered: root.swapInstantly(function() { root.rewarding = false })
  }

  // Hover plate: the whole cell as a squircle wash of plate at 10 %.
  Shape {
    id: hoverPlate
    anchors.fill: parent
    preferredRendererType: Shape.CurveRenderer
    opacity: root.hovered ? 1 : 0
    visible: opacity > 0

    ShapePath {
      strokeWidth: -1
      fillColor: Util.alpha(Model.TOKENS.plate, 0.10)
      PathSvg { path: Model.squirclePath(hoverPlate.width, hoverPlate.height) }
    }

    Behavior on opacity {
      NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
    }
  }

  Item {
    id: faceBox
    x: root.inset
    y: root.inset
    width: root.size
    height: root.size
    opacity: root.stale ? 0.5 : 1

    Behavior on opacity {
      NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
    }

    transform: Scale {
      id: jolt
      origin.x: faceBox.width / 2
      origin.y: faceBox.height
      xScale: 1
      yScale: 1
    }

    Image {
      id: settled
      anchors.fill: parent
      source: Qt.resolvedUrl(root.stillSource)
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      mipmap: false
      cache: true
      opacity: root.framesShown ? 0 : 1

      Behavior on opacity {
        enabled: !root.instantSwap
        NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
      }
    }

    // The previous still, fading out over the new one.
    Image {
      id: ghost
      anchors.fill: parent
      source: ""
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      mipmap: false
      cache: true
      opacity: 0
      visible: opacity > 0
    }

    NumberAnimation {
      id: ghostFade
      target: ghost
      property: "opacity"
      from: 1
      to: 0
      duration: 240
      easing.type: Easing.InCubic
      onStopped: ghost.source = ""
    }

    Image {
      id: runSprite
      anchors.fill: parent
      // Keep the last frame loaded while the layer fades out.
      source: root.framesShown || opacity > 0 ? Qt.resolvedUrl(root.runSource) : ""
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      asynchronous: false
      smooth: true
      mipmap: false
      cache: true
      opacity: root.framesShown ? 1 : 0
      visible: opacity > 0

      Behavior on opacity {
        enabled: !root.instantSwap
        NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
      }
    }

    Image {
      visible: root.glow && root.live && root.framesShown
      anchors.right: parent.right
      anchors.top: parent.top
      width: root.size * 0.55
      height: root.size * 0.65
      source: Qt.resolvedUrl("assets/omo-bolt-badge.svg")
      sourceSize.width: Math.ceil(width * root.dpr)
      sourceSize.height: Math.ceil(height * root.dpr)
      fillMode: Image.PreserveAspectFit
      z: 2
    }

    // Reward and done-blink wash, clipped to the plate's squircle.
    Shape {
      id: flash
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer
      opacity: 0
      visible: opacity > 0

      ShapePath {
        strokeWidth: -1
        fillColor: root.accent
        PathSvg { path: Model.squirclePath(flash.width, flash.height) }
      }
    }
  }

  // The reward: bolt face (via `rewarding`), an aqua wash and a jolt that
  // settles back inside the 560 ms window.
  ParallelAnimation {
    id: rewardFlash

    SequentialAnimation {
      PropertyAction { target: flash; property: "opacity"; value: 0.22 }
      NumberAnimation { target: flash; property: "opacity"; to: 0; duration: root.rewardMs; easing.type: Easing.OutExpo }
    }
    SequentialAnimation {
      NumberAnimation { target: jolt; property: "yScale"; from: 1; to: 1.10; duration: 90; easing.type: Easing.OutQuad }
      NumberAnimation { target: jolt; property: "yScale"; to: 1; duration: 260; easing.type: Easing.OutBack }
    }
    SequentialAnimation {
      NumberAnimation { target: jolt; property: "xScale"; from: 1; to: 0.94; duration: 90; easing.type: Easing.OutQuad }
      NumberAnimation { target: jolt; property: "xScale"; to: 1; duration: 260; easing.type: Easing.OutBack }
    }
  }

  SequentialAnimation {
    id: doneBlink
    PropertyAction { target: flash; property: "opacity"; value: 0.18 }
    NumberAnimation { target: flash; property: "opacity"; to: 0; duration: root.rewardMs; easing.type: Easing.OutCubic }
  }

  // Count badge: a monoline ring with the number, colored by the state.
  Rectangle {
    id: badge
    visible: root.showBadge
    x: root.vertical ? Math.round((root.width - width) / 2) : root.inset + root.size + root.gap
    y: root.vertical ? root.inset + root.size + root.gap : Math.round((root.height - height) / 2)
    width: Math.max(root.badgeHeight, badgeText.implicitWidth + Style.spacing.lg)
    height: root.badgeHeight
    radius: height / 2
    color: "transparent"
    border.width: Style.spacing.hairline
    border.color: root.tone

    Behavior on border.color {
      ColorAnimation { duration: 220 }
    }

    Text {
      id: badgeText
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: Model.captionText(root.count)
      color: root.tone
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.weight: Font.Medium
      renderType: Text.NativeRendering

      Behavior on color {
        ColorAnimation { duration: 220 }
      }
    }
  }

  // One line of Korean copy from the face table (horizontal bar only).
  Text {
    id: copyText
    textFormat: Text.PlainText
    visible: root.showCopy
    x: root.inset + root.size + root.gap + (root.showBadge ? badge.width + root.gap : 0)
    anchors.verticalCenter: parent.verticalCenter
    text: root.copy
    color: root.accentName === "amber" || root.accentName === "coral" ? root.tone : root.foreground
    font.family: root.sansFamily
    font.pixelSize: Style.font.body
    renderType: Text.NativeRendering
    verticalAlignment: Text.AlignVCenter
    opacity: root.showCopy ? 1 : 0

    Behavior on opacity {
      enabled: !root.reduceMotion
      NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
    }

    Behavior on color {
      ColorAnimation { duration: 220 }
    }
  }
}
