import { afterEach, describe, expect, mock, test } from "bun:test";

import { AuthError, type StoredToken } from "../../src/search/types.js";

const originalFetch = globalThis.fetch;
const originalBorrow = process.env.PI_AUTH_NO_BORROW;
const originalEmail = process.env.PI_PERPLEXITY_EMAIL;
const originalOtp = process.env.PI_PERPLEXITY_OTP;

function createJwt(expiryMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiryMs / 1000) })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createOpaqueToken(): string {
  return "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.part2.part3.part4.part5";
}

async function importLoginModule() {
  return import(`../../src/auth/login.ts?test=${crypto.randomUUID()}`);
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

    expect(token).toBe(cachedToken);
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
          headers: { "content-type": "application/json" },
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

    expect(token).toBe(otpToken);
    expect(loadTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(saveTokenMock).toHaveBeenCalledTimes(1);

    const savedToken = saveTokenMock.mock.calls[0]?.[0] as StoredToken;
    expect(savedToken.type).toBe("oauth");
    expect(savedToken.access).toBe(otpToken);
    expect(savedToken.email).toBe("user@example.com");

    const signinEmailRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const signinOtpRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
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
