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

function getSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie !== "function") {
    throw new Error(
      "Perplexity auth requires Headers.getSetCookie() support. Use Node 18.14.1 or newer, or the Node runtime bundled with pi.",
    );
  }

  return getSetCookie.call(headers);
}

/** Fetch a Perplexity endpoint and return text plus any Set-Cookie headers. */
export async function perplexityFetchText(
  url: string,
  options: PerplexityFetchOptions,
): Promise<PerplexityFetchResponse> {
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
    cookies: getSetCookies(response.headers),
  };
}
