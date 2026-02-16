# pi-perplexity Architecture

## Overview

An oh-my-pi plugin that provides web search via a Perplexity Pro/Max subscription. Uses OAuth JWT authentication against Perplexity's internal SSE endpoint — no API credits consumed, only the subscription.

## System Context

```
oh-my-pi (coding-agent)
  |
  +-- plugin loader (discovers pi-perplexity via package.json "omp" manifest)
  |
  +-- pi-perplexity (CustomToolFactory)
        |
        +-- perplexity_search tool (CustomTool)
        |     |
        |     +-- Auth: JWT from macOS app or email OTP
        |     +-- Search: POST SSE to www.perplexity.ai
        |     +-- Parse: incremental event merging
        |     +-- Render: TUI components for call/result
        |
        +-- Token storage (SQLite via omp's AgentStorage, or standalone file)
```

## Authentication

### JWT Acquisition (two paths, tried in order)

**Path 1 — macOS Desktop App Extraction (zero-interaction)**

The Perplexity macOS Catalyst app (`ai.perplexity.mac`) stores its auth JWT in NSUserDefaults, readable by any same-UID process:

```bash
defaults read ai.perplexity.mac authToken
```

If the app is installed and logged in, this returns the JWT immediately. No browser, no user interaction.

Skip this path if `PI_AUTH_NO_BORROW=1` is set.

**Path 2 — Email OTP (interactive, fallback)**

```
GET  https://www.perplexity.ai/api/auth/csrf
  -> { csrfToken: string }

POST https://www.perplexity.ai/api/auth/signin-email
  body: { email, csrfToken }
  -> Sends OTP code to email

(user enters OTP)

POST https://www.perplexity.ai/api/auth/signin-otp
  body: { email, otp, csrfToken }
  -> { token: "<JWT>" }
```

All auth requests use these headers:
```
User-Agent: Perplexity/641 CFNetwork/1568 Darwin/25.2.0
X-App-ApiVersion: 2.18
```

### JWT Handling

- Expiry extracted from JWT payload `exp` claim: `decoded.exp * 1000 - 5min`
- Fallback expiry: 1 hour from acquisition if decode fails
- No automated refresh — Perplexity JWTs are long-lived; re-login on expiry
- Storage: persisted to disk so login survives restarts

### Token Storage

The JWT is stored as:
```typescript
{
  type: "oauth",
  access: "<JWT>",
  expires: <exp_ms_minus_5min>,
  email?: "<user@example.com>"
}
```

Two storage strategies (choose during implementation):

1. **Integrate with omp's AgentStorage** — query `listAuthCredentials("perplexity")` from the agent.db SQLite. Requires access to the db path via `getAgentDbPath()`.
2. **Standalone JSON file** — `~/.config/pi-perplexity/auth.json`. Simpler, no dependency on omp internals, portable.

On search, check stored JWT expiry (with 5-minute buffer). If expired, prompt re-login.

## Search Protocol

### Endpoint

```
POST https://www.perplexity.ai/rest/sse/perplexity_ask
```

### Request

**Headers:**
```
Authorization: Bearer <JWT>
Content-Type: application/json
Accept: text/event-stream
Origin: https://www.perplexity.ai
Referer: https://www.perplexity.ai/
User-Agent: Perplexity/641 CFNetwork/1568 Darwin/25.2.0
X-App-ApiClient: default
X-App-ApiVersion: 2.18
X-Perplexity-Request-Reason: submit
X-Request-ID: <random-uuid>
```

**Body:**
```json
{
  "query_str": "<effective_query>",
  "params": {
    "query_str": "<effective_query>",
    "search_focus": "internet",
    "mode": "copilot",
    "model_preference": "pplx_pro_upgraded",
    "sources": ["web"],
    "attachments": [],
    "frontend_uuid": "<random-uuid>",
    "frontend_context_uuid": "<random-uuid>",
    "version": "2.18",
    "language": "en-US",
    "timezone": "<Intl.DateTimeFormat().resolvedOptions().timeZone>",
    "search_recency_filter": null | "hour" | "day" | "week" | "month" | "year",
    "is_incognito": true,
    "use_schematized_api": true,
    "skip_search_enabled": true
  }
}
```

Key parameters:
- `model_preference: "pplx_pro_upgraded"` — Pro subscription model
- `mode: "copilot"` — multi-step reasoning (Pro feature)
- `is_incognito: true` — does not save to Perplexity history
- `effective_query` — system prompt prepended to user query with `\n\n` separator (no separate system message in this API)

### Response: SSE Event Stream

Each `data:` line contains a JSON event. Events are **incremental snapshots** that must be merged.

#### Event Shape

