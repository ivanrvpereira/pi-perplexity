import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { StoredToken } from "../search/types.js";

const TOKEN_PATH = join(homedir(), ".config", "pi-perplexity", "auth.json");

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredToken>;
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    candidate.access.length > 0 &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires)
  );
}

/** Load persisted token from ~/.config/pi-perplexity/auth.json. Returns null if missing or unreadable. */
export async function loadToken(): Promise<StoredToken | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredToken(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Save token to disk with 0600 permissions. Creates directory if needed. */
export async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  await chmod(TOKEN_PATH, 0o600);
}

/** Delete the stored token file. No-op if missing. */
export async function clearToken(): Promise<void> {
  await rm(TOKEN_PATH, { force: true });
}
