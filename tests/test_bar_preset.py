"""Isolated contract tests for the OmO bar preset lifecycle."""

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MENU = "io.github.tmdgusya.omo-menu-button"
WORKSPACES = "io.github.tmdgusya.omo-workspaces"
CLOCK = "io.github.tmdgusya.omo-clock"
USAGE = "io.github.tmdgusya.omo-usage"
WIDGETS = (MENU, WORKSPACES, CLOCK, USAGE)

FAKE_OMARCHY = r"""#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
root = Path(os.environ["OMO_CONFIG_ROOT"])
config = root / "shell.json"
log = root / "calls.log"

with log.open("a") as stream:
    stream.write(json.dumps(["omarchy", *args]) + "\n")

if args[:2] == ["plugin", "validate"]:
    folder = Path(args[2])
    manifest = json.loads((folder / "manifest.json").read_text())
    assert manifest["schemaVersion"] == 1
    assert manifest["author"] == "tmdgusya"
    assert "bar-widget" in manifest["kinds"]
    assert (folder / manifest["entryPoints"]["barWidget"]).is_file()
    raise SystemExit(0)

data = json.loads(config.read_text())
layout = data["bar"]["layout"]

def entry_id(entry):
    return entry["id"] if isinstance(entry, dict) else entry

def locate(widget):
    for section, entries in layout.items():
        for index, entry in enumerate(entries):
            if entry_id(entry) == widget:
                return section, index
    return None

def remove(widget):
    for section, entries in layout.items():
        layout[section] = [entry for entry in entries if entry_id(entry) != widget]

def insert(widget, placement):
    if locate(widget) is not None:
        return
    entry = {"id": widget}
    if "--before" in placement:
        target = placement[placement.index("--before") + 1]
        found = locate(target)
        if found is not None:
            section, index = found
            layout[section].insert(index, entry)
            return
    if "--section" in placement:
        section = placement[placement.index("--section") + 1]
    elif widget.endswith("omo-clock") or widget == "omarchy.clock":
        section = "center"
    elif widget.endswith("omo-usage"):
        section = "right"
    else:
        section = "left"
    layout[section].append(entry)

if args[:2] == ["plugin", "enable"]:
    insert(args[2], args[3:])
elif args[:2] == ["plugin", "disable"]:
    remove(args[2])
elif args[:2] == ["bar", "put"]:
    insert(args[2], args[3:])
elif args[:2] == ["bar", "move"]:
    widget = args[2]
    found = locate(widget)
    if found is None:
        raise SystemExit("cannot move absent widget")
    section, index = found
    entry = layout[section].pop(index)
    placement = args[3:]
    target = placement[placement.index("--before") + 1]
    target_section, target_index = locate(target)
    layout[target_section].insert(target_index, entry)
elif args[:2] == ["bar", "set"]:
    widget, key, raw = args[2:5]
    found = locate(widget)
    if found is None:
        raise SystemExit("cannot set absent widget")
    section, index = found
    entry = layout[section][index]
    if not isinstance(entry, dict):
        entry = {"id": entry}
        layout[section][index] = entry
    entry[key] = json.loads(raw) if args[5:] == ["--json"] else raw
elif args[:2] == ["bar", "position"]:
    data["bar"]["position"] = args[2]
elif args[:2] == ["bar", "transparent"]:
    data["bar"]["transparent"] = args[2] == "true"
else:
    raise SystemExit("unsupported omarchy command: " + repr(args))

config.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
"""

FAKE_SHELL = r"""#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
root = Path(os.environ["OMO_CONFIG_ROOT"])
config = root / "shell.json"
with (root / "calls.log").open("a") as stream:
    stream.write(json.dumps(["omarchy-shell", *args]) + "\n")

if args == ["shell", "ping"]:
    print("ok")
elif args == ["shell", "listShellConfig"]:
    print(config.read_text())
elif args in (["shell", "rescanPlugins"], ["shell", "reloadConfig"]):
    pass
else:
    raise SystemExit("unsupported shell command: " + repr(args))
"""


class BarPresetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config_root = self.root / "config"
        self.config_root.mkdir()
        self.config = self.config_root / "shell.json"
        self.initial = {
            "version": 1,
            "bar": {
                "position": "left",
                "transparent": True,
                "centerAnchor": "omarchy.clock",
                "layout": {
                    "left": [
                        {"id": "omarchy.menu"},
                        {"id": "unrelated.left", "size": 17},
                        {"id": "roach.workspaces", "labels": False},
                    ],
                    "center": [
                        {"id": "unrelated.center"},
                        {"id": "omarchy.clock", "format": "HH:mm"},
                    ],
                    "right": [
                        {"id": "unrelated.right", "keep": 42},
                        {"id": "robzolkos.agent-usage"},
                    ],
                },
            },
            "unrelated": {"keep": "exactly"},
        }
        self.write_config(self.initial)

        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, source in (
            ("omarchy", FAKE_OMARCHY),
            ("omarchy-shell", FAKE_SHELL),
        ):
            executable = self.bin / name
            executable.write_text(source)
            executable.chmod(0o755)

        self.env = {
            **os.environ,
            "HOME": str(self.root / "home"),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "OMO_CONFIG_ROOT": str(self.config_root),
            "OMO_OMARCHY_BIN": str(self.bin / "omarchy"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def write_config(self, value):
        self.config.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")

    def current(self):
        return json.loads(self.config.read_text())

    def run_script(self, name, *args):
        return subprocess.run(
            ["bash", str(ROOT / "scripts" / name), *args],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def layout_ids(self, section):
        return [entry["id"] for entry in self.current()["bar"]["layout"][section]]

    def install(self, position="top"):
        return self.run_script("install-bar-preset.sh", "--position", position)

    def test_install_top_replaces_only_target_widgets(self):
        result = self.install()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current()["bar"]["position"], "top")
        self.assertEqual(
            self.layout_ids("left"),
            [MENU, "unrelated.left", WORKSPACES],
        )
        self.assertEqual(self.layout_ids("center"), ["unrelated.center", CLOCK])
        self.assertEqual(self.layout_ids("right"), ["unrelated.right", USAGE])
        self.assertEqual(self.current()["bar"]["centerAnchor"], CLOCK)
        marker = json.loads((self.config_root / ".omo-bar-preset.json").read_text())
        self.assertEqual(marker["prior"], {
            "position": "left",
            "transparent": True,
            "centerAnchor": "omarchy.clock",
            "layout": self.initial["bar"]["layout"],
        })
        for widget in WIDGETS:
            target = self.config_root / "plugins" / widget
            self.assertEqual(
                json.loads((target / ".omo-install.json").read_text())["id"],
                widget,
            )

    def test_install_left_selects_left_variant(self):
        result = self.install("left")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current()["bar"]["position"], "left")
        marker = json.loads((self.config_root / ".omo-bar-preset.json").read_text())
        self.assertEqual(marker["preset"], "left")

    def test_uninstall_restores_sha256_identical_shell_json(self):
        before = hashlib.sha256(self.config.read_bytes()).hexdigest()
        self.assertEqual(self.install().returncode, 0)

        result = self.run_script("uninstall-bar-preset.sh")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(hashlib.sha256(self.config.read_bytes()).hexdigest(), before)
        self.assertFalse((self.config_root / ".omo-bar-preset.json").exists())
        for widget in WIDGETS:
            self.assertFalse((self.config_root / "plugins" / widget).exists())

    def test_repeat_install_is_idempotent(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        before = self.config.read_bytes()

        second = self.install()

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.config.read_bytes(), before)
        for section in ("left", "center", "right"):
            ids = self.layout_ids(section)
            for widget in WIDGETS:
                self.assertLessEqual(ids.count(widget), 1)

    def test_foreign_plugin_directory_is_refused(self):
        foreign = self.config_root / "plugins" / MENU
        foreign.mkdir(parents=True)
        (foreign / "private.txt").write_text("mine\n")
        before = self.config.read_bytes()

        result = self.install()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unowned plugin", result.stderr)
        self.assertEqual((foreign / "private.txt").read_text(), "mine\n")
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse((self.config_root / ".omo-bar-preset.json").exists())


if __name__ == "__main__":
    unittest.main()
