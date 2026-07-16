import { afterEach, beforeEach, describe, expect, test } from "./test-helpers.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerPerplexityConfigCommand } from "../src/commands/config.js";

let loadConfig: (configPath?: string) => Promise<import("../src/config.js").PerplexityConfig>;
let saveConfig: (config: import("../src/config.js").PerplexityConfig, configPath?: string) => Promise<void>;

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-command-test-"));
  configPath = join(tempDir, "config.json");

  const mod = await import(`../src/config.js?t=${Date.now()}`);
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("perplexity-config command", () => {
  test("marks the configured model as current in the select options", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

    await saveConfig({ model: "gpt54" }, configPath);

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          expect(name).toBe("perplexity-config");
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
      },
    );

    expect(handler).toBeDefined();

    let options: string[] = [];

    await handler!("", {
      ui: {
        select: async (_label: string, receivedOptions: string[]) => {
          options = receivedOptions;
          return "GPT-5.4 [current]";
        },
        notify: () => undefined,
      },
    });

    expect(options).toContain("GPT-5.4 [current]");
  });

  test("writes selected config to disk", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          expect(name).toBe("perplexity-config");
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
      },
    );

    expect(handler).toBeDefined();

    const notifications: Array<{ message: string; level: string }> = [];
    await handler!("", {
      ui: {
        select: async () => "GPT-5.4",
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ model: "gpt54" });
    expect(notifications).toContainEqual({
      message: "Perplexity config saved:\nModel: gpt54 (GPT-5.4)",
      level: "info",
    });
  });
});
