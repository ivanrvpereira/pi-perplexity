import assert from "node:assert/strict";

import { describe, test } from "./test-helpers.js";

describe("extension entrypoint", () => {
  test("registers the config command", async () => {
    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);
    const commands: string[] = [];

    registerExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool() {
        return undefined;
      },
    } as any);

    assert.ok(commands.includes("perplexity-login"));
    assert.ok(commands.includes("perplexity-config"));
  });
});
