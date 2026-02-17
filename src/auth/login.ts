import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AuthError } from "../search/types.js";
import { decodeJwtExpiry, isJwtExpired } from "./jwt.js";
import { clearToken, loadToken, saveToken } from "./storage.js";

const DESKTOP_AUTH_HELP =
  "Install the Perplexity desktop app and sign in, or set PI_AUTH_NO_BORROW=1 to skip desktop token borrowing.";
const OTP_AUTH_HELP =
  "Provide credentials via PI_PERPLEXITY_EMAIL and PI_PERPLEXITY_OTP, or run interactively to enter email and OTP.";
const AUTH_BASE_URL = "https://www.perplexity.ai/api/auth";
const AUTH_SESSION_URL = `${AUTH_BASE_URL}/session`;
const PERPLEXITY_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const PERPLEXITY_API_VERSION = "2.18";
const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

const execFileAsync = promisify(execFile);

export interface AuthenticateOptions {
  signal?: AbortSignal;
  promptForEmail?: () => Promise<string | null | undefined>;
  promptForOtp?: (email: string) => Promise<string | null | undefined>;
}

function normalizeInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLikelyPerplexityToken(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const token = value.trim();
  if (!token || token === "(null)") {
    return false;
  }

  return token.includes(".") && token.length >= 20;
}

function buildAuthHeaders(
  includeJsonContentType = false,
  cookieHeader?: string,
): Record<string, string> {
  return {
    Accept: "application/json",
    ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    "User-Agent": PERPLEXITY_USER_AGENT,
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
  };
}

