import { afterEach, describe, expect, mock, test } from "../test-helpers.js";

import { AuthError } from "../../src/search/types.js";

async function importCommandModule() {
  return import(`../../src/commands/login.js?test=${crypto.randomUUID()}`);
}

afterEach(() => {
  mock.restore();
});

describe("perplexity-login command", () => {
  test("shows browser auth parse errors instead of generic cancellation", async () => {
    const expectedMessage = "The cURL command you pasted does not include cookies";
    const authenticate = mock(async () => ({ type: "oauth", access: "token" }));
    const saveBrowserAuthInput = mock(async () => {
      throw new AuthError("NO_TOKEN", expectedMessage);
    });

    mock.module("../../src/auth/login.js", () => ({ authenticate, saveBrowserAuthInput }));

    const registered = {
      handler: undefined as undefined | ((args: string, ctx: unknown) => Promise<void>),
    };
    const registerCommand = mock((name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      expect(name).toBe("perplexity-login");
      registered.handler = command.handler;
    });

    const { registerPerplexityCommands } = await importCommandModule();
    registerPerplexityCommands({ registerCommand } as never);

    const input = mock(async () => "curl 'https://www.perplexity.ai/' -H 'User-Agent: browser'");
    const notify = mock((_message: string, _level: string) => undefined);

    await registered.handler?.("--browser", { ui: { input, notify } });

    const lastNotification = notify.mock.calls.at(-1);
    expect(lastNotification?.[0]).toBe(expectedMessage);
    expect(lastNotification?.[1]).toBe("warning");
    expect(saveBrowserAuthInput).toHaveBeenCalledTimes(1);
  });
});
