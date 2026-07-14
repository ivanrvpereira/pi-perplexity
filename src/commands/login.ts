import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { browserLoginInstructions } from "../auth/browser.js";
import { authenticate, saveBrowserAuthInput } from "../auth/login.js";
import { clearToken } from "../auth/storage.js";
import { AuthError } from "../search/types.js";
import { errorMessage } from "../util.js";

const LOGIN_COMMAND_NAME = "perplexity-login";

interface ParsedCommandArgs {
  forceRefresh: boolean;
  browserAuth: boolean;
  showHelp: boolean;
  unknown: string[];
}

function parseCommandArgs(args: string): ParsedCommandArgs {
  const tokens = args
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  let forceRefresh = false;
  let browserAuth = false;
  let showHelp = false;
  const unknown: string[] = [];

  for (const token of tokens) {
    if (token === "--force" || token === "--refresh" || token === "-f") {
      forceRefresh = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      showHelp = true;
      continue;
    }

    if (token === "--browser" || token === "--cookie" || token === "--manual") {
      browserAuth = true;
      continue;
    }

    unknown.push(token);
  }

  return { forceRefresh, browserAuth, showHelp, unknown };
}

function usageText(): string {
  return `Usage: /${LOGIN_COMMAND_NAME} [--force] [--browser]\n\nFlags:\n  --force, --refresh, -f   Clear cached token before login\n  --browser, --cookie      Import browser auth by pasting Copy as cURL, a Cookie header, or a session token\n  --help, -h               Show this help`;
}

export function registerPerplexityCommands(pi: ExtensionAPI): void {
  pi.registerCommand(LOGIN_COMMAND_NAME, {
    description: "Authenticate Perplexity and persist token",
    handler: async (args, ctx) => {
      const parsed = parseCommandArgs(args);

      if (parsed.showHelp) {
        ctx.ui.notify(usageText(), "info");
        return;
      }

      if (parsed.unknown.length > 0) {
        ctx.ui.notify(
          `Unknown arguments: ${parsed.unknown.join(" ")}\n\n${usageText()}`,
          "warning",
        );
        return;
      }

      if (parsed.forceRefresh) {
        await clearToken().catch(() => undefined);
      }

      const promptForEmail = async (): Promise<string | undefined> => {
        const value = await ctx.ui.input("Perplexity email", "you@example.com");
        return value?.trim() || undefined;
      };

      const promptForOtp = async (email: string): Promise<string | undefined> => {
        const value = await ctx.ui.input(`Enter OTP sent to ${email}`, "123456");
        return value?.trim() || undefined;
      };

      const promptForBrowserAuth = async (): Promise<string | undefined> => {
        ctx.ui.notify(browserLoginInstructions(), "info");
        const value = await ctx.ui.input(
          "Paste copied cURL command or Cookie header",
          "curl 'https://www.perplexity.ai/' -H 'Cookie: ...'",
        );
        return value?.trim() || undefined;
      };

      try {
        if (parsed.browserAuth) {
          const input = await promptForBrowserAuth();
          if (!input) {
            ctx.ui.notify("Perplexity browser login canceled.", "warning");
            return;
          }

          await saveBrowserAuthInput(input);
          ctx.ui.notify("Perplexity browser auth saved.", "info");
          return;
        }

        await authenticate({ promptForEmail, promptForOtp });
        ctx.ui.notify("Perplexity login successful. Token saved.", "info");
      } catch (error) {
        if (error instanceof AuthError && error.code === "NO_TOKEN") {
          if (parsed.browserAuth) {
            ctx.ui.notify(error.message, "warning");
            return;
          }

          ctx.ui.notify(
            "Perplexity login canceled. Re-run /perplexity-login for email + OTP, use /perplexity-login --browser, or set PI_PERPLEXITY_EMAIL/PI_PERPLEXITY_OTP/PI_PERPLEXITY_COOKIE.",
            "warning",
          );
          return;
        }

        if (error instanceof AuthError) {
          ctx.ui.notify(`Perplexity login failed: ${error.message}`, "error");
          return;
        }

        ctx.ui.notify(`Perplexity login failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
