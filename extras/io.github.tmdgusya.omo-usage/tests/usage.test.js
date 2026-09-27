import { describe, expect, test } from "bun:test";
import {
  anthropicFailureReason,
  anthropicQuotaResult,
  parseAnthropicUsage,
  parseCodexUsage,
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
      label: "주간 7일",
      usedPercent: 17,
      resetAtMs: 1791046722000,
    }]);
  });

  test("normalizes Anthropic percent-scaled limits", () => {
    // Given
    const payload = {
      five_hour: { utilization: 7, resets_at: "2026-09-27T12:00:00Z" },
      seven_day: { utilization: 42, resets_at: "2026-10-01T12:00:00Z" },
    };

    // When
    const limits = parseAnthropicUsage(payload);

    // Then
    expect(limits.map(limit => limit.usedPercent)).toEqual([7, 42]);
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
        label: "세션 5시간",
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
