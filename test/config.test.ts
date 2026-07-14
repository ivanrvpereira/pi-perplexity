import { afterEach, beforeEach, describe, expect, test } from "./test-helpers.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let loadConfig: (configPath?: string) => Promise<import("../src/config.js").PerplexityConfig>;
let saveConfig: (config: import("../src/config.js").PerplexityConfig, configPath?: string) => Promise<void>;
let resolveSearchDefaults: (
  params: { incognito?: boolean },
  config: import("../src/config.js").PerplexityConfig,
) => { model: string; incognito: boolean };

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-test-"));
  configPath = join(tempDir, "config.json");

  const mod = await import(`../src/config.js?t=${Date.now()}`);
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
  resolveSearchDefaults = mod.resolveSearchDefaults;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns empty object when file is missing", async () => {
    const config = await loadConfig(configPath);
    expect(config).toEqual({});
  });

  test("returns parsed config from file", async () => {
    await writeFile(configPath, JSON.stringify({ model: "gpt54", incognito: false }));
    const config = await loadConfig(configPath);
    expect(config.model).toBe("gpt54");
    expect(config.incognito).toBe(false);
  });

  test("throws on invalid JSON", async () => {
    await writeFile(configPath, "not json");
    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  test("throws on non-object JSON", async () => {
    await writeFile(configPath, '"just a string"');
    await expect(loadConfig(configPath)).rejects.toThrow("must contain a JSON object");
  });

  test("ignores unknown fields", async () => {
    await writeFile(configPath, JSON.stringify({ model: "gpt54", unknown: true }));
    const config = await loadConfig(configPath);
    expect(config.model).toBe("gpt54");
    expect(config).not.toHaveProperty("unknown");
  });

  test("ignores empty model string", async () => {
    await writeFile(configPath, JSON.stringify({ model: "" }));
    const config = await loadConfig(configPath);
    expect(config).not.toHaveProperty("model");
  });
});

describe("saveConfig", () => {
  test("writes file with 0600 permissions", async () => {
    await saveConfig({ model: "claude46sonnetthinking", incognito: true }, configPath);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.model).toBe("claude46sonnetthinking");
    expect(parsed.incognito).toBe(true);

    const stats = await stat(configPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("creates parent directories", async () => {
    const nested = join(tempDir, "a", "b", "config.json");
    await saveConfig({ model: "gpt54" }, nested);

    const raw = await readFile(nested, "utf8");
    expect(JSON.parse(raw).model).toBe("gpt54");
  });
});

describe("resolveSearchDefaults", () => {
  test("returns hardcoded defaults when no config, env, or params", () => {
    const result = resolveSearchDefaults({}, {});
    expect(result.model).toBe("pplx_pro_upgraded");
    expect(result.incognito).toBe(true);
  });

  test("config file values override defaults", () => {
    const result = resolveSearchDefaults({}, { model: "gpt54", incognito: false });
    expect(result.model).toBe("gpt54");
    expect(result.incognito).toBe(false);
  });

  test("env var '0' disables incognito", () => {
    const original = process.env.PI_PERPLEXITY_INCOGNITO;
    try {
      process.env.PI_PERPLEXITY_INCOGNITO = "0";
      const result = resolveSearchDefaults({}, {});
      expect(result.incognito).toBe(false);
    } finally {
      if (original === undefined) delete process.env.PI_PERPLEXITY_INCOGNITO;
      else process.env.PI_PERPLEXITY_INCOGNITO = original;
    }
  });

  test("env vars override config file", () => {
    const originalModel = process.env.PI_PERPLEXITY_MODEL;
    const originalIncognito = process.env.PI_PERPLEXITY_INCOGNITO;
    try {
      process.env.PI_PERPLEXITY_MODEL = "experimental";
      process.env.PI_PERPLEXITY_INCOGNITO = "false";

      const result = resolveSearchDefaults({}, { model: "gpt54", incognito: true });
      expect(result.model).toBe("experimental");
      expect(result.incognito).toBe(false);
    } finally {
      if (originalModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
      else process.env.PI_PERPLEXITY_MODEL = originalModel;
      if (originalIncognito === undefined) delete process.env.PI_PERPLEXITY_INCOGNITO;
      else process.env.PI_PERPLEXITY_INCOGNITO = originalIncognito;
    }
  });

  test("whitespace-only model env var falls back to config", () => {
    const originalModel = process.env.PI_PERPLEXITY_MODEL;
    try {
      process.env.PI_PERPLEXITY_MODEL = "   ";

      const result = resolveSearchDefaults({}, { model: "gpt54" });
      expect(result.model).toBe("gpt54");
    } finally {
      if (originalModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
      else process.env.PI_PERPLEXITY_MODEL = originalModel;
    }
  });

  test("per-call incognito overrides env/config without exposing model override", () => {
    const originalModel = process.env.PI_PERPLEXITY_MODEL;
    try {
      process.env.PI_PERPLEXITY_MODEL = "experimental";

      const result = resolveSearchDefaults(
        { incognito: false },
        { model: "gpt54", incognito: true },
      );
      expect(result.model).toBe("experimental");
      expect(result.incognito).toBe(false);
    } finally {
      if (originalModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
      else process.env.PI_PERPLEXITY_MODEL = originalModel;
    }
  });
});
