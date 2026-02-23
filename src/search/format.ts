import type { SearchResult, WebResult } from "./types.js";

const MAX_SNIPPET_LENGTH = 240;

function truncateSnippet(snippet: string): string {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SNIPPET_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

function humanizeAge(timestamp?: string): string {
  if (!timestamp) {
    return "unknown";
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return "unknown";
  }

  const diffMs = Math.max(0, Date.now() - parsed);
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return "just now";
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatSource(source: WebResult, index: number): string {
  const title = source.name?.trim() || "Untitled source";
  const age = humanizeAge(source.timestamp);
  const lines: string[] = [`[${index + 1}] ${title} (${age})`];

  if (source.url?.trim()) {
    lines.push(`    ${source.url.trim()}`);
  }

  if (source.snippet?.trim()) {
    lines.push(`    ${truncateSnippet(source.snippet)}`);
  }

  return lines.join("\n");
}

/** Format a SearchResult into LLM-friendly text with ## Answer, ## Sources, ## Meta sections. */
export function formatForLLM(result: SearchResult, limit?: number): string {
  const sourceLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : result.sources.length;

  const limitedSources = result.sources.slice(0, sourceLimit);

  const sourceSection =
    limitedSources.length === 0
      ? "0 sources\n(no sources returned)"
      : `${limitedSources.length} sources\n${limitedSources
          .map((source, index) => formatSource(source, index))
          .join("\n\n")}`;

  const metaLines = [
    "Provider: perplexity (oauth)",
    `Model: ${result.displayModel ?? "unknown"}`,
  ];

  if (result.uuid) {
    metaLines.push(`Request ID: ${result.uuid}`);
  }

  return [
    "## Answer",
    result.answer.trim() || "No answer returned.",
    "",
    "## Sources",
    sourceSection,
    "",
    "## Meta",
    ...metaLines,
  ].join("\n");
}
