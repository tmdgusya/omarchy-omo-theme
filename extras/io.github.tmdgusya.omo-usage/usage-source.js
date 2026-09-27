#!/usr/bin/env bun

import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PROVIDER_NAMES = {
  "anthropic-subscription": "Claude",
  "chatgpt-subscription": "Codex",
  "kimi-coding": "Kimi",
  "xiaomi-token-plan-sgp": "Xiaomi",
  zai: "Z.AI",
  devin: "Devin",
};

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetAtMs(value) {
  const numeric = finite(value);
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function codexWindow(value) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = finite(value.used_percent);
  const seconds = finite(value.limit_window_seconds);
  if (usedPercent === null) return null;
  const label = seconds === 604800
    ? "주간 7일"
    : seconds === 18000
      ? "세션 5시간"
      : seconds
        ? `${Math.round(seconds / 3600)}시간`
        : "사용 한도";
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetAtMs: resetAtMs(value.reset_at),
  };
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
  const usedPercent = percentScale || raw > 1 ? raw : raw * 100;
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetAtMs: resetAtMs(value.resets_at),
  };
}

export function parseAnthropicUsage(payload) {
  if (!payload || typeof payload !== "object") return [];
  const weekly = payload.seven_day_oauth_apps ?? payload.seven_day;
  const raw = [payload.five_hour?.utilization, weekly?.utilization];
  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) raw.push(entry?.percent);
  }
  const percentScale = raw.some(value => (finite(value) ?? -1) >= 1);
  const limits = [
    anthropicWindow("세션 5시간", payload.five_hour, percentScale),
    anthropicWindow("주간 7일", weekly, percentScale),
  ].filter(Boolean);
  for (const entry of Array.isArray(payload.limits) ? payload.limits : []) {
    const model = entry?.scope?.model;
    const name = String(model?.display_name ?? model?.id ?? "").trim();
    if (!name) continue;
    const kind = String(entry.kind ?? "").toLowerCase();
    const window = kind.includes("week") || kind.includes("day")
      ? "주간"
      : kind.includes("hour") || kind.includes("session")
        ? "세션"
        : "";
    const parsed = anthropicWindow(`${name}${window ? ` ${window}` : ""}`, entry, percentScale);
    if (parsed) limits.push(parsed);
  }
  return limits;
}

export function summarizeUsageLines(lines) {
  const usage = new Map();
  for (const line of lines) {
    if (!line.includes("\"usage\"") || !line.includes("\"assistant\"")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "assistant" || !message.usage) continue;
    const provider = String(message.provider ?? "");
    if (!provider) continue;
    const values = ["input", "output", "cacheRead", "cacheWrite"].map(key => finite(message.usage[key]));
    const componentTotal = values.reduce((sum, value) => sum + Math.max(0, value ?? 0), 0);
    const recordedTotal = Math.max(0, finite(message.usage.totalTokens) ?? 0);
    const current = usage.get(provider) ?? { tokens: 0, messages: 0 };
    current.tokens += componentTotal > 0 ? componentTotal : recordedTotal;
    current.messages += 1;
    usage.set(provider, current);
  }
  return usage;
}

async function localUsage(agentDir) {
  const totals = new Map();
  const root = join(agentDir, "sessions");
  for await (const path of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true, onlyFiles: true })) {
    const fileUsage = summarizeUsageLines((await Bun.file(path).text()).split("\n"));
    for (const [provider, value] of fileUsage) {
      const current = totals.get(provider) ?? { tokens: 0, messages: 0, sessions: 0 };
      current.tokens += value.tokens;
      current.messages += value.messages;
      current.sessions += 1;
      totals.set(provider, current);
    }
  }
  return totals;
}

