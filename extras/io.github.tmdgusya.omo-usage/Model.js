.pragma library

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0))
}

function parseSnapshot(text) {
  try {
    var raw = JSON.parse(String(text || ""))
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.providers))
      return { ok: false, error: "We couldn't read the usage format." }
    return {
      ok: true,
      snapshot: {
        generatedAt: String(raw.generatedAt || ""),
        providers: raw.providers,
        error: String(raw.error || "")
      }
    }
  } catch (error) {
    return { ok: false, error: "We couldn't read the usage response." }
  }
}

function primaryLimit(provider) {
  var limits = provider && provider.quota && Array.isArray(provider.quota.limits)
    ? provider.quota.limits : []
  var selected = null
  for (var i = 0; i < limits.length; i++) {
    if (!selected || Number(limits[i].usedPercent) > Number(selected.usedPercent))
      selected = limits[i]
  }
  return selected
}

function highestUsage(providers) {
  var list = Array.isArray(providers) ? providers : []
  var highest = null
  for (var i = 0; i < list.length; i++) {
    var limit = primaryLimit(list[i])
    if (limit && (!highest || Number(limit.usedPercent) > Number(highest.usedPercent)))
      highest = limit
  }
  return highest
}

function percent(value) {
  return Math.round(clamp(value, 0, 100)) + "%"
}

function countdown(resetAtMs, nowMs) {
  var remaining = Number(resetAtMs) - Number(nowMs)
  if (!isFinite(remaining) || remaining <= 0) return "Resetting soon"
  var minutes = Math.floor(remaining / 60000)
  var days = Math.floor(minutes / 1440)
  var hours = Math.floor((minutes % 1440) / 60)
  var mins = minutes % 60
  if (days > 0) return days + "d " + hours + "h"
  if (hours > 0) return hours + "h " + mins + "m"
  return mins + "m"
}

function tokenCount(value) {
  var amount = Math.max(0, Number(value) || 0)
  if (amount >= 1000000000) return (amount / 1000000000).toFixed(1).replace(/\.0$/, "") + "B"
  if (amount >= 1000000) return (amount / 1000000).toFixed(1).replace(/\.0$/, "") + "M"
  if (amount >= 1000) return (amount / 1000).toFixed(1).replace(/\.0$/, "") + "K"
  return String(Math.round(amount))
}

function accountText(provider) {
  var accounts = provider && provider.accounts ? provider.accounts : {}
  var total = Number(accounts.total) || 0
  var text = total + (total === 1 ? " account" : " accounts")
  if ((Number(accounts.blocked) || 0) > 0) text += " \u00b7 " + accounts.blocked + " blocked"
  return text
}

function quotaUnavailableText(provider) {
  var reason = provider && provider.quota ? provider.quota.reason : ""
  if (reason === "unsupported") return "This provider does not report quota."
  if (reason === "all_accounts_blocked") return "No accounts are available."
  if (reason === "auth_unavailable") return "Check provider authentication."
  if (reason === "backend_unavailable") return "Quota is unavailable from this provider right now."
  if (reason === "rate_limited") return "Quota lookup is rate-limited. Try again later."
  return "Quota is unavailable right now."
}

var exportsObject = {
  parseSnapshot: parseSnapshot,
  primaryLimit: primaryLimit,
  highestUsage: highestUsage,
  percent: percent,
  countdown: countdown,
  tokenCount: tokenCount,
  accountText: accountText,
  quotaUnavailableText: quotaUnavailableText
}

if (typeof module !== "undefined" && module.exports) module.exports = exportsObject
