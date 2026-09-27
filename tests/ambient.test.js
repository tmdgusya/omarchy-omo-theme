import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")
const fixturePath = join(here, "fixtures", "getoption-active-border.json")
const leaseScript = join(repo, "plugin", "ambient", "border-lease.sh")
const temporaryDirectories = []

function loadQmlLibrary(path) {
  const source = readFileSync(path, "utf8").replace(/^\.pragma library\s*/, "")
  const loaded = { exports: {} }
  new Function("module", "exports", source)(loaded, loaded.exports)
  return loaded.exports
}

const Lease = loadQmlLibrary(join(repo, "plugin", "ambient", "Lease.js"))
const Model = loadQmlLibrary(join(repo, "plugin", "Model.js"))

function createFakeHyprctl(initialBytes) {
  const directory = mkdtempSync(join(tmpdir(), "omo-ambient-test-"))
  temporaryDirectories.push(directory)
  const state = join(directory, "border.json")
  const original = join(directory, "original.json")
  const command = join(directory, "hyprctl")
  writeFileSync(state, initialBytes)
  writeFileSync(original, initialBytes)
  writeFileSync(command, `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1:-} == "-j" && \${2:-} == "getoption" ]]; then
  /usr/bin/cat "$OMO_FAKE_STATE"
  exit 0
fi
if [[ \${1:-} == "keyword" && \${2:-} == "general:col.active_border" ]]; then
  case \${3:-} in
    "rgba(eafbffff) rgba(7fe0d4ff) 45deg")
      printf '%s\\n' '{"option": "general:col.active_border", "gradient": "ffeafbff ff7fe0d4 45deg", "set": true }' >"$OMO_FAKE_STATE"
      ;;
    "rgba(7fe0d4ff) rgba(f4f4f4ff) 45deg")
      /usr/bin/cp "$OMO_FAKE_ORIGINAL" "$OMO_FAKE_STATE"
      ;;
    *) exit 9 ;;
  esac
  exit 0
fi
exit 8
`)
  chmodSync(command, 0o755)
  return { directory, state, original }
}

