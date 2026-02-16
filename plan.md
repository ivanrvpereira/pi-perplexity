# pi-perplexity Implementation Plan

## Prerequisites

- Bun installed
- oh-my-pi installed (for testing the plugin)
- Perplexity macOS app installed and logged in (for Path 1 auth), OR a Perplexity account email (for Path 2 OTP auth)

---

## Phase 1: Project Scaffold

### 1.1 Initialize package

```
pi-perplexity/
  package.json
  tsconfig.json
  src/
    index.ts
```

**package.json** — must include `omp` (or `pi`) manifest field:
```json
{
  "name": "pi-perplexity",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "omp": {
    "name": "Perplexity Search",
    "description": "Web search via Perplexity Pro/Max subscription (OAuth)",
    "tools": "src/index.ts",
    "settings": {
      "email": {
        "type": "string",
        "description": "Perplexity account email (for OTP login)",
        "env": "PERPLEXITY_EMAIL"
      }
    }
  },
  "peerDependencies": {
    "@oh-my-pi/pi-tui": "*"
  },
  "devDependencies": {
    "@oh-my-pi/pi-tui": "workspace:*",
    "@oh-my-pi/pi-agent-core": "workspace:*",
    "@sinclair/typebox": "*",
    "typescript": "*"
  }
}
```

**tsconfig.json** — extend from oh-my-pi root or standalone:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**src/index.ts** — skeleton factory:
```typescript
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent/extensibility";

const factory: CustomToolFactory = (api) => {
  return {
    name: "perplexity_search",
    label: "Perplexity Search",
    description: "...",
    parameters: api.typebox.Type.Object({
      query: api.typebox.Type.String({ description: "Search query" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return { content: [{ type: "text", text: "TODO" }] };
    },
  };
};

export default factory;
```

### Acceptance
- `bun run --bun src/index.ts` doesn't crash
- Factory returns a valid CustomTool shape

---

## Phase 2: Auth — JWT Acquisition and Storage

### 2.1 JWT utilities (`src/auth/jwt.ts`)

Implement:
- `decodeJwtExpiry(token: string): number` — base64url decode payload, extract `exp` claim, return ms with 5-min margin. Fallback: now + 1 hour.
- `isJwtExpired(token: string, bufferMs?: number): boolean`

No dependencies. Use `atob` or `Buffer.from(payload, "base64url")`.

### 2.2 Token storage (`src/auth/storage.ts`)

Implement:
- `loadToken(): Promise<StoredToken | null>` — read from `~/.config/pi-perplexity/auth.json`
- `saveToken(token: StoredToken): Promise<void>` — write with `0600` permissions
- `clearToken(): Promise<void>` — delete file

```typescript
interface StoredToken {
  jwt: string;
  expires: number;
  email?: string;
  acquiredAt: number;
}
```

Use `Bun.write()` and `Bun.file()`. Handle ENOENT on read (no stored token).

### 2.3 Login flow (`src/auth/login.ts`)

Implement:
- `extractFromDesktopApp(): Promise<string | null>` — `defaults read ai.perplexity.mac authToken` via `Bun.$`. macOS only, returns null on other platforms or if app not installed.
- `loginViaEmailOtp(promptFn): Promise<string>` — three-step HTTP flow (CSRF -> send OTP -> verify OTP). Uses `fetch` with the required headers.
- `authenticate(promptFn): Promise<StoredToken>` — tries desktop extraction, falls back to email OTP, saves result.

Constants:
```typescript
const USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const API_VERSION = "2.18";
```

### Acceptance
- Can extract JWT from macOS app (if installed)
- Can complete email OTP flow (manual test)
- Token persists across process restarts
- Expired tokens detected correctly

---

## Phase 3: SSE Client and Event Merging

### 3.1 Type definitions (`src/search/types.ts`)

Define all types from architecture.md:
- `StreamEvent`, `StreamBlock`, `MarkdownBlock`, `WebResult`, `StreamSource`
- `SearchResult` (unified output: answer, sources, model, requestId)
- `SearchSource` (title, url, snippet, publishedDate, ageSeconds)
- `SearchParams` (query, recency, limit, signal)
- `SearchError` class

### 3.2 SSE stream parser (`src/search/stream.ts`)

Implement:
- `async function* readSseEvents<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T>` — reads SSE `data:` lines, parses JSON, yields typed events. Handles `[DONE]` marker. Abort-aware via signal.

This is the core utility. Parse byte stream line by line, detect `data:` prefix, accumulate multi-line data fields, parse JSON.

### 3.3 Event merging (`src/search/stream.ts`)

Implement:
- `mergeMarkdownBlock(existing, incoming): MarkdownBlock` — handle `chunk_starting_offset` splice logic
- `mergeBlocks(existing, incoming): StreamBlock[]` — key by `intended_usage`, merge markdown blocks
- `mergeEvent(existing, incoming): StreamEvent` — shallow merge top-level, delegate blocks, preserve sources

### 3.4 Search client (`src/search/client.ts`)

Implement:
- `searchPerplexity(params: SearchParams, jwt: string): Promise<SearchResult>`

Steps:
1. Build request body (query, params object with all required fields)
2. `fetch` POST to `https://www.perplexity.ai/rest/sse/perplexity_ask` with required headers
3. Iterate SSE events via `readSseEvents()`, merge incrementally
4. On stream end, extract answer (markdown blocks -> ask_text -> text fallback)
5. Extract sources (web_results block -> sources_list fallback), deduplicate by URL
6. Return `SearchResult`

