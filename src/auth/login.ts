import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AuthError, type StoredToken } from "../search/types.js";
import { errorMessage } from "../render/util.js";
import { loadToken, saveToken } from "./storage.js";
import {
  BROWSER_AUTH_HELP,
  browserAuthFailureMessage,
  extractSessionTokenFromCookieHeader,
  parseBrowserAuthInput,
} from "./browser.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";
import {
  perplexityFetchText as fetchAuth,
  type PerplexityFetchResponse as AuthFetchResponse,
} from "../perplexity-fetch.js";

export { parseBrowserAuthInput } from "./browser.js";

const DESKTOP_AUTH_HELP =
  "Install the Perplexity desktop app and sign in, or set PI_AUTH_NO_BORROW=1 to skip desktop token borrowing.";
const OTP_AUTH_HELP =
  "Provide credentials via PI_PERPLEXITY_EMAIL and PI_PERPLEXITY_OTP, or run interactively to enter email and OTP.";
const AUTH_BASE_URL = "https://www.perplexity.ai/api/auth";
const TOKEN_ENV_KEYS = ["PI_PERPLEXITY_TOKEN", "PI_PERPLEXITY_AUTH_TOKEN"] as const;
const COOKIE_ENV_KEYS = ["PI_PERPLEXITY_COOKIE", "PI_PERPLEXITY_COOKIES"] as const;

const execFileAsync = promisify(execFile);

class BrowserChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserChallengeError";
  }
}

export interface AuthenticateOptions {
  signal?: AbortSignal;
  promptForEmail?: () => Promise<string | null | undefined>;
  promptForOtp?: (email: string) => Promise<string | null | undefined>;
  promptForBrowserAuth?: () => Promise<string | null | undefined>;
}

function normalizeInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stripBearerPrefix(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

function credentialsFromTokenValue(value: string): StoredToken | null {
  const token = normalizeInput(stripBearerPrefix(value));
  return token ? { type: "oauth", access: token } : null;
}

function credentialsFromEnvironment(): StoredToken | null {
  for (const key of TOKEN_ENV_KEYS) {
    const value = normalizeInput(process.env[key]);
    if (value) {
      return credentialsFromTokenValue(value);
    }
  }

  for (const key of COOKIE_ENV_KEYS) {
    const value = normalizeInput(process.env[key]);
    if (value) {
      const credentials = parseBrowserAuthInput(value);
      if (!credentials?.cookies) {
        throw new AuthError(
          "NO_TOKEN",
          `${key} is set but does not contain a signed-in Perplexity browser cookie. ${browserAuthFailureMessage(value)}`,
        );
      }
      return credentials;
    }
  }

  return null;
}

export async function saveBrowserAuthInput(input: string): Promise<StoredToken> {
  const credentials = parseBrowserAuthInput(input);
  if (!credentials) {
    throw new AuthError("NO_TOKEN", browserAuthFailureMessage(input));
  }

  await saveToken(credentials);
  return credentials;
}

async function promptForBrowserCredentials(
  options: AuthenticateOptions,
): Promise<StoredToken | null> {
  const input = normalizeInput(await options.promptForBrowserAuth?.());
  if (!input) {
    return null;
  }
  return saveBrowserAuthInput(input);
}

function buildAuthHeaders(includeJsonContentType = false): Record<string, string> {
  return {
    Accept: "application/json",
    ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
    Origin: "https://www.perplexity.ai",
    Referer: "https://www.perplexity.ai/",
    "User-Agent": PERPLEXITY_USER_AGENT,
    "X-App-ApiClient": "default",
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
  };
}

function parseJsonResponse(action: string, response: AuthFetchResponse): unknown {
  try {
    return JSON.parse(response.bodyText) as unknown;
  } catch (error) {
    throw new Error(`${action} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function formatHttpFailure(action: string, response: AuthFetchResponse): string {
  const bodyPreview = response.bodyText.trim().replace(/\s+/g, " ").slice(0, 160);
  const suffix = bodyPreview ? `: ${bodyPreview}` : "";
  return `${action} (HTTP ${response.status}${suffix}).`;
}

function isBrowserChallengeResponse(response: AuthFetchResponse): boolean {
  const body = response.bodyText.toLowerCase();
  return (
    body.includes("just a moment") ||
    body.includes("enable javascript and cookies") ||
    body.includes("_cf_chl_opt") ||
    body.includes("cdn-cgi/challenge-platform") ||
    body.includes("cf-browser-verification")
  );
}

function throwHttpFailure(action: string, response: AuthFetchResponse): never {
  const failure = formatHttpFailure(action, response);
  if (isBrowserChallengeResponse(response)) {
    throw new BrowserChallengeError(
      `${failure} Perplexity returned a browser challenge that Node fetch cannot solve.`,
    );
  }

  throw new Error(failure);
}

function cookieHeaderFrom(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function extractTokenFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  for (const key of ["token", "accessToken", "jwt", "access_token"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

async function loginWithEmailOtp(
  email: string,
  options: AuthenticateOptions,
): Promise<string> {
  const signal = options.signal ?? null;

  const csrfResponse = await fetchAuth(`${AUTH_BASE_URL}/csrf`, {
    method: "GET",
    headers: buildAuthHeaders(),
    signal,
  });

  if (!csrfResponse.ok) {
    throwHttpFailure("Failed to fetch CSRF token", csrfResponse);
  }

  const csrfPayload = parseJsonResponse("CSRF token response", csrfResponse);
  const csrfToken =
    csrfPayload && typeof csrfPayload === "object" && !Array.isArray(csrfPayload)
      ? (csrfPayload as Record<string, unknown>).csrfToken
      : null;

  if (typeof csrfToken !== "string") {
    throw new Error("CSRF token missing from Perplexity auth response.");
  }

  const cookieHeader = cookieHeaderFrom(csrfResponse.cookies);
  if (!cookieHeader) {
    throw new Error(
      "Perplexity auth response did not include Set-Cookie headers required for OTP login.",
    );
  }

  const emailHeaders = buildAuthHeaders(true);
  emailHeaders.Cookie = cookieHeader;

  const emailResponse = await fetchAuth(`${AUTH_BASE_URL}/signin-email`, {
    method: "POST",
    headers: emailHeaders,
    body: JSON.stringify({ email, csrfToken }),
    signal,
  });

  if (!emailResponse.ok) {
    throwHttpFailure("Failed to send OTP email", emailResponse);
  }

  const otp =
    normalizeInput(process.env.PI_PERPLEXITY_OTP) ??
    normalizeInput(await options.promptForOtp?.(email));

  if (!otp) {
    throw new AuthError(
      "NO_TOKEN",
      `OTP code is required to complete Perplexity login. ${OTP_AUTH_HELP}`,
    );
  }

  const otpHeaders = buildAuthHeaders(true);
  otpHeaders.Cookie = cookieHeader;

  const otpResponse = await fetchAuth(`${AUTH_BASE_URL}/signin-otp`, {
    method: "POST",
    headers: otpHeaders,
    body: JSON.stringify({ email, otp, csrfToken }),
    signal,
  });

  if (!otpResponse.ok) {
    throwHttpFailure("OTP verification failed", otpResponse);
  }

  const otpPayload = parseJsonResponse("OTP verification response", otpResponse);
  const token =
    extractTokenFromPayload(otpPayload) ??
    extractSessionTokenFromCookieHeader(cookieHeaderFrom(otpResponse.cookies));
  if (!token) {
    throw new Error("Perplexity OTP response did not include a token.");
  }

  return token;
}

/** Extract JWT from macOS Perplexity desktop app via `defaults read`. Returns null if app not installed or not logged in. */
export async function extractFromDesktopApp(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("defaults", ["read", "ai.perplexity.mac", "authToken"]);
    const token = normalizeInput(stdout);
    if (!token || token === "(null)") {
      return null;
    }

    return token;
  } catch {
    return null;
  }
}

/** Run auth strategy: load cached → env token/cookies → desktop extraction → email OTP → browser paste fallback. */
export async function authenticate(options: AuthenticateOptions = {}): Promise<StoredToken> {
  const cached = await loadToken();
  if (cached) {
    return cached;
  }

  const envCredentials = credentialsFromEnvironment();
  if (envCredentials) {
    await saveToken(envCredentials);
    return envCredentials;
  }

  const borrowDisabled = process.env.PI_AUTH_NO_BORROW === "1";
  if (!borrowDisabled) {
    const desktopToken = await extractFromDesktopApp();
    if (desktopToken) {
      const credentials: StoredToken = {
        type: "oauth",
        access: desktopToken,
      };
      await saveToken(credentials);
      return credentials;
    }
  }

  const email =
    normalizeInput(process.env.PI_PERPLEXITY_EMAIL) ??
    normalizeInput(await options.promptForEmail?.());
  if (!email) {
    const browserCredentials = await promptForBrowserCredentials(options);
    if (browserCredentials) {
      return browserCredentials;
    }

    throw new AuthError(
      "NO_TOKEN",
      `Could not find a desktop token, browser token/cookie, or email for OTP fallback. ${DESKTOP_AUTH_HELP} ${OTP_AUTH_HELP} ${BROWSER_AUTH_HELP}`,
    );
  }

  let otpToken: string;

  try {
    otpToken = await loginWithEmailOtp(email, options);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    if (error instanceof BrowserChallengeError) {
      const browserCredentials = await promptForBrowserCredentials(options);
      if (browserCredentials) {
        return browserCredentials;
      }
    }

    throw new AuthError(
      "EXTRACTION_FAILED",
      `Email OTP authentication failed: ${errorMessage(error)}. ${OTP_AUTH_HELP} ${BROWSER_AUTH_HELP}`,
    );
  }

  const credentials: StoredToken = {
    type: "oauth",
    access: otpToken,
    email,
  };
  await saveToken(credentials);
  return credentials;
}
