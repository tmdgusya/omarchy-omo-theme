# Verification

Verified on Omarchy 4.0.0.alpha, Quickshell 0.3.1 and Hyprland 0.56.2.

- Python collector/installer tests: 25 passed.
- Bun UI model tests: 34 passed.
- Native plugin validation, Bash syntax and Git whitespace checks passed.
- Wallpaper rebuild reproduced both installed PNGs byte-for-byte.
- TypeScript extension diagnostics were clean. Python and Bash language
  servers were unavailable; their executable checks passed. QML lint has
  the same unresolved dynamic token warnings as first-party shell widgets;
  actual native loading and interaction were tested.

## Real desktop checks

The installed widget was exercised in the real compositor, not a browser mock.
Checks covered empty roots, malformed records, two independent working and
waiting sessions, dead/reused PIDs, long Korean titles, actual TODO/criteria
counts, Details, keyboard selection, scrolling, Escape, and both bar positions.
Controlled QA sessions were isolated and clearly labeled; the README panel
image shows those demonstration sessions, not private user records.

The live extension was also loaded through the widget's actual Ghostty Launch
action. Real model requests produced idle -> working -> idle -> ended events.
Eight compositor frames captured the working cat and active count. Separate
controlled ultrawork fixtures exercised lightning and glow while working.

Layout captures were inspected at 1920x1080 scale 1 and, using a temporary
named headless output, 2560x1440 scale 1.6. The temporary output was removed.
Original bar position, display state and unrelated settings were restored.
Temporary processes, fixture directories and runtime records were removed.

Actual installation, update, removal and reinstallation succeeded. Updates
restart the shell to invalidate loaded QML; removing the widget preserved
unrelated settings. Personal Ghostty and Hyprland configuration stayed intact.

## Known host behavior

Changing bar position live can briefly report duplicate IPC handlers, including
first-party widgets. A shell restart clears the transient registration. No
remaining session-list parent-null warnings were observed after the fix.

Existing OmO sessions started without the optional live-state extension remain
explicitly unverified. Details is a bounded summary, not a transcript browser;
Focus is not offered without a proven window mapping.
