// OmO - Lock Screen Explorer design (DESIGN-v3). Opt-in only.
//
// Loads only when the user has enabled io.github.sirjul1337.lock-explorer and
// copied this file together with omo-lock-assets/ into
// ~/.config/omarchy/lock-designs/ (see lock/README.md). The import below points
// at the Explorer's shared parts (DesignBase, PasswordField) relative to that
// directory; keep it as is.
//
// A locked screen is the sleep state: the -m- face on its plate squircle, the
// face table's line "Step away. We have this.", the time, and the field. Nothing
// loops, so the lock idles at 0 fps; the only motion is the host's scene
// shake on a wrong password and its unlock transition. Colors come from the
// shell's Color.lock tokens, type from the DESIGN-v3 scale (11/12/14/20).
pragma ComponentBehavior: Bound
import QtQuick
import qs.Commons
import "../plugins/io.github.sirjul1337.lock-explorer/designs"

DesignBase {
  id: lock
  inputItem: field.input
  // The whole scene shakes on a wrong password (host idiom); the field's own
  // shake stays off so there is one motion.
  shakeOnFail: true

  readonly property string sans: "Noto Sans CJK KR"
  readonly property int type20: Style.fontPx(20 / 12)
  readonly property int type14: Style.font.title
  readonly property int type12: Style.font.body
  readonly property int faceSize: Style.space(128)
  readonly property var weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  // Wider than the shake amplitude (DesignBase moves the scene up to 14 px)
  // so the shake never uncovers the compositor's black behind the surface.
  readonly property int overscan: Style.space(16)

  // Flat Nightsea backdrop: blurred, the wallpaper's own cat turns into a
  // grey smudge beside the face, and the one plate on screen is the face.
  Rectangle {
    anchors.fill: parent
    anchors.margins: -lock.overscan
    color: Color.background
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    onClicked: { lock.wakeRequested(); lock.forcePasswordFocus() }
    onPositionChanged: lock.wakeRequested()
  }

  Text {
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.margins: Style.space(32)
    opacity: lock.snapshotMode ? 0 : 1
    text: lock.userName + "@" + lock.hostName
    textFormat: Text.PlainText
    color: Color.lock.placeholder
    font.family: Style.font.family
    font.pixelSize: lock.type12
  }

  Column {
    anchors.centerIn: parent
    anchors.verticalCenterOffset: -Style.space(24)

    // Face on its plate squircle, drawn by the art lane (a copy of
    // plugin/assets/face/omo-face-sleep.svg), decoded once at 2x.
    Image {
      anchors.horizontalCenter: parent.horizontalCenter
      width: lock.faceSize
      height: lock.faceSize
      source: Qt.resolvedUrl("omo-lock-assets/omo-face-sleep.svg")
      sourceSize.width: lock.faceSize * 2
      sourceSize.height: lock.faceSize * 2
      fillMode: Image.PreserveAspectFit
      smooth: true
    }

    Item { width: 1; height: Style.space(20) }

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: "Step away. We have this."
      textFormat: Text.PlainText
      color: Color.lock.text
      font.family: lock.sans
      font.pixelSize: lock.type20
      font.weight: Font.Medium
    }

    Item { width: 1; height: Style.space(8) }

    // A boot snapshot is a static image: a rendered time would be frozen
    // forever, so the clock stays off it (opacity keeps the column still).
    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      opacity: lock.snapshotMode ? 0 : 1
      text: lock.clock("HH:mm") + " " + lock.weekdays[lock.now.getDay()]
      textFormat: Text.PlainText
      color: Color.lock.placeholder
      font.family: Style.font.family
      font.pixelSize: lock.type14
    }

    Item { width: 1; height: Style.space(32) }

    // Its border comes from [lock] border-active / border-error in shell.toml
    // through the host; 1 px monoline, squircle radius (22.5 % of the height).
    PasswordField {
      id: field
      anchors.horizontalCenter: parent.horizontalCenter
      lock: lock
      shakeOnFail: false
      width: Style.space(320)
      height: Style.space(44)
      radius: Math.round(height * 0.225)
      outlineThickness: 1
      fontScale: lock.type14 / Style.font.heading
      placeholder: "Password"
    }

    Item { width: 1; height: Style.space(12) }

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      opacity: lock.snapshotMode ? 0 : 1
      text: lock.failedAttempts > 0
        ? lock.failedAttempts + (lock.failedAttempts === 1 ? " failed attempt." : " failed attempts.")
        : (lock.fingerprintConfigured ? lock.fingerprintHint("Touch the sensor or press Enter.") : "Press Enter to unlock.")
      textFormat: Text.PlainText
      color: lock.failedAttempts > 0 ? Color.lock.textError : Color.lock.placeholder
      font.family: lock.sans
      font.pixelSize: lock.type12
    }
  }
}
