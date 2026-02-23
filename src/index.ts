import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { registerPerplexityCommands } from "./commands/login.js";

import { authenticate } from "./auth/login.js";

import { formatForLLM } from "./search/format.js";
import { searchPerplexity } from "./search/client.js";
import { renderPerplexityCall } from "./render/call.js";
import { renderPerplexityResult } from "./render/result.js";
import { AuthError, SearchError } from "./search/types.js";
import { errorMessage } from "./render/util.js";

export default function (pi: ExtensionAPI) {
  registerPerplexityCommands(pi);
  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search",
    description: "Search the web with your Perplexity subscription.",
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

        const authOptions: Parameters<typeof authenticate>[0] = {
          promptForEmail: async () => promptInput("Perplexity email", "you@example.com"),
          promptForOtp: async (email) => promptInput(`Enter OTP sent to ${email}`, "123456"),
        };
        if (signal) authOptions.signal = signal;

        const jwt = await authenticate(authOptions);

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

        const searchParams: Parameters<typeof searchPerplexity>[0] = {
          query: params.query,
        };
        if (params.recency) searchParams.recency = params.recency;
        if (typeof params.limit === "number") searchParams.limit = params.limit;

        const result = await searchPerplexity(searchParams, jwt, signal);

        const formatted = formatForLLM(result, params.limit);
        sourceCount =
          typeof params.limit === "number"
            ? Math.min(params.limit, result.sources.length)
            : result.sources.length;

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
          if (error.code === "AUTH") {
            // Do NOT clear the token here. The user must re-login explicitly via
            // /perplexity-login --force. Clearing automatically would silently discard
            // a token that may still be valid (e.g. a transient 401), and removes the
            // user's ability to inspect or recover the cached credential themselves.
            return {
              content: [
                {
                  type: "text",
                  text: `Perplexity authentication failed. Run /perplexity-login --force to re-authenticate.`,
                },
              ],
              details: { sourceCount, queryMs, isError: true },
            };
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
