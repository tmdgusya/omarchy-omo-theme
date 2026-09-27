# OmO theme for Omarchy 4

![OmO Nightsea wallpaper](preview.png)

A quiet deep-teal desktop with the OmO moon cat, an ultrawork lightning
accent, and a native session panel. The cat moves only for verified work;
progress means completed tasks and verified criteria, not a guessed ETA.

![Native session panel with isolated demonstration sessions](docs/session-panel.png)

This repository is an Omarchy 4 Quickshell theme. Its native theme slug is
`omo`; the optional bundled bar widget has ID `io.github.tmdgusya.omo`.
The theme lives at the repository root, while `plugin/` is copied separately.
The plugin bundle includes the bar/panel plus two keep-loaded native services:
verified session notifications and the Ambient Storm controller. The active
border effect is enabled by default; the wallpaper overlay remains **off by
default** and is opt-in from the OmO menu or plugin settings.
Omarchy's `plugin add` expects a plugin manifest at the **repository root**,
so do not use `omarchy plugin add` with this theme repository URL.

The wallpapers are `01-nightsea-calm.png` (default and live-overlay base),
`02-nightsea-storm.png` (static poster and preview), and
`03-nightsea-open.png` (cat-free open sea). `unlock.png` and
`preview-unlock.png` are Plymouth assets; installation never invokes the
sudo-requiring Plymouth command.

## Requirements and installation

Omarchy 4 with its running Quickshell shell, `git`, `jq`, `sha256sum`, Bash,
and Python 3 for the widget's local session collector are required.
For the Launch action, install `omo` or `senpi` and Ghostty separately. This project
does not modify personal Ghostty or Hyprland configuration.

```sh
omarchy theme install https://github.com/tmdgusya/omarchy-omo-theme.git
omarchy theme set omo
bash "$HOME/.config/omarchy/themes/omo/scripts/install-plugin.sh"
bash "$HOME/.config/omarchy/themes/omo/scripts/install-menu.sh"
bash "$HOME/.config/omarchy/themes/omo/scripts/install-pi-theme.sh"
```

The installer requires `plugin/manifest.json` and its QML entry point in the
cloned theme; it stops before changing configuration if either is missing.
It validates the bundled plugin, copies it to
`~/.config/omarchy/plugins/io.github.tmdgusya.omo/`, rescans, validates the
copy, and enables only that widget in the left bar section. It prints a
timestamped `shell.json` backup before the first change. A preexisting plugin
directory not marked as ours is never overwritten. Re-running updates only an
unmodified owned copy; it does not move a widget already in the layout.
Updated copies of the previous plugin remain under `.omo-previous.*` for
manual recovery. Updating an existing copy restarts the Omarchy shell so its
QML components use the new files; open shell panels briefly close.
The plugin installer also copies the owned `art/layers/` set required by the
default-off overlay. Both trees use ownership markers and checksums; modified
or foreign destinations are refused.

`install-menu.sh` merges only the five `omo.*` keys into
`~/.config/omarchy/extensions/omarchy-menu.jsonc`. It uses the same JSONC
contract as the host instead of passing the file through standard JSON, keeps
comments and `remote.*` entries, writes a timestamped backup, and records the
owned values. Removal refuses an edited owned key and never restores a whole
config over unrelated changes.

`install-pi-theme.sh` copies `pi.json` to
`${SENPI_CODING_AGENT_DIR:-~/.omo/agent}/themes/omo-nightsea.json` and selects
only the `theme` setting. Senpi prefers `settings.jsonc` when it exists, so the
installer does too and preserves its comments. Removal restores the prior
theme only while the current value is still the installer-applied
`omo-nightsea`; a later user choice wins. Use `omo --use-theme omo-nightsea`
for a one-off run without changing settings.

For Launch, the installer prefers `omo` in its invocation PATH, falls back to
`senpi`, and saves its absolute path in `launcherPath`. The older `senpiPath`
setting remains available for existing panel integrations and is preserved on
updates. If neither command is found, installation prints a notice. Set the
absolute path manually if necessary:

```sh
omarchy bar set io.github.tmdgusya.omo launcherPath "$(command -v omo)"
```

Run that command in an environment where `command -v omo` finds the desired
executable. Launch passes the setting as a direct Ghostty argv element, along
with `-e` for the installed `omo-status.ts` when global tracking is not enabled;
it does not invoke a login shell.

**Recommended: track all OmO sessions, not only bar-launched sessions:**

```sh
bash "$HOME/.config/omarchy/themes/omo/scripts/install-plugin.sh" --track-all-sessions
```

This registers the copied `omo-status.ts` using `senpi install` in
`SENPI_CODING_AGENT_DIR` (or `~/.omo/agent`) and records the exact source and
agent directory in `.omo-install.json`. Future sessions using that agent
directory load it automatically. Existing sessions can run `/reload` without
restarting; Senpi fires `session_start` with reason `reload`. Removal
unregisters only the recorded source. Re-running the installer preserves
tracking even if the flag is omitted.

**Optional top bar, explicitly requested only:**

```sh
bash "$HOME/.config/omarchy/themes/omo/scripts/install-plugin.sh" --top-bar
```

This changes only bar position via `omarchy bar position top`. The default
installation preserves bar position, transparency, other widgets, disabled
plugins, and existing widget settings. Removal restores the previous
position only if it is still `top`; a later change to another position wins.
Backups are kept, never applied wholesale on removal.

## Opt-in features

The Storm wallpaper overlay is intentionally not enabled by any installer.
Toggle it from the installed OmO menu or set it explicitly:

