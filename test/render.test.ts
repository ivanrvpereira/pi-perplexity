import assert from "node:assert/strict";

import { describe, test } from "./test-helpers.js";
import { renderPerplexityCall } from "../src/render/call.js";
import { renderPerplexityResult } from "../src/render/result.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("renderPerplexityCall", () => {
  test("shows query filters without stale model or incognito fields", () => {
    const rendered = renderPerplexityCall(
      {
        query: "latest Node release notes",
        model: "claude46sonnetthinking",
        incognito: false,
        recency: "week",
        limit: 5,
      } as any,
      theme,
    ).render(200).join("\n");

    assert.match(rendered, /latest Node release notes/);
    assert.match(rendered, /week/);
    assert.match(rendered, /limit 5/);
    assert.doesNotMatch(rendered, /claude46sonnetthinking|incognito/);
  });
});

describe("renderPerplexityResult", () => {
  test("shows the model in the collapsed success row", () => {
    const rendered = renderPerplexityResult(
      {
        content: [{ type: "text", text: "Result summary" }],
        details: {
          model: "gpt54",
          sourceCount: 3,
          queryMs: 800,
        },
      } as any,
      { expanded: false, isPartial: false } as any,
      theme,
    ).render(200).join("\n");

    assert.match(rendered, /gpt54/);
    assert.match(rendered, /3 sources/);
  });
});
