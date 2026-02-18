import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { asString, asPositiveNumber, truncate } from "./util.js";

interface PerplexityCallArgs {
  query?: unknown;
  recency?: unknown;
  limit?: unknown;
}

const RECENCY_VALUES = new Set(["hour", "day", "week", "month", "year"] as const);
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
