import assert from "node:assert/strict";

import { afterEach, describe, mock, test } from "./test-helpers.js";

afterEach(() => {
  mock.restore();
});

describe("perplexity_search execute", () => {
  test("uses configured model and keeps model/incognito out of tool params", async () => {
    const authenticate = mock(async () => "jwt-token");
    const loadConfig = mock(async () => ({ model: "gpt54" }));
    const resolveSearchModel = mock(() => "gpt54");
    const searchPerplexity = mock(async () => ({
      answer: "answer",
      sources: [{ url: "https://example.com" }],
      displayModel: "gpt54",
      uuid: "req-123",
    }));

    mock.module("../src/auth/login.js", () => ({ authenticate }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig,
      resolveSearchModel,
      saveConfig: mock(async () => undefined),
    }));
    mock.module("../src/search/client.js", () => ({ searchPerplexity }));

    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);
    let execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>) | undefined;
    let parameters: unknown;

    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { execute: typeof execute; parameters: unknown }) {
        execute = tool.execute;
        parameters = tool.parameters;
      },
    } as any);

    assert.ok(execute);
    assert.doesNotMatch(JSON.stringify(parameters), /model|incognito/);

    const result = await execute(
      "tool-1",
      { query: "how many planets", model: "pplx_pro", incognito: false },
      undefined,
      undefined,
      { ui: {} },
    );

    assert.equal(loadConfig.mock.calls.length, 1);
    assert.deepEqual(resolveSearchModel.mock.calls, [[{ model: "gpt54" }]]);
    assert.deepEqual(searchPerplexity.mock.calls[0], [
      {
        query: "how many planets",
        model: "gpt54",
      },
      "jwt-token",
      undefined,
    ]);
    assert.equal(result.details.model, "gpt54");
    assert.equal(result.details.incognito, undefined);
  });
});
