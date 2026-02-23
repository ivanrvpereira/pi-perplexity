import { mergeEvent, readSseEvents } from "./stream.js";
import type { SearchResult, StreamEvent, WebResult } from "./types.js";
import { SearchError } from "./types.js";
import { errorMessage } from "../render/util.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";

const PERPLEXITY_ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";


function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const MAX_BUN_STDOUT = 50 * 1024 * 1024;

/**
 * Execute a Perplexity request via a Bun subprocess.
 * Pi loads extensions under Node/jiti whose fetch gets Cloudflare-challenged.
 * Bun's native fetch has a different TLS fingerprint that passes.
 */
async function fetchViaBunRuntime(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<{ status: number; bodyText: string }> {
  const script = `
const c = JSON.parse(await Bun.stdin.text());
try {
  const r = await fetch(c.url, { method: "POST", headers: c.headers, body: c.body });
  const t = await r.text();
  process.stdout.write(JSON.stringify({ s: r.status, b: t }));
} catch (e) {
  process.stdout.write(JSON.stringify({ s: 0, b: String(e?.message ?? e) }));
}
`;

  // Dynamic import: spawn is only needed under Node/jiti (not Bun),
  // and Bun's node:child_process polyfill may not export it.
  const { spawn } = await import("node:child_process");

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("bun", ["-e", script], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
    });

    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    if (!child.stdin || !child.stdout) {
      reject(new Error("Failed to open subprocess pipes"));
      return;
    }

    child.stdin.write(JSON.stringify({ url, headers, body }));
    child.stdin.end();

    const chunks: Buffer[] = [];
    let totalLen = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      totalLen += chunk.length;
      if (totalLen <= MAX_BUN_STDOUT) {
        chunks.push(chunk);
      }
    });

    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.on("error", reject);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Bun subprocess returned invalid output: ${stdout.slice(0, 200)}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("Bun subprocess response is not an object.");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.s !== "number" || typeof obj.b !== "string") {
    throw new Error("Bun subprocess response missing required fields.");
  }

  return { status: obj.s, bodyText: obj.b };
}

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
      model_preference: "pplx_pro_upgraded",
      sources: ["web"],
      attachments: [],
      frontend_uuid: crypto.randomUUID(),
      frontend_context_uuid: crypto.randomUUID(),
      version: PERPLEXITY_API_VERSION,
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

  let eventStream: ReadableStream<Uint8Array>;

  // Bun's native fetch passes Cloudflare; Node/jiti's fetch gets challenged.
  // Use native fetch when running under Bun (tests, direct scripts),
  // subprocess fallback when running under Node/jiti (pi extension runtime).
  const useBunSubprocess = typeof Bun === "undefined";

  if (useBunSubprocess) {
    let bunResult: { status: number; bodyText: string };
    try {
      bunResult = await fetchViaBunRuntime(
        PERPLEXITY_ENDPOINT,
        requestHeaders,
        JSON.stringify(requestBody),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new SearchError("NETWORK", "Perplexity request was cancelled.");
      }

      throw new SearchError(
        "NETWORK",
        `Could not connect to Perplexity. ${errorMessage(error)}`,
      );
    }
    if (bunResult.status === 0) {
      throw new SearchError("NETWORK", bunResult.bodyText);
    }
    if (bunResult.status !== 200) {
      throw mapHttpError(bunResult.status);
    }
    if (!bunResult.bodyText) {
      throw new SearchError("STREAM", "Perplexity returned an empty response.");
    }

    eventStream = streamFromText(bunResult.bodyText);
  } else {
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

    eventStream = response.body;
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
      `Failed to parse Perplexity stream: ${errorMessage(error)}`,
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
