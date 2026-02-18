// --- SSE event types (all fields optional per AGENTS.md: API is unstable) ---

export interface StreamEvent {
  status?: string;
  final?: boolean;
  text?: string;
  blocks?: StreamBlock[];
  sources_list?: StreamSource[];
  display_model?: string;
  uuid?: string;
  error_code?: string;
  error_message?: string;
}

export interface StreamBlock {
  intended_usage?: string;
  markdown_block?: {
    answer?: string;
    chunks?: string[];
    chunk_starting_offset?: number;
  };
  web_result_block?: {
    web_results?: WebResult[];
  };
}

export interface WebResult {
  name?: string;
  url?: string;
  snippet?: string;
  timestamp?: string;
}

export interface StreamSource {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

// --- Auth types ---

export interface StoredToken {
  type: "oauth";
  access: string;
  email?: string;
}

// --- Search result (output of client, input to formatter) ---

export interface SearchResult {
  answer: string;
  sources: WebResult[];
  displayModel?: string;
  uuid?: string;
}

// --- Error types ---

export type SearchErrorCode = "AUTH" | "RATE_LIMIT" | "NETWORK" | "STREAM" | "EMPTY";

export class SearchError extends Error {
  constructor(
    public readonly code: SearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export type AuthErrorCode = "NO_TOKEN" | "EXTRACTION_FAILED";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
