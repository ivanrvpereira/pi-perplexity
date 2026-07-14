import { describe, expect, test } from "./test-helpers.js";

import { loadToken } from "../src/auth/storage.js";
import { searchPerplexity } from "../src/search/client.js";

const DEFAULT_MODELS = [
  "pplx_pro_upgraded",
  "experimental",
  "pplx_reasoning",
  "gpt54",
  "claude46sonnetthinking",
];

const runE2E = process.env.PI_PERPLEXITY_E2E === "1";
const maybeTest = runE2E ? test : test.skip;

function configuredModels(): string[] {
  const raw = process.env.PI_PERPLEXITY_E2E_MODELS;
  if (!raw) return DEFAULT_MODELS;
  return raw
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function configuredDelayMs(): number {
  const raw = Number(process.env.PI_PERPLEXITY_E2E_DELAY_MS ?? "1500");
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Perplexity model selection e2e", () => {
  maybeTest(
    "sends requested model slugs and receives matching display_model values",
    { timeout: 180_000 },
    async () => {
      const token = await loadToken();
      if (!token) {
        throw new Error("No cached Perplexity token. Run /perplexity-login before PI_PERPLEXITY_E2E=1 npm test.");
      }

      const models = configuredModels();
      const delayMs = configuredDelayMs();

      for (const model of models) {
        const result = await searchPerplexity(
          {
            query: "Say exactly OK",
            model,
          },
          token,
        );

        expect(result.answer.trim().startsWith("OK")).toBe(true);
        expect(result.displayModel).toBe(model);

        if (delayMs > 0 && model !== models.at(-1)) {
          await delay(delayMs);
        }
      }
    },
  );
});