async function packageRoot() {
  const executable = process.env.SENPI_BIN || Bun.which("senpi");
  if (!executable) throw new Error("senpi_not_found");
  let directory = dirname(await realpath(executable));
  while (directory !== dirname(directory)) {
    if (await Bun.file(join(directory, "package.json")).exists()) {
      const pkg = await Bun.file(join(directory, "package.json")).json();
      if (pkg.name === "@code-yeongyu/senpi") return directory;
    }
    directory = dirname(directory);
  }
  throw new Error("senpi_package_not_found");
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`usage_http_${response.status}`);
  return response.json();
}

function unavailable(reason) {
  return { status: "unavailable", reason, source: "provider", limits: [] };
}

async function quotaFor(providerId, context) {
  const ready = context.accounts.filter(account => !account.blocked);
  const selected = ready.find(account => account.pinned) ?? ready[0];
  if (!selected) return unavailable("all_accounts_blocked");
  try {
    if (providerId === "chatgpt-subscription") {
      const auth = await context.runtime.getAuth(providerId, { slotName: selected.name });
      const token = auth?.auth?.apiKey;
      if (!token) return unavailable("auth_unavailable");
      const accountId = context.extractAccountId(token);
      const payload = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      });
      const limits = parseCodexUsage(payload);
      return limits.length ? { status: "available", source: "provider", limits } : unavailable("no_limits");
    }
    if (providerId === "anthropic-subscription") {
      const credential = context.storage.get(providerId);
      const slots = credential?.type === "oauth"
        ? context.listAnthropicAccounts(credential, name => process.env[name])
        : [];
      const slot = slots.find(account => account.name === selected.name);
      const token = slot?.source === "env"
        ? context.envSlotToken(name => process.env[name], slot.name)
        : slot?.access;
      if (!token || (slot.expires > 0 && slot.expires <= Date.now())) return unavailable("auth_unavailable");
      const payload = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      });
      const limits = parseAnthropicUsage(payload);
      return limits.length ? { status: "available", source: "provider", limits } : unavailable("no_limits");
    }
    return unavailable("unsupported");
  } catch {
    return unavailable("request_failed");
  }
}

async function collect() {
  const root = await packageRoot();
  const agentDir = process.env.OMO_CODING_AGENT_DIR ?? join(homedir(), ".omo", "agent");
  const authPath = join(agentDir, "auth.json");
  const [{ ModelRuntime }, { AuthStorage }, credentialAccounts, anthropicAccounts, piAi] = await Promise.all([
    import(join(root, "dist/index.js")),
    import(join(root, "dist/core/auth-storage.js")),
    import(join(root, "dist/core/credential-accounts.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/accounts.js")),
    import(join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")),
  ]);
  const storage = AuthStorage.create(authPath);
  storage.reload();
  const runtime = await ModelRuntime.create({
    credentials: storage,
    agentDir,
    authPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const [credentials, usage] = await Promise.all([runtime.listCredentials(), localUsage(agentDir)]);
  const providers = [];
  for (const credential of credentials) {
    const accounts = await credentialAccounts.getCredentialAccounts(storage, credential.providerId);
    const quota = await quotaFor(credential.providerId, {
      accounts,
      runtime,
      storage,
      listAnthropicAccounts: anthropicAccounts.listAccounts,
      envSlotToken: anthropicAccounts.envSlotToken,
      extractAccountId: piAi.extractChatGptSubscriptionAccountId,
    });
    const selected = accounts.find(account => account.pinned) ?? accounts.find(account => !account.blocked);
    providers.push({
      id: credential.providerId,
      name: PROVIDER_NAMES[credential.providerId] ?? runtime.getProvider(credential.providerId)?.name ?? credential.providerId,
      authType: credential.type,
      accounts: {
        total: accounts.length,
        ready: accounts.filter(account => !account.blocked).length,
        blocked: accounts.filter(account => account.blocked).length,
        selected: selected ? (selected.displayName ?? selected.name) : null,
      },
      quota,
      local: usage.get(credential.providerId) ?? { tokens: 0, messages: 0, sessions: 0 },
    });
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), providers };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await collect()));
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), providers: [], error: "collector_failed" }));
    process.exitCode = 1;
  }
}
