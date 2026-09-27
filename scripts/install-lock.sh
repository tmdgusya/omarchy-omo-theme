#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "--lock-explorer" && $# == 1 ]] ||
  { echo "Usage: $0 --lock-explorer" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_qml="$root/lock/OmO.qml"
source_assets="$root/lock/omo-lock-assets"
designs="$HOME/.config/omarchy/lock-designs"
target_qml="$designs/OmO.qml"
target_assets="$designs/omo-lock-assets"
marker="$designs/.omo-lock-install.json"
config="$HOME/.config/omarchy/shell.json"
receipt="${OMO_SOAK_RECEIPT:-$HOME/.local/state/omo/soak/latest.json}"
plugin_id=io.github.sirjul1337.lock-explorer
plugin="$HOME/.config/omarchy/plugins/$plugin_id"
now="${OMO_SOAK_NOW_EPOCH:-$(date +%s)}"

[[ -f "$source_qml" && -d "$source_assets" ]] ||
  { echo "Bundled lock design is incomplete" >&2; exit 1; }
[[ -f "$plugin/manifest.json" ]] ||
  { echo "Lock Screen Explorer is not installed" >&2; exit 1; }
jq -e --arg id "$plugin_id" '.id == $id' "$plugin/manifest.json" >/dev/null ||
  { echo "Unexpected Lock Screen Explorer manifest" >&2; exit 1; }
[[ -f "$receipt" && ! -L "$receipt" ]] ||
  { echo "A passing 24 h shell soak receipt is required" >&2; exit 1; }
jq -e --argjson now "$now" '
  .schema == 1 and .passed == true and .shellAlive == true and
  .durationSeconds >= 86400 and .rssDeltaKiB <= 153600 and
  .maxRssDeltaKiB == 153600 and .finishedAtEpoch <= $now
' "$receipt" >/dev/null || { echo "Soak receipt does not satisfy the lock gate" >&2; exit 1; }
[[ -f "$config" && ! -L "$config" ]] ||
  { echo "Missing regular shell.json" >&2; exit 1; }
jq -e '.version == 1' "$config" >/dev/null || { echo "Unsupported shell.json" >&2; exit 1; }

if [[ -e "$marker" || -e "$target_qml" || -e "$target_assets" ]]; then
  [[ -f "$marker" && ! -L "$marker" && -f "$target_qml" && ! -L "$target_qml" &&
    -d "$target_assets" && ! -L "$target_assets" ]] ||
    { echo "Refusing to overwrite an unowned lock design" >&2; exit 1; }
  jq -e '.schema == 1 and .id == "omo-lock" and (.files | type == "object")' "$marker" >/dev/null ||
    { echo "Invalid lock design ownership marker" >&2; exit 1; }
  while IFS=$'\t' read -r relative expected; do
    installed="$designs/$relative"
    [[ -f "$installed" && ! -L "$installed" &&
      "$(sha256sum "$installed" | cut -d' ' -f1)" == "$expected" ]] ||
      { echo "Installed lock design was edited: $relative" >&2; exit 1; }
  done < <(jq -r '.files | to_entries[] | [.key,.value] | @tsv' "$marker")
  previous="$(jq -c '.previous' "$marker")"
  prior_disabled="$(jq -r '.priorDisabled' "$marker")"
  settings_owned="$(jq -r '.settingsOwned' "$marker")"
else
  for destination in "$target_qml" "$target_assets"; do
    [[ ! -e "$destination" && ! -L "$destination" ]] ||
      { echo "Refusing to claim existing lock design files" >&2; exit 1; }
  done
  prior_disabled="$(jq -r --arg id "$plugin_id" '.disabledPlugins // [] | index($id) != null' "$config")"
  previous="$(jq -c --arg id "$plugin_id" '
    ([.plugins[]? | select(.id == $id)][0] // {}) as $entry |
    {design:{exists:($entry|has("design")),value:($entry.design // null)},
     unlock:{exists:($entry|has("unlock")),value:($entry.unlock // null)},
     unlockMs:{exists:($entry|has("unlockMs")),value:($entry.unlockMs // null)}}
  ' "$config")"
  settings_owned=true
fi

mkdir -p -- "$designs"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$config.bak.omo.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$config.bak.omo.$stamp.$n"; ((n+=1)); done
cp -p -- "$config" "$backup"
printf 'Saved shell settings backup: %s\n' "$backup"
rm -rf -- "$target_assets"
cp -- "$source_qml" "$target_qml"
cp -a -- "$source_assets" "$target_assets"

files="$(find "$target_assets" -type f -printf '%P\n' | sort |
  while IFS= read -r relative; do
    jq -cn --arg key "omo-lock-assets/$relative" \
      --arg value "$(sha256sum "$target_assets/$relative" | cut -d' ' -f1)" '{key:$key,value:$value}'
  done | jq -sc --arg qml "$(sha256sum "$target_qml" | cut -d' ' -f1)" '
    from_entries + {"OmO.qml":$qml}
  ')"
temporary="$(mktemp "$designs/.omo-lock-marker.XXXXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
jq -n --argjson previous "$previous" --argjson disabled "$prior_disabled" \
  --argjson owned "$settings_owned" --argjson files "$files" \
  '{schema:1,id:"omo-lock",priorDisabled:$disabled,previous:$previous,
    applied:{design:"my-omo",unlock:"rise",unlockMs:280},
    settingsOwned:$owned,files:$files}' >"$temporary"
chmod 600 "$temporary"
mv -f -- "$temporary" "$marker"

if [[ "$prior_disabled" == true ]] &&
  jq -e --arg id "$plugin_id" '.disabledPlugins // [] | index($id) != null' "$config" >/dev/null; then
  omarchy plugin enable "$plugin_id"
fi
if [[ "$settings_owned" == true ]]; then
  omarchy-shell lock rescanDesigns
  omarchy-shell lock setDesign my-omo
  omarchy-shell lock setUnlockAnimation rise
  omarchy-shell lock setUnlockDuration 280
fi
printf 'Installed opt-in OmO lock design\n'
