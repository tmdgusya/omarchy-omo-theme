#!/usr/bin/env bash
# Install the OmO launcher keybinding (SUPER+ALT+O -> omoLauncher toggle) as
# one owned, marked block appended to ~/.config/hypr/bindings.lua.
# Refuses when SUPER+ALT+O is already bound in the user or Omarchy default
# Hyprland config, writes a timestamped backup, then reloads Hyprland.
# Test mode: OMO_HYPR_DIR (user hypr dir) set -> no reload;
# OMO_HYPR_DEFAULT_DIR overrides the Omarchy defaults directory.
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
hypr_dir="${OMO_HYPR_DIR:-$HOME/.config/hypr}"
default_dir="${OMO_HYPR_DEFAULT_DIR:-/usr/share/omarchy/default/hypr}"
target="$hypr_dir/bindings.lua"

[[ -f "$target" && ! -L "$target" ]] ||
  { echo "Refusing: $target is missing or not a regular file" >&2; exit 1; }

# rg -L follows the symlinked config files Omarchy uses.
dirs=()
for dir in "$hypr_dir" "$default_dir"; do [[ -d "$dir" ]] && dirs+=("$dir"); done
candidates="$(rg -L --no-heading -n -i -e 'bind' -- "${dirs[@]}" 2>/dev/null || true)"

python3 - "$target" "$candidates" <<'PY'
import re
import sys

BEGIN = "-- >>> omo-launcher keybind (owned by omarchy-omo-theme; remove with scripts/uninstall-keybind.sh)"
END = "-- <<< omo-launcher keybind <<<"
BIND = 'o.bind("SUPER + ALT + O", "OmO", "omarchy-shell omoLauncher toggle")'
target, candidates = sys.argv[1], sys.argv[2]

with open(target, encoding="utf-8", newline="") as handle:
    text = handle.read()
if BEGIN in text or END in text:
    print("OmO keybinding already installed", file=sys.stderr)
    sys.exit(3)


def combo(keys):
    tokens = [t for t in re.split(r"[\s+,]+", keys.strip().upper()) if t]
    alias = {"MOD4": "SUPER", "WIN": "SUPER", "LOGO": "SUPER", "MOD1": "ALT", "OPTION": "ALT"}
    return sorted(alias.get(t, t) for t in tokens)


WANT = combo("SUPER ALT O")
lua = re.compile(r"""\bbind\w*\s*\(\s*(["'])(.*?)\1""")
hyprlang = re.compile(r"^\s*bind\w*\s*=\s*([^,]*),\s*([^,]+),")
conflicts = []
for line in candidates.splitlines():
    location, _, code = line.partition(":")
    lineno, _, code = code.partition(":")
    body = code.strip()
    if body.startswith("--") or body.startswith("#") or "unbind" in body:
        continue
    keys = None
    m = lua.search(body)
    if m:
        keys = m.group(2)
    else:
        m = hyprlang.match(body)
        if m:
            keys = m.group(1) + " " + m.group(2)
    if keys is not None and combo(keys) == WANT:
        conflicts.append(f"{location}:{lineno}: {body}")
if conflicts:
    print("Refusing: SUPER+ALT+O is already bound:", file=sys.stderr)
    for entry in conflicts:
        print("  " + entry, file=sys.stderr)
    sys.exit(4)
PY

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$target.bak.omo.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$target.bak.omo.$stamp.$n"; ((n+=1)); done
cp -p -- "$target" "$backup"
printf 'Saved bindings backup: %s\n' "$backup"

python3 - "$target" <<'PY'
import os
import sys
import tempfile

BEGIN = "-- >>> omo-launcher keybind (owned by omarchy-omo-theme; remove with scripts/uninstall-keybind.sh)"
END = "-- <<< omo-launcher keybind <<<"
BIND = 'o.bind("SUPER + ALT + O", "OmO", "omarchy-shell omoLauncher toggle")'
target = sys.argv[1]
with open(target, encoding="utf-8", newline="") as handle:
    text = handle.read()
# A missing final newline is recorded in the marker so uninstall can restore
# the file byte for byte.
pad = "" if text == "" or text.endswith("\n") else "\n"
begin = BEGIN + (" pad=1" if pad else "") + " >>>"
block = f"{pad}\n{begin}\n{BIND}\n{END}\n"
directory = os.path.dirname(os.path.abspath(target))
fd, temporary = tempfile.mkstemp(prefix=".omo-keybind.", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
        handle.write(text + block)
    os.chmod(temporary, os.stat(target).st_mode & 0o7777)
    os.replace(temporary, target)
except BaseException:
    os.unlink(temporary)
    raise
PY
printf 'Installed OmO keybinding: SUPER+ALT+O -> omarchy-shell omoLauncher toggle\n'

if [[ -z "${OMO_HYPR_DIR:-}" ]] && command -v hyprctl >/dev/null 2>&1; then
  hyprctl reload >/dev/null || echo "hyprctl reload failed; reload Hyprland manually" >&2
fi
