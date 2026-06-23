import { afterEach, describe, expect, mock, test } from "./test-helpers.js";

import { perplexityFetchText } from "../src/perplexity-fetch.js";

const originalFetch = globalThis.fetch;
const originalGetSetCookie = (Headers.prototype as Headers & { getSetCookie?: () => string[] }).getSetCookie;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(Headers.prototype, "getSetCookie", {
    configurable: true,
    writable: true,
    value: originalGetSetCookie,
  });
});

describe("perplexityFetchText", () => {
  test("returns all Set-Cookie headers from Node fetch", async () => {
    globalThis.fetch = mock(async () =>
      new Response("ok", {
        status: 200,
        headers: [
          ["set-cookie", "first=1; Path=/; HttpOnly"],
          ["set-cookie", "second=2; Path=/; Secure"],
        ],
      }),
    ) as unknown as typeof fetch;

    const response = await perplexityFetchText("https://example.com", {
      method: "GET",
      headers: {},
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.bodyText).toBe("ok");
    expect(response.cookies).toEqual([
      "first=1; Path=/; HttpOnly",
      "second=2; Path=/; Secure",
    ]);
  });

  test("fails when the Node fetch runtime cannot expose Set-Cookie headers", async () => {
    Object.defineProperty(Headers.prototype, "getSetCookie", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    globalThis.fetch = mock(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    await expect(perplexityFetchText("https://example.com", { method: "GET", headers: {} })).rejects.toThrow(
      "Headers.getSetCookie",
    );
  });
});
