import { afterEach, describe, expect, mock, test } from "../test-helpers.js";

import { AuthError, type StoredToken } from "../../src/search/types.js";

const originalFetch = globalThis.fetch;
const originalBorrow = process.env.PI_AUTH_NO_BORROW;
const originalEmail = process.env.PI_PERPLEXITY_EMAIL;
const originalOtp = process.env.PI_PERPLEXITY_OTP;
const originalToken = process.env.PI_PERPLEXITY_TOKEN;
const originalCookie = process.env.PI_PERPLEXITY_COOKIE;

function createJwt(expiryMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiryMs / 1000) })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createOpaqueToken(): string {
  return "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.part2.part3.part4.part5";
}

function csrfHeaders(): [string, string][] {
  return [
    ["content-type", "application/json"],
    ["set-cookie", "next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly"],
  ];
}

async function importLoginModule() {
  return import(`../../src/auth/login.js?test=${crypto.randomUUID()}`);
}

function restoreEnv(): void {
  if (originalBorrow === undefined) {
    delete process.env.PI_AUTH_NO_BORROW;
  } else {
    process.env.PI_AUTH_NO_BORROW = originalBorrow;
  }

  if (originalEmail === undefined) {
    delete process.env.PI_PERPLEXITY_EMAIL;
  } else {
    process.env.PI_PERPLEXITY_EMAIL = originalEmail;
  }

  if (originalOtp === undefined) {
    delete process.env.PI_PERPLEXITY_OTP;
  } else {
    process.env.PI_PERPLEXITY_OTP = originalOtp;
  }

  if (originalToken === undefined) {
    delete process.env.PI_PERPLEXITY_TOKEN;
  } else {
    process.env.PI_PERPLEXITY_TOKEN = originalToken;
  }

  if (originalCookie === undefined) {
    delete process.env.PI_PERPLEXITY_COOKIE;
  } else {
    process.env.PI_PERPLEXITY_COOKIE = originalCookie;
  }
}

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("auth/login", () => {
  test("extractFromDesktopApp returns null when defaults command fails", async () => {
    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(new Error("missing defaults entry"), "", "not found");
    });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { extractFromDesktopApp } = await importLoginModule();

    const token = await extractFromDesktopApp();
    expect(token).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("extractFromDesktopApp returns JWT from defaults output", async () => {
    const desktopToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(null, `${desktopToken}\n`, "");
    }) as unknown as typeof import("node:child_process").execFile;

    (execFileMock as unknown as Record<symbol, unknown>)[
      Symbol.for("nodejs.util.promisify.custom")
    ] = async () => ({ stdout: `${desktopToken}\n`, stderr: "" });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { extractFromDesktopApp } = await importLoginModule();

    const token = await extractFromDesktopApp();
    expect(token).toBe(desktopToken);
  });

  test("extractFromDesktopApp returns opaque token from defaults output", async () => {
    const desktopToken = createOpaqueToken();
    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(null, `${desktopToken}\n`, "");
    }) as unknown as typeof import("node:child_process").execFile;

    (execFileMock as unknown as Record<symbol, unknown>)[
      Symbol.for("nodejs.util.promisify.custom")
    ] = async () => ({ stdout: `${desktopToken}\n`, stderr: "" });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { extractFromDesktopApp } = await importLoginModule();

    const token = await extractFromDesktopApp();
    expect(token).toBe(desktopToken);
  });

  test("authenticate returns cached token without desktop or OTP calls", async () => {
    const cachedToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const loadTokenMock = mock(async () => ({
      type: "oauth",
      access: cachedToken,
    }) satisfies StoredToken);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(new Error("should not run"), "", "");
    });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { authenticate } = await importLoginModule();

    const token = await authenticate();

    expect(token.access).toBe(cachedToken);
    expect(loadTokenMock).toHaveBeenCalledTimes(1);
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
    expect(clearTokenMock).toHaveBeenCalledTimes(0);
    expect(execFileMock).toHaveBeenCalledTimes(0);
  });

  test("authenticate uses OTP fallback when desktop borrowing is disabled", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const otpToken = createOpaqueToken();
    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/csrf")) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: csrfHeaders(),
        });
      }

      if (url.endsWith("/signin-email")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/signin-otp")) {
        return new Response(JSON.stringify({ token: otpToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    const token = await authenticate({
      promptForEmail: async () => "user@example.com",
      promptForOtp: async () => "123456",
    });

    expect(token.access).toBe(otpToken);
    expect(loadTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(saveTokenMock).toHaveBeenCalledTimes(1);

    const savedToken = saveTokenMock.mock.calls[0]?.[0] as StoredToken;
    expect(savedToken.type).toBe("oauth");
    expect(savedToken.access).toBe(otpToken);
    expect(savedToken.email).toBe("user@example.com");

    const signinEmailRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const signinOtpRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(signinEmailRequest.headers).get("Cookie")).toBe("next-auth.csrf-token=csrf-cookie");
    expect(new Headers(signinOtpRequest.headers).get("Cookie")).toBe("next-auth.csrf-token=csrf-cookie");
    expect(JSON.parse(String(signinEmailRequest.body))).toEqual({
      email: "user@example.com",
      csrfToken: "csrf-token",
    });
    expect(JSON.parse(String(signinOtpRequest.body))).toEqual({
      email: "user@example.com",
      otp: "123456",
      csrfToken: "csrf-token",
    });

    expect(clearTokenMock).toHaveBeenCalledTimes(0);
  });

  test("authenticate saves PI_PERPLEXITY_TOKEN without desktop or OTP calls", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    process.env.PI_PERPLEXITY_TOKEN = "env-token";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    const token = await authenticate();

    expect(token.access).toBe("env-token");
    expect(saveTokenMock).toHaveBeenCalledTimes(1);
    expect(saveTokenMock.mock.calls[0]?.[0]).toEqual({ type: "oauth", access: "env-token" });
  });

  test("authenticate saves browser Cookie header from PI_PERPLEXITY_COOKIE", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    process.env.PI_PERPLEXITY_COOKIE =
      `pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance`;

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    const token = await authenticate();

    expect(token.cookies).toContain("__Secure-next-auth.session-token=");
    expect(token.access).toBe(browserToken);
    expect(saveTokenMock).toHaveBeenCalledTimes(1);
  });

  test("authenticate rejects PI_PERPLEXITY_COOKIE without a signed-in session cookie", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    process.env.PI_PERPLEXITY_COOKIE = "pplx.visitor-id=visitor; cf_clearance=clearance";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
    expect((thrown as Error).message).toContain("PI_PERPLEXITY_COOKIE is set");
    expect((thrown as Error).message).toContain("not a Perplexity signed-in session cookie");
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
  });

  test("parseBrowserAuthInput extracts cookies from Copy as cURL", async () => {
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const curl = `curl 'https://www.perplexity.ai/rest/sse/perplexity_ask' \\
  -H 'accept: text/event-stream' \\
  -H 'cookie: pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance' \\
  --data-raw '{"query":"hello"}'`;

    const { parseBrowserAuthInput } = await importLoginModule();
    const parsed = parseBrowserAuthInput(curl);

    expect(parsed?.cookies).toBe(
      `pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance`,
    );
    expect(parsed?.access).toBe(browserToken);
  });

  test("parseBrowserAuthInput extracts cookies from --cookie= cURL form", async () => {
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const curl = `curl 'https://www.perplexity.ai/rest/sse/perplexity_ask' \\
  --cookie='pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance' \\
  --data-raw '{"query":"hello"}'`;

    const { parseBrowserAuthInput } = await importLoginModule();
    const parsed = parseBrowserAuthInput(curl);

    expect(parsed?.cookies).toBe(
      `pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance`,
    );
    expect(parsed?.access).toBe(browserToken);
  });

  test("saveBrowserAuthInput explains Copy as cURL without cookies", async () => {
    const curl = `curl 'https://www.perplexity.ai/' \\
  -H 'Upgrade-Insecure-Requests: 1' \\
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' \\
  -H 'sec-ch-ua: "Chromium";v="149", "Not)A;Brand";v="24"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "macOS"'`;

    const { saveBrowserAuthInput } = await importLoginModule();

    let thrown: unknown;
    try {
      await saveBrowserAuthInput(curl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
    expect((thrown as Error).message).toContain("The cURL command you pasted does not include cookies");
    expect((thrown as Error).message).toContain("-b");
    expect((thrown as Error).message).toContain("__Secure-next-auth.session-token");
  });

  test("authenticate reproduces Cloudflare CSRF failure without browser fallback", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const fetchMock = mock(async () =>
      new Response("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>", {
        status: 403,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate({
        promptForEmail: async () => "user@example.com",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("EXTRACTION_FAILED");
    expect((thrown as Error).message).toContain("Failed to fetch CSRF token");
    expect((thrown as Error).message).toContain("browser challenge");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
  });

  test("authenticate falls back to browser auth when OTP CSRF hits Cloudflare", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const fetchMock = mock(async () =>
      new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    const token = await authenticate({
      promptForEmail: async () => "user@example.com",
      promptForBrowserAuth: async () => `__Secure-next-auth.session-token=${browserToken}; cf_clearance=ok`,
    });

    expect(token.cookies).toContain("cf_clearance=ok");
    expect(saveTokenMock).toHaveBeenCalledTimes(1);
  });
  test("authenticate throws NO_TOKEN when no cached token and no OTP email input", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

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
    expect((thrown as AuthError).message).toContain("OTP fallback");
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
  });
});
