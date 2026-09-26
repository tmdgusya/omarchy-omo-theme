# OmO theme for Omarchy 4

![OmO Nightsea wallpaper](preview.png)

A quiet deep-teal desktop with the OmO moon cat, an ultrawork lightning
accent, and a native session panel. The cat moves only for verified work;
progress means completed tasks and verified criteria, not a guessed ETA.

![Native session panel with isolated demonstration sessions](docs/session-panel.png)

This repository is an Omarchy 4 Quickshell theme. Its native theme slug is
`omo`; the optional bundled bar widget has ID `io.github.tmdgusya.omo`.
The theme lives at the repository root, while `plugin/` is copied separately.
Omarchy's `plugin add` expects a plugin manifest at the **repository root**,
so do not use `omarchy plugin add` with this theme repository URL.

## Requirements and installation

Omarchy 4 with its running Quickshell shell, `git`, `jq`, `sha256sum`, Bash,
and Python 3 for the widget's local session collector are required.
For the Launch action, install `senpi` and Ghostty separately. This project
does not modify personal Ghostty or Hyprland configuration.

```sh
omarchy theme install https://github.com/tmdgusya/omarchy-omo-theme.git
omarchy theme set omo
bash "$HOME/.config/omarchy/themes/omo/scripts/install-plugin.sh"
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

For Launch, the installer looks up `senpi` in its invocation PATH and saves
the resolved absolute executable path in the widget's `senpiPath` setting via
`omarchy bar set`. An existing `senpiPath` is preserved on updates. If senpi
is not found, installation prints a notice and leaves the default `senpi`
name, which requires senpi to be on the desktop shell PATH. Set the absolute
path manually if necessary:

```sh
omarchy bar set io.github.tmdgusya.omo senpiPath "$(command -v senpi)"
```

Run that command in an environment where `command -v senpi` finds the desired
executable. Launch passes the setting as a direct Ghostty argv element, along
with `-e` for the installed `omo-status.ts`; it does not invoke a login shell.

**Optional top bar, explicitly requested only:**

```sh
bash "$HOME/.config/omarchy/themes/omo/scripts/install-plugin.sh" --top-bar
```

This changes only bar position via `omarchy bar position top`. The default
installation preserves bar position, transparency, other widgets, disabled
plugins, and existing widget settings. Removal restores the previous
position only if it is still `top`; a later change to another position wins.
Backups are kept, never applied wholesale on removal.

## Update and removal

The Omarchy theme installer deletes a same-slug theme directory before
recloning it. Check for local edits before using it to update; a local Git
checkout can instead be updated with the user's chosen Git workflow. After
the theme's files have been updated, re-run `scripts/install-plugin.sh` to
refresh the bundled plugin. `omarchy plugin update` does not update this
locally copied plugin. If its installed files were edited, the script refuses
to replace them; save or reconcile those changes first.

```sh
bash "$HOME/.config/omarchy/themes/omo/scripts/uninstall-plugin.sh"
omarchy theme set matte-black
omarchy theme current
omarchy theme remove omo
```

Select and verify another installed theme **before** removing `omo`. The
uninstaller disables only its widget (if enabled), then uses `omarchy plugin
remove ... --yes`. Omarchy retains a backup of manually installed plugins.
Neither script deletes unrelated layout entries, other plugins, extension
folders, or user configuration.

## Optional senpi session state

Without live evidence the widget must show session runtime as `unknown`,
not infer it from a recent transcript, goal, or todo. The optional
`plugin/omo-status.ts` extension supplies process-bound session state using
private, local-only metadata under `XDG_RUNTIME_DIR/omo-session-state/`:
session ID, PID, process start tick, state, and waiting flag. No prompt,
transcript, or credential is sent anywhere by this metadata. It applies only
to newly launched senpi processes and requires a private runtime directory.
The supported load mechanism is an explicit per-process `-e` with the
installed plugin copy. The widget's Launch action uses this same path:

```sh
SENPI_CODING_AGENT_DIR="$HOME/.omo/agent" \
  senpi -e "$HOME/.config/omarchy/plugins/io.github.tmdgusya.omo/omo-status.ts"
```

The extension is copied with the bundled plugin, but is loaded only when
passed to a new senpi process. The installer does not modify global senpi
configuration or copy it to a guessed persistent extension directory.
The `senpi -e` path was verified in a real Ghostty-launched senpi process:
session state transitioned from idle to live, back to idle, then ended on
shutdown. Existing sessions started without `-e` remain `unknown`; this
extension cannot retroactively supply their live state.
Launch uses the same agent directory as the collector: the widget's
`agentDir` override, then `SENPI_CODING_AGENT_DIR` or `OMO_CODING_AGENT_DIR`,
then `~/.omo/agent`. It does not silently open a separate empty senpi profile.
Turn events update a private revision signal watched by the bar, so short
turns do not have to wait for the background polling interval.
Omarchy syncs its generated `pi.json` to `~/.pi/agent`, not senpi's
`~/.omo/agent`; this theme installs no synchronization hook.

The widget does not implement Resume, session deletion, or broad bar resets.
Focus is available only when a window-to-session mapping can be established;
Details reads a bounded session summary, Launch requires Ghostty and senpi,
and Dismiss acknowledges a displayed error. A goal marked in progress does
not by itself prove that a session is working.

## Development checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v
bun test tests/model.test.js
omarchy plugin validate plugin
bash -n scripts/install-plugin.sh scripts/uninstall-plugin.sh
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
