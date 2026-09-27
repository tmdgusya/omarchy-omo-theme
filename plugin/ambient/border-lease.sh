#!/usr/bin/env bash
set -euo pipefail

readonly APPLIED_RAW='ffeafbff ff7fe0d4 45deg'
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-}"
readonly LEASE_PATH="${RUNTIME_DIR}/omo-ambient-lease.json"

fail() {
  printf 'border-lease: %s\n' "$*" >&2
  exit 1
}

valid_raw() {
  [[ ${1:-} =~ ^([[:xdigit:]]{8})(\ [[:xdigit:]]{8})*(\ [0-9]+deg)?$ ]]
}

current_raw() {
  local output raw
  output=$(hyprctl -j getoption general:col.active_border) || return 1
  raw=$(jq -er '.gradient | select(type == "string")' <<<"$output") || return 1
  valid_raw "$raw" || return 1
  printf '%s' "$raw"
}

raw_to_keyword() {
  local raw=$1 word output=()
  valid_raw "$raw" || return 1
  for word in $raw; do
    if [[ $word =~ ^[0-9]+deg$ ]]; then
      output+=("$word")
    else
      output+=("rgba(${word:2:6}${word:0:2})")
    fi
  done
  printf '%s' "${output[*]}"
}

raw_to_lua() {
  local raw=$1 word angle=0 colors=()
  valid_raw "$raw" || return 1
  for word in $raw; do
    if [[ $word =~ ^([0-9]+)deg$ ]]; then
      angle=${BASH_REMATCH[1]}
    else
      colors+=("\"rgba(${word:2:6}${word:0:2})\"")
    fi
  done
  if (( ${#colors[@]} == 1 )); then
    printf 'hl.config({ general = { ["col.active_border"] = %s } })' "${colors[0]}"
  else
    local joined
    joined=$(IFS=,; printf '%s' "${colors[*]}")
    printf 'hl.config({ general = { ["col.active_border"] = { colors = {%s}, angle = %s } } })' "$joined" "$angle"
  fi
}

set_border() {
  local raw=$1 keyword lua current
  keyword=$(raw_to_keyword "$raw") || return 1
  hyprctl keyword general:col.active_border "$keyword" >/dev/null 2>&1 || true
  current=$(current_raw 2>/dev/null || true)
  [[ $current == "$raw" ]] && return
  lua=$(raw_to_lua "$raw") || return 1
  hyprctl eval "$lua" >/dev/null 2>&1 || return 1
  current=$(current_raw 2>/dev/null || true)
  [[ $current == "$raw" ]]
}

read_lease() {
  [[ -f $LEASE_PATH ]] || return 1
  SAVED_RAW=$(jq -er '.savedRaw | select(type == "string")' "$LEASE_PATH") || return 1
  LEASE_APPLIED_RAW=$(jq -er '.appliedRaw | select(type == "string")' "$LEASE_PATH") || return 1
  valid_raw "$SAVED_RAW" && valid_raw "$LEASE_APPLIED_RAW"
}

write_lease() {
  local saved=$1 temporary="${LEASE_PATH}.$$"
  umask 077
  jq -n --arg savedRaw "$saved" --arg appliedRaw "$APPLIED_RAW" \
    '{savedRaw: $savedRaw, appliedRaw: $appliedRaw}' >"$temporary"
  mv -f "$temporary" "$LEASE_PATH"
}

apply_border() {
  local current saved
  current=$(current_raw) || fail "cannot read active border; lease skipped"
  saved=$current
  if read_lease; then
    if [[ $current == "$LEASE_APPLIED_RAW" ]]; then
      saved=$SAVED_RAW
    else
      rm -f "$LEASE_PATH"
    fi
  fi
  write_lease "$saved"
  if ! set_border "$APPLIED_RAW"; then
    rm -f "$LEASE_PATH"
    fail "runtime border apply failed"
  fi
  current=$(current_raw) || fail "applied border could not be verified; lease retained"
  [[ $current == "$APPLIED_RAW" ]] || fail "compositor returned an unexpected applied value; lease retained"
  printf '{"status":"applied","savedRaw":"%s","appliedRaw":"%s"}\n' "$saved" "$APPLIED_RAW"
}

restore_border() {
  local current
  [[ -f $LEASE_PATH ]] || {
    printf '{"status":"absent"}\n'
    return
  }
  read_lease || {
    rm -f "$LEASE_PATH"
    fail "invalid lease removed without changing the compositor"
  }
  current=$(current_raw) || fail "cannot read active border; lease retained"
  if [[ $current != "$LEASE_APPLIED_RAW" ]]; then
    rm -f "$LEASE_PATH"
    printf '{"status":"changed","currentRaw":"%s"}\n' "$current"
    return
  fi
  set_border "$SAVED_RAW" || fail "restore failed; lease retained"
  rm -f "$LEASE_PATH"
  printf '{"status":"restored","savedRaw":"%s"}\n' "$SAVED_RAW"
}

status() {
  local current
  current=$(current_raw) || fail "cannot read active border"
  if read_lease; then
    jq -n --arg currentRaw "$current" --arg savedRaw "$SAVED_RAW" \
      --arg appliedRaw "$LEASE_APPLIED_RAW" \
      '{status:"leased", currentRaw:$currentRaw, savedRaw:$savedRaw, appliedRaw:$appliedRaw}'
  else
    jq -n --arg currentRaw "$current" '{status:"unleased", currentRaw:$currentRaw}'
  fi
}

[[ -n $RUNTIME_DIR && -d $RUNTIME_DIR ]] || fail "XDG_RUNTIME_DIR is unavailable"
command -v hyprctl >/dev/null || fail "hyprctl is unavailable"
command -v jq >/dev/null || fail "jq is unavailable"

case ${1:-} in
  apply) apply_border ;;
  restore) restore_border ;;
  status) status ;;
  *) fail "usage: border-lease.sh apply|restore|status" ;;
esac
