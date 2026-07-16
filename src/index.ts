import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPerplexityConfigCommand } from "./commands/config.js";
import { registerPerplexityCommands } from "./commands/login.js";

import { authenticate } from "./auth/login.js";
import { loadConfig, resolveDefaultModel } from "./config.js";
import { effectiveSourceCount, formatForLLM } from "./search/format.js";
import { searchPerplexity } from "./search/client.js";
import { renderPerplexityCall } from "./render/call.js";
import { renderPerplexityResult } from "./render/result.js";
import { errorMessage } from "./util.js";
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
        const model = resolveDefaultModel(config);

        const result = await searchPerplexity(
          {
            query: params.query,
            model,
            ...(params.recency !== undefined ? { recency: params.recency } : {}),
          },
          auth,
          signal,
        );

        const formatted = formatForLLM(result, params.limit);
        sourceCount = effectiveSourceCount(result.sources.length, params.limit);

        return {
          content: [{ type: "text", text: formatted }],
          details: {
            model: result.displayModel,
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
