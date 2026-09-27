"""Isolated menu and Senpi theme installer regression tests."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class InstallerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PYTHONDONTWRITEBYTECODE": "1",
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

    def parsed_jsonc(self, path):
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/jsonc-edit.py"), "dump", str(path)],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        return json.loads(result.stdout)


class MenuInstallerTests(InstallerCase):
    def setUp(self):
        super().setUp()
        self.extensions = self.home / ".config/omarchy/extensions"
        self.extensions.mkdir(parents=True)
        self.target = self.extensions / "omarchy-menu.jsonc"

    def test_roundtrip_preserves_remote_jsonc_byte_for_byte(self):
        # Given a user menu with comments, a trailing comma, and comment-like string data.
        original = """{
  // private remote integration
  "remote.host": {
    "label": "https://host.test/a//b",
  },
}
"""
        self.target.write_text(original)
        # When installing and removing the owned OmO keys.
        installed = self.run_script("install-menu.sh")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        current = self.parsed_jsonc(self.target)
        self.assertEqual(current["remote.host"]["label"], "https://host.test/a//b")
        self.assertEqual(
            set(key for key in current if key.startswith("omo")),
            {"omo", "omo.new", "omo.panel", "omo.sessions", "omo.storm"},
        )
        removed = self.run_script("uninstall-menu.sh")
        # Then the user's original JSONC is restored exactly.
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(self.target.read_text(), original)
        self.assertFalse((self.extensions / "omarchy-menu.omo-install.json").exists())

    def test_existing_omo_key_is_never_claimed(self):
        # Given an unowned entry in the OmO namespace.
        original = '{"remote.keep":{"x":1},"omo.new":{"action":"private"}}\n'
        self.target.write_text(original)
        # When installation is requested.
        result = self.run_script("install-menu.sh")
        # Then it refuses without changing the file.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.target.read_text(), original)

    def test_uninstall_refuses_edited_owned_key(self):
        # Given an installed menu whose owned action was changed.
        self.target.write_text('{"remote.keep":{"x":1}}\n')
        self.assertEqual(self.run_script("install-menu.sh").returncode, 0)
        data = self.parsed_jsonc(self.target)
        data["omo.new"]["action"] = "private-command"
        self.target.write_text(json.dumps(data))
        # When removal is requested.
        result = self.run_script("uninstall-menu.sh")
        # Then the user edit and marker survive for manual reconciliation.
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.parsed_jsonc(self.target)["omo.new"]["action"], "private-command")
        self.assertTrue((self.extensions / "omarchy-menu.omo-install.json").exists())


class SenpiThemeInstallerTests(InstallerCase):
    def setUp(self):
        super().setUp()
        self.agent = self.home / ".omo/agent"
        self.agent.mkdir(parents=True)
        self.env["SENPI_CODING_AGENT_DIR"] = str(self.agent)
        self.settings = self.agent / "settings.jsonc"
        self.target = self.agent / "themes/omo-nightsea.json"

    def test_roundtrip_restores_previous_jsonc_theme(self):
        # Given comments, unrelated values, and an existing theme.
        original = """{
  // keep the user's model and theme
  "theme": "old-sea",
  "model": "provider/model",
}
"""
        self.settings.write_text(original)
        # When the bundled theme is installed and removed.
        installed = self.run_script("install-pi-theme.sh")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(self.parsed_jsonc(self.settings)["theme"], "omo-nightsea")
        self.assertEqual(json.loads(self.target.read_text())["name"], "omo-nightsea")
        removed = self.run_script("uninstall-pi-theme.sh")
        # Then the previous settings text and unrelated model are exact.
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(self.settings.read_text(), original)
        self.assertFalse(self.target.exists())

    def test_uninstall_preserves_later_theme_selection(self):
        # Given an install followed by a user's new theme choice.
        self.settings.write_text('{"theme":"old-sea","keep":42}\n')
        self.assertEqual(self.run_script("install-pi-theme.sh").returncode, 0)
        subprocess.run(
            [
                "python3",
                str(ROOT / "scripts/jsonc-edit.py"),
                "merge",
                str(self.settings),
                '{"theme":"user-new"}',
            ],
            env=self.env,
            check=True,
        )
        # When the owned theme file is removed.
        result = self.run_script("uninstall-pi-theme.sh")
        # Then the newer user setting wins while unrelated settings remain.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.parsed_jsonc(self.settings), {"theme": "user-new", "keep": 42})
        self.assertFalse(self.target.exists())

    def test_modified_theme_file_blocks_removal(self):
        # Given an installed theme file edited in place.
        self.settings.write_text("{}\n")
        self.assertEqual(self.run_script("install-pi-theme.sh").returncode, 0)
        self.target.write_text('{"name":"personal"}\n')
        # When removal is requested.
        result = self.run_script("uninstall-pi-theme.sh")
        # Then no owned state is discarded.
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.target.exists())
        self.assertEqual(self.parsed_jsonc(self.settings)["theme"], "omo-nightsea")


if __name__ == "__main__":
    unittest.main()
