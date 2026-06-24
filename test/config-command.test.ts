import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, test } from "./test-helpers.js";
import { registerPerplexityConfigCommand } from "../src/commands/config.js";

let loadConfig: (configPath?: string) => Promise<import("../src/config.js").PerplexityConfig>;
let saveConfig: (config: import("../src/config.js").PerplexityConfig, configPath?: string) => Promise<void>;

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-command-test-"));
  configPath = join(tempDir, "config.json");

  const mod = await import(`../src/config.js?t=${crypto.randomUUID()}`);
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("perplexity-config command", () => {
  function registerHandler(): (args: string, ctx: any) => Promise<void> {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          assert.equal(name, "perplexity-config");
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
      },
    );

    assert.ok(handler);
    return handler;
  }

  test("marks the configured model as current in the select options", async () => {
    await saveConfig({ model: "gpt54" }, configPath);
    const handler = registerHandler();
    let options: string[] = [];

    await handler("", {
      ui: {
        select: async (_label: string, receivedOptions: string[]) => {
          options = receivedOptions;
          return "GPT-5.4 [current]";
        },
        notify: () => undefined,
      },
    });

    assert.ok(options.includes("GPT-5.4 [current]"));
  });

  test("writes selected model to disk", async () => {
    const handler = registerHandler();
    const notifications: Array<{ message: string; level: string }> = [];

    await handler("", {
      ui: {
        select: async () => "GPT-5.4",
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { model: "gpt54" });
    assert.deepEqual(notifications, [
      {
        message: "Perplexity config saved:\nModel: gpt54 (GPT-5.4)",
        level: "info",
      },
    ]);
  });
});
