#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$root/scripts/jsonc-edit.py"
source_file="$root/pi.json"
agent_dir="${SENPI_CODING_AGENT_DIR:-${OMO_CODING_AGENT_DIR:-$HOME/.omo/agent}}"
themes="$agent_dir/themes"
target="$themes/omo-nightsea.json"
# Senpi loads every *.json under themes/ as a theme, so the ownership marker
# lives beside it in the agent directory. Older installs kept it in themes/,
# where Senpi reported it as an invalid theme; move such a marker once.
marker="$agent_dir/omo-nightsea.omo-install.json"
legacy_marker="$themes/omo-nightsea.omo-install.json"
if [[ -f "$legacy_marker" && ! -L "$legacy_marker" ]]; then
  if [[ ! -e "$marker" ]]; then
    mv -- "$legacy_marker" "$marker"
  elif cmp -s -- "$legacy_marker" "$marker"; then
    rm -- "$legacy_marker"
  else
    echo "Two different Senpi theme ownership markers exist: $marker and $legacy_marker" >&2
    exit 1
  fi
fi
if [[ -f "$agent_dir/settings.jsonc" ]]; then
  settings="$agent_dir/settings.jsonc"
else
  settings="$agent_dir/settings.json"
fi

[[ "$agent_dir" == /* ]] || { echo "Agent directory must be absolute" >&2; exit 1; }
[[ -f "$source_file" && -x "$helper" ]] ||
  { echo "Bundled Senpi theme installer is incomplete" >&2; exit 1; }
jq -e '.name == "omo-nightsea" and (.colors | type == "object")' "$source_file" >/dev/null ||
  { echo "Bundled pi.json is not the omo-nightsea theme" >&2; exit 1; }
[[ ! -e "$settings" || (-f "$settings" && ! -L "$settings") ]] ||
  { echo "Refusing to edit non-regular Senpi settings: $settings" >&2; exit 1; }
[[ ! -e "$target" || (-f "$target" && ! -L "$target") ]] ||
  { echo "Refusing to overwrite non-regular Senpi theme: $target" >&2; exit 1; }

setting_owned=true
settings_created=false
base_text=null
if [[ -e "$target" || -e "$marker" ]]; then
  [[ -f "$target" && ! -L "$target" && -f "$marker" && ! -L "$marker" ]] ||
    { echo "Refusing to overwrite an unowned Senpi theme" >&2; exit 1; }
  jq -e --arg target "$target" --arg settings "$settings" '
    .schema == 1 and .id == "omo-nightsea" and .target == $target and
    .settingsPath == $settings and (.installedSha256 | type == "string")
  ' "$marker" >/dev/null || { echo "Invalid Senpi theme ownership marker" >&2; exit 1; }
  [[ "$(sha256sum "$target" | cut -d' ' -f1)" == "$(jq -r '.installedSha256' "$marker")" ]] ||
    { echo "Installed Senpi theme was edited; refusing to overwrite it" >&2; exit 1; }
  previous_theme="$(jq -c '.previousTheme' "$marker")"
  setting_owned="$(jq -r '.settingOwned' "$marker")"
  settings_created="$(jq -r '.settingsCreated' "$marker")"
  if [[ "$setting_owned" == true ]]; then
    current="$(python3 "$helper" state "$settings" '["theme"]')"
    if ! jq -e '.theme.exists == true and .theme.value == "omo-nightsea"' <<<"$current" >/dev/null; then
      setting_owned=false
    fi
  fi
  if [[ -f "$settings" ]] &&
    [[ "$(sha256sum "$settings" | cut -d' ' -f1)" == "$(jq -r '.installedSettingsSha256 // ""' "$marker")" ]]; then
    base_text="$(jq -c '.baseText' "$marker")"
  fi
else
  if [[ -f "$settings" ]]; then
    previous_theme="$(python3 "$helper" state "$settings" '["theme"]' | jq -c '.theme')"
    base_text="$(jq -Rs . <"$settings")"
  else
    previous_theme='{"exists":false,"value":null}'
    settings_created=true
    base_text='""'
  fi
fi

mkdir -p -- "$themes"
if [[ "$setting_owned" == true ]]; then
  if [[ -f "$settings" ]]; then
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    backup="$settings.bak.omo.$stamp"
    n=1
    while [[ -e "$backup" ]]; do backup="$settings.bak.omo.$stamp.$n"; ((n+=1)); done
    cp -p -- "$settings" "$backup"
    printf 'Saved Senpi settings backup: %s\n' "$backup"
  fi
  python3 "$helper" merge "$settings" '{"theme":"omo-nightsea"}'
fi

temporary_theme="$(mktemp "$themes/.omo-nightsea.XXXXXXXX")"
temporary_marker="$(mktemp "$agent_dir/.omo-nightsea-marker.XXXXXXXX")"
trap 'rm -f -- "$temporary_theme" "$temporary_marker"' EXIT
cp -- "$source_file" "$temporary_theme"
chmod 644 "$temporary_theme"
installed_hash="$(sha256sum "$temporary_theme" | cut -d' ' -f1)"
settings_hash=""
[[ -f "$settings" ]] && settings_hash="$(sha256sum "$settings" | cut -d' ' -f1)"
jq -n --arg target "$target" --arg settings "$settings" --arg hash "$installed_hash" \
  --arg settingsHash "$settings_hash" --argjson previous "$previous_theme" \
  --argjson owned "$setting_owned" --argjson created "$settings_created" \
  --argjson base "$base_text" \
  '{schema:1,id:"omo-nightsea",target:$target,settingsPath:$settings,
    installedSha256:$hash,installedSettingsSha256:$settingsHash,
    previousTheme:$previous,appliedTheme:"omo-nightsea",settingOwned:$owned,
    settingsCreated:$created,baseText:$base}' >"$temporary_marker"
chmod 600 "$temporary_marker"
mv -f -- "$temporary_theme" "$target"
mv -f -- "$temporary_marker" "$marker"
if [[ "$setting_owned" == true ]]; then
  printf 'Installed and selected Senpi theme omo-nightsea\n'
else
  printf 'Updated Senpi theme; preserved the user-selected theme\n'
fi
