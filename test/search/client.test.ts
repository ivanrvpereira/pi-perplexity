import { afterEach, describe, expect, test } from "bun:test";

import { searchPerplexity } from "../../src/search/client.js";
import { SearchError } from "../../src/search/types.js";

const ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";

function createSseResponse(events: Array<Record<string, unknown>>, status = 200): Response {
  const streamText = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");

  return new Response(streamText, {
    status,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

describe("searchPerplexity", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("builds request body and headers according to protocol", async () => {
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
            {
              intended_usage: "markdown_block",
              markdown_block: {
                answer: "answer text",
              },
            },
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
      { query: "latest bun release notes", recency: "week" },
      "jwt-token",
      controller.signal,
    );

    expect(String(capturedUrl)).toBe(ENDPOINT);
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.signal).toBe(controller.signal);

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-token");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("X-App-ApiVersion")).toBe("2.18");
    expect(headers.get("X-Request-ID")).toBeTruthy();

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

    expect(body.query_str).toBe("latest bun release notes");
    expect(body.params.query_str).toBe("latest bun release notes");
    expect(body.params.mode).toBe("copilot");
    expect(body.params.model_preference).toBe("pplx_pro_upgraded");
    expect(body.params.is_incognito).toBe(true);
    expect(body.params.search_recency_filter).toBe("week");
    expect(body.params.frontend_uuid).toBeTruthy();
    expect(body.params.frontend_context_uuid).toBeTruthy();

    expect(result.answer).toBe("answer text");
    expect(result.sources).toHaveLength(1);
  });

  test("maps 401 and 403 responses to AUTH error", async () => {
    for (const status of [401, 403]) {
      globalThis.fetch = (async () => new Response("auth fail", { status })) as unknown as typeof fetch;

      await expect(searchPerplexity({ query: "q" }, "jwt")).rejects.toMatchObject({
        name: "SearchError",
        code: "AUTH",
      });
    }
  });

  test("maps 429 responses to RATE_LIMIT error", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    await expect(searchPerplexity({ query: "q" }, "jwt")).rejects.toMatchObject({
      name: "SearchError",
      code: "RATE_LIMIT",
    });
  });

  test("deduplicates sources by normalized URL", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          blocks: [
            {
              intended_usage: "markdown_block",
              markdown_block: {
                answer: "answer text",
              },
            },
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

    const result = await searchPerplexity({ query: "q" }, "jwt");

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe("https://example.com/path");
    expect(result.sources[1].url).toBe("https://another.example/path");
  });

  test("answer extraction prioritizes markdown_block over ask_text and text", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          text: "fallback text",
          blocks: [
            {
              intended_usage: "ask_text",
              markdown_block: { answer: "ask text" },
            },
            {
              intended_usage: "markdown_block",
              markdown_block: { answer: "markdown answer" },
            },
          ],
          sources_list: [{ title: "S", url: "https://example.com" }],
        },
      ])) as unknown as typeof fetch;

    const result = await searchPerplexity({ query: "q" }, "jwt");
    expect(result.answer).toBe("markdown answer");
  });

  test("answer extraction falls back to ask_text then text", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          text: "fallback text",
          blocks: [
            {
              intended_usage: "ask_text",
              markdown_block: { answer: "ask answer" },
            },
          ],
          sources_list: [{ title: "S", url: "https://example.com" }],
        },
      ])) as unknown as typeof fetch;

    const askTextResult = await searchPerplexity({ query: "q" }, "jwt");
    expect(askTextResult.answer).toBe("ask answer");

    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
          text: "text fallback",
          sources_list: [{ title: "S", url: "https://example.com" }],
        },
      ])) as unknown as typeof fetch;

    const textResult = await searchPerplexity({ query: "q" }, "jwt");
    expect(textResult.answer).toBe("text fallback");
  });

  test("returns EMPTY error when response has no answer and no sources", async () => {
    globalThis.fetch = (async () =>
      createSseResponse([
        {
          status: "COMPLETED",
          final: true,
        },
      ])) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await searchPerplexity({ query: "q" }, "jwt");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SearchError);
    expect((thrown as SearchError).code).toBe("EMPTY");
  });
});
