import { mergeEvent, readSseEvents } from "./stream.js";
import type { SearchResult, StreamEvent, WebResult } from "./types.js";
import { SearchError } from "./types.js";
import { errorMessage } from "../render/util.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";

const PERPLEXITY_ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";

export interface SearchParams {
  query: string;
  recency?: "hour" | "day" | "week" | "month" | "year";
  limit?: number;
  model: string;
  incognito: boolean;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, "").toLowerCase();
}

function dedupeSourcesByUrl(sources: WebResult[]): WebResult[] {
  const seen = new Set<string>();
  const deduped: WebResult[] = [];

  for (const source of sources) {
    const url = source.url?.trim();
    if (!url) {
      deduped.push(source);
      continue;
    }

    const key = normalizeUrl(url);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(source);
  }

  return deduped;
}

function extractTextFromBlock(event: StreamEvent, match: (usage: string) => boolean): string | null {
  const blocks = event.blocks ?? [];

  for (const block of blocks) {
    const usage = block.intended_usage ?? "";
    if (!match(usage)) {
      continue;
    }

    const markdown = block.markdown_block;
    if (!markdown) {
      continue;
    }

    if (typeof markdown.answer === "string" && markdown.answer.trim().length > 0) {
      return markdown.answer.trim();
    }

    if (markdown.chunks && markdown.chunks.length > 0) {
      const chunkText = markdown.chunks.join("").trim();
      if (chunkText.length > 0) {
        return chunkText;
      }
    }
  }

  return null;
}

function extractAnswer(event: StreamEvent): string {
  const markdownAnswer = extractTextFromBlock(event, (usage) => usage.includes("markdown"));
  if (markdownAnswer) {
    return markdownAnswer;
  }

  const askTextAnswer = extractTextFromBlock(event, (usage) => usage === "ask_text");
  if (askTextAnswer) {
    return askTextAnswer;
  }

  return event.text?.trim() ?? "";
}

function extractSources(event: StreamEvent): WebResult[] {
  const webResultsBlock = (event.blocks ?? []).find(
    (block) => block.intended_usage === "web_results",
  );

  const blockSources = webResultsBlock?.web_result_block?.web_results ?? [];
  if (blockSources.length > 0) {
    return dedupeSourcesByUrl(blockSources);
  }

  const fallbackSources: WebResult[] = (event.sources_list ?? []).map((source) => {
    const result: WebResult = {};
    if (source.title !== undefined) result.name = source.title;
    if (source.url !== undefined) result.url = source.url;
    if (source.snippet !== undefined) result.snippet = source.snippet;
    if (source.date !== undefined) result.timestamp = source.date;
    return result;
  });

  return dedupeSourcesByUrl(fallbackSources);
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
  const query = params.query;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  return {
    query_str: query,
    params: {
      query_str: query,
      search_focus: "internet",
      mode: "copilot",
      model_preference: params.model,
      sources: ["web"],
      attachments: [],
      frontend_uuid: crypto.randomUUID(),
      frontend_context_uuid: crypto.randomUUID(),
      version: PERPLEXITY_API_VERSION,
      language: "en-US",
      timezone,
      search_recency_filter: params.recency ?? null,
      is_incognito: params.incognito,
      use_schematized_api: true,
      skip_search_enabled: true,
    },
  };
}

function buildRequestHeaders(jwt: string, requestId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Origin: "https://www.perplexity.ai",
    Referer: "https://www.perplexity.ai/",
    "User-Agent": PERPLEXITY_USER_AGENT,
    "X-App-ApiClient": "default",
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
    "X-Perplexity-Request-Reason": "submit",
    "X-Request-ID": requestId,
  };
}

function mapHttpError(status: number): SearchError {
  if (status === 401 || status === 403) {
    return new SearchError(
      "AUTH",
      "Perplexity rejected authentication (401/403). Sign in to Perplexity desktop app and retry.",
    );
  }

  if (status === 429) {
    return new SearchError(
      "RATE_LIMIT",
      "Perplexity rate limited this request (429). Wait a bit, then retry.",
    );
  }

  return new SearchError(
    "NETWORK",
    `Perplexity request failed with HTTP ${status}. Check connectivity and retry.`,
  );
}

/** Execute a Perplexity search: POST SSE, stream/merge events, extract answer + sources. Throws SearchError on failure. */
export async function searchPerplexity(
  params: SearchParams,
  jwt: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const requestId = crypto.randomUUID();
  const requestBody = buildRequestBody(params);
  const requestHeaders = buildRequestHeaders(jwt, requestId);

  let response: Response;
  try {
    response = await fetch(PERPLEXITY_ENDPOINT, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: signal ?? null,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new SearchError("NETWORK", "Perplexity request was cancelled.");
    }

    throw new SearchError(
      "NETWORK",
      `Could not connect to Perplexity. ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw mapHttpError(response.status);
  }

  if (!response.body) {
    throw new SearchError("STREAM", "Perplexity returned an empty stream body.");
  }

  const eventStream = response.body;

  let snapshot: StreamEvent = {};
  let shouldCancelStream = true;
  let stoppedAtTerminalEvent = false;

  try {
    try {
      for await (const event of readSseEvents(eventStream, signal)) {
        snapshot = mergeEvent(snapshot, event);
        if (event.final || event.status === "COMPLETED") {
          stoppedAtTerminalEvent = true;
          break;
        }
      }

      if (signal?.aborted) {
        throw new SearchError("NETWORK", "Perplexity request was cancelled.");
      }

      shouldCancelStream = stoppedAtTerminalEvent;
    } finally {
      if (shouldCancelStream && !signal?.aborted) {
        await eventStream.cancel();
      }
    }
  } catch (error) {
    if (error instanceof SearchError) {
      throw error;
    }

    if (signal?.aborted) {
      throw new SearchError("NETWORK", "Perplexity request was cancelled.");
    }

    throw new SearchError(
      "STREAM",
      `Failed to read Perplexity stream: ${errorMessage(error)}`,
    );
  }

  if (snapshot.error_code || snapshot.error_message) {
    throw new SearchError(
      "STREAM",
      snapshot.error_message || `Perplexity stream error: ${snapshot.error_code}`,
    );
  }

  const answer = extractAnswer(snapshot);
  const sources = extractSources(snapshot);

  if (!answer && sources.length === 0) {
    throw new SearchError(
      "EMPTY",
      "Perplexity returned no answer and no sources for this query.",
    );
  }

  const result: SearchResult = {
    answer: answer || "No answer text returned by Perplexity.",
    sources,
  };
  if (snapshot.display_model !== undefined) result.displayModel = snapshot.display_model;
  if (snapshot.uuid !== undefined) result.uuid = snapshot.uuid;

  return result;
}