### Acceptance
- Given a valid JWT, returns answer + sources for a test query
- Handles stream errors (error_code in event)
- Handles abort signal
- Empty results return gracefully

---

## Phase 4: Response Formatting

### 4.1 LLM output formatter (`src/search/format.ts`)

Implement:
- `formatForLLM(result: SearchResult): string`

Output format:
```
## Answer
<answer text>

## Sources
N sources
[1] Title (2d ago)
    https://url
    snippet preview...
...

## Meta
Provider: perplexity (oauth)
Model: <display_model>
Request: <uuid>
```

- Age calculation: `(Date.now() - new Date(dateStr).getTime()) / 1000` -> human-readable ("2d ago", "3h ago", "just now")
- Truncate snippets to 240 chars
- Respect `limit` param for source count

### Acceptance
- Output is clean, readable, parseable by LLM
- Sources numbered and linked
- Age formatting works for various date formats

---

## Phase 5: Plugin Integration

### 5.1 Tool definition (`src/index.ts`)

Wire everything together:

```typescript
const factory: CustomToolFactory = (api) => {
  const { Type } = api.typebox;

  return {
    name: "perplexity_search",
    label: "Perplexity Search",
    description: "...", // from a .md file or inline
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      recency: Type.Optional(
        Type.Union([
          Type.Literal("hour"),
          Type.Literal("day"),
          Type.Literal("week"),
          Type.Literal("month"),
          Type.Literal("year"),
        ], { description: "Filter results by recency" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max sources to return", minimum: 1, maximum: 50 })
      ),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      // 1. Get or refresh JWT
      // 2. Call searchPerplexity()
      // 3. Format result
      // 4. Return { content: [{ type: "text", text }], details }
    },
  };
};
```

### 5.2 Tool description prompt

Create `src/prompts/tool-description.md`:
```markdown
# Perplexity Search

Search the web using Perplexity Pro with multi-step reasoning and source citations.

<instruction>
- Use for questions requiring up-to-date web information
- Prefer primary sources; corroborate claims across multiple results
- Include source links in your response
</instruction>

<output>
Returns synthesized answer with numbered source citations, URLs, and snippets.
</output>

<params>
- query: Search query (required)
- recency: Filter by time — hour, day, week, month, year (optional)
- limit: Maximum number of sources to return (optional)
</params>
```

### 5.3 TUI rendering (optional, can defer)

If TUI rendering is desired:
- `renderCall(args, theme)` — show query text and recency filter
- `renderResult(result, options, theme)` — show answer preview, source count, expandable source list

This requires importing `@oh-my-pi/pi-tui` Component types. Can be added later; the tool works without it (omp shows raw text).

### Acceptance
- Plugin loads when registered with omp (`omp plugin install ./pi-perplexity`)
- Agent sees `perplexity_search` tool
- Agent can invoke tool and gets results
- Results display in TUI

---

## Phase 6: Login Command (optional)

### 6.1 Custom command for `omp login perplexity`

If the plugin should expose a login command:

Create `src/commands/login.ts`:
```typescript
// CustomCommand that triggers the auth flow interactively
```

Register in package.json manifest:
```json
"omp": {
  "commands": ["src/commands/login.ts"]
}
```

This allows `omp perplexity login` or similar. If not needed, the tool's `execute` can trigger login on first use.

---

## Phase 7: Testing

### 7.1 Unit tests

- `auth/jwt.test.ts` — JWT decode, expiry extraction, edge cases (malformed, missing exp)
- `search/stream.test.ts` — SSE parsing with fixture data, event merging logic
- `search/format.test.ts` — LLM output formatting, age calculation, truncation

### 7.2 Integration tests (manual)

- End-to-end: authenticate -> search -> verify answer and sources returned
- Expired JWT handling: mock expired token, verify re-auth prompt
- Abort: cancel mid-stream, verify clean exit
- Error responses: 401, 429, stream errors

### 7.3 Fixture data

Capture real SSE responses from Perplexity for test fixtures:
```typescript
// test/fixtures/sse-response.txt — raw SSE stream
// test/fixtures/merged-event.json — expected merged result
```

---

## Implementation Order

```
Phase 1: Scaffold          (~30 min)  — package.json, tsconfig, skeleton factory
Phase 2: Auth              (~2 hours) — JWT decode, storage, login flow
Phase 3: SSE Client        (~3 hours) — stream parser, event merging, search client
Phase 4: Formatting        (~1 hour)  — LLM output formatting
Phase 5: Plugin Wiring     (~1 hour)  — connect auth + search + format in factory
Phase 6: Login Command     (~30 min)  — optional interactive login command
Phase 7: Testing           (~2 hours) — unit tests + manual integration
```

Total estimate: ~10 hours

### Critical path

Phase 3 (SSE parsing + event merging) is the most complex and error-prone component. The incremental merge logic for markdown chunks with offset splicing needs careful testing with real Perplexity SSE data. Capture fixtures early.

### Risk areas

1. **Perplexity API instability** — this is a reverse-engineered internal API, not a public contract. Headers, body format, or SSE event schema could change without notice. Mitigate by keeping the client thin and the types loose (optional fields everywhere).

2. **JWT expiry** — Perplexity JWTs from the desktop app may have varying lifetimes. The 5-minute buffer should handle most cases, but monitor for short-lived tokens.

3. **macOS-only desktop extraction** — Path 1 only works on macOS. Linux/Windows users must use email OTP. This is acceptable for the initial version.

4. **Cloudflare challenges** — Perplexity uses Cloudflare. The specific User-Agent and headers bypass managed challenges (reverse-engineered from the macOS app). If Cloudflare changes rules, this may break.
