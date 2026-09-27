pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "Lease.js" as Lease

Item {
  id: root

  property bool overlayEnabled: false
  property bool storm: false
  property bool reduceMotion: false
  property string currentBackground: ""
  property var fullscreenByMonitor: ({})
  property bool allMonitorsFullscreen: false
  property string manifestPath: Qt.resolvedUrl("../../art/layers/manifest.json").toString().replace(/^file:\/\//, "")
  property url layerBaseUrl: Qt.resolvedUrl("../../art/layers/")
  property var manifest: null
  property string phase: "off"
  property real afterglowStrength: 0
  property real breathStrength: 0.35
  property int strikes: 0

  readonly property bool motionAllowed: overlayEnabled && storm && !reduceMotion
    && Lease.backgroundMatches(currentBackground) && !allMonitorsFullscreen && manifest !== null

  function panelMotion(screenName) {
    return Lease.overlayMotion(overlayEnabled, storm, reduceMotion,
      fullscreenByMonitor[String(screenName || "")] === true, currentBackground) && manifest !== null
  }

  function layerOpacity(screenName, layerName) {
    if (!panelMotion(screenName)) return 0
    if (phase === "working")
      return Lease.phaseHasLayer(manifest, "working", layerName) ? breathStrength : 0
    if (phase === "afterglow")
      return Lease.phaseHasLayer(manifest, "afterglow", layerName) ? afterglowStrength : 0
    return Lease.phaseHasLayer(manifest, phase, layerName) ? 1 : 0
  }

  function strike() {
    if (!motionAllowed) return
    strikes += 1
    strikeAnimation.restart()
  }

  function stopMotion() {
    strikeAnimation.stop()
    restrike.stop()
    phase = "off"
    afterglowStrength = 0
    breathStrength = 0.35
  }

  function loadManifest(raw) {
    manifest = Lease.parseManifest(raw)
    if (manifest === null) stopMotion()
  }

  onMotionAllowedChanged: {
    if (motionAllowed) strike()
    else stopMotion()
  }

  Component.onDestruction: stopMotion()

  FileView {
    id: manifestFile
    path: root.manifestPath
    watchChanges: true
    preload: true
    printErrors: false
    onLoaded: root.loadManifest(text())
    onLoadFailed: root.loadManifest("")
    onFileChanged: reload()
  }

  SequentialAnimation {
    id: strikeAnimation
    ScriptAction { script: root.phase = "leader" }
    PauseAnimation { duration: Lease.phaseDuration(root.manifest, "leader", 90) }
    ScriptAction { script: root.phase = "strike" }
    PauseAnimation { duration: Lease.phaseDuration(root.manifest, "strike", 90) }
    ScriptAction {
      script: {
        root.phase = "afterglow"
        root.afterglowStrength = 1
      }
    }
    NumberAnimation {
      target: root
      property: "afterglowStrength"
      to: 0
      duration: Lease.phaseDuration(root.manifest, "afterglow", 600)
      easing.type: Easing.OutExpo
    }
    ScriptAction {
      script: {
        root.phase = root.motionAllowed ? "working" : "off"
        restrike.interval = 20000 + Math.floor(Math.random() * 20001)
        if (root.motionAllowed) restrike.restart()
      }
    }
  }

  SequentialAnimation on breathStrength {
    id: breath
    running: root.motionAllowed && root.phase === "working"
    loops: Animation.Infinite
    NumberAnimation { to: 0.8; duration: 1200; easing.type: Easing.InOutSine }
    NumberAnimation { to: 0.35; duration: 1200; easing.type: Easing.InOutSine }
  }

  Timer {
    id: restrike
    interval: 20000 + Math.floor(Math.random() * 20001)
    repeat: false
    running: false
    onTriggered: root.strike()
  }

  Variants {
    model: Quickshell.screens

    PanelWindow {
      id: panel
      required property var modelData
      readonly property string screenName: String(modelData.name || "")
      readonly property bool motion: root.panelMotion(screenName)

      screen: modelData
      visible: root.overlayEnabled
      anchors { top: true; bottom: true; left: true; right: true }
      color: "transparent"
      mask: Region {}
      exclusionMode: ExclusionMode.Ignore
      WlrLayershell.namespace: "omo-nightsea-live"
      WlrLayershell.layer: WlrLayer.Background
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

      Item {
        id: art
        width: root.manifest ? root.manifest.frame.width : 2560
        height: root.manifest ? root.manifest.frame.height : 1440
        scale: Math.max(panel.width / width, panel.height / height)
        transformOrigin: Item.TopLeft
        x: (panel.width - width * scale) / 2
        y: (panel.height - height * scale) / 2
        visible: panel.motion

        Repeater {
          model: root.manifest ? root.manifest.layers : []

          Image {
            required property var modelData
            x: modelData.x
            y: modelData.y
            width: modelData.width
            height: modelData.height
            source: Qt.resolvedUrl(String(root.layerBaseUrl) + modelData.file)
            fillMode: Image.Stretch
            asynchronous: true
            cache: true
            smooth: true
            mipmap: true
            opacity: root.layerOpacity(panel.screenName, modelData.name)
            visible: opacity > 0
          }
        }
      }
    }
  }
}
