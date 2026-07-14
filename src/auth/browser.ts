import type { StoredToken } from "../search/types.js";

export const BROWSER_AUTH_HELP =
  "If direct OTP is blocked by Cloudflare, sign in at https://www.perplexity.ai in a browser, then run /perplexity-login --browser and paste the copied cURL command, the Cookie request header, or the __Secure-next-auth.session-token value.";

const SESSION_TOKEN_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "perplexity_jwt",
  "pplx_jwt",
] as const;

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

  const unquotedCurlCookieOption = trimmed.match(/(?:^|\s)(?:-b|--cookie)(?:=|\s+)([^\s\\]+)/i)?.[1];
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

export function extractSessionTokenFromCookieHeader(cookieHeader: string): string | null {
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

export function browserAuthFailureMessage(input: string): string {
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

export function browserLoginInstructions(): string {
  return [
    "Browser login:",
    "1. Open https://www.perplexity.ai and sign in.",
    "2. Open DevTools → Network.",
    "3. Reload the page or ask one Perplexity question.",
    "4. Right-click a www.perplexity.ai request → Copy → Copy as cURL.",
    "5. Paste the copied cURL command here.",
    "",
    "The copied text must include -b, --cookie, or Cookie:, and should include __Secure-next-auth.session-token.",
    "If it does not, copy a different www.perplexity.ai request, preferably perplexity_ask.",
    "Alternatives: paste the request Cookie header, or paste the __Secure-next-auth.session-token value.",
  ].join("\n");
}
