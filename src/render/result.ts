import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface PerplexityResultDetails {
  model?: unknown;
  sourceCount?: unknown;
  queryMs?: unknown;
  uuid?: unknown;
  toolCallId?: unknown;
  error?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function extractTextContent(result: AgentToolResult<PerplexityResultDetails>): string | undefined {
  if (!Array.isArray(result?.content)) {
    return undefined;
  }

  for (const item of result.content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      const text = item.text.trim();
      if (text.length > 0) {
        return text;
      }
    }
  }

  return undefined;
}

function isErrorText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  return text.startsWith("Authentication failed:") || text.startsWith("Perplexity search failed:");
}

export function renderPerplexityResult(
  result: AgentToolResult<PerplexityResultDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const details = (result?.details ?? {}) as PerplexityResultDetails;
  const contentText = extractTextContent(result);

  if (options?.isPartial) {
    let partial = theme.fg("warning", "Perplexity: searching…");

    if (contentText) {
      partial += `\n${theme.fg("dim", truncate(contentText.replace(/\s+/g, " "), 140))}`;
    }

    return new Text(partial, 0, 0);
  }

  const error = asString(details.error)?.trim();
  if (error) {
    return new Text(theme.fg("error", `Perplexity error: ${error}`), 0, 0);
  }

  if (isErrorText(contentText)) {
    return new Text(theme.fg("error", truncate(contentText ?? "Perplexity request failed", 200)), 0, 0);
  }

  const sourceCount = asNumber(details.sourceCount);
  const queryMs = asNumber(details.queryMs);
  const model = asString(details.model)?.trim();
  const uuid = asString(details.uuid)?.trim();

  let text = theme.fg("success", "✓ Perplexity");
  if (typeof sourceCount === "number") {
    text += theme.fg("muted", ` • ${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
  }
  if (typeof queryMs === "number") {
    text += theme.fg("dim", ` • ${(queryMs / 1000).toFixed(queryMs < 1000 ? 2 : 1)}s`);
  }

  if (!options?.expanded) {
    if (contentText) {
      const oneLine = contentText.replace(/\s+/g, " ").trim();
      if (oneLine.length > 0) {
        text += `\n${theme.fg("dim", truncate(oneLine, 160))}`;
      }
    }

    return new Text(text, 0, 0);
  }

  if (model) {
    text += `\n${theme.fg("dim", `model: ${model}`)}`;
  }
  if (uuid) {
    text += `\n${theme.fg("dim", `id: ${uuid}`)}`;
  }

  if (contentText) {
    text += `\n\n${truncate(contentText, 2400)}`;
  }

  return new Text(text, 0, 0);
}
