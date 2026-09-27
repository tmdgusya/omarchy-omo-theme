import QtQuick
import QtQuick.Effects
import qs.Commons

// The vector OmO cat for the bar cell.
//
// A full-body still (the stand pose: run frame 1's head, upright, on two stub
// legs with the tail curled behind; one SVG per face, the two brand inks
// baked in) crossfades to an eight-frame run cycle (stub legs, forward lean,
// squash and stretch, dust puffs baked into the frames) while a session is
// verifiably working, so the character never changes size or place between
// states. Ear glow masks are tinted with the shell accent for ultrawork, and
// a bolt plus spark mask pair carries the periodic strike. Only opacity and
// transforms animate, every timer or loop runs solely while its state holds
// and the item is visible, and `reduceMotion` keeps still frames: run stance
// frame 1, a steady glow, no strike, no blink, no tail swish, no tilt, no
// breathing.
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
  // Near-white bolt core derived from the accent, so every theme keeps a
  // matching strike color. The halo, the wash and the ears use `accent`.
  property color boltCore: Qt.lighter(accent, 1.3)

  implicitWidth: size
  implicitHeight: size

  readonly property real unit: size / 24
  readonly property real dpr: Screen.devicePixelRatio > 1 ? Screen.devicePixelRatio : 2
  readonly property int texturePx: Math.ceil(size * dpr)

  // Motion gates. `running` and `glow` already mean "a session is verifiably
  // working" (Model.js reports ultrawork only for a working turn), so the cat
  // never runs or strikes on unknown, idle, ended or stale data.
  readonly property bool live: visible && !stale
  readonly property bool motion: live && !reduceMotion
  readonly property bool runPose: running && live
  readonly property bool cycling: running && motion
  readonly property bool charged: glow && running && live
  readonly property bool breathingEars: charged && !reduceMotion
  readonly property bool canStrike: charged && !reduceMotion
  readonly property bool canBlink: motion && !running && face === "idle"
  readonly property bool canBreathe: motion && !running && face === "idle"
  readonly property bool canSwish: motion && !running && face === "idle"
  readonly property bool canTilt: motion && !running && face === "waiting"
  readonly property bool dimmed: !stale && face === "unknown"

  property bool blinking: false
  property int frame: 0
  // Ear pulse phase, advanced by the run frame timer (no extra renders).
  property int pulse: 0
  // Idle breath phase, advanced by a slow timer instead of a per-vsync
  // animation: an always-on NumberAnimation re-renders the bar every frame
  // and costs ~4 % CPU for a 24 px cat; 16 steps every 250 ms is invisible
  // at this size and costs a few renders per second.
  property int breathStep: 0
  // Tail swish phase: 0 is the tail at rest, 1..swishSteps walks the swish
  // frames up and back (1 2 3 2 1). Stepped by a timer that only runs while
  // the swish plays.
  property int swishStep: 0

  readonly property int frameCount: 8
  // 105 ms working, 90 ms during ultrawork: the brief's 90-110 ms cadence.
  readonly property int frameMs: charged ? 90 : 105
  readonly property int pulseSteps: 27 // 27 x 90 ms = 2.4 s ear pulse
  readonly property int breathSteps: 16 // 16 x 250 ms = 4 s breath
  readonly property int firstStrikeMs: 700
  readonly property int strikeGapMinMs: 4000
  readonly property int strikeGapJitterMs: 3000
  // Idle tail swish: three lift frames played 1 2 3 2 1 at 140 ms (700 ms),
  // then 6-9 s of rest.
  readonly property int swishFrames: 3
  readonly property int swishSteps: 2 * swishFrames - 1
  readonly property int swishFrameMs: 140
  readonly property int swishGapMinMs: 6000
  readonly property int swishGapJitterMs: 3000
  readonly property int swishFrame: swishStep <= swishFrames ? swishStep : 2 * swishFrames - swishStep
  readonly property string swishSource: "assets/omo-cat-stand-swish-" + Math.max(1, swishFrame) + ".svg"

  readonly property real earOpacity: !glow || !live ? 0
    : (breathingEars ? 0.35 + 0.25 * (0.5 - 0.5 * Math.cos(2 * Math.PI * pulse / pulseSteps)) : 0.45)
  readonly property real breathScale: canBreathe
    ? 1 + 0.03 * (0.5 - 0.5 * Math.cos(2 * Math.PI * breathStep / breathSteps))
    : 1

  readonly property string dotKind: stale ? ""
    : (face === "error" ? "square" : (face === "waiting" ? "ring" : (face === "success" ? "circle" : "")))

  // Every still is the full-body stand pose (omo-cat-stand-*.svg); the
  // head-only omo-cat-<face>.svg icons stay as the generator's face sources.
  function faceSource(name) {
    switch (name) {
    case "working":
    case "ultrawork":
      // A working face that is not cycling keeps the run stance.
      return "assets/omo-cat-run-1.svg"
    case "waiting":
      return "assets/omo-cat-stand-waiting.svg"
    case "success":
      return "assets/omo-cat-stand-success.svg"
    case "error":
      return "assets/omo-cat-stand-error.svg"
    case "ended":
      // Eyes closed: nothing is live any more.
      return "assets/omo-cat-stand-blink.svg"
    default:
      return "assets/omo-cat-stand-idle.svg"
    }
  }

  // The swish frame wins over a blink that lands inside it: the tail is the
  // larger motion and the blink cycle keeps its own timing.
  readonly property string stillSource: stale
    ? "assets/omo-cat-stand-plate.svg"
    : (swishStep > 0 ? swishSource
      : (blinking ? "assets/omo-cat-stand-blink.svg" : faceSource(face)))
  readonly property string runSource: "assets/omo-cat-run-" + (frame + 1) + ".svg"
  readonly property string glowSource: runPose
    ? "assets/omo-cat-run-glow-" + (frame + 1) + ".svg"
    : "assets/omo-cat-stand-glow.svg"

  function strike() {
    if (!canStrike) return
    strikeAnimation.restart()
  }

  onCyclingChanged: if (!cycling) {
    frame = 0
    pulse = 0
  }
  onCanBlinkChanged: if (!canBlink) blinking = false
  onCanStrikeChanged: if (!canStrike) {
    strikeAnimation.stop()
    boltFx.opacity = 0
    spark.opacity = 0
    wash.opacity = 0
    jolt.yScale = 1
  }
  onCanTiltChanged: if (!canTilt) tilt.angle = 0
  onCanBreatheChanged: if (!canBreathe) breathStep = 0
  onCanSwishChanged: if (!canSwish) swishStep = 0
  Component.onDestruction: {
    strikeAnimation.stop()
    tiltAnimation.stop()
  }

  Timer {
    id: frameTimer
    interval: root.frameMs
    repeat: true
    running: root.cycling
    onTriggered: {
      root.frame = (root.frame + 1) % root.frameCount
      root.pulse = (root.pulse + 1) % root.pulseSteps
    }
  }

  Timer {
    id: breatheTimer
    interval: 250
    repeat: true
    running: root.canBreathe
    onTriggered: root.breathStep = (root.breathStep + 1) % root.breathSteps
  }

  // One strike shortly after ultrawork starts, then every 4-7 s. A strike is
  // two flashes inside 250 ms, so any one-second window sees at most two
  // flashes (WCAG 2.3.1 allows three) on a 24 px cell.
  Timer {
    id: strikeTimer
    interval: root.firstStrikeMs
    repeat: true
    running: root.canStrike
    onTriggered: {
      root.strike()
      interval = root.strikeGapMinMs + Math.floor(Math.random() * root.strikeGapJitterMs)
    }
    onRunningChanged: if (!running) interval = root.firstStrikeMs
  }

  // Idle tail swish: one-shot wait of 6-9 s, then a 140 ms tick walks the
  // lift frames up and back. Both stop the moment `canSwish` drops.
  Timer {
    id: swishWait
    interval: root.swishGapMinMs + Math.floor(Math.random() * root.swishGapJitterMs)
    repeat: false
    running: root.canSwish && root.swishStep === 0
    onTriggered: root.swishStep = 1
  }

  Timer {
    id: swishTick
    interval: root.swishFrameMs
    repeat: true
    running: root.swishStep > 0
    onTriggered: {
      if (root.swishStep >= root.swishSteps) {
        root.swishStep = 0
        swishWait.interval = root.swishGapMinMs + Math.floor(Math.random() * root.swishGapJitterMs)
      } else {
        root.swishStep += 1
      }
    }
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
    transform: [
      Scale {
        id: jolt
        origin.x: body.width / 2
        origin.y: body.height
        xScale: 2 - yScale
        yScale: 1
      },
      Scale {
        id: breath
        origin.x: body.width / 2
        origin.y: body.height
        xScale: 1 + (root.breathScale - 1) * 0.5
        yScale: root.breathScale
      },
      Rotation {
        id: tilt
        origin.x: body.width / 2
        origin.y: body.height
        angle: 0
      }
    ]

    Image {
      id: still
      anchors.fill: parent
      source: Qt.resolvedUrl(root.stillSource)
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      mipmap: false
      cache: true
      opacity: root.runPose ? 0 : (root.stale ? 0.5 : (root.dimmed ? 0.7 : 1))

      Behavior on opacity {
        NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
      }
    }

    Image {
      id: runSprite
      anchors.fill: parent
      // Keep the last frame loaded while the layer fades out.
      source: root.runPose || opacity > 0 ? Qt.resolvedUrl(root.runSource) : ""
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      asynchronous: false
      smooth: true
      mipmap: false
      cache: true
      opacity: root.runPose ? 1 : 0
      visible: opacity > 0

      Behavior on opacity {
        NumberAnimation { duration: 240; easing.type: Easing.OutCubic }
      }
    }

    Image {
      id: glowMask
      anchors.fill: parent
      source: root.glow && root.live ? Qt.resolvedUrl(root.glowSource) : ""
      sourceSize.width: root.texturePx
      sourceSize.height: root.texturePx
      fillMode: Image.PreserveAspectFit
      asynchronous: false
      smooth: true
      visible: false
    }

    MultiEffect {
      id: glowTint
      anchors.fill: glowMask
      source: glowMask
      colorization: 1.0
      colorizationColor: root.accent
      visible: root.glow && root.live
      opacity: root.earOpacity
    }
  }

  // Waiting for a human: a slow head tilt to one side, then the other.
  SequentialAnimation {
    id: tiltAnimation
    running: root.canTilt
    loops: Animation.Infinite

    PauseAnimation { duration: 2600 }
    NumberAnimation { target: tilt; property: "angle"; to: -7; duration: 360; easing.type: Easing.InOutSine }
    PauseAnimation { duration: 900 }
    NumberAnimation { target: tilt; property: "angle"; to: 0; duration: 360; easing.type: Easing.InOutSine }
    PauseAnimation { duration: 2600 }
    NumberAnimation { target: tilt; property: "angle"; to: 7; duration: 360; easing.type: Easing.InOutSine }
    PauseAnimation { duration: 900 }
    NumberAnimation { target: tilt; property: "angle"; to: 0; duration: 360; easing.type: Easing.InOutSine }
  }

  Image {
    id: boltMask
    width: Math.round(root.size * 0.55)
    height: width
    anchors.top: parent.top
    anchors.right: parent.right
    anchors.topMargin: -Math.round(root.unit * 2)
    anchors.rightMargin: -Math.round(root.unit * 3)
    source: root.canStrike ? Qt.resolvedUrl("assets/omo-bolt.svg") : ""
    sourceSize.width: Math.ceil(width * root.dpr)
    sourceSize.height: Math.ceil(height * root.dpr)
    fillMode: Image.PreserveAspectFit
    asynchronous: false
    smooth: true
    visible: false
  }

  Item {
    id: boltFx
    anchors.fill: boltMask
    opacity: 0
    visible: opacity > 0

    MultiEffect {
      id: boltHalo
      anchors.fill: parent
      source: boltMask
      colorization: 1.0
      colorizationColor: root.accent
      blurEnabled: true
      blurMax: 16
      blur: 0.7
      opacity: 0.9
    }

    MultiEffect {
      id: boltCoreFx
      anchors.fill: parent
      source: boltMask
      colorization: 1.0
      colorizationColor: root.boltCore
    }
  }

  Image {
    id: sparkMask
    width: Math.round(root.size * 0.5)
    height: width
    source: root.canStrike ? Qt.resolvedUrl("assets/omo-spark.svg") : ""
    sourceSize.width: Math.ceil(width * root.dpr)
    sourceSize.height: Math.ceil(height * root.dpr)
    fillMode: Image.PreserveAspectFit
    asynchronous: false
    smooth: true
    visible: false
  }

  // Sparks burst from the bolt's tip, which lands on the right ear.
  MultiEffect {
    id: spark
    width: sparkMask.width
    height: sparkMask.height
    x: boltMask.x + boltMask.width * 0.29 - width / 2
    y: boltMask.y + boltMask.height * 0.99 - height / 2
    source: sparkMask
    colorization: 1.0
    colorizationColor: root.boltCore
    opacity: 0
    visible: opacity > 0
  }

  SequentialAnimation {
    id: strikeAnimation

    ParallelAnimation {
      // Two flashes, then the fade: 2 flashes per strike, strikes >= 4 s apart.
      SequentialAnimation {
        PropertyAction { target: boltFx; property: "opacity"; value: 1 }
        PauseAnimation { duration: 90 }
        PropertyAction { target: boltFx; property: "opacity"; value: 0.25 }
        PauseAnimation { duration: 70 }
        PropertyAction { target: boltFx; property: "opacity"; value: 1 }
        NumberAnimation { target: boltFx; property: "opacity"; to: 0; duration: 520; easing.type: Easing.OutExpo }
      }
      SequentialAnimation {
        PropertyAction { target: wash; property: "opacity"; value: 0.10 }
        NumberAnimation { target: wash; property: "opacity"; to: 0; duration: 600; easing.type: Easing.OutExpo }
      }
      ParallelAnimation {
        NumberAnimation { target: spark; property: "scale"; from: 0.45; to: 1.35; duration: 420; easing.type: Easing.OutCubic }
        NumberAnimation { target: spark; property: "rotation"; from: -10; to: 40; duration: 420; easing.type: Easing.OutCubic }
        NumberAnimation { target: spark; property: "opacity"; from: 1; to: 0; duration: 420; easing.type: Easing.InQuad }
      }
      // The jolt: a squash-and-stretch pulse through the whole body.
      SequentialAnimation {
        NumberAnimation { target: jolt; property: "yScale"; from: 1; to: 1.12; duration: 80; easing.type: Easing.OutQuad }
        NumberAnimation { target: jolt; property: "yScale"; to: 0.96; duration: 110; easing.type: Easing.InOutQuad }
        NumberAnimation { target: jolt; property: "yScale"; to: 1; duration: 160; easing.type: Easing.OutBack }
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
