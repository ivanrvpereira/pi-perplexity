const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

/** Decode JWT payload and extract expiry as epoch ms (with 5min safety margin). Returns fallback of now+1h on decode failure. */
export function decodeJwtExpiry(token: string): number {
  const fallback = Date.now() + ONE_HOUR_MS;

  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return fallback;
    }

    const decodedPayload = decodeBase64Url(payload);
    const parsed = JSON.parse(decodedPayload) as { exp?: unknown };

    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) {
      return fallback;
    }

    const expiryMs = parsed.exp * 1000 - FIVE_MINUTES_MS;
    return Number.isFinite(expiryMs) ? expiryMs : fallback;
  } catch {
    return fallback;
  }
}

/** Returns true if the token is expired (with optional buffer). */
export function isJwtExpired(token: string, bufferMs = 0): boolean {
  return decodeJwtExpiry(token) <= Date.now() + bufferMs;
}
