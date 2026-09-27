"""Isolated CLI contract tests for the bundled plugin installer."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ID = "io.github.tmdgusya.omo"
CLI = """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
config = Path.home() / ".config/omarchy/shell.json"
plugins = Path.home() / ".config/omarchy/plugins"
plugin_id = "io.github.tmdgusya.omo"
log = Path.home() / "calls.log"
with log.open("a") as stream:
    stream.write(json.dumps([Path(sys.argv[0]).name, *args]) + "\\n")

if Path(sys.argv[0]).name == "omarchy-shell":
    if args == ["shell", "ping"]:
        print("ok")
    elif args == ["shell", "rescanPlugins"]:
        pass
    else:
        sys.exit("unsupported shell command")
    sys.exit(0)

if args[:2] == ["plugin", "validate"]:
    folder = Path(args[2])
    manifest = json.loads((folder / "manifest.json").read_text())
    assert manifest["id"] == plugin_id
    assert manifest["schemaVersion"] == 1
    assert (folder / manifest["entryPoints"]["barWidget"]).is_file()
    if "service" in manifest["kinds"]:
        assert manifest["keepLoaded"] is True
        assert (folder / manifest["entryPoints"]["service"]).is_file()
    assert not any(path.is_symlink() for path in folder.rglob("*"))
    sys.exit(0)

if args == ["restart", "shell"]:
    sys.exit(0)

data = json.loads(config.read_text())
layout = data["bar"]["layout"]
if args[:2] == ["plugin", "enable"]:
    assert args == ["plugin", "enable", plugin_id, "--section", "left"]
    assert not any(entry["id"] == plugin_id for section in layout.values() for entry in section)
    layout["left"].append({"id": plugin_id})
elif args[:2] == ["plugin", "disable"]:
    assert args == ["plugin", "disable", plugin_id]
    for section in layout:
        layout[section] = [entry for entry in layout[section] if entry["id"] != plugin_id]
elif args[:2] == ["plugin", "remove"]:
    assert args == ["plugin", "remove", plugin_id, "--yes"]
    assert not any(entry["id"] == plugin_id for section in layout.values() for entry in section)
    assert (plugins / plugin_id).is_dir()
    (plugins / plugin_id).rename(plugins / ("." + plugin_id + ".bak"))
elif args[:2] == ["bar", "position"]:
    assert args[2] in ("top", "left", "right", "bottom")
    data["bar"]["position"] = args[2]
elif args[:2] == ["bar", "set"]:
    assert args[2] == plugin_id and args[3] in ("senpiPath", "launcherPath", "trackingInstalled")
    assert len(args) == 5
    entry = next(entry for section in layout.values() for entry in section if entry["id"] == plugin_id)
    entry[args[3]] = args[4]
else:
    sys.exit("unsupported command: " + repr(args))
