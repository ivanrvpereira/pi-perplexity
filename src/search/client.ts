import { mergeEvent, readSseEvents } from "./stream.js";
import type { SearchResult, StreamEvent, WebResult } from "./types.js";
import { SearchError } from "./types.js";

const PERPLEXITY_ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const PERPLEXITY_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

export interface SearchParams {
  query: string;
  recency?: "hour" | "day" | "week" | "month" | "year";
  limit?: number;
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

  const fallbackSources: WebResult[] = (event.sources_list ?? []).map((source) => ({
    name: source.title,
    url: source.url,
    snippet: source.snippet,
    timestamp: source.date,
  }));

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
      model_preference: "pplx_pro_upgraded",
      sources: ["web"],
      attachments: [],
      frontend_uuid: crypto.randomUUID(),
      frontend_context_uuid: crypto.randomUUID(),
      version: "2.18",
      language: "en-US",
      timezone,
      search_recency_filter: params.recency ?? null,
      is_incognito: true,
      use_schematized_api: true,
      skip_search_enabled: true,
    },
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

  let response: Response;
  try {
    response = await fetch(PERPLEXITY_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Origin: "https://www.perplexity.ai",
        Referer: "https://www.perplexity.ai/",
        "User-Agent": PERPLEXITY_USER_AGENT,
        "X-App-ApiClient": "default",
        "X-App-ApiVersion": "2.18",
        "X-Perplexity-Request-Reason": "submit",
        "X-Request-ID": requestId,
      },
      body: JSON.stringify(buildRequestBody(params)),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new SearchError("NETWORK", "Perplexity request was cancelled.");
    }

    throw new SearchError(
      "NETWORK",
      `Could not connect to Perplexity. ${(error as Error).message || "Network failure."}`,
    );
  }

  if (!response.ok) {
    throw mapHttpError(response.status);
  }

  if (!response.body) {
    throw new SearchError("STREAM", "Perplexity returned an empty stream body.");
  }

  let snapshot: StreamEvent = {};

  try {
    for await (const event of readSseEvents(response.body, signal)) {
      snapshot = mergeEvent(snapshot, event);
      if (event.final || event.status === "COMPLETED") {
        break;
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
      `Failed to parse Perplexity stream: ${(error as Error).message || "unknown error"}`,
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

  return {
    answer: answer || "No answer text returned by Perplexity.",
    sources,
    displayModel: snapshot.display_model,
    uuid: snapshot.uuid,
  };
}
