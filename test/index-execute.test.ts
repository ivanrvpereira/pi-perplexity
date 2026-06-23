import { afterEach, describe, expect, mock, test } from "./test-helpers.js";

afterEach(() => {
  mock.restore();
});

describe("perplexity_search execute", () => {
  test("includes effective config values in the search request and result details", async () => {
    const authenticate = mock(async () => "jwt-token");
    const loadConfig = mock(async () => ({ model: "gpt54", incognito: false }));
    const resolveSearchDefaults = mock(() => ({ model: "gpt54", incognito: false }));
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
      resolveSearchDefaults,
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

    expect(execute).toBeDefined();
    expect(JSON.stringify(parameters)).not.toContain("model");

    const result = await execute!(
      "tool-1",
      { query: "how many planets", model: "pplx_pro" },
      undefined,
      undefined,
      { ui: {} },
    );

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveSearchDefaults).toHaveBeenCalledWith({}, { model: "gpt54", incognito: false });
    expect(searchPerplexity).toHaveBeenCalledWith(
      {
        query: "how many planets",
        model: "gpt54",
        incognito: false,
      },
      "jwt-token",
      undefined,
    );
    expect(result.details.incognito).toBe(false);
    expect(result.details.model).toBe("gpt54");
  });
});