config.write_text(json.dumps(data))
"""


class InstallPluginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.repo = self.root / "theme"
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / "plugin").mkdir()
        (self.repo / "plugin" / "ambient").mkdir()
        (self.repo / "plugin" / "notify").mkdir()
        (self.repo / "art/layers").mkdir(parents=True)
        for name in ("install-plugin.sh", "uninstall-plugin.sh"):
            shutil.copy2(ROOT / "scripts" / name, self.repo / "scripts" / name)
        (self.repo / "plugin" / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "id": PLUGIN_ID, "name": "OmO", "version": "1",
            "kinds": ["bar-widget", "service"], "keepLoaded": True,
            "entryPoints": {"barWidget": "Panel.qml", "service": "Service.qml"},
        }))
        (self.repo / "plugin" / "Panel.qml").write_text("widget v1\n")
        (self.repo / "plugin" / "Service.qml").write_text("service root\n")
        (self.repo / "plugin/ambient/AmbientService.qml").write_text("ambient service\n")
        (self.repo / "plugin/notify/NotificationService.qml").write_text("notification service\n")
        (self.repo / "plugin" / "omo-status.ts").write_text("export default function () {}\n")
        (self.repo / "art/layers/manifest.json").write_text('{"frame":{"width":2560,"height":1440}}\n')
        (self.repo / "art/layers/strike.png").write_bytes(b"owned layer")
        self.config = self.home / ".config/omarchy/shell.json"
        self.config.parent.mkdir(parents=True)
        self.initial = {
            "version": 1, "bar": {"position": "left", "transparent": True,
            "layout": {"left": [{"id": "roach.workspaces"}],
                       "center": [{"id": "omarchy.clock", "format": "HH:mm"}],
                       "right": [{"id": "robzolkos.agent-usage"}]}},
            "plugins": [], "disabledPlugins": ["sid.sessions", "omapets"],
            "unrelated": {"keep": 42},
        }
        self.save(self.initial)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("omarchy", "omarchy-shell"):
            path = self.bin / name
            path.write_text(CLI)
            path.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home),
                    "PATH": f"{self.bin}:/usr/bin:/bin",
                    "PYTHONDONTWRITEBYTECODE": "1"}
        self.target = self.home / ".config/omarchy/plugins" / PLUGIN_ID
        self.layers_target = self.home / ".config/omarchy/plugins/art/layers"

    def save(self, data):
        self.config.write_text(json.dumps(data))

    def current(self):
        return json.loads(self.config.read_text())

    def run_script(self, name, *args):
        return subprocess.run(
            ["bash", str(self.repo / "scripts" / name), *args],
            env=self.env, capture_output=True, text=True, timeout=10, check=False,
        )

    def calls(self):
        return [json.loads(line) for line in (self.home / "calls.log").read_text().splitlines()]

    def test_roundtrip_preserves_unrelated_layout_and_settings(self):
        # Given an existing personalized shell layout.
        before = self.current()
        # When installing and then removing the owned widget.
        installed = self.run_script("install-plugin.sh")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertIn("Saved layout backup:", installed.stdout)
        self.assertEqual(self.current()["bar"]["layout"]["left"][-1], {"id": PLUGIN_ID})
        removed = self.run_script("uninstall-plugin.sh")
        # Then all unrelated choices remain byte-for-byte equivalent as JSON.
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(self.current(), before)
        self.assertFalse(self.target.exists())
        self.assertFalse(self.layers_target.exists())
        self.assertTrue(list(self.config.parent.glob("shell.json.bak.omo.*")))

    def test_install_copies_native_services_and_owned_ambient_layers(self):
        # Given a bundle with both native services and the overlay layer set.
        # When installing the plugin.
        result = self.run_script("install-plugin.sh")
        # Then the host entry point and its external relative assets are installed as owned files.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.target / "Service.qml").read_text(), "service root\n")
        self.assertEqual((self.target / "ambient/AmbientService.qml").read_text(), "ambient service\n")
        self.assertEqual((self.target / "notify/NotificationService.qml").read_text(),
                         "notification service\n")
        self.assertEqual((self.layers_target / "strike.png").read_bytes(), b"owned layer")
        layer_marker = json.loads((self.layers_target / ".omo-install.json").read_text())
        self.assertEqual(layer_marker, {"schema": 1, "id": PLUGIN_ID, "kind": "ambient-layers"})
        checksums = (self.layers_target / ".omo-install.sha256").read_text()
        self.assertIn("./manifest.json", checksums)
        self.assertIn("./strike.png", checksums)
        self.assertEqual((self.target / "ambient/../../art/layers").resolve(), self.layers_target)

    def test_foreign_ambient_layers_are_never_claimed(self):
        # Given an unowned directory at the overlay's required runtime path.
        self.layers_target.mkdir(parents=True)
        foreign = self.layers_target / "private.png"
        foreign.write_bytes(b"private")
        # When installation is requested.
        result = self.run_script("install-plugin.sh")
        # Then neither the foreign asset nor plugin layout is changed.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(foreign.read_bytes(), b"private")
        self.assertFalse(self.target.exists())
        self.assertEqual(self.current(), self.initial)

    def test_modified_ambient_layers_block_update_and_removal(self):
        # Given installed layers changed after installation.
        self.assertEqual(self.run_script("install-plugin.sh").returncode, 0)
        edited = self.layers_target / "strike.png"
        edited.write_bytes(b"personal layer")
        before = self.current()
        # When either lifecycle command is requested.
        update = self.run_script("install-plugin.sh")
        remove = self.run_script("uninstall-plugin.sh")
        # Then the edit and all installed state survive for manual recovery.
        self.assertNotEqual(update.returncode, 0)
        self.assertNotEqual(remove.returncode, 0)
        self.assertEqual(edited.read_bytes(), b"personal layer")
        self.assertTrue(self.target.exists())
        self.assertEqual(self.current(), before)

    def test_repeat_install_updates_owned_files_without_reenabling(self):
        # Given an installed widget with a later user layout change.
        self.assertEqual(self.run_script("install-plugin.sh").returncode, 0)
        changed = self.current()
        changed["bar"]["layout"]["left"].insert(0, {"id": "extra.widget"})
        self.save(changed)
        (self.repo / "plugin" / "Panel.qml").write_text("widget v2\n")
        # When applying the new bundle.
        result = self.run_script("install-plugin.sh")
        # Then the files update while the personalized layout stays intact.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.target / "Panel.qml").read_text(), "widget v2\n")
        self.assertEqual(self.current(), changed)
        self.assertEqual(sum(call[1:3] == ["plugin", "enable"] for call in self.calls()), 1)
        self.assertEqual(sum(call[1:] == ["restart", "shell"] for call in self.calls()), 1)

    def test_install_persists_senpi_executable_outside_desktop_path(self):
        # Given senpi available only in the installer's invocation environment.
        extra_bin = self.root / "other bin"
        extra_bin.mkdir()
        executable = extra_bin / "senpi"
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        self.env["PATH"] = f"{extra_bin}:{self.env['PATH']}"
        # When installing the widget.
        result = self.run_script("install-plugin.sh")
        # Then the absolute path is stored through the supported bar command.
        self.assertEqual(result.returncode, 0, result.stderr)
        entry = self.current()["bar"]["layout"]["left"][-1]
        self.assertEqual(entry["senpiPath"], str(executable))
        self.assertIn(["omarchy", "bar", "set", PLUGIN_ID, "senpiPath", str(executable)], self.calls())

    def test_update_preserves_explicit_senpi_path(self):
        # Given an installed widget whose user changed its executable setting.
        first_bin = self.root / "first"
        first_bin.mkdir()
        first = first_bin / "senpi"
        first.write_text("#!/bin/sh\n")
        first.chmod(0o755)
        self.env["PATH"] = f"{first_bin}:{self.env['PATH']}"
        self.assertEqual(self.run_script("install-plugin.sh").returncode, 0)
        changed = self.current()
        changed["bar"]["layout"]["left"][-1]["senpiPath"] = "/custom/user/senpi"
        self.save(changed)
        second_bin = self.root / "second"
        second_bin.mkdir()
        second = second_bin / "senpi"
        second.write_text("#!/bin/sh\n")
        second.chmod(0o755)
        self.env["PATH"] = f"{second_bin}:{self.bin}:/usr/bin:/bin"
        # When the owned plugin is updated with a different senpi on PATH.
        result = self.run_script("install-plugin.sh")
        # Then the user's explicit path is never replaced.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current(), changed)
        self.assertEqual(sum(call[1:5] == ["bar", "set", PLUGIN_ID, "senpiPath"]
                             for call in self.calls()), 1)
        self.assertIn(["omarchy", "restart", "shell"], self.calls())

    def test_install_without_senpi_reports_unresolved_launch(self):
        # Given no senpi executable in the invocation environment.
        # When installing the widget.
        result = self.run_script("install-plugin.sh")
        # Then the installer does not claim it configured a working Launch.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("senpi", result.stderr)
        self.assertNotIn("senpiPath", self.current()["bar"]["layout"]["left"][-1])

    def test_foreign_destination_is_never_overwritten(self):
        # Given a foreign directory occupying the plugin id.
        self.target.mkdir(parents=True)
        (self.target / "private.txt").write_text("private")
        # When installation is requested.
        result = self.run_script("install-plugin.sh")
        # Then it fails without mutating either destination or layout.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.target / "private.txt").read_text(), "private")
        self.assertEqual(self.current(), self.initial)

    def test_existing_layout_entry_is_not_claimed(self):
        # Given a plugin ID in the layout without an owned destination.
        changed = self.current()
        changed["bar"]["layout"]["right"].append({"id": PLUGIN_ID, "custom": 1})
        self.save(changed)
        # When installing.
        result = self.run_script("install-plugin.sh")
        # Then the foreign placement is neither modified nor taken over.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current(), changed)
        self.assertFalse(self.target.exists())

    def test_modified_owned_files_block_update_and_removal(self):
        # Given an owned plugin that its user has edited.
        self.assertEqual(self.run_script("install-plugin.sh").returncode, 0)
        (self.target / "Panel.qml").write_text("personal version\n")
        before = self.current()
        # When either lifecycle command is requested.
        update = self.run_script("install-plugin.sh")
        remove = self.run_script("uninstall-plugin.sh")
        # Then neither discards the file or layout.
        self.assertNotEqual(update.returncode, 0)
        self.assertNotEqual(remove.returncode, 0)
        self.assertEqual(self.current(), before)
        self.assertEqual((self.target / "Panel.qml").read_text(), "personal version\n")

    def test_top_bar_restores_only_unchanged_opt_in_position(self):
        # Given an explicitly opted-in top bar installation.
        result = self.run_script("install-plugin.sh", "--top-bar")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current()["bar"]["position"], "top")
        self.assertEqual(self.run_script("install-plugin.sh", "--top-bar").returncode, 0)
        # When removing the owned widget.
        result = self.run_script("uninstall-plugin.sh")
        # Then only the position changed by the installer is restored.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current(), self.initial)

    def test_uninstall_keeps_intervening_bar_position_and_other_settings(self):
        # Given an opt-in followed by a user's independent position change.
        self.assertEqual(self.run_script("install-plugin.sh", "--top-bar").returncode, 0)
        changed = self.current()
        changed["bar"]["position"] = "bottom"
        changed["unrelated"]["keep"] = 99
        self.save(changed)
        # When removing the widget.
        result = self.run_script("uninstall-plugin.sh")
        # Then the newer user decisions survive.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current()["bar"]["position"], "bottom")
        self.assertEqual(self.current()["unrelated"], {"keep": 99})

    def test_tracking_opt_in_installs_and_removes_only_owned_extension(self):
        # Given an isolated profile with an unrelated installed extension.
        agent = self.home / ".omo/agent"
        agent.mkdir(parents=True)
        settings = agent / "settings.json"
        settings.write_text(json.dumps({"packages": ["/other/extension.ts"]}))
        senpi = self.bin / "senpi"
        senpi.write_text("""#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
