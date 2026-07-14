import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  getConfigPath as defaultGetConfigPath,
  loadConfig as defaultLoadConfig,
  saveConfig as defaultSaveConfig,
  type PerplexityConfig,
} from "../config.js";
import { KNOWN_MODELS } from "../search/models.js";

function formatCurrentConfig(config: { model?: string; incognito?: boolean }): string {
  const model = config.model ?? "pplx_pro_upgraded (default)";
  const modelLabel = KNOWN_MODELS.find((m) => m.value === config.model)?.label;
  const modelDisplay = modelLabel ? `${model} (${modelLabel})` : model;
  const incognito = config.incognito ?? true;
  return `Model: ${modelDisplay}\nIncognito: ${incognito}`;
}

function formatModelOption(model: { value: string; label: string }, currentModel?: string): string {
  return model.value === currentModel ? `${model.label} [current]` : model.label;
}

function parseSelectedModel(selected: string): string {
  return selected.replace(/ \[current\]$/, "");
}

interface ConfigCommandDeps {
  getConfigPath: () => string;
  loadConfig: () => Promise<PerplexityConfig>;
  saveConfig: (config: PerplexityConfig) => Promise<void>;
}

export function registerPerplexityConfigCommand(
  pi: ExtensionAPI,
  deps: ConfigCommandDeps = {
    getConfigPath: defaultGetConfigPath,
    loadConfig: defaultLoadConfig,
    saveConfig: defaultSaveConfig,
  },
): void {
  pi.registerCommand("perplexity-config", {
    description: "Configure Perplexity search defaults",
    handler: async (args, ctx) => {
      if (args.trim() === "--help" || args.trim() === "-h") {
        ctx.ui.notify(
          `Usage: /perplexity-config [--show]\n\nInteractively set default model and incognito mode.\nConfig stored at: ${deps.getConfigPath()}`,
          "info",
        );
        return;
      }

      try {
        const config = await deps.loadConfig();

        if (args.trim() === "--show") {
          ctx.ui.notify(`Perplexity config (${deps.getConfigPath()}):\n${formatCurrentConfig(config)}`, "info");
          return;
        }

        const modelOptions = KNOWN_MODELS.map((model) => formatModelOption(model, config.model));
        const selected = await ctx.ui.select("Default model", modelOptions);
        if (selected === undefined || selected === null) {
          ctx.ui.notify("Perplexity config unchanged.", "info");
          return;
        }
        const normalizedSelection = parseSelectedModel(selected);
        const selectedModel = KNOWN_MODELS.find((model) => model.label === normalizedSelection)?.value
          ?? normalizedSelection;

        const incognito = await ctx.ui.confirm(
          "Incognito mode",
          "Hide searches from Perplexity web history? (recommended)",
        );
        if (incognito === undefined || incognito === null) {
          ctx.ui.notify("Perplexity config unchanged.", "info");
          return;
        }

        config.model = selectedModel;
        config.incognito = incognito;

        await deps.saveConfig(config);
        ctx.ui.notify(`Perplexity config saved:\n${formatCurrentConfig(config)}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Failed to save Perplexity config: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