function runLease(fake, action) {
  return spawnSync("bash", [leaseScript, action], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fake.directory}:/usr/bin`,
      XDG_RUNTIME_DIR: fake.directory,
      OMO_FAKE_STATE: fake.state,
      OMO_FAKE_ORIGINAL: fake.original,
    },
  })
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

describe("active-border fixture", () => {
  test("round-trips the real hyprctl bytes and gradient encoding", () => {
    // Given: bytes captured from this machine's real hyprctl.
    const fixture = readFileSync(fixturePath, "utf8")

    // When: the QML-compatible extractor parses and converts the gradient.
    const parsed = Lease.parseOptionJson(fixture)
    const keyword = Lease.gradientToKeyword(parsed.gradient)
    const roundTrip = Lease.keywordToGradient(keyword)

    // Then: both the untouched JSON bytes and raw gradient are exact.
    expect(parsed.rawJson).toBe(fixture)
    expect(roundTrip).toBe(parsed.gradient)
    expect(keyword).toBe("rgba(7fe0d4ff) rgba(f4f4f4ff) 45deg")
  })

  test("rejects malformed compositor output instead of guessing", () => {
    // Given: syntactically valid JSON without a usable Hyprland gradient.
    const malformed = '{"option":"general:col.active_border","gradient":"not-a-gradient"}\n'

    // When: the boundary parser reads it.
    const parsed = Lease.parseOptionJson(malformed)

    // Then: lease 2 is skipped.
    expect(parsed).toBeNull()
    expect(Lease.gradientToKeyword("not-a-gradient")).toBe("")
  })
})

describe("storm and overlay gates", () => {
  test("requires a verified working runtime and in-progress ultrawork together", () => {
    // Given: the four nearby runtime/ledger combinations.
    const live = { kind: "live", working: true, status: "working" }
    const idle = { kind: "idle", working: false, status: "idle" }
    const inProgress = { passed: 0, total: 2, status: "in_progress" }

    // When: Model.js alone interprets each session.
    const states = [
      Model.sessionState({ runtime: live, ulw: inProgress }, 0),
      Model.sessionState({ runtime: live, ulw: null }, 0),
      Model.sessionState({ runtime: idle, ulw: inProgress }, 0),
      Model.sessionState({ runtime: { kind: "unknown", working: true }, ulw: inProgress }, 0),
    ]

    // Then: only the verified conjunction is Storm.
    expect(states).toEqual(["ultrawork", "working", "idle", "unknown"])
  })

  test("stops motion for every required boundary", () => {
    // Given: a fully enabled Storm on the calm background.
    const calm = "/theme/backgrounds/04-nightsea-calm.png"

    // When/Then: each single stop input independently forces motion false.
    expect(Lease.overlayMotion(true, true, false, false, calm)).toBe(true)
    expect(Lease.overlayMotion(true, false, false, false, calm)).toBe(false)
    expect(Lease.overlayMotion(true, true, true, false, calm)).toBe(false)
    expect(Lease.overlayMotion(true, true, false, true, calm)).toBe(false)
    expect(Lease.overlayMotion(true, true, false, false, "/theme/backgrounds/02-nightsea-storm.png")).toBe(false)
    expect(Lease.overlayMotion(false, true, false, false, calm)).toBe(false)
  })

  test("keeps overlay off by default and reads explicit bar settings", () => {
    // Given: no plugin entry, then a string-valued installed entry.
    const empty = {}
    const configured = {
      bar: { layout: { left: [{ id: "io.github.tmdgusya.omo", ambientBorder: "false", ambientOverlay: "true", reduceMotion: "yes" }] } },
    }

    // When: shell.json settings cross the boundary.
    const defaults = Lease.pluginSettings(empty, "io.github.tmdgusya.omo")
    const explicit = Lease.pluginSettings(configured, "io.github.tmdgusya.omo")

    // Then: lease 3 is default-off and booleans remain deterministic.
    expect(defaults).toEqual({ ambientBorder: true, ambientOverlay: false, reduceMotion: false })
    expect(explicit).toEqual({ ambientBorder: false, ambientOverlay: true, reduceMotion: true })
  })

  test("derives fullscreen monitor names from compositor snapshots", () => {
    // Given: one fullscreen client on monitor id 7 and one ordinary client.
    const clients = [
      { monitor: 7, fullscreen: 1, mapped: true, hidden: false },
      { monitor: 8, fullscreen: 0, mapped: true, hidden: false },
    ]
    const monitors = [{ id: 7, name: "DP-1" }, { id: 8, name: "HDMI-A-1" }]

    // When: the snapshot is reduced.
    const covered = Lease.fullscreenMonitors(clients, monitors)

    // Then: only the covered output stops.
    expect(covered).toEqual({ "DP-1": true })
  })
})

describe("manifest contract", () => {
  test("uses runtime offsets and phase membership without hardcoding geometry", () => {
    // Given: a minimal valid lane-A manifest with deliberately unusual offsets.
    const raw = JSON.stringify({
      frame: { width: 320, height: 180 },
      layers: { glow: { file: "glow.png", x: 17, y: 23, width: 91, height: 77 } },
      sequence: [{ phase: "working", layers: ["glow"], ms: 2400 }],
    })

    // When: the runtime parser consumes it.
    const manifest = Lease.parseManifest(raw)

    // Then: geometry and timing come from the file.
    expect(manifest.frame).toEqual({ width: 320, height: 180 })
    expect(manifest.layers[0]).toEqual({ name: "glow", file: "glow.png", x: 17, y: 23, width: 91, height: 77 })
    expect(Lease.phaseHasLayer(manifest, "working", "glow")).toBe(true)
    expect(Lease.phaseDuration(manifest, "working", 0)).toBe(2400)
  })
})

describe("border lease process", () => {
  test("applies and restores the captured bytes exactly", () => {
    // Given: a fake compositor initialized from the real fixture.
    const original = readFileSync(fixturePath)
    const fake = createFakeHyprctl(original)

    // When: the true edge applies and the false edge restores.
    const applied = runLease(fake, "apply")
    const restored = runLease(fake, "restore")

    // Then: the original bytes return and the lease is gone.
    expect(applied.status).toBe(0)
    expect(restored.status).toBe(0)
    expect(readFileSync(fake.state)).toEqual(original)
    expect(existsSync(join(fake.directory, "omo-ambient-lease.json"))).toBe(false)
  })

  test("does not overwrite a border changed by another owner", () => {
    // Given: an active lease followed by a foreign compositor change.
    const original = readFileSync(fixturePath)
    const fake = createFakeHyprctl(original)
    expect(runLease(fake, "apply").status).toBe(0)
    const foreign = '{"option":"general:col.active_border","gradient":"ff112233","set":true}\n'
    writeFileSync(fake.state, foreign)

    // When: the false edge attempts restoration.
    const restored = runLease(fake, "restore")

    // Then: the foreign value survives and only the lease disappears.
    expect(restored.status).toBe(0)
    expect(restored.stdout).toContain('"status":"changed"')
    expect(readFileSync(fake.state, "utf8")).toBe(foreign)
    expect(existsSync(join(fake.directory, "omo-ambient-lease.json"))).toBe(false)
  })
})
