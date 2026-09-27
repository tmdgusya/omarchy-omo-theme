# OmO lock design (opt-in, Lock Screen Explorer)

`OmO.qml` is a custom design for the third-party **Lock Screen Explorer**
plugin (`io.github.sirjul1337.lock-explorer`). It is **not installed by
default** and nothing here loads until you copy the files and enable the
plugin yourself.

The default Omarchy lock stays the stock `LockView`; the theme's `[lock]`
tokens in `shell.toml` style it. This Explorer design is the DESIGN-v3 sleep
state, which the stock view cannot draw:

- the `-m-` sleep face (closed-line eyes, `m` mouth) on its plate squircle,
  centred, 128 px;
- the face table's line **자리 비우셔도 돼요.** (Noto Sans CJK KR, 20 px);
- the time as `HH:mm` plus the Korean weekday (`17:25 일`, mono 14 px);
- a 1 px monoline squircle password field (`비밀번호`) and a 12 px hint:
  `Enter를 누르면 열려요.`, `센서를 터치하거나 Enter를 누르세요.` with a
  fingerprint reader, `N번 틀렸어요.` after a wrong password.

Nothing loops: a locked screen is the sleep state, so the face stays still and
the lock idles at 0 fps. The only motion is the host's scene shake on a wrong
password and its unlock transition. All colours come from the shell's
`Color.lock.*` tokens and all sizes from `Style.*`, so it follows theme
changes. Strings the host draws itself (PAM messages, `Checking…`, the power
buttons) stay the Explorer's.

> **Why opt-in:** lock-explorer was one of the suspects in the 2026-09-25
> 43 GB `omarchy-shell` memory incident and is disabled in `shell.json`.
> Enable it only if you accept that; the theme's installer refuses to do it
> for you without an explicit flag and a clean 24 h soak
> (`~/.local/state/omo/soak/latest.json`).

## Files

```
lock/OmO.qml                             the design (Explorer user-design API)
lock/omo-lock-assets/omo-face-sleep.svg  sleep face on its plate squircle
```

`omo-face-sleep.svg` is a copy of `plugin/assets/face/omo-face-sleep.svg`
(the DESIGN-v3 face asset); the design is copied out of the repository on
install, so it carries its own copy. Keep the two identical. The face is
derived from the oh-my-openagent OmO icon and retains the upstream
Sustainable Use License 1.0 — see `LICENSE`. It is not covered by the plugin
code's MIT grant.

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
omarchy-shell lock setUnlockDuration 280     # ms, what scripts/install-lock.sh applies
```

Preview without locking:

```sh
omarchy-shell lock previewDesign my-omo
omarchy-shell lock previewUnlock             # exercises the unlock transition
```

Notes:

- The design renders on every output. If you restrict Explorer to one input
  monitor, Explorer pins its built-in `companion` design on the others; keep
  the input monitor at `all` for a total look.
- The face says nothing about session state. A lock screen has no
  trustworthy signal, and the cat never lies: it only sleeps.
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
