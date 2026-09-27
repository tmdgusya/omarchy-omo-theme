"""Lane E token contracts: shell.toml, colors.toml, pi.json, icons.theme, menu."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = Path(os.environ.get("OMARCHY_PATH", "/usr/share/omarchy")) / "default/themed"
HEX = re.compile(r"#[0-9A-Fa-f]{6}\b")
PROVIDER = ROOT / "menu" / "omo-menu-sessions"


def colors():
    return tomllib.loads((ROOT / "colors.toml").read_text())


def resolved_colors():
    # Same selection fallbacks as omarchy-theme-color:229-231.
    c = dict(colors())
    c.setdefault("selection_background", c["selection"])
    c.setdefault("selection_foreground", c["bright_foreground"])
    return c


def mix(start, end, amount):
    # omarchy-theme-set-templates mix_color(): per channel, int(x + 0.5).
    a, b = start.lstrip("#"), end.lstrip("#")
    return "#" + "".join("%02x" % int(int(a[i:i + 2], 16) * (1 - amount) + int(b[i:i + 2], 16) * amount + 0.5)
                         for i in (0, 2, 4))


def luminance(hex_color):
    h = hex_color.lstrip("#")
    lin = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        lin.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def strip_jsonc(raw):
    # MenuModel.js stripJsonc(): whole-line // comments, trailing commas.
    return re.sub(r",(\s*[}\]])", r"\1", re.sub(r"^\s*//[^\n]*(\n|$)", "", raw, flags=re.M))


def needs_template(name):
    path = TEMPLATES / name
    if not path.is_file():
        raise unittest.SkipTest(f"{path} not installed")
    return path.read_text()


class ShellTomlTests(unittest.TestCase):
    def setUp(self):
        self.shell = tomllib.loads((ROOT / "shell.toml").read_text())

    def test_every_key_exists_in_stock_template(self):
        template = tomllib.loads(needs_template("shell.toml.tpl"))
        for section, values in self.shell.items():
            self.assertIn(section, template)
            for key in values:
                self.assertIn(key, template[section], f"[{section}] {key}")

    def test_every_hex_comes_from_the_palette(self):
        palette = {v.upper() for v in colors().values() if isinstance(v, str)
                   for v in HEX.findall(v)}
        for section, values in self.shell.items():
            for key, value in values.items():
                for hex_color in HEX.findall(str(value)):
                    self.assertIn(hex_color.upper(), palette, f"[{section}] {key}")

    def test_card_surfaces_are_opaque(self):
        # Measured on the desktop: below 1.0 terminal text ghosts through cards.
        for section in ("popups", "tooltip", "menu", "launcher", "notifications", "polkit"):
            self.assertEqual(self.shell[section]["background-alpha"], 1.0, section)

    def test_selected_rows_use_tonal_fill_without_stripe(self):
        for section in ("menu", "launcher"):
            self.assertEqual(self.shell[section]["selected-background"], "#F4F4F4")
            self.assertEqual(self.shell[section]["selected-text"], colors()["accent"])
            self.assertEqual(self.shell[section]["selected-border-alpha"], 0.0)
        self.assertEqual(self.shell["controls"]["selected-border-width"], 0)

    def test_text_tokens_meet_aa_on_their_surface(self):
        for section in ("popups", "tooltip", "notifications", "menu", "launcher", "polkit", "lock"):
            values = self.shell[section]
            self.assertGreaterEqual(contrast(values["text"], values["background"]), 4.5, section)
        lock = self.shell["lock"]
        self.assertGreaterEqual(contrast(lock["placeholder"], lock["background"]), 4.5)


class PiThemeTests(unittest.TestCase):
    def setUp(self):
        self.theme = json.loads((ROOT / "pi.json").read_text())

    def test_renders_every_template_token_from_nightsea_colors(self):
        template = needs_template("pi.json.tpl").replace(
            "{{ mix foreground background 52% }}", "{{ mix foreground background 44% }}")
        c = resolved_colors()
        rendered = re.sub(r"\{\{\s*mix\s+(\w+)\s+(\w+)\s+([\d.]+)%\s*\}\}",
                          lambda m: mix(c[m[1]], c[m[2]], float(m[3]) / 100), template)
        rendered = re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: c[m[1]], rendered)
        expected = json.loads(rendered)
        expected["name"] = "omo-nightsea"
        self.assertEqual(self.theme, expected)

    def test_name_and_token_count(self):
        self.assertEqual(self.theme["name"], "omo-nightsea")
        self.assertEqual(len(self.theme["colors"]), 51)
        for token, ref in self.theme["colors"].items():
            self.assertIn(ref, self.theme["vars"], token)

    def test_dim_text_meets_aa(self):
        v = self.theme["vars"]
        self.assertEqual(v["dimText"], mix(v["foreground"], v["background"], 0.44))
        self.assertGreaterEqual(contrast(v["dimText"], v["background"]), 4.5)
        self.assertGreaterEqual(contrast(v["mutedText"], v["background"]), 4.5)


class IconsThemeTests(unittest.TestCase):
    def test_names_an_installed_icon_theme(self):
        name = (ROOT / "icons.theme").read_text().strip()
        self.assertEqual(name, "Yaru-prussiangreen")
        if Path("/usr/share/icons").is_dir():
            self.assertTrue((Path("/usr/share/icons") / name).is_dir())


class MenuFragmentTests(unittest.TestCase):
    def setUp(self):
        self.items = json.loads(strip_jsonc((ROOT / "menu" / "omarchy-menu.omo.jsonc").read_text()))

    def test_owned_ids_and_rows(self):
        self.assertTrue(all(i in ("omo", "omo-launch") or i.startswith("omo.") for i in self.items))
        self.assertEqual(next(iter(self.items)), "omo-launch")
        self.assertEqual([i for i in self.items if i.startswith("omo.")],
                         ["omo.new", "omo.panel", "omo.sessions", "omo.storm"])
        self.assertEqual(self.items["omo"]["aliases"], ["omo"])
        self.assertIn("checked", self.items["omo.storm"])
        for key in ("omo.new", "omo.panel", "omo.sessions", "omo.storm"):
            self.assertTrue(self.items[key]["action"], key)

    def test_icons_are_nerd_font_glyphs_not_emoji(self):
        for key, item in self.items.items():
            self.assertEqual(len(item["icon"]), 1, key)
            self.assertGreaterEqual(ord(item["icon"]), 0xF0000, key)  # Nerd Font md plane


FAKE_COLLECTOR = """
import time
SECONDS = 4
def list_sessions(agent_dir, task_dir):
    if {sleep}:
        time.sleep({sleep})
    return {{"schemaVersion": 1, "sessions": {sessions}}}
