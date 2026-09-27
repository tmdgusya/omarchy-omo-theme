// OmO Nightsea - Lock Screen Explorer design. Opt-in only.
//
// Loads only when the user has enabled io.github.sirjul1337.lock-explorer and
// copied this file together with omo-lock-assets/ into
// ~/.config/omarchy/lock-designs/ (see lock/README.md). The import below points
// at the Explorer's shared parts (DesignBase, PasswordField, Wallpaper)
// relative to that directory; keep it as is.
//
// The moon cat watches from the calm left third of the sea, the time stands in
// a column on the right, and the password field floats on the water below. The
// cat makes no claim about any session: it breathes 1.5 % and blinks, and only
// while the display is lit (`lock.animating`). Colors come from the shell's
// Color.lock tokens, sizes from Style, positions from screen fractions.
//
// Bound so the clock's shadow effects may read `lock` from inside their
// layer components.
pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Effects
import qs.Commons
import "../plugins/io.github.sirjul1337.lock-explorer/designs"

DesignBase {
  id: lock
  inputItem: field.input
  // The whole scene shakes on a wrong password (host idiom, see Pond, Sparks,
  // Spotlight); the field's own shake stays off so there is one motion.
  shakeOnFail: true

  // Composition as fractions of the screen so every output reads the same:
  // cat 28 % tall with its centre at x 28 %, field 7 % above the lower edge.
  readonly property int catSize: Math.round(height * 0.28)
  readonly property int margin: Math.round(Math.min(width, height) * 0.09)
  readonly property int fieldBottom: Math.round(height * 0.07)
  // Wider than the shake amplitude (DesignBase moves the scene up to 14 px)
  // so the shake never uncovers the compositor's black behind the surface.
  readonly property int overscan: Style.space(16)

  // Glass: the wallpaper's own moon cat softens into a moon behind it.
  Wallpaper {
    anchors.fill: parent
    anchors.margins: -lock.overscan
    lock: lock
    blur: 0.65
    dim: 0.18
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    onClicked: { lock.wakeRequested(); lock.forcePasswordFocus() }
    onPositionChanged: lock.wakeRequested()
  }

  // Who is locked, quietly, top left.
  Text {
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.margins: lock.margin
    opacity: lock.snapshotMode ? 0 : 1
    text: lock.userName + "@" + lock.hostName
    textFormat: Text.PlainText
    color: lock.withAlpha(Color.lock.text, 0.55)
    font.family: Style.font.family
    font.pixelSize: Style.font.subtitle
    font.letterSpacing: 2
  }

  // The moon cat: the exact OmO face (ring eyes, m mouth) in the two brand
  // inks. Both still frames are decoded once at texture size; a blink only
  // cross-fades between them.
  Item {
    id: cat
    width: lock.catSize
    height: lock.catSize
    x: Math.round(lock.width * 0.28 - width / 2)
    y: Math.round((lock.height - height) / 2)

    // Supersampled 2x: crisp on HiDPI, extra anti-aliasing on 1x.
    readonly property int texturePx: width * 2
    property bool blinking: false
    property int breathStep: 0
    readonly property int breathSteps: 16 // 16 x 250 ms = 4 s breath
    readonly property real breathScale: lock.animating
      ? 1 + 0.015 * (0.5 - 0.5 * Math.cos(2 * Math.PI * breathStep / breathSteps))
      : 1

    transform: Scale {
      origin.x: cat.width / 2
      origin.y: cat.height
      xScale: 1 + (cat.breathScale - 1) * 0.5
      yScale: cat.breathScale
    }

    Image {
      anchors.fill: parent
      source: Qt.resolvedUrl("omo-lock-assets/omo-cat-idle.svg")
      sourceSize.width: cat.texturePx
      sourceSize.height: cat.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      opacity: cat.blinking ? 0 : 1
      // A blink cross-fades (lock.md recipe), 120 ms each way and only when
      // the blink timers fire -- no always-on animation.
      Behavior on opacity { NumberAnimation { duration: 120 } }
    }

    Image {
      anchors.fill: parent
      source: Qt.resolvedUrl("omo-lock-assets/omo-cat-blink.svg")
      sourceSize.width: cat.texturePx
      sourceSize.height: cat.texturePx
      fillMode: Image.PreserveAspectFit
      smooth: true
      opacity: cat.blinking ? 1 : 0
      Behavior on opacity { NumberAnimation { duration: 120 } }
    }

    // Breath by timer step, not a running NumberAnimation: four renders a
    // second instead of one per vsync, and none while the display is off.
    Timer {
      interval: 250
      repeat: true
      running: lock.animating
      onTriggered: cat.breathStep = (cat.breathStep + 1) % cat.breathSteps
    }

    // 120 ms blink every 4-7 s.
    Timer {
      id: blinkWait
      interval: 4000 + Math.floor(Math.random() * 3000)
      running: lock.animating && !cat.blinking
      onTriggered: cat.blinking = true
    }

    Timer {
      interval: 120
      running: cat.blinking
      onTriggered: {
        cat.blinking = false
        blinkWait.interval = 4000 + Math.floor(Math.random() * 3000)
      }
    }

    // Phase reset when motion stops, so a wake never resumes mid-breath.
    Connections {
      target: lock
      function onAnimatingChanged() {
        if (lock.animating) return
        cat.blinking = false
        cat.breathStep = 0
      }
    }
  }

  // Clock column, right. It sits below the screen's centre line so the
  // wallpaper's blurred moon keeps the upper right to itself.
  Column {
    anchors.right: parent.right
    anchors.rightMargin: lock.margin
    anchors.verticalCenter: parent.verticalCenter
    anchors.verticalCenterOffset: Math.round(lock.height * 0.14)
    spacing: Style.spacing.lg

    // A boot snapshot is a static image: a rendered time would be frozen
    // forever, so the clock stays off it.
    Text {
      visible: !lock.snapshotMode
      anchors.right: parent.right
      text: lock.clock("HH:mm")
      textFormat: Text.PlainText
      color: Color.lock.text
      font.family: Style.font.family
      font.pixelSize: Math.round(Style.font.baseSize * 15)
      font.weight: Font.DemiBold
      font.letterSpacing: -Math.round(Style.font.baseSize * 0.5)
      lineHeight: 0.85
      layer.enabled: true
      layer.effect: MultiEffect {
        shadowEnabled: true
        shadowColor: lock.withAlpha(Color.lock.background, 0.6)
        shadowBlur: 1.0
        shadowVerticalOffset: Style.spacing.xs
      }
    }

    Text {
      visible: !lock.snapshotMode
      anchors.right: parent.right
      text: Qt.formatDate(lock.now, "dddd, d MMMM")
      textFormat: Text.PlainText
      color: lock.withAlpha(Color.lock.text, 0.75)
      font.family: Style.font.family
      font.pixelSize: Style.font.display
      font.letterSpacing: 1
      layer.enabled: true
      layer.effect: MultiEffect {
        shadowEnabled: true
        shadowColor: lock.withAlpha(Color.lock.background, 0.6)
        shadowBlur: 1.0
        shadowVerticalOffset: Style.spacing.xxs
      }
    }
  }

  // The field floats on the water, 7 % above the lower edge. Its aqua-to-plate
  // border comes from [lock] border-active in shell.toml through the host.
  PasswordField {
    id: field
    lock: lock
    shakeOnFail: false
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: lock.fieldBottom
    width: Style.space(400)
    height: Style.space(56)
    placeholder: "Password"
  }

  Text {
    anchors.horizontalCenter: field.horizontalCenter
    anchors.top: field.bottom
    anchors.topMargin: Style.spacing.xxl
    opacity: lock.snapshotMode ? 0 : 1
    text: lock.failedAttempts > 0
      ? lock.failedAttempts + " failed " + (lock.failedAttempts === 1 ? "attempt" : "attempts")
      : (lock.fingerprintConfigured ? lock.fingerprintHint("󰈷  Touch the sensor or press Enter") : "Press Enter to unlock")
    textFormat: Text.PlainText
    color: lock.failedAttempts > 0 ? Color.lock.textError : lock.withAlpha(Color.lock.text, 0.55)
    font.family: Style.font.family
    font.pixelSize: Style.font.bodySmall
    font.letterSpacing: 1
  }
}