function getSetCookieValues(headers: Headers): string[] {
  const withSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };

  if (typeof withSetCookie.getSetCookie === "function") {
    return withSetCookie.getSetCookie();
  }

  if (typeof withSetCookie.raw === "function") {
    const raw = withSetCookie.raw();
    const setCookies = raw["set-cookie"];
    if (Array.isArray(setCookies)) {
      return setCookies;
    }
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

class CookieJar {
  #cookies = new Map<string, string>();

  capture(headers: Headers): void {
    for (const setCookie of getSetCookieValues(headers)) {
      const firstPart = setCookie.split(";")[0]?.trim();
      if (!firstPart) {
        continue;
      }

      const eqIndex = firstPart.indexOf("=");
      if (eqIndex <= 0) {
        continue;
      }

      const name = firstPart.slice(0, eqIndex).trim();
      const value = firstPart.slice(eqIndex + 1).trim();
      if (!name || !value) {
        continue;
      }

      this.#cookies.set(name, decodeCookieValue(value));
    }
  }

  toHeader(): string | undefined {
    if (this.#cookies.size === 0) {
      return undefined;
    }

    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }
}

function extractTokenFromCookies(headers: Headers, jar?: CookieJar): string | null {
  for (const cookieName of SESSION_COOKIE_NAMES) {
    const fromJar = jar?.get(cookieName);
    if (isLikelyPerplexityToken(fromJar)) {
      return fromJar;
    }
  }

  for (const setCookie of getSetCookieValues(headers)) {
    for (const cookieName of SESSION_COOKIE_NAMES) {
      const pattern = new RegExp(`(?:^|[;,]\\s*)${cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`);
      const match = setCookie.match(pattern);
      if (!match) {
        continue;
      }

      const decoded = decodeCookieValue(match[1] ?? "");
      if (isLikelyPerplexityToken(decoded)) {
        return decoded;
      }
    }
  }

  return null;
}

function extractTokenFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const tokenKeyPattern = /(token|jwt|access)/i;
  const queue: unknown[] = [payload];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      for (const value of current) {
        queue.push(value);
      }
      continue;
    }

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (tokenKeyPattern.test(key) && isLikelyPerplexityToken(value)) {
        return value.trim();
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function loginWithEmailOtp(
  email: string,
  options: AuthenticateOptions,
): Promise<string> {
  const cookieJar = new CookieJar();

  const csrfResponse = await fetch(`${AUTH_BASE_URL}/csrf`, {
    method: "GET",
    headers: buildAuthHeaders(false, cookieJar.toHeader()),
    signal: options.signal,
  });

  cookieJar.capture(csrfResponse.headers);

  if (!csrfResponse.ok) {
    throw new Error(`Failed to fetch CSRF token (HTTP ${csrfResponse.status}).`);
  }

  const csrfPayload = (await readJsonResponse(csrfResponse)) as { csrfToken?: unknown } | null;
  const csrfToken =
    csrfPayload && typeof csrfPayload.csrfToken === "string" ? csrfPayload.csrfToken : null;

  if (!csrfToken) {
    throw new Error("CSRF token missing from Perplexity auth response.");
  }

  const emailResponse = await fetch(`${AUTH_BASE_URL}/signin-email`, {
    method: "POST",
    headers: buildAuthHeaders(true, cookieJar.toHeader()),
    body: JSON.stringify({ email, csrfToken }),
    signal: options.signal,
  });

  cookieJar.capture(emailResponse.headers);

  if (!emailResponse.ok) {
    throw new Error(`Failed to send OTP email (HTTP ${emailResponse.status}).`);
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

  const otpResponse = await fetch(`${AUTH_BASE_URL}/signin-otp`, {
    method: "POST",
    headers: buildAuthHeaders(true, cookieJar.toHeader()),
    body: JSON.stringify({ email, otp, csrfToken }),
    signal: options.signal,
  });

  cookieJar.capture(otpResponse.headers);

  if (!otpResponse.ok) {
    throw new Error(`OTP verification failed (HTTP ${otpResponse.status}).`);
  }

  const otpPayload = await readJsonResponse(otpResponse);
  const directToken = extractTokenFromPayload(otpPayload);
  if (directToken) {
    return directToken;
  }

  const cookieToken = extractTokenFromCookies(otpResponse.headers, cookieJar);
  if (cookieToken) {
    return cookieToken;
  }

  const sessionResponse = await fetch(AUTH_SESSION_URL, {
    method: "GET",
    headers: buildAuthHeaders(false, cookieJar.toHeader()),
    signal: options.signal,
  });

  cookieJar.capture(sessionResponse.headers);

  if (sessionResponse.ok) {
    const sessionPayload = await readJsonResponse(sessionResponse);
    const sessionToken = extractTokenFromPayload(sessionPayload);
    if (sessionToken) {
      return sessionToken;
    }

    const sessionCookieToken = extractTokenFromCookies(sessionResponse.headers, cookieJar);
    if (sessionCookieToken) {
      return sessionCookieToken;
    }
  }

  const otpBodyHint = otpPayload ? JSON.stringify(otpPayload).slice(0, 300) : "(empty or non-JSON)";
  const otpKeys =
    otpPayload && typeof otpPayload === "object"
      ? Object.keys(otpPayload as Record<string, unknown>).join(", ")
      : "N/A";

  throw new Error(
    `Perplexity OTP response did not include an access token. OTP keys: ${otpKeys}. OTP body preview: ${otpBodyHint}. Session status: ${sessionResponse.status}.`,
  );
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

/** Run MVP auth strategy: load cached → try desktop extraction → save → throw AuthError if all fail. */
export async function authenticate(options: AuthenticateOptions = {}): Promise<string> {
  const cached = await loadToken();
  let sawExpiredToken = false;

  if (cached) {
    if (cached.expires > Date.now()) {
      return cached.access;
    }

    if (!isJwtExpired(cached.access)) {
      return cached.access;
    }

    sawExpiredToken = true;
    await clearToken();
  }

  const borrowDisabled = process.env.PI_AUTH_NO_BORROW === "1";

  if (!borrowDisabled) {
    let desktopToken: string | null;

    try {
      desktopToken = await extractFromDesktopApp();
    } catch {
      throw new AuthError(
        "EXTRACTION_FAILED",
        `Failed to read token from the Perplexity desktop app. Ensure the app is installed and signed in. ${DESKTOP_AUTH_HELP}`,
      );
    }

    if (desktopToken) {
      const desktopExpiry = decodeJwtExpiry(desktopToken);
      if (desktopExpiry <= Date.now()) {
        sawExpiredToken = true;
      } else {
        await saveToken({
          type: "oauth",
          access: desktopToken,
          expires: desktopExpiry,
        });

        return desktopToken;
      }
    }
  }

  const email =
    normalizeInput(process.env.PI_PERPLEXITY_EMAIL) ??
    normalizeInput(await options.promptForEmail?.());

  if (!email) {
    if (sawExpiredToken) {
      throw new AuthError(
        "EXPIRED",
        `Perplexity token is expired and no email was provided for OTP fallback. ${DESKTOP_AUTH_HELP} ${OTP_AUTH_HELP}`,
      );
    }

    throw new AuthError(
      "NO_TOKEN",
      `Could not find a desktop token and no email was provided for OTP fallback. ${DESKTOP_AUTH_HELP} ${OTP_AUTH_HELP}`,
    );
  }

  let otpToken: string;

  try {
    otpToken = await loginWithEmailOtp(email, options);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    throw new AuthError(
      "EXTRACTION_FAILED",
      `Email OTP authentication failed: ${(error as Error).message}. ${OTP_AUTH_HELP}`,
    );
  }

  const otpExpiry = decodeJwtExpiry(otpToken);
  if (otpExpiry <= Date.now()) {
    throw new AuthError(
      "EXPIRED",
      `Perplexity returned an expired token from OTP login. Re-run login and verify OTP freshness. ${OTP_AUTH_HELP}`,
    );
  }

  await saveToken({
    type: "oauth",
    access: otpToken,
    expires: otpExpiry,
    email,
  });

  return otpToken;
}
