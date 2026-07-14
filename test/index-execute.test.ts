import { afterEach, describe, expect, mock, test } from "./test-helpers.js";

import { SearchError } from "../src/search/types.js";

afterEach(() => {
  mock.restore();
});

describe("perplexity_search execute", () => {
  test("includes effective config values in the search request and result details", async () => {
    const authenticate = mock(async () => "jwt-token");
    const saveBrowserAuthInput = mock(async () => ({ type: "oauth", access: "jwt-token" }));
    const loadConfig = mock(async () => ({ model: "gpt54" }));
    const resolveDefaultModel = mock(() => "gpt54");
    const searchPerplexity = mock(async () => ({
      answer: "answer",
      sources: [{ url: "https://example.com" }],
      displayModel: "gpt54",
      uuid: "req-123",
    }));

    mock.module("../src/auth/login.js", () => ({ authenticate, saveBrowserAuthInput }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig,
      resolveDefaultModel,
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
    expect(JSON.stringify(parameters)).not.toContain("incognito");

    const result = await execute!(
      "tool-1",
      { query: "how many planets", model: "pplx_pro" },
      undefined,
      undefined,
      { ui: {} },
    );

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveDefaultModel).toHaveBeenCalledWith({ model: "gpt54" });
    expect(searchPerplexity).toHaveBeenCalledWith(
      {
        query: "how many planets",
        model: "gpt54",
      },
      "jwt-token",
      undefined,
    );
    expect(result.details.model).toBe("gpt54");
  });

  test("does not clear cached credentials on Perplexity auth rejection", async () => {
    const authenticate = mock(async () => "jwt-token");
    const saveBrowserAuthInput = mock(async () => ({ type: "oauth", access: "jwt-token" }));
    const clearToken = mock(async () => undefined);
    const loadConfig = mock(async () => ({}));
    const resolveDefaultModel = mock(() => "pplx_pro_upgraded");
    const searchPerplexity = mock(async () => {
      throw new SearchError("AUTH", "Perplexity rejected authentication (401/403).");
    });

    mock.module("../src/auth/login.js", () => ({ authenticate, saveBrowserAuthInput }));
    mock.module("../src/auth/storage.js", () => ({ clearToken }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig,
      resolveDefaultModel,
      saveConfig: mock(async () => undefined),
    }));
    mock.module("../src/search/client.js", () => ({ searchPerplexity }));

    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    let execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>) | undefined;
    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
    } as any);

    const result = await execute!("tool-1", { query: "hello" }, undefined, undefined, { ui: {} });

    expect(result.details.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("Perplexity search failed");
    expect(clearToken).toHaveBeenCalledTimes(0);
  });
});
