import QtQuick
import QtQuick.Layouts
import Quickshell.Hyprland
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "io.github.tmdgusya.omo-workspaces"

  readonly property color plate: "#F4F4F4"
  readonly property color ink: "#041617"
  readonly property color coral: "#F08A8A"
  readonly property int markerSize: 12
  readonly property int cellSize: 20
  readonly property int focusedIndex: {
    var ids = workspaceIds()
    return Hyprland.focusedWorkspace ? ids.indexOf(Hyprland.focusedWorkspace.id) : -1
  }
  readonly property var focusedItem: focusedIndex >= 0 ? cells.itemAt(focusedIndex) : null

  function workspaceById(workspaceId) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (values[i].id === workspaceId) return values[i]
    }
    return null
  }

  function workspaceIds() {
    var ids = [1, 2, 3, 4, 5]
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      var workspaceId = values[i].id
      if (workspaceId > 0 && workspaceId <= 10 && ids.indexOf(workspaceId) === -1)
        ids.push(workspaceId)
    }
    ids.sort(function(left, right) { return left - right })
    return ids
  }

  function workspaceIsUrgent(workspace) {
    if (!workspace) return false
    if (workspace.urgent === true || workspace.hasUrgent === true) return true
    var windows = workspace.toplevels ? workspace.toplevels.values : []
    for (var i = 0; i < windows.length; i++) {
      if (windows[i].urgent === true) return true
    }
    return false
  }

  function focusWorkspace(workspaceId) {
    if (!bar) return
    bar.run("hyprctl dispatch " + Util.shellQuote(
      "hl.dsp.focus({ workspace = \"" + workspaceId + "\" })"))
  }

  implicitWidth: vertical ? barSize : grid.implicitWidth
  implicitHeight: vertical ? grid.implicitHeight : barSize

  Rectangle {
    id: activePlate
    visible: root.focusedItem !== null
    width: root.cellSize
    height: root.cellSize
    radius: width * 0.225
    color: root.plate
    x: root.focusedItem ? grid.x + root.focusedItem.x : 0
    y: root.focusedItem ? grid.y + root.focusedItem.y : 0

    Behavior on x {
      NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
    }
    Behavior on y {
      NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
    }
  }

  GridLayout {
    id: grid
    anchors.centerIn: parent
    columns: root.vertical ? 1 : root.workspaceIds().length
    columnSpacing: root.vertical ? 0 : 4
    rowSpacing: root.vertical ? 4 : 0

    Repeater {
      id: cells
      model: root.workspaceIds()

      Item {
        id: cell
        required property int modelData

        readonly property var workspace: root.workspaceById(modelData)
        readonly property bool occupied: workspace !== null
          && workspace.toplevels.values.length > 0
        readonly property bool focused: Hyprland.focusedWorkspace !== null
          && Hyprland.focusedWorkspace.id === modelData
        readonly property bool urgent: root.workspaceIsUrgent(workspace)

        implicitWidth: root.cellSize
        implicitHeight: root.cellSize

        Rectangle {
          anchors.centerIn: parent
          width: root.markerSize
          height: root.markerSize
          radius: width / 2
          color: "transparent"
          border.width: 1
          border.color: cell.urgent
            ? root.coral
            : (cell.focused ? root.ink : (root.bar ? root.bar.barForeground : root.plate))
          antialiasing: true
        }

        Rectangle {
          visible: cell.occupied && !cell.focused
          anchors.centerIn: parent
          width: 3
          height: 3
          radius: width / 2
          color: cell.urgent
            ? root.coral
            : (root.bar ? root.bar.barForeground : root.plate)
          antialiasing: true
        }

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.focusWorkspace(cell.modelData)
        }
      }
    }
  }
}
