function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetAtMs(value) {
  const numeric = finite(value);
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value) {
  const parsed = finite(value);
  return parsed === null ? null : Math.max(0, Math.min(100, parsed));
}

function allowance(label, usedPercent, reset, details = {}) {
  const normalized = percent(usedPercent);
  if (normalized === null) return null;
  return {
    label,
    usedPercent: normalized,
    resetAtMs: resetAtMs(reset),
    ...details,
  };
}

function codexWindow(value) {
  if (!value || typeof value !== "object") return null;
  const seconds = finite(value.limit_window_seconds);
  const label = seconds === 604800
    ? "Weekly (7 days)"
    : seconds === 18000
      ? "Session (5 hours)"
      : seconds
        ? `${Math.round(seconds / 3600)} hours`
        : "Usage limit";
  return allowance(label, value.used_percent, value.reset_at);
}

export function parseCodexUsage(payload) {
  const rateLimit = payload?.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return [];
  return [codexWindow(rateLimit.primary_window), codexWindow(rateLimit.secondary_window)].filter(Boolean);
}

function anthropicWindow(label, value, percentScale) {
  if (!value || typeof value !== "object") return null;
  const raw = finite(value.utilization ?? value.percent);
  if (raw === null) return null;
  return allowance(label, percentScale || raw > 1 ? raw : raw * 100, value.resets_at);
}

export function parseAnthropicUsage(payload) {
  if (!payload || typeof payload !== "object") return [];
  const weekly = payload.seven_day_oauth_apps ?? payload.seven_day;
  const raw = [payload.five_hour?.utilization, weekly?.utilization];
  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) raw.push(entry?.percent);
  }
  if (Array.isArray(payload.model_scoped)) {
    for (const entry of payload.model_scoped) raw.push(entry?.utilization);
  }
  const percentScale = raw.some(value => (finite(value) ?? -1) >= 1);
  const limits = [
    anthropicWindow("Session (5 hours)", payload.five_hour, percentScale),
    anthropicWindow("Weekly (7 days)", weekly, percentScale),
  ].filter(Boolean);
  for (const entry of Array.isArray(payload.limits) ? payload.limits : []) {
    const model = entry?.scope?.model;
    const name = String(model?.display_name ?? model?.id ?? "").trim();
    if (!name) continue;
    const kind = String(entry.kind ?? "").toLowerCase();
    const window = kind.includes("week") || kind.includes("day")
      ? "weekly"
      : kind.includes("hour") || kind.includes("session")
        ? "session"
        : "";
    const parsed = anthropicWindow(`${name}${window ? ` ${window}` : ""}`, entry, percentScale);
    if (parsed) limits.push(parsed);
  }
  for (const entry of Array.isArray(payload.model_scoped) ? payload.model_scoped : []) {
    const name = String(entry?.display_name ?? "").trim();
    if (!name) continue;
    const parsed = anthropicWindow(`${name} weekly`, entry, percentScale);
    if (parsed) limits.push(parsed);
  }
  return limits.filter((limit, index) => limits.findIndex(candidate =>
    candidate.label === limit.label
      && candidate.usedPercent === limit.usedPercent
      && candidate.resetAtMs === limit.resetAtMs) === index);
}

function kimiRow(label, value, resetFallback) {
  if (!value || typeof value !== "object") return null;
  const limit = finite(value.limit);
  let used = finite(value.used);
  const remaining = finite(value.remaining);
  if (used === null && limit !== null && remaining !== null) used = limit - remaining;
  const usedPercent = limit !== null && limit > 0 && used !== null
    ? used / limit * 100
    : finite(value.utilization ?? value.percent ?? value.usedPercent ?? value.used_percent);
  if (usedPercent === null) return null;
  return allowance(label, usedPercent, value.resetTime ?? value.resetAt
    ?? value.reset_time ?? value.reset_at ?? resetFallback?.resetTime
    ?? resetFallback?.resetAt ?? resetFallback?.reset_time ?? resetFallback?.reset_at, {
    kind: "credit_allowance",
    unit: "credits",
    ...(used !== null ? { used } : {}),
    ...(limit !== null ? { limit } : {}),
    ...(remaining !== null ? { remaining } : {}),
  });
}

