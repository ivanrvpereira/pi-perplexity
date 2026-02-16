import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { formatForLLM } from "../../src/search/format.js";

const NOW = Date.UTC(2026, 1, 16, 12, 0, 0);

describe("formatForLLM", () => {
  const originalNow = Date.now;

  beforeEach(() => {
    Date.now = () => NOW;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  test("renders required sections and deterministic source ordering", () => {
    const output = formatForLLM({
      answer: "Answer body",
      sources: [
        {
          name: "Source 1",
          url: "https://example.com/1",
          snippet: "Snippet 1",
          timestamp: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
        },
        {
          name: "Source 2",
          url: "https://example.com/2",
          snippet: "Snippet 2",
          timestamp: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
      displayModel: "pplx_pro_upgraded",
      uuid: "req-123",
    });

    expect(output).toContain("## Answer");
    expect(output).toContain("## Sources");
    expect(output).toContain("## Meta");
    expect(output.indexOf("[1] Source 1")).toBeLessThan(output.indexOf("[2] Source 2"));
    expect(output).toContain("Provider: perplexity (oauth)");
    expect(output).toContain("Model: pplx_pro_upgraded");
    expect(output).toContain("Request ID: req-123");
  });

  test("humanizes source ages", () => {
    const output = formatForLLM({
      answer: "Age test",
      sources: [
        {
          name: "Recent",
          url: "https://example.com/recent",
          snippet: "recent snippet",
          timestamp: new Date(NOW - 30 * 1000).toISOString(),
        },
        {
          name: "Minutes",
          url: "https://example.com/minutes",
          snippet: "minutes snippet",
          timestamp: new Date(NOW - 12 * 60 * 1000).toISOString(),
        },
        {
          name: "Hours",
          url: "https://example.com/hours",
          snippet: "hours snippet",
          timestamp: new Date(NOW - 5 * 60 * 60 * 1000).toISOString(),
        },
        {
          name: "Days",
          url: "https://example.com/days",
          snippet: "days snippet",
          timestamp: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });

    expect(output).toContain("Recent (just now)");
    expect(output).toContain("Minutes (12m ago)");
    expect(output).toContain("Hours (5h ago)");
    expect(output).toContain("Days (3d ago)");
  });

  test("truncates snippets to 240 chars", () => {
    const longSnippet = "x".repeat(300);

    const output = formatForLLM({
      answer: "Snippet test",
      sources: [
        {
          name: "Long snippet",
          url: "https://example.com/long",
          snippet: longSnippet,
        },
      ],
    });

    const snippetLine = output
      .split("\n")
      .find((line) => line.startsWith("    ") && line.includes("..."));

    expect(snippetLine).toBeDefined();
    expect(snippetLine!.trim().length).toBe(240);
  });

  test("handles empty source list", () => {
    const output = formatForLLM({
      answer: "No sources",
      sources: [],
    });

    expect(output).toContain("0 sources");
    expect(output).toContain("(no sources returned)");
  });
});
