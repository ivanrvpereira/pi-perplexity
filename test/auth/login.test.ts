import assert from "node:assert/strict";

import { afterEach, describe, mock, test } from "../test-helpers.js";
import { AuthError, type StoredToken } from "../../src/search/types.js";

const originalFetch = globalThis.fetch;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalEnv = {
  PI_AUTH_NO_BORROW: process.env.PI_AUTH_NO_BORROW,
  PI_PERPLEXITY_EMAIL: process.env.PI_PERPLEXITY_EMAIL,
  PI_PERPLEXITY_OTP: process.env.PI_PERPLEXITY_OTP,
};

const TEST_EMAIL = "user@test.com";
const TEST_OTP = "9f3e2-knzol";
const CSRF_TOKEN = "csrf-token";
const OTP_TOKEN = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..parts";
const CSRF_COOKIES = [
  "next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly",
  "cf_clearance=clearance-cookie; Path=/; Secure",
];
const CSRF_COOKIE_HEADER = "next-auth.csrf-token=csrf-cookie; cf_clearance=clearance-cookie";

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonHeaders(cookies: string[] = []): [string, string][] {
  return [
    ["content-type", "application/json; charset=utf-8"],
    ...cookies.map((cookie): [string, string] => ["set-cookie", cookie]),
  ];
}

function mockStorage(loadToken: StoredToken | null = null) {
  const loadTokenMock = mock(async () => loadToken);
  const saveTokenMock = mock(async (_token: StoredToken) => undefined);
  const clearTokenMock = mock(async () => undefined);

  mock.module("../../src/auth/storage.js", () => ({
    loadToken: loadTokenMock,
    saveToken: saveTokenMock,
    clearToken: clearTokenMock,
  }));

  return { loadTokenMock, saveTokenMock, clearTokenMock };
}

function buildOtpFetchMock(options: { cookies?: string[]; otpStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const cookies = options.cookies ?? CSRF_COOKIES;
  const otpStatus = options.otpStatus ?? 200;

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(init === undefined ? { url } : { url, init });

    if (url.endsWith("/csrf")) {
      return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
        status: 200,
        headers: jsonHeaders(cookies),
      });
    }

    if (url.endsWith("/signin-email")) {
      return new Response(JSON.stringify({ success: "Email sign in triggered" }), {
        status: 200,
        headers: jsonHeaders(),
      });
    }

    if (url.endsWith("/signin-otp")) {
      return new Response(JSON.stringify({ token: OTP_TOKEN, status: "success" }), {
        status: otpStatus,
        headers: jsonHeaders(),
      });
    }

    return new Response("not found", { status: 404 });
  });

  return { fetchMock, calls };
}