settings = Path(os.environ["SENPI_CODING_AGENT_DIR"]) / "settings.json"
data = json.loads(settings.read_text())
assert sys.argv[1] in ("install", "remove")
source = sys.argv[2]
if sys.argv[1] == "install":
    assert Path(source).is_file()
    if source not in data["packages"]: data["packages"].append(source)
else:
    data["packages"].remove(source)
settings.write_text(json.dumps(data))
""")
        senpi.chmod(0o755)
        self.env["SENPI_CODING_AGENT_DIR"] = str(agent)
        # When tracking is enabled then the widget is removed.
        installed = self.run_script("install-plugin.sh", "--track-all-sessions")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        source = json.loads((self.target / ".omo-install.json").read_text())["trackingSource"]
        self.assertEqual(source, str(self.target / "omo-status.ts"))
        self.assertEqual(json.loads(settings.read_text())["packages"], ["/other/extension.ts", source])
        self.assertEqual(self.current()["bar"]["layout"]["left"][-1]["trackingInstalled"], "true")
        removed = self.run_script("uninstall-plugin.sh")
        # Then only the extension installed by this widget is removed.
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(json.loads(settings.read_text())["packages"], ["/other/extension.ts"])

    def test_launcher_preference_uses_omo_when_available(self):
        # Given both launcher binaries on the installer PATH.
        for name in ("omo", "senpi"):
            executable = self.bin / name
            executable.write_text("#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)
        # When installing the widget.
        result = self.run_script("install-plugin.sh")
        # Then the preferred launcher is stored for the panel.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current()["bar"]["layout"]["left"][-1]["launcherPath"],
                         str(self.bin / "omo"))


if __name__ == "__main__":
    unittest.main()
