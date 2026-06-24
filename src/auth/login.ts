import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AuthError, type StoredToken } from "../search/types.js";
import { errorMessage } from "../render/util.js";
import { loadToken, saveToken } from "./storage.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";
import {
  perplexityFetchText as fetchAuth,
  type PerplexityFetchResponse as AuthFetchResponse,
} from "../perplexity-fetch.js";

const DESKTOP_AUTH_HELP =
  "Install the Perplexity desktop app and sign in, or set PI_AUTH_NO_BORROW=1 to skip desktop token borrowing.";
const OTP_AUTH_HELP =
  "Provide credentials via PI_PERPLEXITY_EMAIL and PI_PERPLEXITY_OTP, or run interactively to enter email and OTP.";
const BROWSER_AUTH_HELP =
  "If direct OTP is blocked by Cloudflare, sign in at https://www.perplexity.ai in a browser, then run /perplexity-login --browser and paste the copied cURL command, the Cookie request header, or the __Secure-next-auth.session-token value.";
const AUTH_BASE_URL = "https://www.perplexity.ai/api/auth";
const TOKEN_ENV_KEYS = ["PI_PERPLEXITY_TOKEN", "PI_PERPLEXITY_AUTH_TOKEN"] as const;
const COOKIE_ENV_KEYS = ["PI_PERPLEXITY_COOKIE", "PI_PERPLEXITY_COOKIES"] as const;
const SESSION_TOKEN_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "perplexity_jwt",
  "pplx_jwt",
] as const;

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

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function stripBearerPrefix(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

function looksLikeToken(value: string): boolean {
  const token = stripBearerPrefix(value);
  const parts = token.split(".");
  return token.length >= 40 && token.startsWith("eyJ") && (parts.length === 3 || parts.length === 5);
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeCurlCommand(input: string): boolean {
  return /^\s*curl(?:\s|$)/i.test(input);
}

function curlCommandHasCookieSource(input: string): boolean {
  return (
    /(?:^|\s)(?:-H|--header)(?:\s+|=)\$?(['"])Cookie\s*:/i.test(input) ||
    /(?:^|\s)(?:-b|--cookie)(?:=|\s+)/i.test(input)
  );
}

function extractCookieHeader(input: string): string {
  const trimmed = stripMatchingQuotes(input);
  const curlHeader = trimmed.match(/(?:^|\s)(?:-H|--header)(?:\s+|=)\$?(['"])Cookie:\s*([\s\S]*?)\1/i)?.[2];
  if (curlHeader) {
    return curlHeader.trim();
  }

  const quotedCurlCookieOption = trimmed.match(/(?:^|\s)(?:-b|--cookie)(?:\s+|=)\$?(['"])([\s\S]*?)\1/i)?.[2];
  if (quotedCurlCookieOption) {
    return quotedCurlCookieOption.trim();
  }

  const unquotedCurlCookieOption = trimmed.match(/(?:^|\s)(?:-b|--cookie)=([^\s\\]+)/i)?.[1];
  if (unquotedCurlCookieOption) {
    return unquotedCurlCookieOption.trim();
  }

  const cookieLine = trimmed.split(/\r?\n/).find((line) => /^\s*Cookie\s*:/i.test(line));
  const candidate = cookieLine ?? trimmed;
  return stripMatchingQuotes(candidate.replace(/^\s*Cookie\s*:\s*/i, ""));
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = stripMatchingQuotes(part.slice(separator + 1).trim());
    if (name && value) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function cookieValueFromChunks(cookies: Map<string, string>, name: string): string | null {
  const direct = cookies.get(name);
  if (direct) {
    return direct;
  }

  const chunks: string[] = [];
  for (let index = 0; ; index += 1) {
    const chunk = cookies.get(`${name}.${index}`);
    if (!chunk) {
      break;
    }
    chunks.push(chunk);
  }

  return chunks.length > 0 ? chunks.join("") : null;
}

function extractSessionTokenFromCookieHeader(cookieHeader: string): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  for (const name of SESSION_TOKEN_COOKIE_NAMES) {
    const value = cookieValueFromChunks(cookies, name);
    const token = normalizeInput(value ? decodeCookieValue(value) : null);
    if (token) {
      return token;
    }
  }
  return null;
}

function credentialsFromTokenValue(value: string): StoredToken | null {
  const token = normalizeInput(stripBearerPrefix(value));
  return token ? { type: "oauth", access: token } : null;
}

function credentialsFromCookieValue(value: string): StoredToken | null {
  const cookies = normalizeInput(extractCookieHeader(value));
  if (!cookies || !cookies.includes("=")) {
    return null;
  }

  const credentials: StoredToken = { type: "oauth", cookies };
  const sessionToken = extractSessionTokenFromCookieHeader(cookies);
  if (sessionToken && looksLikeToken(sessionToken)) {
    credentials.access = sessionToken;
  }
  return credentials;
}

export function parseBrowserAuthInput(input: string): StoredToken | null {
  const normalized = normalizeInput(input);
  if (!normalized) {
    return null;
  }

  const bearerToken = normalizeInput(stripBearerPrefix(normalized));
  if (bearerToken && looksLikeToken(bearerToken)) {
    return { type: "oauth", access: bearerToken };
  }

  const cookieCredentials = credentialsFromCookieValue(normalized);
  const cookies = cookieCredentials?.cookies;
  if (cookieCredentials && cookies && cookies.includes("=")) {
    const hasKnownSessionToken = Boolean(extractSessionTokenFromCookieHeader(cookies));
    if (hasKnownSessionToken) {
      return cookieCredentials;
    }
  }

  return null;
}

function browserAuthFailureMessage(input: string): string {
  const normalized = normalizeInput(input) ?? "";

  if (looksLikeCurlCommand(normalized) && !curlCommandHasCookieSource(normalized)) {
    return [
      "The cURL command you pasted does not include cookies, so it cannot be used for login.",
      "Copy a signed-in Perplexity request whose cURL contains `-b ...`, `--cookie ...`, or `-H 'Cookie: ...'`.",
      "In DevTools → Network, reload Perplexity or ask a question, then right-click a `www.perplexity.ai` request such as `perplexity_ask` → Copy → Copy as cURL.",
      "Make sure the copied text contains `__Secure-next-auth.session-token` and ideally `cf_clearance`.",
    ].join(" ");
  }

  const cookies = normalizeInput(extractCookieHeader(normalized));
  if (cookies && cookies.includes("=") && !extractSessionTokenFromCookieHeader(cookies)) {
    return [
      "I found cookies in the pasted value, but not a Perplexity signed-in session cookie.",
      "Make sure you are signed in at https://www.perplexity.ai, then copy a request whose cookies include `__Secure-next-auth.session-token`.",
      "Copy as cURL from a `perplexity_ask` request usually works best.",
    ].join(" ");
  }

  return `Could not find a Perplexity session token in the pasted browser auth value. ${BROWSER_AUTH_HELP}`;
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