"""


def session(sid, kind, status, working=False, ulw=None, goal=None, activity="2026-01-01T00:00:00Z"):
    return {"id": sid, "title": f"title {sid}", "cwdLabel": "repo", "activityAt": activity,
            "runtime": {"kind": kind, "status": status, "working": working},
            "ulw": {"status": ulw} if ulw else None, "goal": {"status": goal} if goal else None}


FIXTURES = [
    session("idle1", "idle", "idle"),
    session("storm1", "live", "working", True, ulw="in_progress"),
    session("tide1", "live", "working", True),
    session("wait1", "live", "waiting"),
    session("coral1", "idle", "idle", goal="blocked"),
    session("unk1", "unknown", "unknown"),
    session("rec1", "unknown", "recent"),
    session("end1", "ended", "ended"),
]


class ProviderTests(unittest.TestCase):
    def run_provider(self, sessions, sleep=0):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "omo_sessions.py"
            fake.write_text(FAKE_COLLECTOR.format(sessions=repr(sessions), sleep=sleep))
            env = dict(os.environ, OMO_SESSIONS_PY=str(fake))
            done = subprocess.run([sys.executable, "-B", str(PROVIDER)], env=env,
                                  capture_output=True, text=True, timeout=10)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_rows_follow_menu_model_schema_and_weather(self):
        rows = self.run_provider(FIXTURES)
        schema = {"id", "parent", "kind", "icon", "iconFont", "label", "title", "target",
                  "description", "action", "provider", "aliases", "when", "checked"}
        for row in rows:
            self.assertEqual(set(row), schema)
            self.assertEqual(row["parent"], "omo.sessions")
            self.assertEqual(row["kind"], "action")
            self.assertTrue(row["action"].startswith("omarchy-shell io.github.tmdgusya.omo focus "))
        weather = {r["id"].split(".", 2)[2]: r["description"].split(" · ")[:2] for r in rows}
        self.assertEqual(weather["storm1"], ["Storm", "ultrawork"])
        self.assertEqual(weather["tide1"], ["Tide", "working"])
        self.assertEqual(weather["wait1"], ["Lantern", "waiting"])
        self.assertEqual(weather["coral1"], ["Coral", "error"])
        self.assertEqual(weather["unk1"], ["Calm", "unknown"])
        self.assertEqual(weather["rec1"], ["Calm", "recent"])
        self.assertEqual(weather["end1"], ["Calm", "ended"])
        self.assertEqual([r["id"] for r in rows[:4]],
                         ["omo.sessions.wait1", "omo.sessions.coral1", "omo.sessions.storm1", "omo.sessions.tide1"])

    def test_states_match_plugin_model(self):
        bun = shutil.which("bun")
        if not bun:
            self.skipTest("bun not installed")
        script = (
            "const fs=require('fs');"
            f"const src=fs.readFileSync({json.dumps(str(ROOT / 'plugin/Model.js'))},'utf8').replace(/^\\.pragma library\\s*/,'');"
            "const m={exports:{}};new Function('module','exports',src)(m,m.exports);"
            f"const list={json.dumps(FIXTURES)};"
            "console.log(JSON.stringify(list.map(s=>[s.id,m.exports.sessionState(s,0)])))"
        )
        model = dict(json.loads(subprocess.run([bun, "-e", script], capture_output=True, text=True,
                                               check=True, timeout=10).stdout))
        rows = self.run_provider(FIXTURES)
        ours = {r["id"].split(".", 2)[2]: r["description"].split(" · ")[1] for r in rows}
        self.assertEqual(ours, model)

    def test_row_limit_and_empty_fallback(self):
        many = [session(f"s{i}", "idle", "idle") for i in range(30)]
        self.assertEqual(len(self.run_provider(many)), 12)
        empty = self.run_provider([])
        self.assertEqual([r["id"] for r in empty], ["omo.sessions.panel"])

    def test_slow_collector_is_cut_off(self):
        rows = self.run_provider(FIXTURES, sleep=2)
        self.assertEqual([r["id"] for r in rows], ["omo.sessions.panel"])
        self.assertIn("timed out", rows[0]["description"])


if __name__ == "__main__":
    unittest.main()