```typescript
interface StreamEvent {
  status?: string;              // "COMPLETED" on final
  final?: boolean;              // true on last event
  text?: string;                // plain text answer (fallback)
  blocks?: StreamBlock[];       // structured content blocks
  sources_list?: StreamSource[];// source references (alternative format)
  display_model?: string;       // model name used
  uuid?: string;                // request ID
  error_code?: string;
  error_message?: string;
}

interface StreamBlock {
  intended_usage?: string;      // "markdown_block" | "ask_text" | "web_results"
  markdown_block?: {
    answer?: string;
    chunks?: string[];          // incremental text chunks
    chunk_starting_offset?: number;
  };
  web_result_block?: {
    web_results?: WebResult[];
  };
}

interface WebResult {
  name?: string;
  url?: string;
  snippet?: string;
  timestamp?: string;
}

interface StreamSource {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}
```

#### Event Merging Strategy

Events are incremental — each new event is merged into a running snapshot:

1. **Top-level fields**: shallow merge (`{ ...existing, ...incoming }`)
2. **Blocks**: keyed by `intended_usage` — new blocks with same key replace/merge with existing
3. **Markdown chunks**: if `chunk_starting_offset` is 0, replace all chunks; otherwise splice at offset
4. **Sources**: accumulated, not replaced; `sources_list` preserved from earlier events if absent in later ones

Stream terminates when `event.final === true` or `event.status === "COMPLETED"`.

#### Answer Extraction (priority order)

1. `blocks` where `intended_usage` contains `"markdown"` -> join `chunks[]` or use `answer` field
2. `blocks` where `intended_usage === "ask_text"` -> same logic
3. `event.text` fallback

#### Source Extraction (priority order)

1. `blocks` where `intended_usage === "web_results"` -> `web_result_block.web_results[]`
2. `event.sources_list[]` fallback
3. Deduplicate by URL

## Plugin Interface

### oh-my-pi CustomTool Contract

The plugin exports a `CustomToolFactory`:

```typescript
type CustomToolFactory = (api: CustomToolAPI) =>
  CustomTool | CustomTool[] | Promise<CustomTool | CustomTool[]>;
```

Each `CustomTool` implements:
```typescript
interface CustomTool<TParams, TDetails> {
  name: string;                    // "perplexity_search"
  label: string;                   // "Perplexity Search"
  description: string;             // tool description for LLM
  parameters: TSchema;             // TypeBox schema
  execute(toolCallId, params, onUpdate, ctx, signal): Promise<AgentToolResult>;
  renderCall?(args, theme): Component;       // TUI call display
  renderResult?(result, options, theme): Component; // TUI result display
}
```

### Tool Parameters

```typescript
{
  query: string;                              // required
  recency?: "hour" | "day" | "week" | "month" | "year";
  limit?: number;                             // max sources to return
}
```

### Tool Output

Text block formatted for LLM consumption:
```
## Answer
<synthesized answer with inline citations>

## Sources
N sources
[1] Title (age)
    https://url
    snippet...

## Meta
Provider: perplexity (oauth)
Model: <display_model>
```

## Package Structure

```
pi-perplexity/
  package.json          # omp plugin manifest
  tsconfig.json
  src/
    index.ts            # CustomToolFactory entry point
    auth/
      jwt.ts            # JWT decode, expiry extraction
      login.ts          # macOS app extraction + email OTP flow
      storage.ts        # Token persistence (read/write/check expiry)
    search/
      client.ts         # HTTP request to SSE endpoint
      stream.ts         # SSE parsing + event merging
      types.ts          # All type definitions
      format.ts         # Response formatting for LLM output
    render/
      call.ts           # TUI renderCall component
      result.ts         # TUI renderResult component
```

## Dependencies

### Required
- `@sinclair/typebox` — injected by omp via `CustomToolAPI.typebox`, no direct dependency needed
- `@oh-my-pi/pi-tui` — for TUI `Component` type in renderers (peer dependency)

### None (zero runtime dependencies)
- `fetch` — global (Bun/Node 18+)
- `crypto.randomUUID()` — global
- `atob` / `Buffer` — global
- `Bun.$` — for `defaults read` on macOS
- `Intl.DateTimeFormat` — global

The plugin should have **zero npm dependencies**. All HTTP, SSE parsing, and JWT decoding use platform APIs.

## Error Handling

| Error | Behavior |
|---|---|
| No JWT found (not logged in) | Return error text to agent: "Not authenticated. Run `omp login perplexity`." |
| JWT expired | Attempt re-login via macOS app extraction; if fails, return error prompting manual login |
| HTTP 401/403 | JWT revoked or expired; clear stored token, return auth error |
| HTTP 429 | Rate limited; return error with retry suggestion |
| SSE `error_code` in stream | Extract `error_message`, throw SearchError |
| Network failure | Return error text to agent |
| Empty response (no answer, no sources) | Return "No results found" |

## Security Considerations

- JWT stored on disk with user-only permissions (0600)
- `is_incognito: true` prevents queries from appearing in Perplexity history
- No API key needed — subscription auth only
- Token never logged; only expiry metadata logged at debug level
