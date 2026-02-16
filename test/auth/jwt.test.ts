import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { decodeJwtExpiry, isJwtExpired } from "../../src/auth/jwt.js";

const FIXED_NOW = Date.UTC(2026, 1, 16, 12, 0, 0);

function createJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("jwt helpers", () => {
  const originalNow = Date.now;

  beforeEach(() => {
    Date.now = () => FIXED_NOW;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  test("decodeJwtExpiry returns expiry in ms with 5 minute safety margin", () => {
    const expSeconds = Math.floor((FIXED_NOW + 2 * 60 * 60 * 1000) / 1000);
    const token = createJwt(expSeconds);

    expect(decodeJwtExpiry(token)).toBe(expSeconds * 1000 - 5 * 60 * 1000);
  });

  test("decodeJwtExpiry falls back to now + 1h when token is malformed", () => {
    expect(decodeJwtExpiry("not-a-jwt")).toBe(FIXED_NOW + 60 * 60 * 1000);
  });

  test("isJwtExpired honors additional caller-provided buffer", () => {
    const expSeconds = Math.floor((FIXED_NOW + 20 * 60 * 1000) / 1000);
    const token = createJwt(expSeconds);

    expect(isJwtExpired(token)).toBe(false);
    expect(isJwtExpired(token, 16 * 60 * 1000)).toBe(true);
  });
});
