import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { registerPerplexityConfigCommand } from "./commands/config.js";
import { registerPerplexityCommands } from "./commands/login.js";

import { authenticate } from "./auth/login.js";
import { clearToken } from "./auth/storage.js";
import { loadConfig, resolveSearchDefaults } from "./config.js";
import { formatForLLM } from "./search/format.js";
import { searchPerplexity } from "./search/client.js";
import { renderPerplexityCall } from "./render/call.js";
import { renderPerplexityResult } from "./render/result.js";
import { errorMessage } from "./render/util.js";
import { AuthError, SearchError } from "./search/types.js";

export default function (pi: ExtensionAPI) {
  registerPerplexityCommands(pi);
  registerPerplexityConfigCommand(pi);
  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search",
    description: "Search the web using Perplexity",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      recency: Type.Optional(
        StringEnum(["hour", "day", "week", "month", "year"] as const, {
          description: "Filter results by recency",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max sources to return", minimum: 1, maximum: 50 }),
      ),
      incognito: Type.Optional(Type.Boolean({ description: "Hide search from Perplexity history" })),
    }),
    renderCall: renderPerplexityCall,
    renderResult: renderPerplexityResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const start = Date.now();
      let sourceCount = 0;

      try {
        onUpdate?.({
          content: [{ type: "text", text: "Authenticating with Perplexity..." }],
          details: { toolCallId },
        });

        const promptInput = async (label: string, placeholder: string): Promise<string | null | undefined> => {
          if (!ctx?.ui?.input) {
            return undefined;
          }

          return ctx.ui.input(label, placeholder);
        };

        const auth = await authenticate({
          ...(signal !== undefined ? { signal } : {}),
          promptForEmail: async () => promptInput("Perplexity email", "you@example.com"),
          promptForOtp: async (email) => promptInput(`Enter OTP sent to ${email}`, "123456"),
          promptForBrowserAuth: async () => {
            ctx?.ui?.notify?.(
              [
                "Browser login needed:",
                "1. Open https://www.perplexity.ai and sign in.",
                "2. Open DevTools → Network.",
                "3. Reload the page or ask one Perplexity question.",
                "4. Right-click a www.perplexity.ai request → Copy → Copy as cURL.",
                "5. Paste the copied cURL command here.",
                "",
                "The copied text must include -b, --cookie, or Cookie:, and should include __Secure-next-auth.session-token.",
                "If it does not, copy a different www.perplexity.ai request, preferably perplexity_ask.",
                "Alternatives: paste the request Cookie header, or paste the __Secure-next-auth.session-token value.",
              ].join("\n"),
              "info",
            );
            return promptInput(
              "Paste copied cURL command or Cookie header",
              "curl 'https://www.perplexity.ai/' -H 'Cookie: ...'",
            );
          },
        });

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Perplexity search was cancelled." }],
            details: { sourceCount: 0, queryMs: Date.now() - start },
          };
        }

        onUpdate?.({
          content: [{ type: "text", text: "Querying Perplexity..." }],
          details: { toolCallId },
        });

        const config = await loadConfig();
        const { model, incognito } = resolveSearchDefaults(
          {
            ...(params.incognito !== undefined ? { incognito: params.incognito } : {}),
          },
          config,
        );

        const result = await searchPerplexity(
          {
            query: params.query,
            model,
            incognito,
            ...(params.recency !== undefined ? { recency: params.recency } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          },
          auth,
          signal,
        );

        const formatted = formatForLLM(result, params.limit);
        sourceCount =
          typeof params.limit === "number"
            ? Math.min(params.limit, result.sources.length)
            : result.sources.length;

        return {
          content: [{ type: "text", text: formatted }],
          details: {
            model: result.displayModel,
            incognito,
            sourceCount,
            queryMs: Date.now() - start,
            uuid: result.uuid,
          },
        };
      } catch (error) {
        const queryMs = Date.now() - start;

        if (error instanceof AuthError) {
          return {
            content: [{ type: "text", text: `Authentication failed: ${error.message}` }],
            details: { sourceCount, queryMs, isError: true },
          };
        }

        if (error instanceof SearchError) {
          if (error.code === "AUTH") {
            // Clear cached token on auth rejection so next call triggers re-login.
            await clearToken().catch(() => undefined);
          }
          return {
            content: [{ type: "text", text: `Perplexity search failed: ${error.message}` }],
            details: { sourceCount, queryMs, isError: true },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Perplexity search failed: ${errorMessage(error)}`,
            },
          ],
          details: { sourceCount, queryMs, isError: true },
        };
      }
    },
  });
}
