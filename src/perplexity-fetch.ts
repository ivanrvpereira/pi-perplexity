const MAX_BUN_STDOUT = 50 * 1024 * 1024;

export interface PerplexityFetchOptions {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal | null;
}

export interface PerplexityFetchResponse {
  status: number;
  ok: boolean;
  bodyText: string;
  cookies: string[];
}

/**
 * Perplexity's Cloudflare edge can challenge Node/jiti fetch.
 * Use native fetch under Bun (tests/direct scripts), otherwise shell out to Bun for its TLS fingerprint.
 */
export async function perplexityFetchText(
  url: string,
  options: PerplexityFetchOptions,
): Promise<PerplexityFetchResponse> {
  if (typeof Bun === "undefined") {
    return fetchViaBunRuntime(url, options);
  }

  const fetchOptions: RequestInit = {
    method: options.method,
    headers: options.headers,
    signal: options.signal ?? null,
  };
  if (options.body !== undefined) {
    fetchOptions.body = options.body;
  }

  const response = await fetch(url, fetchOptions);

  return {
    status: response.status,
    ok: response.ok,
    bodyText: await response.text(),
    cookies: response.headers.getSetCookie?.() ?? [],
  };
}

async function fetchViaBunRuntime(
  url: string,
  options: PerplexityFetchOptions,
): Promise<PerplexityFetchResponse> {
  const script = `
const c = JSON.parse(await Bun.stdin.text());
try {
  const r = await fetch(c.url, {
    method: c.method,
    headers: c.headers,
    body: c.body,
  });
  const t = await r.text();
  process.stdout.write(JSON.stringify({
    s: r.status,
    b: t,
    c: r.headers.getSetCookie?.() ?? [],
  }));
} catch (e) {
  process.stdout.write(JSON.stringify({ s: 0, b: String(e?.message ?? e), c: [] }));
}
`;

  const { spawn } = await import("node:child_process");

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("bun", ["-e", script], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
    });

    const onAbort = () => child.kill();
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    }

    if (!child.stdin || !child.stdout) {
      reject(new Error("Failed to open subprocess pipes"));
      return;
    }

    child.stdin.write(
      JSON.stringify({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
      }),
    );
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

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bun subprocess response is not an object.");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.s !== "number" || typeof obj.b !== "string" || !Array.isArray(obj.c)) {
    throw new Error("Bun subprocess response missing required fields.");
  }

  const cookies = obj.c.filter((cookie): cookie is string => typeof cookie === "string");
  return {
    status: obj.s,
    ok: obj.s >= 200 && obj.s < 300,
    bodyText: obj.b,
    cookies,
  };
}
