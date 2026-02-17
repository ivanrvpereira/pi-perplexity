import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface PerplexityCallArgs {
  query?: unknown;
  recency?: unknown;
  limit?: unknown;
}

const RECENCY_VALUES = new Set(["hour", "day", "week", "month", "year"] as const);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function renderPerplexityCall(args: PerplexityCallArgs, theme: Theme): Text {
  const query = asString(args?.query)?.trim();
  const recencyRaw = asString(args?.recency)?.trim().toLowerCase();
  const recency = recencyRaw && RECENCY_VALUES.has(recencyRaw as (typeof RECENCY_VALUES extends Set<infer T> ? T : never))
    ? recencyRaw
    : undefined;
  const limit = asPositiveNumber(args?.limit);

  let text = theme.fg("toolTitle", theme.bold("perplexity_search "));
  text += query ? theme.fg("muted", truncate(query, 90)) : theme.fg("warning", "(missing query)");

  if (recency) {
    text += theme.fg("dim", ` • ${recency}`);
  }

  if (typeof limit === "number") {
    text += theme.fg("dim", ` • limit ${Math.round(limit)}`);
  }

  return new Text(text, 0, 0);
}
