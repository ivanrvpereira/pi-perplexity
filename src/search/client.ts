import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mergeEvent, readSseEvents } from "./stream.js";
import type { SearchResult, StreamEvent, WebResult } from "./types.js";
import { SearchError } from "./types.js";

const PERPLEXITY_ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const PERPLEXITY_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const MAX_BUN_STDOUT_BYTES = 50 * 1024 * 1024;
const CLOUDFLARE_HINTS = ["just a moment", "cloudflare", "cf-chl", "cf-ray"];

const execFileAsync = promisify(execFile);

export interface SearchParams {
  query: string;
  recency?: "hour" | "day" | "week" | "month" | "year";
  limit?: number;
}

interface BunFetchResult {
  status: number;
  contentType: string | null;
  bodyText: string;
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

function buildRequestHeaders(jwt: string, requestId: string): Record<string, string> {
  return {
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
  };
}

function isCloudflareChallenge(status: number, contentType: string | null, bodyText: string): boolean {
  if (status !== 403) {
    return false;
  }

  const contentTypeLower = (contentType ?? "").toLowerCase();
  const bodyLower = bodyText.toLowerCase();

  if (!contentTypeLower.includes("text/html")) {
    return false;
  }

  return CLOUDFLARE_HINTS.some((hint) => bodyLower.includes(hint));
}

function mapHttpError(status: number, bodyText = "", contentType: string | null = null): SearchError {
  if (status === 401 || status === 403) {
    if (isCloudflareChallenge(status, contentType, bodyText)) {
      return new SearchError(
        "NETWORK",
        "Perplexity request was blocked by Cloudflare challenge in this runtime. Retry via Bun runtime fallback or desktop app token path.",
      );
    }

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

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function fetchViaBunRuntime(
  requestBody: Record<string, unknown>,
  jwt: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<BunFetchResult> {
  const script = `
const endpoint = process.env.PI_PPLX_ENDPOINT;
const token = process.env.PI_PPLX_TOKEN;
const body = JSON.parse(process.env.PI_PPLX_BODY || "{}");
const requestId = process.env.PI_PPLX_REQUEST_ID || crypto.randomUUID();
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${token}\`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Origin: "https://www.perplexity.ai",
      Referer: "https://www.perplexity.ai/",
      "User-Agent": "${PERPLEXITY_USER_AGENT}",
      "X-App-ApiClient": "default",
      "X-App-ApiVersion": "2.18",
      "X-Perplexity-Request-Reason": "submit",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  process.stdout.write(JSON.stringify({
    status: response.status,
    contentType: response.headers.get("content-type"),
    bodyText: text,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 0,
    contentType: null,
    bodyText: String(error && error.message ? error.message : error),
  }));
}
`;

  const { stdout } = await execFileAsync(
    "bun",
    ["-e", script],
    {
      encoding: "utf8",
      maxBuffer: MAX_BUN_STDOUT_BYTES,
      signal,
      env: {
        ...process.env,
        PI_PPLX_ENDPOINT: PERPLEXITY_ENDPOINT,
        PI_PPLX_TOKEN: jwt,
        PI_PPLX_BODY: JSON.stringify(requestBody),
        PI_PPLX_REQUEST_ID: requestId,
      },
    },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Bun fallback returned non-JSON output.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Bun fallback returned invalid payload.");
  }

  const result = parsed as Partial<BunFetchResult>;
  if (typeof result.status !== "number" || typeof result.bodyText !== "string") {
    throw new Error("Bun fallback response missing required fields.");
  }

  return {
    status: result.status,
    contentType: typeof result.contentType === "string" ? result.contentType : null,
    bodyText: result.bodyText,
  };
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

  let eventStream: ReadableStream<Uint8Array> | null = null;

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }

    const contentType = response.headers.get("content-type");

    if (isCloudflareChallenge(response.status, contentType, bodyText)) {
      let bunResult: BunFetchResult;
      try {
        bunResult = await fetchViaBunRuntime(requestBody, jwt, requestId, signal);
      } catch (error) {
        throw new SearchError(
          "NETWORK",
          `Perplexity request hit Cloudflare challenge and Bun fallback failed: ${(error as Error).message || "unknown error"}`,
        );
      }

      if (bunResult.status !== 200) {
        throw mapHttpError(bunResult.status, bunResult.bodyText, bunResult.contentType);
      }

      eventStream = streamFromText(bunResult.bodyText);
    } else {
      throw mapHttpError(response.status, bodyText, contentType);
    }
  } else {
    if (!response.body) {
      throw new SearchError("STREAM", "Perplexity returned an empty stream body.");
    }

    eventStream = response.body;
  }

  if (!eventStream) {
    throw new SearchError("STREAM", "Perplexity returned no readable stream.");
  }

  let snapshot: StreamEvent = {};

  try {
    for await (const event of readSseEvents(eventStream, signal)) {
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
