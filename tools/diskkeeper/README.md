# OmO diskkeeper

OmO tidies your disk every day and reports to you — part of the
[OmO Omarchy theme](../../README.md), installed by `scripts/install.sh` (opt out with
`--no-diskkeeper`).

Every morning at 10:30, OmO scans your home for **cold, large files** (untouched for
14+ days), moves them to your archive disk, and leaves a **symlink at the original
path** — so everything keeps working exactly where it was. A cat-faced notification
summarizes the day; click it for the full report.

## Safety model (read this once)

- The archive disk is pinned by **UUID**. If the disk is not mounted, OmO does
  nothing except tell you it's resting today.
- Per file/directory: copy → fsync → **sha256 verified on both sides** → only then
  is the original deleted and replaced by a symlink. There is **no code path that
  deletes an original without a verified copy**.
- Only whitelisted directories are ever touched. Files in active use are skipped.
- Per-run caps (50 GB, 200 units) and a 20 GB free-space reserve on the target.
- Every move is recorded in `~/.local/state/omo-diskkeeper/index.jsonl`, so
  `restore` can always bring things back, and dangling symlinks are healed
  automatically after the archive disk remounts somewhere else.
- It ships in **proposal mode**: nothing moves until you say `go`.

## Commands

```sh
bun ~/omarchy-omo-theme/tools/diskkeeper/src/cli.ts status          # mode, disk, archived stats
bun ~/omarchy-omo-theme/tools/diskkeeper/src/cli.ts setup           # pick the archive disk
bun ~/omarchy-omo-theme/tools/diskkeeper/src/cli.ts go              # proposal → execute mode
bun ~/omarchy-omo-theme/tools/diskkeeper/src/cli.ts restore <path>  # undo a move
bun ~/omarchy-omo-theme/tools/diskkeeper/src/cli.ts scan            # run once now (proposal)
```

If the `senpi` CLI is available, the daily report is written by OmO itself in full
cat personality; otherwise a plain template report is used.

## Configuration

`~/.config/omo-diskkeeper/config.json` — whitelist, size/age thresholds, caps,
report language (`ko`/`en`), and the archive disk UUID. Defaults are conservative;
the whitelist decides what may ever move.
