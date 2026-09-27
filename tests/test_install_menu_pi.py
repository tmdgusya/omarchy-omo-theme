"""Isolated menu and Senpi theme installer regression tests."""

import hashlib
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
            {"omo-launch", "omo", "omo.new", "omo.panel", "omo.sessions", "omo.storm"},
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


class MenuOrderingTests(InstallerCase):
    """Root order as the stock Omarchy menu computes it (MenuModel.js)."""

    MENU_DIR = Path("/usr/share/omarchy/shell/plugins/menu")
    DEFAULTS = Path("/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc")
    LAUNCH = {
        "label": "OmO \u2014 What would you like done?",
        "action": "omarchy-shell omoLauncher open",
    }

    def setUp(self):
        super().setUp()
        self.extensions = self.home / ".config/omarchy/extensions"
        self.extensions.mkdir(parents=True)
        self.target = self.extensions / "omarchy-menu.jsonc"
        if not (self.MENU_DIR / "MenuModel.js").is_file() or not self.DEFAULTS.is_file():
            self.skipTest("Omarchy menu sources are not installed")

    def extension_root_rows(self):
        script = """
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8").replace(/^\\.(pragma|import).*$/gm, "");
const M = new Function(src + "; return { parseMenuJsonc, mergeMenuSources };")();
const defaults = M.parseMenuJsonc(fs.readFileSync(process.argv[2], "utf8"));
const merged = M.mergeMenuSources(defaults, M.parseMenuJsonc(fs.readFileSync(process.argv[3], "utf8")));
const stock = new Set(defaults.map((item) => item.id));
const rows = merged.itemOrder.map((id) => merged.items[id])
  .filter((item) => item.parent === "root" && !stock.has(item.id));
console.log(JSON.stringify(rows.map((item) => [item.id, item.label, item.action])));
"""
        result = subprocess.run(
            ["bun", "-e", script, str(self.MENU_DIR / "MenuModel.js"), str(self.DEFAULTS), str(self.target)],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        return json.loads(result.stdout)

    def test_launcher_is_first_row_added_to_root(self):
        # Given an empty extension file.
        self.target.write_text("{}\n")
        # When the OmO menu is installed.
        self.assertEqual(self.run_script("install-menu.sh").returncode, 0)
        # Then the launcher row leads every root row the extension adds.
        rows = self.extension_root_rows()
        self.assertEqual(rows[0], ["omo-launch", self.LAUNCH["label"], self.LAUNCH["action"]])
        self.assertEqual([row[0] for row in rows], ["omo-launch", "omo"])

    def test_upgrade_from_older_install_moves_launcher_ahead(self):
        # Given user-owned remote/PirateTalk rows and an earlier install that
        # owned only the omo.* keys.
        original = """{
  // Extend the Quickshell Omarchy menu with JSONC.
  "remote": {"icon":"\U0001f5a5","label":"\uc6d0\uaca9"},
  "remote.pc": {"icon":"\U0001fa9f","label":"PC","action":"uwsm-app -- pc-stream"},
  "piratetalk": {"icon":"\U0001f4ac","label":"PirateTalk","action":"uwsm-app -- piratetalk"}
}
"""
        self.target.write_text(original)
        before = hashlib.sha256(self.target.read_bytes()).hexdigest()
        self.assertEqual(self.run_script("install-menu.sh").returncode, 0)
        marker_path = self.extensions / "omarchy-menu.omo-install.json"
        marker = json.loads(marker_path.read_text())
        marker["ownedKeys"].remove("omo-launch")
        del marker["applied"]["omo-launch"]
        subprocess.run(
            ["python3", str(ROOT / "scripts/jsonc-edit.py"), "remove", str(self.target), '["omo-launch"]'],
            env=self.env,
            check=True,
        )
        marker["installedSha256"] = hashlib.sha256(self.target.read_bytes()).hexdigest()
        marker_path.write_text(json.dumps(marker))
        # When installing the new version over it.
        result = self.run_script("install-menu.sh")
        # Then the launcher is claimed and ordered first, user rows untouched.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            [row[0] for row in self.extension_root_rows()],
            ["remote", "piratetalk", "omo-launch", "omo"],
        )
        self.assertIn("omo-launch", json.loads(marker_path.read_text())["ownedKeys"])
        # And uninstall restores the pre-OmO file byte for byte.
        removed = self.run_script("uninstall-menu.sh")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(hashlib.sha256(self.target.read_bytes()).hexdigest(), before)


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

    def test_themes_directory_holds_only_the_theme(self):
        # Given a fresh agent directory.
        self.settings.write_text("{}\n")
        # When the bundled theme is installed.
        result = self.run_script("install-pi-theme.sh")
        # Then Senpi's theme loader sees no ownership marker as a theme.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.target.parent.iterdir()), ["omo-nightsea.json"])

    def test_legacy_marker_in_themes_directory_is_migrated(self):
        # Given an install whose marker was written by the older layout.
        self.settings.write_text('{"theme":"old-sea"}\n')
        self.assertEqual(self.run_script("install-pi-theme.sh").returncode, 0)
        legacy = self.target.parent / "omo-nightsea.omo-install.json"
        (self.agent / "omo-nightsea.omo-install.json").rename(legacy)
        # When the installer runs again.
        result = self.run_script("install-pi-theme.sh")
        # Then the marker leaves themes/ and removal still restores the prior theme.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(legacy.exists())
        self.assertEqual(self.run_script("uninstall-pi-theme.sh").returncode, 0)
        self.assertEqual(self.parsed_jsonc(self.settings)["theme"], "old-sea")

    def test_duplicate_legacy_marker_is_removed_on_reinstall_and_uninstall(self):
        # Given the same marker at both the current and the legacy path.
        self.settings.write_text('{"theme":"old-sea"}\n')
        self.assertEqual(self.run_script("install-pi-theme.sh").returncode, 0)
        marker = self.agent / "omo-nightsea.omo-install.json"
        legacy = self.target.parent / "omo-nightsea.omo-install.json"
        legacy.write_bytes(marker.read_bytes())
        # When the installer runs again.
        result = self.run_script("install-pi-theme.sh")
        # Then the legacy copy is gone.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(legacy.exists())
        # And when a duplicate reappears, removal also clears it.
        legacy.write_bytes(marker.read_bytes())
        removed = self.run_script("uninstall-pi-theme.sh")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(list(self.target.parent.iterdir()), [])
        self.assertFalse(marker.exists())

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