```sh
omarchy bar set io.github.tmdgusya.omo ambientOverlay true --json
```

It renders only during a verified live ultrawork state and stops for reduced
motion, fullscreen, a non-calm wallpaper, or service shutdown.

The custom `lock/OmO.qml` design is also opt-in and requires the separately
installed `io.github.sirjul1337.lock-explorer` plugin. It is gated by a clean
24 hour shell soak because that plugin was implicated in an earlier memory
incident. The soak tool does not wait or poll: start it, continue using the
desktop normally, and finish it after at least 24 hours. Finish succeeds only
for the same live process and RSS growth no greater than 150 MiB.

```sh
bash "$HOME/.config/omarchy/themes/omo/scripts/soak-shell.sh" start
# at least 24 hours later:
bash "$HOME/.config/omarchy/themes/omo/scripts/soak-shell.sh" finish
bash "$HOME/.config/omarchy/themes/omo/scripts/install-lock.sh" --lock-explorer
```

The receipt is written to `~/.local/state/omo/soak/latest.json`. A successful
lock install copies only `OmO.qml` and `omo-lock-assets/`, then selects
`my-omo`, `rise`, and 400 ms. Its marker records the prior Explorer enabled
state and settings. Uninstall restores only values that still equal the
installer-applied values; edited files are never deleted.

## Update and removal

The Omarchy theme installer deletes a same-slug theme directory before
recloning it. Check for local edits before using it to update; a local Git
checkout can instead be updated with the user's chosen Git workflow. After
the theme's files have been updated, re-run `scripts/install-plugin.sh` to
refresh the bundled plugin. `omarchy plugin update` does not update this
locally copied plugin. If its installed files were edited, the script refuses
to replace them; save or reconcile those changes first.

```sh
bash "$HOME/.config/omarchy/themes/omo/scripts/uninstall-lock.sh"  # if installed
bash "$HOME/.config/omarchy/themes/omo/scripts/uninstall-pi-theme.sh"
bash "$HOME/.config/omarchy/themes/omo/scripts/uninstall-menu.sh"
bash "$HOME/.config/omarchy/themes/omo/scripts/uninstall-plugin.sh"
omarchy theme set matte-black
omarchy theme current
omarchy theme remove omo
```

Select and verify another installed theme **before** removing `omo`. The
uninstaller disables only its widget (if enabled), then uses `omarchy plugin
remove ... --yes`. Omarchy retains a backup of manually installed plugins.
Neither script deletes unrelated layout entries, other plugins, extension
folders, or user configuration. The lock uninstaller is only applicable after
the opt-in lock installer; the default installation creates no lock design.

## Optional senpi session state

Without live evidence the widget never claims a session is working. Sessions
with user/assistant activity in the last ten minutes are `recent` (unverified
and never animated); older sessions remain `unknown`. The optional
`plugin/omo-status.ts` extension supplies process-bound session state using
private, local-only metadata under `XDG_RUNTIME_DIR/omo-session-state/`:
session ID, PID, process start tick, state, and waiting flag. No prompt,
transcript, or credential is sent anywhere by this metadata. It requires a
private runtime directory. Without global tracking, the supported load
mechanism is an explicit per-process `-e` with the installed plugin copy:

```sh
SENPI_CODING_AGENT_DIR="$HOME/.omo/agent" \
  senpi -e "$HOME/.config/omarchy/plugins/io.github.tmdgusya.omo/omo-status.ts"
```

Without the tracking option the copied extension is loaded only when passed
to a new process. A session started without it can become tracked after
`/reload` once global registration is installed.
Launch uses the same agent directory as the collector: the widget's
`agentDir` override, then `SENPI_CODING_AGENT_DIR` or `OMO_CODING_AGENT_DIR`,
then `~/.omo/agent`. It does not silently open a separate empty senpi profile.
Turn events update a private revision signal watched by the bar, so short
turns do not have to wait for the background polling interval.
Omarchy syncs its generated `pi.json` to `~/.pi/agent`, not senpi's
`~/.omo/agent`; use `install-pi-theme.sh` for the explicit, reversible Senpi
copy. This theme installs no background synchronization hook.

The model exposes focus for a uniquely verified Hyprland window, resume for
an ended or old unverified session, and a blocked result for a verified
running session without a window or a recent unverified session. A blocked
session must never spawn a second writer. Details reads a bounded session
summary, Launch requires Ghostty and the configured launcher,
and Dismiss acknowledges a displayed error. A goal marked in progress does
not by itself prove that a session is working.

## Development checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v
bun test tests/model.test.js
omarchy plugin validate plugin
bash -n scripts/*.sh
```

The tests use isolated fixtures; desktop visual checks still require the
real Omarchy shell. To rebuild the wallpapers, install Bun, ImageMagick and
`rsvg-convert`, then run `bun art/build-wallpapers.mjs --render`.

## Attribution and license

Original code and theme configuration are MIT licensed. The OmO icon and
cat-derived wallpaper/SVG assets retain the upstream Sustainable Use License
1.0, including its non-commercial distribution conditions. `LICENSE` lists
the affected files and reproduces both sets of terms.

The OmO cat icon reference in `art/reference/omo-icon-light.svg` comes from
[code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/.github/assets/omo-icon-light.svg).
That repository's [LICENSE.md](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/LICENSE.md)
identifies its own content as subject to the Sustainable Use License 1.0,
with separately licensed third-party components. See `LICENSE` for the
original terms and attribution; this repository does not claim the icon is
MIT, public domain, or owned by this theme.
