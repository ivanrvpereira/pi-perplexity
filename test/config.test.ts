import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, test } from "./test-helpers.js";

let loadConfig: (configPath?: string) => Promise<import("../src/config.js").PerplexityConfig>;
let saveConfig: (config: import("../src/config.js").PerplexityConfig, configPath?: string) => Promise<void>;
let resolveSearchModel: (config: import("../src/config.js").PerplexityConfig) => string;

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-test-"));
  configPath = join(tempDir, "config.json");

  const mod = await import(`../src/config.js?t=${crypto.randomUUID()}`);
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
  resolveSearchModel = mod.resolveSearchModel;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns empty object when file is missing", async () => {
    assert.deepEqual(await loadConfig(configPath), {});
  });

  test("returns parsed model from file", async () => {
    await writeFile(configPath, JSON.stringify({ model: "gpt54" }));

    assert.deepEqual(await loadConfig(configPath), { model: "gpt54" });
  });

  test("throws on invalid JSON", async () => {
    await writeFile(configPath, "not json");

    await assert.rejects(loadConfig(configPath), SyntaxError);
  });

  test("throws on non-object JSON", async () => {
    await writeFile(configPath, '"just a string"');

    await assert.rejects(loadConfig(configPath), /must contain a JSON object/);
  });

  test("ignores unknown fields and empty model strings", async () => {
    await writeFile(configPath, JSON.stringify({ model: "", incognito: false, unknown: true }));

    assert.deepEqual(await loadConfig(configPath), {});
  });
});

describe("saveConfig", () => {
  test("writes file with 0600 permissions", async () => {
    await saveConfig({ model: "claude46sonnetthinking" }, configPath);

    const raw = await readFile(configPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { model: "claude46sonnetthinking" });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  });

  test("creates parent directories", async () => {
    const nested = join(tempDir, "a", "b", "config.json");

    await saveConfig({ model: "gpt54" }, nested);

    assert.equal(JSON.parse(await readFile(nested, "utf8")).model, "gpt54");
  });
});

describe("resolveSearchModel", () => {
  test("uses default, config, and env in priority order", () => {
    const originalModel = process.env.PI_PERPLEXITY_MODEL;
    try {
      assert.equal(resolveSearchModel({}), "pplx_pro_upgraded");
      assert.equal(resolveSearchModel({ model: "gpt54" }), "gpt54");

      process.env.PI_PERPLEXITY_MODEL = "experimental";
      assert.equal(resolveSearchModel({ model: "gpt54" }), "experimental");

      process.env.PI_PERPLEXITY_MODEL = "   ";
      assert.equal(resolveSearchModel({ model: "gpt54" }), "gpt54");
    } finally {
      if (originalModel === undefined) delete process.env.PI_PERPLEXITY_MODEL;
      else process.env.PI_PERPLEXITY_MODEL = originalModel;
    }
  });
});
