import { describe, expect, test } from "./test-helpers.js";

import { renderPerplexityCall } from "../src/render/call.js";
import { renderPerplexityResult } from "../src/render/result.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("renderPerplexityCall", () => {
  test("shows the selected model in the tool call row", () => {
    const rendered = renderPerplexityCall(
      {
        query: "latest Node release notes",
        model: "claude46sonnetthinking",
        recency: "week",
        limit: 5,
      },
      theme,
    ).render(200).join("\n");

    expect(rendered).toContain("claude46sonnetthinking");
    expect(rendered).toContain("week");
    expect(rendered).toContain("limit 5");
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

    expect(rendered).toContain("gpt54");
    expect(rendered).toContain("3 sources");
  });
});
