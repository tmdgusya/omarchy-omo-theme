#!/usr/bin/env bash
set -euo pipefail

id=io.github.tmdgusya.omo
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/plugin"
config="$HOME/.config/omarchy/shell.json"
plugins="$HOME/.config/omarchy/plugins"
target="$plugins/$id"
marker="$target/.omo-install.json"
checksums="$target/.omo-install.sha256"
top_bar=false

case "${1:-}" in
  "") ;;
  --top-bar) top_bar=true; shift ;;
  *) echo "Usage: $0 [--top-bar]" >&2; exit 2 ;;
esac
(( $# == 0 )) || { echo "Usage: $0 [--top-bar]" >&2; exit 2; }

[[ -f "$source_dir/manifest.json" ]] || { echo "Bundled plugin is incomplete: missing manifest.json" >&2; exit 1; }
jq -e --arg id "$id" '.id == $id' "$source_dir/manifest.json" >/dev/null ||
  { echo "Bundled plugin has the wrong id" >&2; exit 1; }
omarchy plugin validate "$source_dir"
[[ "$(omarchy-shell shell ping)" == ok ]] || { echo "Omarchy shell is not running" >&2; exit 1; }

installed=false
original_position=""
explicit_senpi_path=false
if [[ -e "$target" || -L "$target" ]]; then
  [[ -d "$target" && ! -L "$target" && -f "$marker" && -f "$checksums" ]] ||
    { echo "Refusing to overwrite unowned plugin: $target" >&2; exit 1; }
  jq -e --arg id "$id" '.id == $id and .schema == 1' "$marker" >/dev/null ||
    { echo "Refusing to overwrite unowned plugin: $target" >&2; exit 1; }
  (cd "$target" && sha256sum -c .omo-install.sha256 >/dev/null) ||
    { echo "Installed plugin was edited; refusing to overwrite it" >&2; exit 1; }
  installed=true
  original_position="$(jq -r '.originalPosition // ""' "$marker")"
fi

if [[ -f "$config" ]]; then
  jq -e '.version == 1' "$config" >/dev/null || { echo "Unsupported shell.json" >&2; exit 1; }
  if jq -e --arg id "$id" '
    any([.bar.layout.left[]?, .bar.layout.center[]?, .bar.layout.right[]?, .plugins[]?][];
      if type == "object" then .id == $id and has("senpiPath") else false end)
  ' "$config" >/dev/null; then
    explicit_senpi_path=true
  fi
  if [[ "$installed" == false ]] && jq -e --arg id "$id" '
    any([.bar.layout.left[]?, .bar.layout.center[]?, .bar.layout.right[]?, .plugins[]?][]; .id == $id)
  ' "$config" >/dev/null; then
    echo "Refusing to take ownership of an existing layout entry" >&2
    exit 1
  fi
fi

senpi_path="$(command -v senpi || true)"
if [[ "$senpi_path" == */* && -f "$senpi_path" && -x "$senpi_path" ]]; then
  senpi_path="$(realpath -e -- "$senpi_path")"
else
  senpi_path=""
fi

position="$(jq -r '.bar.position // "top"' "$config" 2>/dev/null || echo top)"
if [[ "$top_bar" == true && -z "$original_position" && "$position" != top ]]; then
  original_position="$position"
fi

mkdir -p -- "$plugins"
if [[ -f "$config" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$config.bak.omo.$stamp"
  n=1
  while [[ -e "$backup" ]]; do backup="$config.bak.omo.$stamp.$n"; ((n+=1)); done
  cp -p -- "$config" "$backup"
  printf 'Saved layout backup: %s\n' "$backup"
fi

staging="$(mktemp -d "$plugins/.omo-staging.XXXXXXXX")"
trap '[[ -d "$staging" ]] && rm -rf -- "$staging"' EXIT
cp -a -- "$source_dir/." "$staging/"
jq -n --arg id "$id" --arg position "$original_position" \
  '{schema: 1, id: $id, originalPosition: $position}' > "$staging/.omo-install.json"
(cd "$staging" && find . -type f ! -name '.omo-install.json' ! -name '.omo-install.sha256' -print0 |
  sort -z | xargs -0 -r sha256sum) > "$staging/.omo-install.sha256"
if [[ "$installed" == true ]]; then
  previous="$(mktemp -d "$plugins/.omo-previous.XXXXXXXX")"
  rmdir -- "$previous"
  mv -- "$target" "$previous"
  mv -- "$staging" "$target"
  printf 'Previous plugin retained: %s\n' "$previous"
else
  mv -- "$staging" "$target"
fi
omarchy-shell shell rescanPlugins
omarchy plugin validate "$target"
if [[ "$installed" == false ]]; then
  omarchy plugin enable "$id" --section left
fi
if [[ "$explicit_senpi_path" == false ]]; then
  if [[ -n "$senpi_path" ]]; then
    omarchy bar set "$id" senpiPath "$senpi_path"
  else
    echo "senpi was not found in the installer PATH; set the widget senpiPath to an absolute executable path for Launch." >&2
  fi
fi
if [[ "$top_bar" == true && "$position" != top ]]; then
  omarchy bar position top
fi
if [[ "$installed" == true ]]; then
  # Replacing a plugin directory does not invalidate loaded QML components.
  omarchy restart shell
fi
printf 'Installed %s\n' "$id"
