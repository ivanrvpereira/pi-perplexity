import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, test } from "../test-helpers.js";
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

    assert.match(output, /## Answer/);
    assert.match(output, /## Sources/);
    assert.match(output, /## Meta/);
    assert.ok(output.indexOf("[1] Source 1") < output.indexOf("[2] Source 2"));
    assert.match(output, /Provider: perplexity \(oauth\)/);
    assert.match(output, /Model: pplx_pro_upgraded/);
    assert.match(output, /Request ID: req-123/);
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

    assert.match(output, /Recent \(just now\)/);
    assert.match(output, /Minutes \(12m ago\)/);
    assert.match(output, /Hours \(5h ago\)/);
    assert.match(output, /Days \(3d ago\)/);
  });

  test("truncates snippets to 240 chars", () => {
    const output = formatForLLM({
      answer: "Snippet test",
      sources: [
        {
          name: "Long snippet",
          url: "https://example.com/long",
          snippet: "x".repeat(300),
        },
      ],
    });

    const snippetLine = output
      .split("\n")
      .find((line) => line.startsWith("    ") && line.includes("…"));

    assert.ok(snippetLine);
    assert.equal(snippetLine.trim().length, 240);
  });

  test("handles empty source list", () => {
    const output = formatForLLM({
      answer: "No sources",
      sources: [],
    });

    assert.match(output, /0 sources/);
    assert.match(output, /\(no sources returned\)/);
  });
});
