import { afterEach, beforeEach, describe, expect, test } from "./test-helpers.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let loadConfig: (configPath?: string) => Promise<import("../src/config.js").PerplexityConfig>;
let saveConfig: (config: import("../src/config.js").PerplexityConfig, configPath?: string) => Promise<void>;
let resolveDefaultModel: (
  config: import("../src/config.js").PerplexityConfig,
) => string;

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-test-"));
  configPath = join(tempDir, "config.json");

  const mod = await import(`../src/config.js?t=${Date.now()}`);
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
  resolveDefaultModel = mod.resolveDefaultModel;
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
    await writeFile(configPath, JSON.stringify({ model: "gpt54" }));
    const config = await loadConfig(configPath);
    expect(config.model).toBe("gpt54");
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
    await writeFile(configPath, JSON.stringify({ model: "gpt54", unknown: true, incognito: false }));
    const config = await loadConfig(configPath);
    expect(config.model).toBe("gpt54");
    expect(config).not.toHaveProperty("unknown");
    expect(config).not.toHaveProperty("incognito");
  });

  test("ignores empty model string", async () => {
    await writeFile(configPath, JSON.stringify({ model: "" }));
    const config = await loadConfig(configPath);
    expect(config).not.toHaveProperty("model");
  });
});

describe("saveConfig", () => {
  test("writes file with 0600 permissions", async () => {
    await saveConfig({ model: "claude46sonnetthinking" }, configPath);

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.model).toBe("claude46sonnetthinking");

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

describe("resolveDefaultModel", () => {
  test("returns hardcoded default when no config or env", () => {
    expect(resolveDefaultModel({})).toBe("pplx_pro_upgraded");
  });

  test("config file model overrides default", () => {
    expect(resolveDefaultModel({ model: "gpt54" })).toBe("gpt54");
  });

  test("env var overrides config file", () => {
    const originalModel = process.env.PI_PERPLEXITY_MODEL;
    try {
      process.env.PI_PERPLEXITY_MODEL = "experimental";
      expect(resolveDefaultModel({ model: "gpt54" })).toBe("experimental");
    } finally {
      if (originalModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
      else process.env.PI_PERPLEXITY_MODEL = originalModel;
    }
  });

  test("whitespace-only model env var falls back to config", () => {
    const originalModel = process.env.PI_PERPLEXITY_MODEL;
    try {
      process.env.PI_PERPLEXITY_MODEL = "   ";
      expect(resolveDefaultModel({ model: "gpt54" })).toBe("gpt54");
    } finally {
      if (originalModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
      else process.env.PI_PERPLEXITY_MODEL = originalModel;
    }
  });
});
