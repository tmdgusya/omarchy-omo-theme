#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$root/scripts/jsonc-edit.py"
agent_dir="${SENPI_CODING_AGENT_DIR:-${OMO_CODING_AGENT_DIR:-$HOME/.omo/agent}}"
target="$agent_dir/themes/omo-nightsea.json"
marker="$agent_dir/omo-nightsea.omo-install.json"
# Installs made before the marker left themes/ still keep it there.
legacy_marker="$agent_dir/themes/omo-nightsea.omo-install.json"
if [[ ! -e "$marker" ]]; then
  marker="$legacy_marker"
elif [[ -f "$legacy_marker" && ! -L "$legacy_marker" ]]; then
  cmp -s -- "$legacy_marker" "$marker" ||
    { echo "Two different Senpi theme ownership markers exist: $marker and $legacy_marker" >&2; exit 1; }
  rm -- "$legacy_marker"
fi

[[ -f "$target" && ! -L "$target" && -f "$marker" && ! -L "$marker" ]] ||
  { echo "No owned Senpi theme installation; nothing removed" >&2; exit 1; }
settings="$(jq -r '.settingsPath' "$marker")"
jq -e --arg target "$target" '
  .schema == 1 and .id == "omo-nightsea" and .target == $target and
  (.previousTheme.exists | type == "boolean")
' "$marker" >/dev/null || { echo "Invalid Senpi theme ownership marker" >&2; exit 1; }
[[ "$(sha256sum "$target" | cut -d' ' -f1)" == "$(jq -r '.installedSha256' "$marker")" ]] ||
  { echo "Installed Senpi theme was edited; refusing to remove it" >&2; exit 1; }
[[ ! -e "$settings" || (-f "$settings" && ! -L "$settings") ]] ||
  { echo "Refusing to edit non-regular Senpi settings: $settings" >&2; exit 1; }

restore=false
if [[ "$(jq -r '.settingOwned' "$marker")" == true && -f "$settings" ]]; then
  current="$(python3 "$helper" state "$settings" '["theme"]')"
  jq -e '.theme.exists == true and .theme.value == "omo-nightsea"' <<<"$current" >/dev/null &&
    restore=true
fi
if [[ "$restore" == true ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$settings.bak.omo.$stamp"
  n=1
  while [[ -e "$backup" ]]; do backup="$settings.bak.omo.$stamp.$n"; ((n+=1)); done
  cp -p -- "$settings" "$backup"
  printf 'Saved Senpi settings backup: %s\n' "$backup"
  current_hash="$(sha256sum "$settings" | cut -d' ' -f1)"
  if [[ "$current_hash" == "$(jq -r '.installedSettingsSha256' "$marker")" ]] &&
    jq -e '.baseText != null' "$marker" >/dev/null; then
    if [[ "$(jq -r '.settingsCreated' "$marker")" == true ]]; then
      rm -- "$settings"
    else
      temporary="$(mktemp "$(dirname "$settings")/.omo-settings.XXXXXXXX")"
      trap 'rm -f -- "$temporary"' EXIT
      jq -j '.baseText' "$marker" >"$temporary"
      chmod --reference="$settings" "$temporary"
      mv -f -- "$temporary" "$settings"
    fi
  elif [[ "$(jq -r '.previousTheme.exists' "$marker")" == true ]]; then
    previous="$(jq -c '{theme:.previousTheme.value}' "$marker")"
    python3 "$helper" merge "$settings" "$previous"
  else
    python3 "$helper" remove "$settings" '["theme"]'
  fi
fi
rm -- "$target" "$marker"
if [[ "$restore" == true ]]; then
  printf 'Removed Senpi theme and restored the prior selection\n'
else
  printf 'Removed Senpi theme; preserved the current user selection\n'
fi
