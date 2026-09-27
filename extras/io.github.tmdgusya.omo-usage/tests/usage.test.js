import { describe, expect, test } from "bun:test";
import {
  anthropicFailureReason,
  anthropicQuotaResult,
  anthropicUsageProviderSettings,
  parseAnthropicUsage,
  parseCodexUsage,
  parseDevinUsage,
  parseKimiUsage,
  parseZaiUsage,
  providerQuotaAuthLimitation,
  readAnthropicUsage,
  summarizeUsageLines,
} from "../usage-source.js";

describe("provider quota parsing", () => {
  test("reads Codex provider windows and reset time", () => {
    // Given
    const payload = {
      rate_limit: {
        primary_window: {
          used_percent: 17,
          limit_window_seconds: 604800,
          reset_at: 1791046722,
        },
      },
    };

    // When
    const limits = parseCodexUsage(payload);

    // Then
    expect(limits).toEqual([{
      label: "Weekly (7 days)",
      usedPercent: 17,
      resetAtMs: 1791046722000,
    }]);
  });

  test("keeps an absent provider reset as unknown", () => {
    // Given
    const payload = {
      rate_limit: {
        primary_window: {
          used_percent: 5,
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    };

    // When
    const limits = parseCodexUsage(payload);

    // Then
    expect(limits[0]?.resetAtMs).toBeNull();
  });

  test("normalizes Anthropic percent-scaled limits", () => {
    // Given
    const payload = {
      five_hour: { utilization: 7, resets_at: "2026-09-27T12:00:00Z" },
      seven_day: { utilization: 42, resets_at: "2026-10-01T12:00:00Z" },
      model_scoped: [{
        display_name: "Fable",
        utilization: 11,
        resets_at: "2026-10-01T12:00:00Z",
      }],
      limits: [{
        kind: "weekly_scoped",
        percent: 11,
        resets_at: "2026-10-01T12:00:00Z",
        scope: { model: { display_name: "Fable" } },
      }],
    };

    // When
    const limits = parseAnthropicUsage(payload);

    // Then
    expect(limits.map(limit => [limit.label, limit.usedPercent])).toEqual([
      ["Session (5 hours)", 7],
      ["Weekly (7 days)", 42],
      ["Fable weekly", 11],
    ]);
  });

  test("uses the config-dir lane without changing account selection", () => {
    // Given
    const settings = {
      pinnedAccount: "work",
      tokenInjection: "oauth-slots",
      resumeMode: "auto",
    };

    // When
    const usageSettings = anthropicUsageProviderSettings(settings);

    // Then
    expect(usageSettings).toEqual({
      pinnedAccount: "work",
      tokenInjection: "config-dir",
      resumeMode: "auto",
    });
  });

  test("reads Claude quota through the installed SDK usage control", async () => {
    // Given
    const calls = [];
    const query = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
        calls.push(options);
        return Promise.resolve({
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 8, resets_at: "2026-09-27T12:00:00Z" },
          },
        });
      },
    };

    // When
    const payload = await readAnthropicUsage(query);
    const quota = anthropicQuotaResult(payload);

    // Then
    expect(calls).toEqual([{ skipBehaviors: true }]);
    expect(quota).toEqual({
      status: "available",
      source: "provider",
      limits: [{
        label: "Session (5 hours)",
        usedPercent: 8,
        resetAtMs: 1790510400000,
      }],
    });
  });

  test("reports the SDK rate-limit backend as unavailable", () => {
    // Given
    const payload = {
      rate_limits_available: false,
      rate_limits: null,
    };

    // When
    const quota = anthropicQuotaResult(payload);

    // Then
    expect(quota).toEqual({
      status: "unavailable",
      reason: "backend_unavailable",
      source: "provider",
      limits: [],
    });
  });

  test("distinguishes Claude rate limits from authentication failures", () => {
    // Given
    const classify = error => ({
      kind: String(error?.message ?? error).includes("429") ? "rate_limit" : "auth_error",
    });

    // When
    const rateLimited = anthropicFailureReason(new Error("HTTP 429"), classify);
    const authFailed = anthropicFailureReason(new Error("authentication_failed"), classify);

    // Then
    expect(rateLimited).toBe("rate_limited");
    expect(authFailed).toBe("auth_unavailable");
  });

  test("reads Kimi credit allowances without calling them tokens", () => {
    // Given
    const payload = {
      usage: { used: 25, limit: 100, remaining: 75, resetTime: 1791046722000 },
      limits: [{
        name: "5 hour",
        detail: { used: 4, limit: 20, remaining: 16 },
        window: { duration: 5, timeUnit: "HOUR", resetTime: 1790524800000 },
      }],
    };

    // When
    const limits = parseKimiUsage(payload);

    // Then
    expect(limits).toEqual([
      {
        label: "Session (5 hours)",
        usedPercent: 20,
        resetAtMs: 1790524800000,
        kind: "credit_allowance",
        unit: "credits",
        used: 4,
        limit: 20,
        remaining: 16,
      },
      {
        label: "Weekly (7 days)",
        usedPercent: 25,
        resetAtMs: 1791046722000,
        kind: "credit_allowance",
        unit: "credits",
        used: 25,
        limit: 100,
        remaining: 75,
      },
    ]);
  });

  test("keeps Z.AI token limits separate from MCP time limits", () => {
    // Given
    const payload = {
      success: true,
      data: {
        limits: [
          { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 80 },
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 12,
            usage: 120,
            remaining: 880,
            nextResetTime: 1790524800000,
          },
        ],
      },
    };

    // When
    const limits = parseZaiUsage(payload);

    // Then
    expect(limits).toEqual([{
      label: "Session (5 hours)",
      usedPercent: 12,
      resetAtMs: 1790524800000,
      kind: "token_allowance",
      unit: "tokens",
      used: 120,
      remaining: 880,
    }]);
  });

  test("honors Devin hidden daily quota and weekly reset", () => {
    // Given
    const payload = {
      userStatus: {
        planStatus: {
          planInfo: { hideDailyQuota: true },
          dailyQuotaRemainingPercent: 90,
          weeklyQuotaRemainingPercent: 64,
          weeklyQuotaResetAtUnix: 1791046722,
        },
      },
    };

    // When
    const limits = parseDevinUsage(payload);

    // Then
    expect(limits).toEqual([{
      label: "Weekly (7 days)",
      usedPercent: 36,
      resetAtMs: 1791046722000,
      kind: "allowance",
    }]);
  });

  test("reports exact missing credential types for provider-only quota APIs", () => {
    // Given
    const providers = ["xiaomi-token-plan-sgp", "devin"];

    // When
    const limitations = providers.map(providerQuotaAuthLimitation);

    // Then
    expect(limitations).toEqual([
      {
        status: "unavailable",
        reason: "requires_console_cookie",
        source: "provider",
        limits: [],
        authRequirement: "api-platform_serviceToken+userId",
      },
      {
        status: "unavailable",
        reason: "requires_codeium_api_key",
        source: "provider",
        limits: [],
        authRequirement: "Codeium/Windsurf metadata apiKey",
      },
    ]);
  });
});

describe("OmO local session usage", () => {
  test("keeps local tokens separate from provider quota", () => {
    // Given
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          provider: "kimi-coding",
          usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150 },
        },
      }),
      "{broken",
    ];

    // When
    const usage = summarizeUsageLines(lines).get("kimi-coding");

    // Then
    expect(usage).toEqual({ tokens: 150, messages: 1 });
  });
});
