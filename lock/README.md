# OmO lock design (opt-in, Lock Screen Explorer)

`OmO.qml` is a custom design for the third-party **Lock Screen Explorer**
plugin (`io.github.sirjul1337.lock-explorer`). It is **not installed by
default** and nothing here loads until you copy the files and enable the
plugin yourself.

The default Omarchy lock stays the stock `LockView`; the theme's `[lock]`
tokens in `shell.toml` (Nightsea background, aqua-to-plate active border,
error red) already style it. This Explorer design adds the layout the stock
view cannot do: the moon cat at 28 % / x 28 %, a clock column on the right,
the password field floating 7 % above the lower edge, a whole-scene shake on
a wrong password, and the 400 ms `rise` unlock. All colours come from the
shell's `Color.lock.*` and `Style.*` tokens, so it follows theme changes.

> **Why opt-in:** lock-explorer was one of the suspects in the 2026-09-25
> 43 GB `omarchy-shell` memory incident and is disabled in `shell.json`.
> Enable it only if you accept that; the theme's installer refuses to do it
> for you without an explicit flag and a clean 24 h soak
> (`~/.local/state/omo/soak/latest.json`).

## Files

```
lock/OmO.qml                          the design (Explorer user-design API)
lock/omo-lock-assets/omo-cat-idle.svg   moon cat, ring eyes + m mouth
lock/omo-lock-assets/omo-cat-blink.svg  blink frame (closed eyes)
```

The SVGs are the exact OmO face paths (identical to
`plugin/assets/omo-cat-{idle,blink}.svg`), derived from the oh-my-openagent
OmO icon, and retain the upstream Sustainable Use License 1.0 — see
`LICENSE`. They are not covered by the plugin code's MIT grant.

## Enable (manual, reversible)

From the theme repository root:

```sh
mkdir -p ~/.config/omarchy/lock-designs
cp lock/OmO.qml ~/.config/omarchy/lock-designs/OmO.qml
cp -r lock/omo-lock-assets ~/.config/omarchy/lock-designs/

omarchy plugin enable io.github.sirjul1337.lock-explorer
omarchy-shell lock rescanDesigns
omarchy-shell lock setDesign my-omo          # OmO.qml scans in as "my-omo"
omarchy-shell lock setUnlockAnimation rise   # fade | zoom | rise | none
omarchy-shell lock setUnlockDuration 400     # ms
```

Preview without locking:

```sh
omarchy-shell lock previewDesign my-omo
omarchy-shell lock previewUnlock             # exercises the 400 ms rise
```

Notes:

- The design renders on every output. If you restrict Explorer to one input
  monitor, Explorer pins its built-in `companion` design on the others; keep
  the input monitor at `all` for a total look.
- The cat only breathes (1.5 %) and blinks while the display is lit; it says
  nothing about session state. A lock screen has no trustworthy signal, and
  the cat never lies.
- The boot-splash `unlock.png` / `preview-unlock.png` in the theme root are
  Plymouth assets consumed by `omarchy-plymouth-set-by-theme` (needs sudo) —
  unrelated to this design and never touched by it.

## Disable / uninstall

```sh
omarchy-shell lock setDesign <your-previous-design>   # or rescanDesigns + pick
omarchy plugin disable io.github.sirjul1337.lock-explorer
rm ~/.config/omarchy/lock-designs/OmO.qml
rm -r ~/.config/omarchy/lock-designs/omo-lock-assets
omarchy-shell lock rescanDesigns
```

Only the two copied paths are yours to remove; never delete other designs in
`~/.config/omarchy/lock-designs/`.