async function importLoginModule() {
  return import(`../../src/auth/login.js?test=${crypto.randomUUID()}`);
}

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  restoreEnv();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("auth/login", () => {
  test("extractFromDesktopApp returns null when defaults command fails", async () => {
    setPlatform("darwin");
    const execFileMock = mock((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void;
      callback(new Error("missing defaults entry"), "", "not found");
    });

    mock.module("node:child_process", () => ({ execFile: execFileMock }));

    const { extractFromDesktopApp } = await importLoginModule();

    assert.equal(await extractFromDesktopApp(), null);
    assert.equal(execFileMock.mock.calls.length, 1);
  });

  test("extractFromDesktopApp returns a trimmed token from defaults output", async () => {
    setPlatform("darwin");
    const desktopToken = "desktop-token";
    const execFileMock = mock((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void;
      callback(null, `${desktopToken}\n`, "");
    });
    (execFileMock as unknown as Record<symbol, unknown>)[
      Symbol.for("nodejs.util.promisify.custom")
    ] = async () => ({ stdout: `${desktopToken}\n`, stderr: "" });

    mock.module("node:child_process", () => ({ execFile: execFileMock }));

    const { extractFromDesktopApp } = await importLoginModule();

    assert.equal(await extractFromDesktopApp(), desktopToken);
  });

  test("authenticate returns cached token before desktop or OTP work", async () => {
    const cachedToken: StoredToken = { type: "oauth", access: "cached-token" };
    const { loadTokenMock, saveTokenMock } = mockStorage(cachedToken);
    const execFileMock = mock(() => undefined);
    mock.module("node:child_process", () => ({ execFile: execFileMock }));

    const { authenticate } = await importLoginModule();

    assert.equal(await authenticate(), "cached-token");
    assert.equal(loadTokenMock.mock.calls.length, 1);
    assert.equal(saveTokenMock.mock.calls.length, 0);
    assert.equal(execFileMock.mock.calls.length, 0);
  });

  test("authenticate completes email OTP flow with expected request shape", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    const { saveTokenMock } = mockStorage();
    const { fetchMock, calls } = buildOtpFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    assert.equal(
      await authenticate({
        promptForEmail: async () => TEST_EMAIL,
        promptForOtp: async () => TEST_OTP,
      }),
      OTP_TOKEN,
    );

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.equal(calls[0]?.init?.method ?? "GET", "GET");
    assert.equal(calls[1]?.init?.method, "POST");
    assert.equal(calls[2]?.init?.method, "POST");
    assert.equal(new Headers(calls[1]?.init?.headers).get("Cookie"), CSRF_COOKIE_HEADER);
    assert.equal(new Headers(calls[2]?.init?.headers).get("Cookie"), CSRF_COOKIE_HEADER);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      email: TEST_EMAIL,
      csrfToken: CSRF_TOKEN,
    });
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
      email: TEST_EMAIL,
      otp: TEST_OTP,
      csrfToken: CSRF_TOKEN,
    });
    assert.deepEqual(saveTokenMock.mock.calls[0]?.[0], {
      type: "oauth",
      access: OTP_TOKEN,
      email: TEST_EMAIL,
    });
  });

  test("environment email and OTP bypass prompts", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    process.env.PI_PERPLEXITY_EMAIL = TEST_EMAIL;
    process.env.PI_PERPLEXITY_OTP = TEST_OTP;
    mockStorage();
    const { fetchMock } = buildOtpFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const promptForEmail = mock(async () => "wrong@test.com");
    const promptForOtp = mock(async () => "wrong");

    const { authenticate } = await importLoginModule();

    assert.equal(await authenticate({ promptForEmail, promptForOtp }), OTP_TOKEN);
    assert.equal(promptForEmail.mock.calls.length, 0);
    assert.equal(promptForOtp.mock.calls.length, 0);
  });

  test("authenticate throws NO_TOKEN when email or OTP is missing", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    mockStorage();

    const { authenticate } = await importLoginModule();

    await assert.rejects(
      authenticate({ promptForEmail: async () => undefined }),
      (error) => error instanceof AuthError && error.code === "NO_TOKEN",
    );

    const { fetchMock } = buildOtpFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await assert.rejects(
      authenticate({
        promptForEmail: async () => TEST_EMAIL,
        promptForOtp: async () => undefined,
      }),
      (error) => error instanceof AuthError && error.code === "NO_TOKEN",
    );
  });

  test("authenticate wraps Perplexity OTP protocol failures", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    mockStorage();
    const { fetchMock } = buildOtpFetchMock({ cookies: [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    await assert.rejects(
      authenticate({ promptForEmail: async () => TEST_EMAIL }),
      (error) => error instanceof AuthError && error.code === "EXTRACTION_FAILED",
    );

    mock.restore();
    process.env.PI_AUTH_NO_BORROW = "1";
    mockStorage();
    const failedOtp = buildOtpFetchMock({ otpStatus: 401 });
    globalThis.fetch = failedOtp.fetchMock as unknown as typeof fetch;
    const { authenticate: authenticateAgain } = await importLoginModule();

    await assert.rejects(
      authenticateAgain({
        promptForEmail: async () => TEST_EMAIL,
        promptForOtp: async () => TEST_OTP,
      }),
      (error) => error instanceof AuthError && error.code === "EXTRACTION_FAILED",
    );
  });
});
