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
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.62)
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
    contentWidth: panel.fittedContentWidth(372)
    contentHeight: panel.fittedContentHeight(content.implicitHeight, 620)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onActivateRequested: root.refresh()
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.refresh()
      }

      Column {
        id: content
        width: parent.width
        spacing: 12

        RowLayout {
          width: parent.width
          spacing: 8

          Image {
            source: Qt.resolvedUrl("assets/omo-face-idle.svg")
            Layout.preferredWidth: 20
            Layout.preferredHeight: 20
            sourceSize.width: 40
            sourceSize.height: 40
            fillMode: Image.PreserveAspectFit
          }

          Text {
            Layout.fillWidth: true
            text: "공급자 사용량"
            color: root.foreground
            font.family: "Noto Sans CJK KR"
            font.pixelSize: 14
            font.weight: Font.Bold
            renderType: Text.NativeRendering
          }

          Text {
            text: root.usageService && root.usageService.refreshing ? "확인 중" : "R 새로고침"
            color: root.dim
            font.family: "Noto Sans CJK KR"
            font.pixelSize: 11
            renderType: Text.NativeRendering
          }
        }

        Rectangle {
          width: parent.width
          height: 1
          color: root.foreground
          opacity: 0.24
        }

        Text {
          visible: root.providers.length === 0
          width: parent.width
          text: root.usageService && root.usageService.refreshing
            ? "연결된 공급자를 확인하고 있어요."
            : "연결된 공급자를 찾지 못했어요."
          color: root.dim
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
            readonly property var limit: Model.primaryLimit(provider)
            readonly property bool quotaAvailable: provider.quota
              && provider.quota.status === "available" && limit
            readonly property bool blocked: provider.accounts
              && Number(provider.accounts.ready) === 0
            width: content.width
            spacing: 6

            RowLayout {
              width: parent.width

              Rectangle {
                Layout.preferredWidth: 12
                Layout.preferredHeight: 12
                radius: 6
                color: "transparent"
                border.width: 1
                border.color: providerRow.blocked ? root.coral : root.foreground

                Rectangle {
                  visible: !providerRow.blocked
                  anchors.centerIn: parent
                  width: 3
                  height: 3
                  radius: 2
                  color: root.foreground
                }
              }

              Text {
                Layout.fillWidth: true
                text: providerRow.provider.name
                color: providerRow.blocked ? root.coral : root.foreground
                font.family: "Noto Sans CJK KR"
                font.pixelSize: 14
                font.weight: Font.Bold
                renderType: Text.NativeRendering
              }

              Text {
                text: Model.accountText(providerRow.provider)
                color: providerRow.blocked ? root.coral : root.dim
                font.family: "Noto Sans CJK KR"
                font.pixelSize: 11
                renderType: Text.NativeRendering
              }
            }

            RowLayout {
              width: parent.width

              Text {
                Layout.fillWidth: true
                text: providerRow.quotaAvailable
                  ? "공급자 쿼터 · " + providerRow.limit.label
                  : "공급자 쿼터"
                color: root.dim
                font.family: "Noto Sans CJK KR"
                font.pixelSize: 11
                renderType: Text.NativeRendering
              }

              Text {
                text: providerRow.quotaAvailable
                  ? Model.percent(providerRow.limit.usedPercent) + " · " + Model.countdown(providerRow.limit.resetAtMs, root.nowMs)
                  : Model.quotaUnavailableText(providerRow.provider)
                color: providerRow.blocked ? root.coral : root.dim
                font.family: "Noto Sans CJK KR"
                font.pixelSize: 11
                renderType: Text.NativeRendering
              }
            }

            Rectangle {
              visible: providerRow.quotaAvailable
              width: parent.width
              height: 4
              radius: 2
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)

              Rectangle {
                width: parent.width * Math.max(0, Math.min(100, Number(providerRow.limit.usedPercent))) / 100
                height: parent.height
                radius: parent.radius
                color: root.foreground
              }
            }

            Text {
              width: parent.width
              text: "OmO 로컬 세션 · "
                + Model.tokenCount(providerRow.provider.local.tokens) + " 토큰 · "
                + providerRow.provider.local.sessions + "개 세션"
              color: root.dim
              font.family: "Noto Sans CJK KR"
              font.pixelSize: 11
              renderType: Text.NativeRendering
            }

            Rectangle {
              width: parent.width
              height: 1
              color: root.foreground
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
