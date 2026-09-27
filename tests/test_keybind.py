"""Isolated SUPER+ALT+O keybinding installer tests (OMO_HYPR_DIR test mode)."""

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BIND = 'o.bind("SUPER + ALT + O", "OmO", "omarchy-shell omoLauncher toggle")'
ORIGINAL = """-- Keep only your personal keybinding overrides here.
-- o.bind("SUPER + ALT + O", "commented out", "true")
o.bind("SUPER + SHIFT + R", "PC", "uwsm-app -- pc-stream")
"""


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class KeybindInstallerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        self.hypr = base / "hypr"
        self.defaults = base / "defaults"
        self.hypr.mkdir()
        self.defaults.mkdir()
        (self.defaults / "bindings.lua").write_text('o.bind("SUPER + ALT + F", "Full width", "x")\n')
        self.target = self.hypr / "bindings.lua"
        self.target.write_text(ORIGINAL)
        self.env = {
            **os.environ,
            "OMO_HYPR_DIR": str(self.hypr),
            "OMO_HYPR_DEFAULT_DIR": str(self.defaults),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def run_script(self, name):
        return subprocess.run(
            ["bash", str(ROOT / "scripts" / name)],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def backups(self):
        return sorted(self.hypr.glob("bindings.lua.bak.omo.*"))

    def test_roundtrip_restores_exact_bytes(self):
        # Given a user bindings file whose only SUPER+ALT+O line is a comment.
        before = sha(self.target)
        # When installing.
        installed = self.run_script("install-keybind.sh")
        # Then one owned block with the IPC toggle is appended and a backup exists.
        self.assertEqual(installed.returncode, 0, installed.stderr)
        text = self.target.read_text()
        self.assertTrue(text.startswith(ORIGINAL))
        self.assertEqual(text.count(BIND), 1)
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(sha(self.backups()[0]), before)
        # When uninstalling.
        removed = self.run_script("uninstall-keybind.sh")
        # Then the file is byte-identical to the original.
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(sha(self.target), before)

    def test_roundtrip_without_trailing_newline(self):
        # Given a file that does not end in a newline.
        self.target.write_text(ORIGINAL.rstrip("\n"))
        before = sha(self.target)
        # When installing then uninstalling.
        self.assertEqual(self.run_script("install-keybind.sh").returncode, 0)
        self.assertIn("\n" + BIND + "\n", self.target.read_text())
        self.assertEqual(self.run_script("uninstall-keybind.sh").returncode, 0)
        # Then the bytes are restored exactly.
        self.assertEqual(sha(self.target), before)

    def test_refuses_when_user_already_binds_combo(self):
        # Given the combo bound in another user file, keys in a different order.
        (self.hypr / "extra.lua").write_text('o.bind("ALT + SUPER + O", "Mine", "foot")\n')
        before = sha(self.target)
        # When installing.
        result = self.run_script("install-keybind.sh")
        # Then it refuses, names the conflict, and touches nothing.
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("extra.lua", result.stderr)
        self.assertEqual(sha(self.target), before)
        self.assertEqual(self.backups(), [])

    def test_refuses_when_default_binds_combo(self):
        # Given an Omarchy default binding for the combo (hyprlang syntax).
        (self.defaults / "legacy.conf").write_text("bindd = SUPER ALT, O, Something, exec, true\n")
        # When installing.
        result = self.run_script("install-keybind.sh")
        # Then it refuses.
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.conf", result.stderr)
        self.assertEqual(self.target.read_text(), ORIGINAL)

    def test_second_install_is_refused(self):
        # Given an installed keybinding.
        self.assertEqual(self.run_script("install-keybind.sh").returncode, 0)
        after = sha(self.target)
        # When installing again.
        result = self.run_script("install-keybind.sh")
        # Then nothing is duplicated.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sha(self.target), after)

    def test_uninstall_keeps_later_user_edits(self):
        # Given an install followed by a user binding added below the block.
        self.assertEqual(self.run_script("install-keybind.sh").returncode, 0)
        with self.target.open("a") as handle:
            handle.write('o.bind("SUPER + J", "Later", "true")\n')
        # When uninstalling.
        result = self.run_script("uninstall-keybind.sh")
        # Then only the owned block is removed.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_text(), ORIGINAL + 'o.bind("SUPER + J", "Later", "true")\n')

    def test_uninstall_refuses_edited_block(self):
        # Given an installed block whose command was edited by hand.
        self.assertEqual(self.run_script("install-keybind.sh").returncode, 0)
        edited = self.target.read_text().replace("omoLauncher toggle", "omoLauncher open")
        self.target.write_text(edited)
        # When uninstalling.
        result = self.run_script("uninstall-keybind.sh")
        # Then the edited file is left alone.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.target.read_text(), edited)


if __name__ == "__main__":
    unittest.main()
