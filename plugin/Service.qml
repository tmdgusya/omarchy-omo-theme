import QtQuick
import "ambient" as Ambient
import "launcher" as Launcher
import "notify" as Notify

Item {
  Notify.NotificationService { id: notifyService }
  Ambient.AmbientService {}
  // SUPER+ALT+O one-line launcher; reuses the bar entry settings the
  // notification service already reads from shell.json.
  Launcher.Launcher { settings: notifyService.settings }
}
