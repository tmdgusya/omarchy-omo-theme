#!/usr/bin/env bash
# Remove exactly the owned OmO launcher block from ~/.config/hypr/bindings.lua
# (restoring the file byte for byte when nothing else changed), keep a
# timestamped backup, then reload Hyprland. OMO_HYPR_DIR set = test mode.
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
hypr_dir="${OMO_HYPR_DIR:-$HOME/.config/hypr}"
target="$hypr_dir/bindings.lua"

[[ -f "$target" && ! -L "$target" ]] ||
  { echo "Refusing: $target is missing or not a regular file" >&2; exit 1; }

python3 - "$target" <<'PY'
import sys

BEGIN = "-- >>> omo-launcher keybind (owned by omarchy-omo-theme; remove with scripts/uninstall-keybind.sh)"
END = "-- <<< omo-launcher keybind <<<"
BIND = 'o.bind("SUPER + ALT + O", "OmO", "omarchy-shell omoLauncher toggle")'
with open(sys.argv[1], encoding="utf-8", newline="") as handle:
    text = handle.read()
blocks = [f"\n{BEGIN} >>>\n{BIND}\n{END}\n", f"\n\n{BEGIN} pad=1 >>>\n{BIND}\n{END}\n"]
if sum(text.count(block) for block in blocks) != 1:
    print("No unmodified owned OmO keybinding block; nothing removed", file=sys.stderr)
    sys.exit(1)
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
padded = f"\n\n{BEGIN} pad=1 >>>\n{BIND}\n{END}\n"
plain = f"\n{BEGIN} >>>\n{BIND}\n{END}\n"
# pad=1 means install added the newline the original file lacked.
text = text.replace(padded, "", 1) if padded in text else text.replace(plain, "", 1)
fd, temporary = tempfile.mkstemp(prefix=".omo-keybind.", dir=os.path.dirname(os.path.abspath(target)))
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.chmod(temporary, os.stat(target).st_mode & 0o7777)
    os.replace(temporary, target)
except BaseException:
    os.unlink(temporary)
    raise
PY
printf 'Removed owned OmO keybinding\n'

if [[ -z "${OMO_HYPR_DIR:-}" ]] && command -v hyprctl >/dev/null 2>&1; then
  hyprctl reload >/dev/null || echo "hyprctl reload failed; reload Hyprland manually" >&2
fi
