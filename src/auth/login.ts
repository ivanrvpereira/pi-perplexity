import { AuthError } from "../search/types.js";
import { decodeJwtExpiry, isJwtExpired } from "./jwt.js";
import { clearToken, loadToken, saveToken } from "./storage.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const DESKTOP_AUTH_HELP =
  "Install the Perplexity desktop app and sign in, or set PI_AUTH_NO_BORROW=1 to skip desktop token borrowing.";
const execFileAsync = promisify(execFile);

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
export async function authenticate(): Promise<string> {
  const cached = await loadToken();
  if (cached) {
    if (!isJwtExpired(cached.access)) {
      return cached.access;
    }

    await clearToken();

    if (process.env.PI_AUTH_NO_BORROW === "1") {
      throw new AuthError(
        "EXPIRED",
        `Cached token is expired. Re-authenticate in Perplexity desktop app, then retry. ${DESKTOP_AUTH_HELP}`,
      );
    }
  }

  if (process.env.PI_AUTH_NO_BORROW === "1") {
    throw new AuthError(
      "NO_TOKEN",
      `No valid cached token found and desktop token borrowing is disabled. ${DESKTOP_AUTH_HELP}`,
    );
  }

  let desktopToken: string | null;
  try {
    desktopToken = await extractFromDesktopApp();
  } catch {
    throw new AuthError(
      "EXTRACTION_FAILED",
      `Failed to read token from the Perplexity desktop app. Ensure the app is installed and signed in. ${DESKTOP_AUTH_HELP}`,
    );
  }

  if (!desktopToken) {
    throw new AuthError(
      "NO_TOKEN",
      `Could not find a desktop token. Ensure Perplexity desktop app is installed and signed in. ${DESKTOP_AUTH_HELP}`,
    );
  }

  if (isJwtExpired(desktopToken)) {
    throw new AuthError(
      "EXPIRED",
      `Desktop token is expired. Open Perplexity desktop app and sign in again, then retry. ${DESKTOP_AUTH_HELP}`,
    );
  }

  await saveToken({
    type: "oauth",
    access: desktopToken,
    expires: decodeJwtExpiry(desktopToken),
  });

  return desktopToken;
}
