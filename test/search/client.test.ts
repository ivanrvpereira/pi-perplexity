import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, test } from "../test-helpers.js";
import { SearchError } from "../../src/search/types.js";

let searchPerplexity: typeof import("../../src/search/client.js").searchPerplexity;

function createSseResponse(events: Array<Record<string, unknown>>, status = 200): Response {
  const streamText = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");

  return new Response(streamText, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("searchPerplexity", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const mod = await import(`../../src/search/client.js?t=${crypto.randomUUID()}`);
    searchPerplexity = mod.searchPerplexity;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("builds the request body and headers according to protocol", async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;

      return createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          blocks: [
            { intended_usage: "markdown_block", markdown_block: { answer: "answer text" } },
            {
              intended_usage: "web_results",
              web_result_block: {
                web_results: [
                  {
                    name: "Source",
                    url: "https://example.com",
                    snippet: "snippet",
                    timestamp: "2026-02-16T10:00:00.000Z",
                  },
                ],
              },
            },
          ],
        },
      ]);
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const result = await searchPerplexity(
      { query: "latest Node release notes", recency: "week", model: "pplx_pro_upgraded" },
      "jwt-token",
      controller.signal,
    );

    assert.equal(String(capturedUrl), "https://www.perplexity.ai/rest/sse/perplexity_ask");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.signal, controller.signal);

    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("Authorization"), "Bearer jwt-token");
    assert.equal(headers.get("Accept"), "text/event-stream");
    assert.equal(headers.get("X-App-ApiVersion"), "2.18");
    assert.ok(headers.get("X-Request-ID"));

    const body = JSON.parse(String(capturedInit?.body)) as {
      query_str: string;
      params: {
        query_str: string;
        mode: string;
        model_preference: string;
        is_incognito: boolean;
        search_recency_filter: string | null;
        frontend_uuid: string;
        frontend_context_uuid: string;
      };
    };

    assert.equal(body.query_str, "latest Node release notes");
    assert.equal(body.params.query_str, "latest Node release notes");
    assert.equal(body.params.mode, "copilot");
    assert.equal(body.params.model_preference, "pplx_pro_upgraded");
    assert.equal(body.params.is_incognito, true);
    assert.equal(body.params.search_recency_filter, "week");
    assert.ok(body.params.frontend_uuid);
    assert.ok(body.params.frontend_context_uuid);
    assert.equal(result.answer, "answer text");
    assert.equal(result.sources.length, 1);
  });

  test("passes model through and always sends incognito true", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return createSseResponse([{ status: "COMPLETED", final: true, text: "answer", blocks: [] }]);
    }) as unknown as typeof fetch;

    await searchPerplexity({ query: "q", model: "claude46sonnetthinking" }, "jwt-token");

    const body = JSON.parse(String(capturedInit?.body)) as {
      params: { model_preference: string; is_incognito: boolean };
    };
    assert.equal(body.params.model_preference, "claude46sonnetthinking");
    assert.equal(body.params.is_incognito, true);
  });

  test("cancels the response body after a terminal event", async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"status":"COMPLETED","final":true,"text":"answer"}\n\n'));
      },
      cancel() {
        cancelCalled = true;
      },
    });

    globalThis.fetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const result = await searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt");

    assert.equal(result.answer, "answer");
    assert.equal(cancelCalled, true);
  });

  test("maps terminal-event cancellation failures to typed stream errors", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"status":"COMPLETED","final":true,"text":"answer"}\n\n'));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });

    globalThis.fetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    await assert.rejects(
      searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt"),
      (error) => error instanceof SearchError && error.code === "STREAM",
    );
  });

  test("maps premature stream EOF to a typed stream error", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([{ text: "partial answer" }])) as unknown as typeof fetch;

    await assert.rejects(
      searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt"),
      (error) => error instanceof SearchError && error.code === "STREAM",
    );
  });

  test("maps 401/403 and 429 responses to typed errors", async () => {
    for (const status of [401, 403] as const) {
      globalThis.fetch = (async () => new Response("auth fail", { status })) as unknown as typeof fetch;

      await assert.rejects(
        searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt"),
        (error) => error instanceof SearchError && error.code === "AUTH",
      );
    }

    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await assert.rejects(
      searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt"),
      (error) => error instanceof SearchError && error.code === "RATE_LIMIT",
    );
  });

  test("deduplicates sources by normalized URL", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          blocks: [
            { intended_usage: "markdown_block", markdown_block: { answer: "answer text" } },
            {
              intended_usage: "web_results",
              web_result_block: {
                web_results: [
                  { name: "A", url: "https://example.com/path" },
                  { name: "A duplicate", url: "https://example.com/path/" },
                  { name: "B", url: "https://another.example/path" },
                ],
              },
            },
          ],
        },
      ])) as unknown as typeof fetch;

    const result = await searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt");

    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0]?.url, "https://example.com/path");
    assert.equal(result.sources[1]?.url, "https://another.example/path");
  });

  test("answer extraction prioritizes markdown_block, then ask_text, then text", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          text: "fallback text",
          blocks: [
            { intended_usage: "ask_text", markdown_block: { answer: "ask text" } },
            { intended_usage: "markdown_block", markdown_block: { answer: "markdown answer" } },
          ],
          sources_list: [{ title: "S", url: "https://example.com" }],
        },
      ])) as unknown as typeof fetch;

    const markdownResult = await searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt");
    assert.equal(markdownResult.answer, "markdown answer");

    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          text: "fallback text",
          blocks: [{ intended_usage: "ask_text", markdown_block: { answer: "ask answer" } }],
          sources_list: [{ title: "S", url: "https://example.com" }],
        },
      ])) as unknown as typeof fetch;

    const askTextResult = await searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt");
    assert.equal(askTextResult.answer, "ask answer");

    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          text: "text fallback",
          sources_list: [{ title: "S", url: "https://example.com" }],
        },
      ])) as unknown as typeof fetch;

    const textResult = await searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt");
    assert.equal(textResult.answer, "text fallback");
  });

  test("returns EMPTY error when response has no answer and no sources", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([{ status: "COMPLETED", final: true }])) as unknown as typeof fetch;

    await assert.rejects(
      searchPerplexity({ query: "q", model: "pplx_pro_upgraded" }, "jwt"),
      (error) => error instanceof SearchError && error.code === "EMPTY",
    );
  });
});
