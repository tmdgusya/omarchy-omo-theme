#!/usr/bin/env bun

import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseAnthropicUsage,
  parseCodexUsage,
  parseDevinUsage,
  parseKimiUsage,
  parseZaiUsage,
} from "./quota-adapters.js";
import {
  anthropicUsageProviderSettings,
  nativeAnthropicUsage,
  packageRoot,
  readAnthropicUsage,
} from "./senpi-usage.js";

export {
  parseAnthropicUsage,
  parseCodexUsage,
  parseDevinUsage,
  parseKimiUsage,
  parseZaiUsage,
  anthropicUsageProviderSettings,
  readAnthropicUsage,
};

const PROVIDER_NAMES = {
  "anthropic-subscription": "Claude",
  "chatgpt-subscription": "Codex",
  "kimi-coding": "Kimi",
  "xiaomi-token-plan-sgp": "Xiaomi",
  zai: "Z.AI",
  devin: "Devin",
};

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function anthropicQuotaResult(payload) {
  if (!payload?.rate_limits_available || !payload.rate_limits) {
    return unavailable("backend_unavailable");
  }
  const limits = parseAnthropicUsage(payload.rate_limits);
  return limits.length ? { status: "available", source: "provider", limits } : unavailable("no_limits");
}

export function anthropicFailureReason(error, classify) {
  switch (classify(error).kind) {
    case "rate_limit":
      return "rate_limited";
    case "auth_error":
    case "org_not_allowed":
      return "auth_unavailable";
    default:
      return "request_failed";
  }
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

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const error = new Error(`usage_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function unavailable(reason) {
  return { status: "unavailable", reason, source: "provider", limits: [] };
}

export function providerQuotaAuthLimitation(providerId) {
  if (providerId === "xiaomi-token-plan-sgp") {
    return {
      ...unavailable("requires_console_cookie"),
      authRequirement: "api-platform_serviceToken+userId",
    };
  }
  if (providerId === "devin") {
    return {
      ...unavailable("requires_codeium_api_key"),
      authRequirement: "Codeium/Windsurf metadata apiKey",
    };
  }
  return null;
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
      const result = await context.anthropicUsage(selected.name);
      return {
        ...anthropicQuotaResult(result.usage),
        credentialSource: "senpi",
        accountName: result.accountName,
      };
    }
    if (providerId === "kimi-coding") {
      const auth = await context.runtime.getAuth(providerId, { slotName: selected.name });
      const headers = auth?.auth?.headers;
      if (!headers?.Authorization) return unavailable("missing_oauth_headers");
      const payload = await fetchJson("https://api.kimi.com/coding/v1/usages", {
        Accept: "application/json",
        ...headers,
      });
      const limits = parseKimiUsage(payload);
      return limits.length ? { status: "available", source: "provider", limits } : unavailable("no_limits");
    }
    if (providerId === "zai") {
      const auth = await context.runtime.getAuth(providerId, { slotName: selected.name });
      const token = auth?.auth?.apiKey;
      if (!token) return unavailable("missing_api_key");
      const payload = await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      });
      const limits = parseZaiUsage(payload);
      return limits.length ? { status: "available", source: "provider", limits } : unavailable("no_token_limits");
    }
    const limitation = providerQuotaAuthLimitation(providerId);
    if (limitation) return limitation;
    return unavailable("not_implemented");
  } catch (error) {
    if (providerId === "anthropic-subscription") {
      return unavailable(anthropicFailureReason(error, context.classifyAnthropicError));
    }
    if (error?.status === 401 || error?.status === 403) return unavailable("auth_rejected");
    if (error?.status === 429) return unavailable("rate_limited");
    return unavailable("request_failed");
  }
}

async function collect() {
  const root = await packageRoot();
  const agentDir = process.env.SENPI_CODING_AGENT_DIR
    ?? process.env.OMO_CODING_AGENT_DIR
    ?? join(homedir(), ".omo", "agent");
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  const authPath = join(agentDir, "auth.json");
  const [{ ModelRuntime }, { AuthStorage }, credentialAccounts, anthropicErrors, piAi] = await Promise.all([
    import(join(root, "dist/index.js")),
    import(join(root, "dist/core/auth-storage.js")),
    import(join(root, "dist/core/credential-accounts.js")),
    import(join(root, "dist/core/extensions/builtin/anthropic-subscription/errors.js")),
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
    const context = {
      runtime,
      storage,
      anthropicUsage: name => nativeAnthropicUsage(root, name),
      classifyAnthropicError: anthropicErrors.classifySdkError,
      extractAccountId: piAi.extractChatGptSubscriptionAccountId,
    };
    const accountQuotas = [];
    for (const account of accounts) {
      accountQuotas.push({
        name: account.name,
        displayName: account.displayName ?? account.name,
        blocked: Boolean(account.blocked),
        pinned: Boolean(account.pinned),
        quota: await quotaFor(credential.providerId, { ...context, accounts: [account] }),
      });
    }
    const selected = accounts.find(account => account.pinned && !account.blocked)
      ?? accounts.find(account => !account.blocked);
    const quota = accountQuotas.find(account => account.name === selected?.name)?.quota
      ?? unavailable("all_accounts_blocked");
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
      accountQuotas,
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
