#!/usr/bin/env bash
set -euo pipefail

state_dir="${OMO_SOAK_STATE_DIR:-$HOME/.local/state/omo/soak}"
pending="$state_dir/pending.json"
receipt="$state_dir/latest.json"
required_seconds=86400
max_delta_kib=153600
proc_root="${OMO_SOAK_PROC_ROOT:-/proc}"

usage() {
  echo "Usage: $0 start [PID] | finish | status" >&2
  exit 2
}

now_epoch() {
  if [[ -n "${OMO_SOAK_NOW_EPOCH:-}" ]]; then
    printf '%s\n' "$OMO_SOAK_NOW_EPOCH"
  else
    date +%s
  fi
}

process_start_ticks() {
  local pid=$1 stat
  stat="$(<"$proc_root/$pid/stat")"
  stat="${stat##*) }"
  awk '{print $20}' <<<"$stat"
}

process_rss_kib() {
  local pid=$1
  awk '/^VmRSS:/ {print $2; found=1} END {if (!found) exit 1}' "$proc_root/$pid/status"
}

case "${1:-}" in
  start)
    (( $# <= 2 )) || usage
    pid="${2:-${OMO_SOAK_PID:-}}"
    if [[ -z "$pid" ]]; then
      pid="$(pgrep -n -x quickshell || true)"
    fi
    [[ "$pid" =~ ^[0-9]+$ && -r "$proc_root/$pid/stat" && -r "$proc_root/$pid/status" ]] ||
      { echo "A live quickshell PID is required" >&2; exit 1; }
    mkdir -p -- "$state_dir"
    temporary="$(mktemp "$state_dir/.pending.XXXXXXXX")"
    trap 'rm -f -- "$temporary"' EXIT
    jq -n --argjson now "$(now_epoch)" --argjson pid "$pid" \
      --argjson ticks "$(process_start_ticks "$pid")" \
      --argjson rss "$(process_rss_kib "$pid")" \
      '{schema:1,startedAtEpoch:$now,pid:$pid,processStartTicks:$ticks,rssStartKiB:$rss}' \
      >"$temporary"
    chmod 600 "$temporary"
    mv -f -- "$temporary" "$pending"
    rm -f -- "$receipt"
    printf 'Started Omarchy shell soak for PID %s\n' "$pid"
    ;;
  finish)
    (( $# == 1 )) || usage
    [[ -f "$pending" && ! -L "$pending" ]] ||
      { echo "No pending shell soak; run start first" >&2; exit 1; }
    jq -e '.schema == 1 and (.pid | type == "number")' "$pending" >/dev/null ||
      { echo "Invalid pending soak state" >&2; exit 1; }
    pid="$(jq -r '.pid' "$pending")"
    [[ -r "$proc_root/$pid/stat" && -r "$proc_root/$pid/status" ]] ||
      { echo "The observed shell process is no longer alive" >&2; exit 1; }
    start_ticks="$(jq -r '.processStartTicks' "$pending")"
    [[ "$(process_start_ticks "$pid")" == "$start_ticks" ]] ||
      { echo "The shell PID was reused; soak failed" >&2; exit 1; }
    now="$(now_epoch)"
    started="$(jq -r '.startedAtEpoch' "$pending")"
    duration=$((now - started))
    (( duration >= required_seconds )) ||
      { echo "Soak is only ${duration}s; 86400s is required" >&2; exit 1; }
    rss_start="$(jq -r '.rssStartKiB' "$pending")"
    rss_end="$(process_rss_kib "$pid")"
    rss_delta=$((rss_end - rss_start))
    (( rss_delta <= max_delta_kib )) ||
      { echo "Shell RSS grew ${rss_delta} KiB; limit is ${max_delta_kib} KiB" >&2; exit 1; }
    temporary="$(mktemp "$state_dir/.receipt.XXXXXXXX")"
    trap 'rm -f -- "$temporary"' EXIT
    jq -n --argjson started "$started" --argjson finished "$now" \
      --argjson duration "$duration" --argjson pid "$pid" --argjson ticks "$start_ticks" \
      --argjson rssStart "$rss_start" --argjson rssEnd "$rss_end" \
      --argjson delta "$rss_delta" --argjson maximum "$max_delta_kib" \
      '{schema:1,startedAtEpoch:$started,finishedAtEpoch:$finished,
        durationSeconds:$duration,pid:$pid,processStartTicks:$ticks,
        rssStartKiB:$rssStart,rssEndKiB:$rssEnd,rssDeltaKiB:$delta,
        maxRssDeltaKiB:$maximum,shellAlive:true,passed:true}' >"$temporary"
    chmod 600 "$temporary"
    mv -f -- "$temporary" "$receipt"
    rm -- "$pending"
    printf 'Wrote passing soak receipt: %s\n' "$receipt"
    ;;
  status)
    (( $# == 1 )) || usage
    if [[ -f "$receipt" ]]; then
      jq . "$receipt"
    elif [[ -f "$pending" ]]; then
      jq . "$pending"
    else
      echo "No soak state" >&2
      exit 1
    fi
    ;;
  *) usage ;;
esac
