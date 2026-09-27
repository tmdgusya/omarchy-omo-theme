import { describe, expect, test } from "bun:test";
import {
  parseAnthropicUsage,
  parseCodexUsage,
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
