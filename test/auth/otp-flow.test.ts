/**
 * OTP login flow tests derived from real captured request/response data.
 * See scripts/debug-login-dump.json for the raw fixture.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AuthError, type StoredToken } from "../../src/search/types.js";

const originalFetch = globalThis.fetch;
const originalBorrow = process.env.PI_AUTH_NO_BORROW;
const originalEmail = process.env.PI_PERPLEXITY_EMAIL;
const originalOtp = process.env.PI_PERPLEXITY_OTP;

// --- Fixtures from real Perplexity responses (scripts/debug-login-dump.json) ---

/** Real JWE token structure: alg=dir, enc=A256GCM — NOT a JWT, opaque to us */
const REAL_JWE_TOKEN =
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAA";

const CSRF_TOKEN = "0e4f8cc491e3197788492604ad32577f2022747fe30e0f51ba3ba235f07cc9ee";

const TEST_EMAIL = "user@test.com";
const TEST_OTP = "9f3e2-knzol";

// ---

async function importLoginModule() {
  return import(`../../src/auth/login.ts?test=${crypto.randomUUID()}`);
}

function restoreEnv(): void {
  for (const [key, original] of [
    ["PI_AUTH_NO_BORROW", originalBorrow],
    ["PI_PERPLEXITY_EMAIL", originalEmail],
    ["PI_PERPLEXITY_OTP", originalOtp],
  ] as const) {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

function mockStorage() {
  const loadTokenMock = mock(async () => null);
  const saveTokenMock = mock(async (_token: StoredToken) => undefined);
  const clearTokenMock = mock(async () => undefined);

  mock.module("../../src/auth/storage.js", () => ({
    loadToken: loadTokenMock,
    saveToken: saveTokenMock,
    clearToken: clearTokenMock,
  }));

  return { loadTokenMock, saveTokenMock, clearTokenMock };
}

/** Build a fetch mock that replays real Perplexity response shapes. */
function buildReplayFetchMock(options?: {
  /** Override the OTP response body (default: real token+status response) */
  otpResponseBody?: unknown;
}) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const otpBody = options?.otpResponseBody ?? { token: REAL_JWE_TOKEN, status: "success" };

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const entry: { url: string; init?: RequestInit } = { url };
    if (init !== undefined) entry.init = init;
    calls.push(entry);

    if (url.endsWith("/csrf")) {
      return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.endsWith("/signin-email")) {
      return new Response(JSON.stringify({ success: "Email sign in triggered" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.endsWith("/signin-otp")) {
      return new Response(JSON.stringify(otpBody), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  });

  return { fetchMock, calls };
}

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("OTP login flow (from real captured responses)", () => {
  test("full flow: CSRF → email → OTP, extracts JWE token from response body", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const { saveTokenMock } = mockStorage();
    const { fetchMock } = buildReplayFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    const token = await authenticate({
      promptForEmail: async () => TEST_EMAIL,
      promptForOtp: async () => TEST_OTP,
    });

    expect(token).toBe(REAL_JWE_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(saveTokenMock).toHaveBeenCalledTimes(1);

    const saved = saveTokenMock.mock.calls[0]?.[0] as StoredToken;
    expect(saved.type).toBe("oauth");
    expect(saved.access).toBe(REAL_JWE_TOKEN);
  });

  test("exactly 3 requests: no /session fallback when token is in body", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    mockStorage();
    const { fetchMock, calls } = buildReplayFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    await authenticate({
      promptForEmail: async () => TEST_EMAIL,
      promptForOtp: async () => TEST_OTP,
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("/csrf");
    expect(calls[1].url).toContain("/signin-email");
    expect(calls[2].url).toContain("/signin-otp");
  });
  test("request bodies match expected shape", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    mockStorage();
    const { fetchMock, calls } = buildReplayFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    await authenticate({
      promptForEmail: async () => TEST_EMAIL,
      promptForOtp: async () => TEST_OTP,
    });

    // CSRF is GET, no body
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(calls[0].init?.body).toBeFalsy();

    // signin-email: POST with email + csrfToken
    expect(calls[1].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      email: TEST_EMAIL,
      csrfToken: CSRF_TOKEN,
    });

    // signin-otp: POST with email + otp + csrfToken
    expect(calls[2].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      email: TEST_EMAIL,
      otp: TEST_OTP,
      csrfToken: CSRF_TOKEN,
    });
  });


  test("env vars PI_PERPLEXITY_EMAIL and PI_PERPLEXITY_OTP bypass prompts", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    process.env.PI_PERPLEXITY_EMAIL = TEST_EMAIL;
    process.env.PI_PERPLEXITY_OTP = TEST_OTP;

    mockStorage();
    const { fetchMock } = buildReplayFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    const promptForEmail = mock(async () => "should-not-be-called@test.com");
    const promptForOtp = mock(async () => "should-not-be-called");

    const token = await authenticate({ promptForEmail, promptForOtp });

    expect(token).toBe(REAL_JWE_TOKEN);
    expect(promptForEmail).toHaveBeenCalledTimes(0);
    expect(promptForOtp).toHaveBeenCalledTimes(0);
  });

  test("throws AuthError NO_TOKEN when email prompt returns undefined", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    mockStorage();

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate({
        promptForEmail: async () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
  });

  test("throws AuthError NO_TOKEN when OTP prompt returns undefined", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    mockStorage();
    const { fetchMock } = buildReplayFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate({
        promptForEmail: async () => TEST_EMAIL,
        promptForOtp: async () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
  });

  test("throws when OTP verification returns non-200", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    mockStorage();

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/csrf")) {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/signin-email")) {
        return new Response(JSON.stringify({ success: "Email sign in triggered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/signin-otp")) {
        return new Response("Unauthorized", { status: 401 });
      }

      return new Response("not found", { status: 404 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate({
        promptForEmail: async () => TEST_EMAIL,
        promptForOtp: async () => TEST_OTP,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("EXTRACTION_FAILED");
    expect((thrown as AuthError).message).toContain("OTP verification failed");
  });
});
