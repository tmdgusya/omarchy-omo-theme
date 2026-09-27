#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
designs="$HOME/.config/omarchy/lock-designs"
marker="$designs/.omo-lock-install.json"
config="$HOME/.config/omarchy/shell.json"
plugin_id=io.github.sirjul1337.lock-explorer

[[ -f "$marker" && ! -L "$marker" && -f "$config" && ! -L "$config" ]] ||
  { echo "No owned OmO lock design; nothing removed" >&2; exit 1; }
jq -e '.schema == 1 and .id == "omo-lock" and (.files | type == "object")' "$marker" >/dev/null ||
  { echo "Invalid lock design ownership marker" >&2; exit 1; }
while IFS=$'\t' read -r relative expected; do
  installed="$designs/$relative"
  [[ -f "$installed" && ! -L "$installed" &&
    "$(sha256sum "$installed" | cut -d' ' -f1)" == "$expected" ]] ||
    { echo "Installed lock design was edited: $relative" >&2; exit 1; }
done < <(jq -r '.files | to_entries[] | [.key,.value] | @tsv' "$marker")

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$config.bak.omo.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$config.bak.omo.$stamp.$n"; ((n+=1)); done
cp -p -- "$config" "$backup"
printf 'Saved shell settings backup: %s\n' "$backup"

current_disabled="$(jq -r --arg id "$plugin_id" '.disabledPlugins // [] | index($id) != null' "$config")"
if [[ "$(jq -r '.priorDisabled' "$marker")" == true ]]; then
  if [[ "$current_disabled" == false ]]; then
    omarchy plugin disable "$plugin_id"
  fi
elif [[ "$(jq -r '.settingsOwned' "$marker")" == true && "$current_disabled" == false ]]; then
  temporary="$(mktemp "$(dirname "$config")/.omo-shell.XXXXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  jq --arg id "$plugin_id" --slurpfile marker "$marker" '
    ($marker[0]) as $m |
    .plugins |= map(
      if .id != $id then .
      elif .design == $m.applied.design and
           .unlock == $m.applied.unlock and
           .unlockMs == $m.applied.unlockMs then
        reduce ["design","unlock","unlockMs"][] as $key (.;
          if $m.previous[$key].exists then
            .[$key] = $m.previous[$key].value
          else
            del(.[$key])
          end)
      else .
      end)
  ' "$config" >"$temporary"
  chmod --reference="$config" "$temporary"
  mv -f -- "$temporary" "$config"
fi

rm -- "$designs/OmO.qml"
rm -rf -- "$designs/omo-lock-assets"
rm -- "$marker"
if [[ "$current_disabled" == false ]]; then
  omarchy-shell lock rescanDesigns
fi
printf 'Removed owned OmO lock design and restored owned settings\n'
