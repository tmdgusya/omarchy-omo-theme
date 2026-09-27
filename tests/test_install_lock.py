"""Deterministic soak receipt and opt-in lock installer tests."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCK_ID = "io.github.sirjul1337.lock-explorer"
OMARCHY = """#!/usr/bin/env python3
import json
import sys
from pathlib import Path

config = Path.home() / ".config/omarchy/shell.json"
data = json.loads(config.read_text())
args = sys.argv[1:]
if args[:2] == ["plugin", "enable"]:
    data["disabledPlugins"] = [item for item in data["disabledPlugins"] if item != %r]
    if not any(item.get("id") == %r for item in data["plugins"]):
        data["plugins"].append({"id": %r})
elif args[:2] == ["plugin", "disable"]:
    data["plugins"] = [item for item in data["plugins"] if item.get("id") != %r]
    if %r not in data["disabledPlugins"]:
        data["disabledPlugins"].append(%r)
else:
    raise SystemExit("unsupported omarchy command")
config.write_text(json.dumps(data))
""" % ((LOCK_ID,) * 6)
OMARCHY_SHELL = """#!/usr/bin/env python3
import json
import sys
from pathlib import Path

config = Path.home() / ".config/omarchy/shell.json"
data = json.loads(config.read_text())
args = sys.argv[1:]
if args == ["lock", "rescanDesigns"]:
    raise SystemExit(0)
entry = next(item for item in data["plugins"] if item.get("id") == %r)
key = {
    "setDesign": "design",
    "setUnlockAnimation": "unlock",
    "setUnlockDuration": "unlockMs",
}[args[1]]
entry[key] = int(args[2]) if key == "unlockMs" else args[2]
config.write_text(json.dumps(data))
""" % LOCK_ID


class LockInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        plugin = self.home / ".config/omarchy/plugins" / LOCK_ID
        plugin.mkdir(parents=True)
        (plugin / "manifest.json").write_text(json.dumps({"id": LOCK_ID}))
        self.config = self.home / ".config/omarchy/shell.json"
        self.initial = {
            "version": 1,
            "bar": {"layout": {"left": [], "center": [], "right": []}},
            "plugins": [],
            "disabledPlugins": [LOCK_ID],
            "unrelated": {"keep": 42},
        }
        self.config.write_text(json.dumps(self.initial))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, source in (("omarchy", OMARCHY), ("omarchy-shell", OMARCHY_SHELL)):
            executable = self.bin / name
            executable.write_text(source)
            executable.chmod(0o755)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "OMO_SOAK_NOW_EPOCH": "86500",
        }

    def run_script(self, name, *args):
        return subprocess.run(
            ["bash", str(ROOT / "scripts" / name), *args],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def write_receipt(self):
        receipt = self.home / ".local/state/omo/soak/latest.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(json.dumps({
            "schema": 1,
            "passed": True,
            "shellAlive": True,
            "durationSeconds": 86400,
            "rssDeltaKiB": 20000,
            "maxRssDeltaKiB": 153600,
            "finishedAtEpoch": 86500,
        }))

    def test_lock_install_requires_flag_and_passing_receipt(self):
        # Given no explicit opt-in and no soak receipt.
        # When installation is attempted through either incomplete gate.
        no_flag = self.run_script("install-lock.sh")
        no_receipt = self.run_script("install-lock.sh", "--lock-explorer")
        # Then both attempts fail without enabling Explorer or copying a design.
        self.assertNotEqual(no_flag.returncode, 0)
        self.assertNotEqual(no_receipt.returncode, 0)
        self.assertEqual(json.loads(self.config.read_text()), self.initial)
        self.assertFalse((self.home / ".config/omarchy/lock-designs/OmO.qml").exists())

    def test_lock_roundtrip_restores_disabled_state(self):
        # Given an explicit opt-in backed by a passing 24 hour receipt.
        self.write_receipt()
        # When installing and removing the design.
        installed = self.run_script("install-lock.sh", "--lock-explorer")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        active = json.loads(self.config.read_text())
        entry = next(item for item in active["plugins"] if item["id"] == LOCK_ID)
        self.assertEqual(
            {key: entry[key] for key in ("design", "unlock", "unlockMs")},
            {"design": "my-omo", "unlock": "rise", "unlockMs": 400},
        )
        removed = self.run_script("uninstall-lock.sh")
        # Then the exact prior plugin state and unrelated config return.
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(json.loads(self.config.read_text()), self.initial)
        self.assertFalse((self.home / ".config/omarchy/lock-designs/OmO.qml").exists())

    def test_edited_design_blocks_removal(self):
        # Given an installed design edited by the user.
        self.write_receipt()
        self.assertEqual(self.run_script("install-lock.sh", "--lock-explorer").returncode, 0)
        target = self.home / ".config/omarchy/lock-designs/OmO.qml"
        target.write_text("personal design\n")
        # When removal is requested.
        result = self.run_script("uninstall-lock.sh")
        # Then the file and enabled state survive.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "personal design\n")
        self.assertNotEqual(json.loads(self.config.read_text()), self.initial)


class SoakReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.proc = self.root / "proc"
        self.pid = "4242"
        process = self.proc / self.pid
        process.mkdir(parents=True)
        fields = ["S", *(["0"] * 18), "12345"]
        (process / "stat").write_text(f"{self.pid} (quickshell) {' '.join(fields)}\n")
        self.status = process / "status"
        self.status.write_text("Name:\tquickshell\nVmRSS:\t100000 kB\n")
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "OMO_SOAK_PROC_ROOT": str(self.proc),
            "OMO_SOAK_PID": self.pid,
            "OMO_SOAK_NOW_EPOCH": "100",
        }

    def run_soak(self, command):
        return subprocess.run(
            ["bash", str(ROOT / "scripts/soak-shell.sh"), command],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def test_finish_uses_elapsed_signal_without_sleep(self):
        # Given a started soak and deterministic process metrics.
        self.assertEqual(self.run_soak("start").returncode, 0)
        self.status.write_text("Name:\tquickshell\nVmRSS:\t120000 kB\n")
        self.env["OMO_SOAK_NOW_EPOCH"] = "86500"
        # When the same live process finishes after exactly 24 hours.
        result = self.run_soak("finish")
        # Then a bounded passing receipt records the observed delta.
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(
            (self.home / ".local/state/omo/soak/latest.json").read_text()
        )
        self.assertEqual(receipt["durationSeconds"], 86400)
        self.assertEqual(receipt["rssDeltaKiB"], 20000)
        self.assertTrue(receipt["passed"])

    def test_finish_rejects_short_observation(self):
        # Given a started soak with only one second elapsed.
        self.assertEqual(self.run_soak("start").returncode, 0)
        self.env["OMO_SOAK_NOW_EPOCH"] = "101"
        # When finish is requested.
        result = self.run_soak("finish")
        # Then no passing receipt is created.
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / ".local/state/omo/soak/latest.json").exists())


if __name__ == "__main__":
    unittest.main()
