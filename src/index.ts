import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { authenticate } from "./auth/login.js";
import { clearToken } from "./auth/storage.js";
import { formatForLLM } from "./search/format.js";
import { searchPerplexity } from "./search/client.js";
import { AuthError, SearchError } from "./search/types.js";

export default function (pi: ExtensionAPI) {
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const start = Date.now();
      let sourceCount = 0;

      try {
        onUpdate?.({
          content: [{ type: "text", text: "Authenticating with Perplexity..." }],
          details: { toolCallId },
        });

        const jwt = await authenticate();

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

        const result = await searchPerplexity(
          {
            query: params.query,
            recency: params.recency,
            limit: params.limit,
          },
          jwt,
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
            details: { sourceCount, queryMs },
          };
        }

        if (error instanceof SearchError) {
          if (error.code === "AUTH") {
            await clearToken().catch(() => undefined);
          }

          return {
            content: [{ type: "text", text: `Perplexity search failed: ${error.message}` }],
            details: { sourceCount, queryMs },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Perplexity search failed: ${(error as Error).message || "Unknown error"}`,
            },
          ],
          details: { sourceCount, queryMs },
        };
      }
    },
  });
}