function kimiWindowKind(item, detail, window) {
  const duration = finite(window?.duration ?? item?.duration ?? detail?.duration);
  const unit = String(window?.timeUnit ?? item?.timeUnit ?? detail?.timeUnit ?? "").toUpperCase();
  const label = [item?.name, item?.title, item?.scope, detail?.name, detail?.title]
    .filter(value => typeof value === "string").join(" ").toLowerCase();
  if ((unit.includes("MINUTE") && duration === 300) || (unit.includes("HOUR") && duration === 5)
    || /(^|\b)5\s*(h|hour)/.test(label)) return "five_hour";
  if ((unit.includes("DAY") && duration === 7) || (unit.includes("HOUR") && duration === 168)
    || /weekly|7\s*(d|day)/.test(label)) return "weekly";
  return null;
}

export function parseKimiUsage(payload) {
  const nested = payload?.data;
  const body = !payload?.usage && !payload?.limits && nested && typeof nested === "object" ? nested : payload;
  if (!body || typeof body !== "object") return [];
  let weekly = kimiRow("Weekly (7 days)", body.usage);
  let fiveHour = null;
  for (const item of Array.isArray(body.limits) ? body.limits : []) {
    const detail = item?.detail && typeof item.detail === "object" ? item.detail : item;
    const window = item?.window && typeof item.window === "object" ? item.window : {};
    const kind = kimiWindowKind(item, detail, window);
    if (kind === "five_hour" && !fiveHour) fiveHour = kimiRow("Session (5 hours)", detail, window);
    if (kind === "weekly" && !weekly) weekly = kimiRow("Weekly (7 days)", detail, window);
  }
  const total = kimiRow("Total subscription credits", body.totalQuota);
  return [fiveHour, weekly, total].filter(Boolean);
}

export function parseZaiUsage(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const parsed = [];
  for (const row of limits) {
    if (row?.type !== "TOKENS_LIMIT" && row?.type !== "CREDIT_LIMIT") continue;
    const usedPercent = finite(row.percentage ?? row.currentValue ?? row.usage);
    if (usedPercent === null) continue;
    const unit = finite(row.unit);
    const number = finite(row.number);
    const label = unit === 3 && number === 5
      ? "Session (5 hours)"
      : unit === 6 && number === 1
        ? "Weekly (7 days)"
        : `Token allowance (${number ?? "?"}/${unit ?? "?"})`;
    const limit = allowance(label, usedPercent, row.nextResetTime, {
      kind: "token_allowance",
      unit: "tokens",
      ...(finite(row.usage) !== null ? { used: finite(row.usage) } : {}),
      ...(finite(row.remaining) !== null ? { remaining: finite(row.remaining) } : {}),
    });
    if (limit) parsed.push(limit);
  }
  return parsed;
}

export function parseDevinUsage(payload) {
  const plan = payload?.userStatus?.planStatus;
  if (!plan || typeof plan !== "object") return [];
  const limits = [];
  if (plan?.planInfo?.hideDailyQuota !== true) {
    const dailyRemaining = finite(plan.dailyQuotaRemainingPercent);
    if (dailyRemaining !== null) {
      limits.push(allowance("Daily (24 hours)", 100 - dailyRemaining, plan.dailyQuotaResetAtUnix, {
        kind: "allowance",
      }));
    }
  }
  const weeklyRemaining = finite(plan.weeklyQuotaRemainingPercent);
  if (weeklyRemaining !== null) {
    limits.push(allowance("Weekly (7 days)", 100 - weeklyRemaining, plan.weeklyQuotaResetAtUnix, {
      kind: "allowance",
    }));
  }
  return limits.filter(Boolean);
}
