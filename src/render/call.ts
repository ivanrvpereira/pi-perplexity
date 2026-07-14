import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { asString, asPositiveInteger, truncate } from "./util.js";

interface PerplexityCallArgs {
  query?: unknown;
  recency?: unknown;
  limit?: unknown;
  incognito?: unknown;
}

const RECENCY_VALUES: readonly string[] = ["hour", "day", "week", "month", "year"];
export function renderPerplexityCall(args: PerplexityCallArgs, theme: Theme): Text {
  const query = asString(args?.query)?.trim();
  const recencyRaw = asString(args?.recency)?.trim().toLowerCase();
  const recency = recencyRaw && RECENCY_VALUES.includes(recencyRaw) ? recencyRaw : undefined;
  const limit = asPositiveInteger(args?.limit);
  const incognito = typeof args?.incognito === "boolean" ? args.incognito : undefined;

  let text = theme.fg("toolTitle", theme.bold("perplexity_search "));
  text += query ? theme.fg("muted", truncate(query, 90)) : theme.fg("warning", "(missing query)");

  if (typeof incognito === "boolean") {
    text += theme.fg("dim", ` • incognito ${incognito ? "on" : "off"}`);
  }

  if (recency) {
    text += theme.fg("dim", ` • ${recency}`);
  }

  if (typeof limit === "number") {
    text += theme.fg("dim", ` • limit ${limit}`);
  }

  return new Text(text, 0, 0);
}
