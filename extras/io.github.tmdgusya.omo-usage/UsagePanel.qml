pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.tmdgusya.omo-usage"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var usageService: null
  property double nowMs: Date.now()

  readonly property var barIdentity: hostWidget || root
  readonly property var providers: usageService ? usageService.snapshot.providers : []
  readonly property color plate: "#F4F4F4"
  readonly property color ink: "#041617"
  readonly property color aqua: "#7FE0D4"
  readonly property color muted: "#5F7A7B"
  readonly property color coral: "#F08A8A"
  readonly property string monoFamily: bar ? bar.fontFamily : Style.font.family

  function open() {
    nowMs = Date.now()
    controller.show()
  }

  function close() {
    controller.hide()
  }

  function refresh() {
    nowMs = Date.now()
    if (usageService) usageService.refresh()
  }

  Timer {
    interval: 30000
    repeat: true
    running: true
    onTriggered: root.nowMs = Date.now()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(404)
    contentHeight: panel.fittedContentHeight(content.implicitHeight + 32, 620)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onActivateRequested: root.refresh()
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.refresh()
      }

      Rectangle {
        anchors.fill: parent
        color: root.plate
      }

      Column {
        id: content
        x: 16
        y: 16
        width: parent.width - 32
        spacing: 16

        RowLayout {
          width: parent.width
          spacing: 12

          Image {
            source: Qt.resolvedUrl("assets/omo-head-idle.svg")
            Layout.preferredWidth: 24
            Layout.preferredHeight: 24
            sourceSize.width: 48
            sourceSize.height: 48
            fillMode: Image.PreserveAspectFit
          }

          Column {
            Layout.fillWidth: true
            spacing: 2

            Text {
              text: "OmO Provider Usage"
              color: root.ink
              font.family: "Noto Sans CJK KR"
              font.pixelSize: 14
              font.weight: Font.Bold
              renderType: Text.NativeRendering
            }

            Text {
              text: "Provider quotas and local session activity"
              color: root.muted
              font.family: "Noto Sans CJK KR"
              font.pixelSize: 11
              renderType: Text.NativeRendering
            }
          }

          Text {
            text: root.usageService && root.usageService.refreshing ? "Refreshing…" : "R Refresh"
            color: root.usageService && root.usageService.refreshing ? root.aqua : root.muted
            font.family: root.monoFamily
            font.pixelSize: 11
            font.weight: root.usageService && root.usageService.refreshing ? Font.Bold : Font.Normal
            renderType: Text.NativeRendering
          }
        }

        Rectangle {
          width: parent.width
          height: 1
          color: root.ink
          opacity: 0.18
        }

        Text {
          visible: root.providers.length === 0
          width: parent.width
          text: root.usageService && root.usageService.refreshing
            ? "Checking connected providers…"
            : "No connected providers found."
          color: root.muted
          font.family: "Noto Sans CJK KR"
          font.pixelSize: 12
          wrapMode: Text.WordWrap
          renderType: Text.NativeRendering
        }

        Repeater {
          model: root.providers

          delegate: Column {
            id: providerRow
            required property var modelData
            readonly property var provider: modelData
            readonly property var limits: provider.quota
              && Array.isArray(provider.quota.limits) ? provider.quota.limits : []
            readonly property bool quotaAvailable: provider.quota
              && provider.quota.status === "available" && limits.length > 0
            readonly property bool blocked: provider.accounts
              && Number(provider.accounts.ready) === 0
            width: content.width
            spacing: 10

            RowLayout {
              width: parent.width
              spacing: 8

              Image {
                Layout.preferredWidth: 24
                Layout.preferredHeight: 24
                source: Qt.resolvedUrl("assets/omo-head-idle.svg")
                sourceSize.width: 48
                sourceSize.height: 48
                fillMode: Image.PreserveAspectFit
              }

              Text {
                Layout.fillWidth: true
                text: providerRow.provider.name
                color: providerRow.blocked ? root.coral : root.ink
                font.family: "Noto Sans CJK KR"
                font.pixelSize: 14
                font.weight: Font.Bold
                renderType: Text.NativeRendering
              }

              Text {
                text: Model.accountText(providerRow.provider)
                color: providerRow.blocked ? root.coral : root.muted
                font.family: root.monoFamily
                font.pixelSize: 11
                renderType: Text.NativeRendering
              }
            }

            Text {
              width: parent.width
              text: "Provider quota"
              color: root.muted
              font.family: "Noto Sans CJK KR"
              font.pixelSize: 11
              font.weight: Font.Bold
              renderType: Text.NativeRendering
            }

            Text {
              visible: !providerRow.quotaAvailable
              width: parent.width
              text: Model.quotaUnavailableText(providerRow.provider)
              color: providerRow.blocked ? root.coral : root.muted
              font.family: "Noto Sans CJK KR"
              font.pixelSize: 12
              wrapMode: Text.WordWrap
              renderType: Text.NativeRendering
            }

            Repeater {
              model: providerRow.quotaAvailable ? providerRow.limits : []

              delegate: Column {
                id: quotaWindow
                required property var modelData
                readonly property var limit: modelData
                width: providerRow.width
                spacing: 5

                RowLayout {
                  width: parent.width

                  Text {
                    Layout.fillWidth: true
                    text: quotaWindow.limit.label
                    color: root.ink
                    font.family: "Noto Sans CJK KR"
                    font.pixelSize: 12
                    font.weight: Font.Medium
                    renderType: Text.NativeRendering
                  }

                  Text {
                    text: Model.percent(quotaWindow.limit.usedPercent)
                    color: root.ink
                    font.family: root.monoFamily
                    font.pixelSize: 12
                    font.weight: Font.Bold
                    renderType: Text.NativeRendering
                  }
                }

                Rectangle {
                  width: parent.width
                  height: 4
                  radius: 2
                  color: Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.12)

                  Rectangle {
                    width: parent.width * Math.max(0, Math.min(100, Number(quotaWindow.limit.usedPercent))) / 100
                    height: parent.height
                    radius: parent.radius
                    color: root.ink
                  }
                }

                Text {
                  width: parent.width
                  text: "Resets in " + Model.countdown(quotaWindow.limit.resetAtMs, root.nowMs)
                  color: root.muted
                  font.family: root.monoFamily
                  font.pixelSize: 11
                  horizontalAlignment: Text.AlignRight
                  renderType: Text.NativeRendering
                }
              }
            }

            Rectangle {
              width: parent.width
              height: 1
              color: root.ink
              opacity: 0.10
            }

            RowLayout {
              width: parent.width

              Text {
                Layout.fillWidth: true
                text: "Local session usage"
                color: root.muted
                font.family: "Noto Sans CJK KR"
                font.pixelSize: 11
                renderType: Text.NativeRendering
              }

              Text {
                text: Model.tokenCount(providerRow.provider.local.tokens)
                  + (Number(providerRow.provider.local.tokens) === 1 ? " token · " : " tokens · ")
                  + providerRow.provider.local.sessions
                  + (Number(providerRow.provider.local.sessions) === 1 ? " session" : " sessions")
                color: root.muted
                font.family: root.monoFamily
                font.pixelSize: 11
                renderType: Text.NativeRendering
              }
            }

            Rectangle {
              width: parent.width
              height: 1
              color: root.ink
              opacity: 0.14
            }
          }
        }

        Text {
          visible: root.usageService && root.usageService.lastError !== ""
          width: parent.width
          text: root.usageService ? root.usageService.lastError : ""
          color: root.coral
          font.family: "Noto Sans CJK KR"
          font.pixelSize: 11
          wrapMode: Text.WordWrap
          renderType: Text.NativeRendering
        }
      }
    }
  }
}
