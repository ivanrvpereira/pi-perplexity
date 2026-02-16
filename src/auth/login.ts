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
const PERPLEXITY_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const PERPLEXITY_API_VERSION = "2.18";

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

function buildAuthHeaders(includeJsonContentType = false): Record<string, string> {
  return {
    Accept: "application/json",
    ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
    "User-Agent": PERPLEXITY_USER_AGENT,
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
  };
}

function extractTokenFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const possible = [candidate.token, candidate.accessToken, candidate.jwt];

  for (const token of possible) {
    if (typeof token === "string" && token.split(".").length === 3) {
      return token;
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
  const csrfResponse = await fetch(`${AUTH_BASE_URL}/csrf`, {
    method: "GET",
    headers: buildAuthHeaders(),
    signal: options.signal,
  });

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
    headers: buildAuthHeaders(true),
    body: JSON.stringify({ email, csrfToken }),
    signal: options.signal,
  });

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
    headers: buildAuthHeaders(true),
    body: JSON.stringify({ email, otp, csrfToken }),
    signal: options.signal,
  });

  if (!otpResponse.ok) {
    throw new Error(`OTP verification failed (HTTP ${otpResponse.status}).`);
  }

  const otpPayload = await readJsonResponse(otpResponse);
  const token = extractTokenFromPayload(otpPayload);

  if (!token) {
    throw new Error("Perplexity OTP response did not include a JWT token.");
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
    const token = stdout.trim();
    if (!token || token.split(".").length !== 3) {
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
      if (isJwtExpired(desktopToken)) {
        sawExpiredToken = true;
      } else {
        await saveToken({
          type: "oauth",
          access: desktopToken,
          expires: decodeJwtExpiry(desktopToken),
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

  if (isJwtExpired(otpToken)) {
    throw new AuthError(
      "EXPIRED",
      `Perplexity returned an expired token from OTP login. Re-run login and verify OTP freshness. ${OTP_AUTH_HELP}`,
    );
  }

  await saveToken({
    type: "oauth",
    access: otpToken,
    expires: decodeJwtExpiry(otpToken),
    email,
  });

  return otpToken;
}
