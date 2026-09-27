.pragma library

var ACTIVE_BORDER_KEYWORD = "rgba(eafbffff) rgba(7fe0d4ff) 45deg"
var ACTIVE_BORDER_RAW = "ffeafbff ff7fe0d4 45deg"
var CALM_BACKGROUND = "01-nightsea-calm.png"

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function bool(value, fallback) {
  if (value === true || value === false) return value
  if (typeof value === "string") {
    var normalized = value.replace(/^\s+|\s+$/g, "").toLowerCase()
    if (normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "1") return true
    if (normalized === "false" || normalized === "no" || normalized === "off" || normalized === "0") return false
  }
  return fallback
}

function validGradient(raw) {
  return typeof raw === "string"
    && /^(?:[0-9a-fA-F]{8})(?: [0-9a-fA-F]{8})*(?: [0-9]+deg)?$/.test(raw)
}

function parseOptionJson(rawJson) {
  if (typeof rawJson !== "string" || rawJson === "") return null
  var parsed
  try {
    parsed = JSON.parse(rawJson)
  } catch (error) {
    return null
  }
  if (record(parsed).option !== "general:col.active_border" || !validGradient(parsed.gradient)) return null
  return {
    rawJson: rawJson,
    gradient: parsed.gradient,
    set: parsed.set === true
  }
}

function gradientToKeyword(raw) {
  if (!validGradient(raw)) return ""
  var parts = raw.split(" ")
  var converted = []
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (/^[0-9]+deg$/.test(part)) converted.push(part)
    else converted.push("rgba(" + part.substring(2) + part.substring(0, 2) + ")")
  }
  return converted.join(" ")
}

function keywordToGradient(keyword) {
  if (typeof keyword !== "string") return ""
  var parts = keyword.split(" ")
  var converted = []
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (/^[0-9]+deg$/.test(part)) {
      converted.push(part)
      continue
    }
    var match = /^rgba\(([0-9a-fA-F]{8})\)$/.exec(part)
    if (!match) return ""
    converted.push(match[1].substring(6) + match[1].substring(0, 6))
  }
  var raw = converted.join(" ")
  return validGradient(raw) ? raw : ""
}

function pluginSettings(config, pluginId) {
  var defaults = { ambientBorder: true, ambientOverlay: false, reduceMotion: false }
  var layout = record(record(config).bar).layout
  var groups = ["left", "center", "right"]
  for (var i = 0; i < groups.length; i++) {
    var entries = record(layout)[groups[i]]
    if (!Array.isArray(entries)) continue
    for (var j = 0; j < entries.length; j++) {
      var entry = record(entries[j])
      if (entry.id !== pluginId) continue
      return {
        ambientBorder: bool(entry.ambientBorder, defaults.ambientBorder),
        ambientOverlay: bool(entry.ambientOverlay, defaults.ambientOverlay),
        reduceMotion: bool(entry.reduceMotion, defaults.reduceMotion)
      }
    }
  }
  return defaults
}

function backgroundMatches(path) {
  if (typeof path !== "string") return false
  var clean = path.replace(/\/+$/, "")
  return clean.substring(clean.lastIndexOf("/") + 1) === CALM_BACKGROUND
}

function overlayMotion(enabled, storm, reduceMotion, fullscreen, backgroundPath) {
  return enabled === true && storm === true && reduceMotion !== true
    && fullscreen !== true && backgroundMatches(backgroundPath)
}

function parseManifest(rawJson) {
  var parsed
  try {
    parsed = JSON.parse(String(rawJson || ""))
  } catch (error) {
    return null
  }
  var manifest = record(parsed)
  var frame = record(manifest.frame)
  var layers = record(manifest.layers)
  var sequence = Array.isArray(manifest.sequence) ? manifest.sequence : []
  if (!(frame.width > 0) || !(frame.height > 0) || sequence.length === 0) return null
  var layerList = []
  for (var name in layers) {
    var layer = record(layers[name])
    if (typeof layer.file !== "string" || layer.file === ""
      || !isFinite(Number(layer.x)) || !isFinite(Number(layer.y))
      || !(Number(layer.width) > 0) || !(Number(layer.height) > 0)) return null
    layerList.push({
      name: name,
      file: layer.file,
      x: Number(layer.x),
      y: Number(layer.y),
      width: Number(layer.width),
      height: Number(layer.height)
    })
  }
  if (layerList.length === 0) return null
  return {
    frame: { width: Number(frame.width), height: Number(frame.height) },
    layers: layerList,
    sequence: sequence
  }
}

function phase(manifest, name) {
  var sequence = record(manifest).sequence
  if (!Array.isArray(sequence)) return null
  for (var i = 0; i < sequence.length; i++) {
    var entry = record(sequence[i])
    if (entry.phase === name && Array.isArray(entry.layers) && Number(entry.ms) >= 0) return entry
  }
  return null
}

function phaseHasLayer(manifest, phaseName, layerName) {
  var entry = phase(manifest, phaseName)
  return entry !== null && entry.layers.indexOf(layerName) >= 0
}

function phaseDuration(manifest, phaseName, fallback) {
  var entry = phase(manifest, phaseName)
  return entry === null ? fallback : Number(entry.ms)
}

function fullscreenMonitors(clients, monitors) {
  var result = {}
  var monitorNames = {}
  var monitorList = Array.isArray(monitors) ? monitors : []
  for (var i = 0; i < monitorList.length; i++) {
    var monitor = record(monitorList[i])
    monitorNames[String(monitor.id)] = String(monitor.name || "")
  }
  var clientList = Array.isArray(clients) ? clients : []
  for (var j = 0; j < clientList.length; j++) {
    var client = record(clientList[j])
    if (Number(client.fullscreen) <= 0 || client.mapped === false || client.hidden === true) continue
    var name = monitorNames[String(client.monitor)]
    if (name) result[name] = true
  }
  return result
}

var exportsObject = {
  ACTIVE_BORDER_KEYWORD: ACTIVE_BORDER_KEYWORD,
  ACTIVE_BORDER_RAW: ACTIVE_BORDER_RAW,
  CALM_BACKGROUND: CALM_BACKGROUND,
  bool: bool,
  validGradient: validGradient,
  parseOptionJson: parseOptionJson,
  gradientToKeyword: gradientToKeyword,
  keywordToGradient: keywordToGradient,
  pluginSettings: pluginSettings,
  backgroundMatches: backgroundMatches,
  overlayMotion: overlayMotion,
  parseManifest: parseManifest,
  phaseHasLayer: phaseHasLayer,
  phaseDuration: phaseDuration,
  fullscreenMonitors: fullscreenMonitors
}

if (typeof module !== "undefined" && module.exports) module.exports = exportsObject
