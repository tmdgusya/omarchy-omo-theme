# OmO v3 design contract — "the icon becomes the desktop"

Binding contract for every v3 lane. Source of truth for tokens, faces, copy,
motion, and bar geometry. The reference is the official icon
`omo-icon-light.svg` (https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/.github/assets/omo-icon-light.svg):
one ink cat head on a light squircle plate, one white inner monoline that wraps
the face like a hood, ring eyes and a small `m` that spell "OmO", flat two-tone.

## Philosophy (owner's words, keep visible in every surface)

- ultrawork lets anyone get work done easily.
- Anyone can open and use OmO easily — one key, one sentence.
- Cute overall; Apple-level smoothness.
- The cute ultrawork lightning is visible in the bar.

## Tokens

| Token | Value | Use |
|---|---|---|
| plate | `#F4F4F4` | squircle plates, cat face fill, primary light surface |
| ink | `#041617` | cat silhouette, text on plate |
| monoline | `#F4F4F4` on ink, `#041617` on plate, 1 logical px | borders, inner face line, ring markers |
| backdrop | `#0B1B1D` (Nightsea bg), `#071416` darker | desktop and panel backdrop only |
| aqua | `#7FE0D4` | ONLY working / verified ultrawork |
| amber | `#F2D38B` | ONLY human decision needed (waiting) |
| coral | `#F08A8A` | ONLY error / blocked |
| muted | `#5F7A7B` | secondary text |

Rest state is two-tone (plate + ink). A color appears only when a state earns it.

## Shape language

- Squircle = continuous-corner rounded rect; radius = 22.5% of the short side
  (icon ratio). Every cell, card, plate, and hover highlight is a squircle.
- 1 logical px monoline outlines; never drop shadows.
- Ring (`O`) is the marker: empty ring = available, filled ring = active,
  ring with dot = has windows/attention.
- Never add props to the cat (no glasses, books, clipboards). Variation is
  expression only (eyes/mouth) plus an outside caption or badge.

## Faces (state vocabulary)

Graphic faces are the official silhouette with inner monoline kept; only eyes
and mouth change. Every frame, including running frames, keeps ring eyes.

| State | Text face | Graphic eyes / mouth | Korean copy | Accent |
|---|---|---|---|---|
| idle (sessions exist, none running) | `OmO` | rings / m | 할 일을 말하세요. | none |
| sleep (zero sessions) | `-m-` | closed lines / m | 자리 비우셔도 돼요. | none |
| working | `OmO` | rings / m, run cycle | 일하는 중이에요. | aqua |
| ultrawork (verified) | `OmO⚡` | rings / m + bolt at ear | ultrawork · 끝날 때까지 가요. | aqua |
| waiting | `OmO?` | rings looking up / small o | 결정 하나 필요해요. | amber |
| done | `^m^` | arcs / m | 다 됐어요. 확인만 하세요. | none (one aqua blink) |
| error | `>m<` | chevrons / m | 여기서 막혔어요. | coral |

Face asset contract (produced by the art lane, consumed by bar/panel/notify/lock):
`plugin/assets/face/omo-face-{idle,sleep,working,ultrawork,waiting,done,error}.svg`
(viewBox 0 0 64 64, face on squircle plate) and
`plugin/assets/face/omo-head-{idle,sleep,waiting,done,error}.svg` (head only,
transparent, viewBox 0 0 64 64). Must stay legible at 20 logical px
(32 physical at scale 1.6): ring eye inner hole >= 3px at 20px.

## Voice

Korean 해요체, short, dry, no exclamation marks. English only in identifiers.
Numbers are mono. Actions: 열기, 상세, 새로 시작, 닫기.

## Typography

- Mono (`bar.fontFamily`, JetBrainsMono Nerd Font) for faces, counts, time.
- Sans `"Noto Sans CJK KR"` for Korean copy.
- Sizes: 11 / 12 / 14 / 20 logical px only. Weights: 400 / 500 / 700.

## Motion

- Input feedback 120–180 ms; state change 220–320 ms; reward (done blink,
  ultrawork strike) 450–700 ms once.
- Enter OutCubic, exit InCubic; position moves may use a short spring.
- Interrupt from the current value; never restart from frame 0.
- reduceMotion: every loop becomes a still face; transitions become opacity only.
- Idle = 0 fps. Loops step from Timers, never always-on NumberAnimations.
- At most one looping animation on screen.

## Bar geometry

- Top preset (default): bar height 32 logical px. Left preset: width 36.
- 4 px grid; icon box 20 px; cell inset 6 px; hover plate = squircle ink-on-backdrop at 10% plate.
- Left section: OmO menu button (squircle plate face) · ring workspaces · cat cell.
- Center: OmO clock (`HH:mm` mono + small Korean weekday, e.g. `15:57 일`).
- Right: tray (pinned 2 + overflow ring) · system widgets.
- Cat cell: face 20 px + count (mono 12). Top preset may add one line of copy
  from the face table when a session is working/waiting/error.

## Session panel

Three sections: 진행 중 / 결정 필요 / 완료 (plus collapsed 이전 기록).
One card per session: face 24 px, title (sans), project + age (muted mono),
progress = todo and verified-criteria counts (never guessed). Primary action
열기 (focus existing window, or resume ended), secondary 상세. Header button
새로 시작. Empty state: sleep face + "할 일을 말하세요." + 새로 시작 button.
No fake/disabled buttons.

## Launcher (SUPER+ALT+O)

One-line input overlay, centered, squircle plate card: face + placeholder
"할 일을 말하세요." Enter with text runs `omo "<text>"` (argument passed as one
argv element, never shell-interpolated) in Ghostty; Enter empty runs `omo`;
Escape closes. Keybinding is installed by default by an owned, reversible
installer into `~/.config/hypr/bindings.lua`.

## Wallpaper

Bright icon tone over the Nightsea backdrop: the plate-white official cat plus
2–4 small decorative cats (same silhouette, expression-only variation,
sleeping/stretching/peeking), left third calm for terminals. Storm stays a
separate reward layer. Default wallpaper sorts first.
