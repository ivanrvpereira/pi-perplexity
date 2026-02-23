import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AuthError } from "../search/types.js";
import { errorMessage } from "../render/util.js";
import { loadToken, saveToken } from "./storage.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";

const DESKTOP_AUTH_HELP =
  "Install the Perplexity desktop app and sign in, or set PI_AUTH_NO_BORROW=1 to skip desktop token borrowing.";
const OTP_AUTH_HELP =
  "Provide credentials via PI_PERPLEXITY_EMAIL and PI_PERPLEXITY_OTP, or run interactively to enter email and OTP.";
const AUTH_BASE_URL = "https://www.perplexity.ai/api/auth";

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
  const signal = options.signal ?? null;

  const csrfResponse = await fetch(`${AUTH_BASE_URL}/csrf`, {
    method: "GET",
    headers: buildAuthHeaders(),
    signal,
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

  const cookies = csrfResponse.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

  const emailHeaders = buildAuthHeaders(true);
  if (cookieHeader) {
    emailHeaders.Cookie = cookieHeader;
  }

  const emailResponse = await fetch(`${AUTH_BASE_URL}/signin-email`, {
    method: "POST",
    headers: emailHeaders,
    body: JSON.stringify({ email, csrfToken }),
    signal,
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

  const otpHeaders = buildAuthHeaders(true);
  if (cookieHeader) {
    otpHeaders.Cookie = cookieHeader;
  }

  const otpResponse = await fetch(`${AUTH_BASE_URL}/signin-otp`, {
    method: "POST",
    headers: otpHeaders,
    body: JSON.stringify({ email, otp, csrfToken }),
    signal,
  });

  if (!otpResponse.ok) {
    throw new Error(`OTP verification failed (HTTP ${otpResponse.status}).`);
  }

  const otpPayload = await readJsonResponse(otpResponse);
  const token = extractTokenFromPayload(otpPayload);
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

/** Run auth strategy: load cached → try desktop extraction → save → throw AuthError if all fail. */
export async function authenticate(options: AuthenticateOptions = {}): Promise<string> {
  const cached = await loadToken();
  if (cached) {
    return cached.access;
  }

  const borrowDisabled = process.env.PI_AUTH_NO_BORROW === "1";
  if (!borrowDisabled) {
    const desktopToken = await extractFromDesktopApp();
    if (desktopToken) {
      await saveToken({
        type: "oauth",
        access: desktopToken,
      });
      return desktopToken;
    }
  }
  const email =
    normalizeInput(process.env.PI_PERPLEXITY_EMAIL) ??
    normalizeInput(await options.promptForEmail?.());
  if (!email) {
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
      `Email OTP authentication failed: ${errorMessage(error)}. ${OTP_AUTH_HELP}`,
    );
  }

  await saveToken({
    type: "oauth",
    access: otpToken,
    email,
  });
  return otpToken;
}
