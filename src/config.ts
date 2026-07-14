import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PerplexityConfig {
  model?: string;
  incognito?: boolean;
}

const CONFIG_PATH = join(homedir(), ".config", "pi-perplexity", "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseConfig(raw: string): PerplexityConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config file must contain a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const config: PerplexityConfig = {};
  if (typeof obj.model === "string" && obj.model.length > 0) config.model = obj.model;
  if (typeof obj.incognito === "boolean") config.incognito = obj.incognito;
  return config;
}

/** Load config from ~/.config/pi-perplexity/config.json. Returns {} if file doesn't exist. Throws on parse/IO errors. */
export async function loadConfig(configPath: string = CONFIG_PATH): Promise<PerplexityConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
  return parseConfig(raw);
}

/** Save config to disk with 0600 permissions. */
export async function saveConfig(config: PerplexityConfig, configPath: string = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
}

/** Resolve effective search defaults from env vars, config file, and per-call incognito override. */
export function resolveSearchDefaults(
  params: { incognito?: boolean },
  config: PerplexityConfig,
): { model: string; incognito: boolean } {
  const envModel = process.env.PI_PERPLEXITY_MODEL?.trim() || undefined;
  const envIncognito = process.env.PI_PERPLEXITY_INCOGNITO || undefined;

  const model = envModel ?? config.model ?? "pplx_pro_upgraded";
  const incognito = params.incognito
    ?? (envIncognito !== undefined ? envIncognito !== "false" && envIncognito !== "0" : undefined)
    ?? config.incognito
    ?? true;

  return { model, incognito };
}
