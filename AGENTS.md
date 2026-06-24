# AGENTS.md — pi-perplexity

## What This Is

A **pi extension** (plugin for `@mariozechner/pi-coding-agent`) that provides web search via a Perplexity Pro/Max subscription. Uses OAuth JWT authentication against Perplexity's internal SSE endpoint — no API credits consumed, only the subscription.

## Build / Test / Lint

```bash
# Type check
npm run typecheck

# Run tests
npm test

# Quick smoke test — factory returns valid tool shape
node --import @mariozechner/jiti/register --input-type=module -e "import('./src/index.ts').then((m)=>{ const entry = m.default?.default ?? m.default; if (typeof entry !== 'function') throw new Error('default export missing'); })"
```

No build step. Extensions are loaded via jiti — TypeScript runs directly.

## Project Structure

```
pi-perplexity/
  package.json              # pi extension manifest (see "omp"/"pi" field)
  tsconfig.json
  AGENTS.md                 # You are here
  docs/
    design-decisions.md     # Rationale for non-obvious behavior
  src/
    index.ts                # CustomToolFactory entry — default export
    auth/
      jwt.ts                # JWT base64url decode, expiry extraction
      login.ts              # macOS app extraction + email OTP flow
      storage.ts            # Token persistence (~/.config/pi-perplexity/auth.json)
    search/
      types.ts              # All type definitions (StreamEvent, SearchResult, etc.)
      client.ts             # HTTP POST to SSE endpoint, orchestrates stream + merge
      stream.ts             # SSE line parser + incremental event merging
      format.ts             # SearchResult → LLM-readable text output
    render/
      call.ts               # TUI renderCall component
      result.ts             # TUI renderResult component
```

## Critical Constraints

### Zero Runtime Dependencies
This plugin has **zero npm dependencies**. All HTTP, SSE parsing, JWT decoding, and UUID generation use platform globals:
- `fetch` — global (Node 18.14.1+ for `Headers.getSetCookie()` support)
- `crypto.randomUUID()` — global
- `atob` / `Buffer.from(payload, "base64url")` — global
- `Intl.DateTimeFormat` — global

Do NOT add dependencies to `dependencies` in package.json.

### Peer Dependencies Only
These are bundled by pi and must go in `peerDependencies` with `"*"` range:
- `@sinclair/typebox` — schema definitions (injected at runtime via `api.typebox`)
- `@mariozechner/pi-tui` — TUI Component types for renderers

### Reverse-Engineered API
The Perplexity SSE endpoint is **not a public API**. It can break without notice.
- Keep types loose — all fields optional
- Keep the client thin — minimal assumptions about response shape
- Specific User-Agent and headers are required (see `src/search/client.ts`)
- `is_incognito: true` always — don't pollute user's Perplexity history

## Coding Conventions

### TypeScript
- `strict: true`, `noEmit: true`
- Target: ESNext, module: ESNext, moduleResolution: bundler
- Use `interface` for data shapes, `type` for unions/aliases
- All stream event fields are optional — the API is unstable

### Extension API
- Entry point: `src/index.ts` exports `default` function or factory
- Import types from `@mariozechner/pi-coding-agent`
- Use `StringEnum` from `@mariozechner/pi-ai` for string enum params — `Type.Union`/`Type.Literal` breaks Google's API
- Tool execute signature: `execute(toolCallId, params, signal, onUpdate, ctx)`
- Return shape: `{ content: [{ type: "text", text }], details: { ... } }`

### Naming
- Tool name: `perplexity_search` (snake_case, matches pi convention)
- File names: lowercase, descriptive (`stream.ts`, `client.ts`, `jwt.ts`)
- Types: PascalCase (`StreamEvent`, `SearchResult`, `StoredToken`)
- Constants: UPPER_SNAKE or camelCase for compound values

### Error Handling
- Never throw raw errors from tool execute — always return error text in `content`
- Use a `SearchError` class for typed errors with code and message
- HTTP 401/403: return an auth error telling the user to run `/perplexity-login --force`; do not clear stored tokens as a hidden side effect
- HTTP 429: return rate limit message with retry suggestion
- Network failures: return error text, don't crash
- Empty responses: return "No results found"
- JWT errors: fallback expiry of 1 hour if decode fails

## Auth Flow (two paths, tried in order)

1. **macOS Desktop App** (zero-interaction): `defaults read ai.perplexity.mac authToken`
   - Skip if `PI_AUTH_NO_BORROW=1` is set
   - Returns null on non-macOS or if app not installed
2. **Email OTP** (interactive fallback): CSRF → send OTP → verify OTP
  - Uses `ctx.ui.input()` for email and OTP prompts

Token stored at `~/.config/pi-perplexity/auth.json` with `0600` permissions.
JWT expiry: `decoded.exp * 1000 - 5min` buffer. No auto-refresh — re-login on expiry.

## SSE Stream Protocol

Endpoint: `POST https://www.perplexity.ai/rest/sse/perplexity_ask`

Events are **incremental snapshots** that must be merged:
- Top-level fields: shallow merge
- Blocks: keyed by `intended_usage` — merge, don't replace array
- Markdown chunks: respect `chunk_starting_offset` for splice
- Sources: accumulate, never replace; preserve from earlier events

Stream terminates when `event.final === true` or `event.status === "COMPLETED"`.

Answer extraction priority: markdown blocks → ask_text blocks → event.text fallback.
Source extraction priority: web_results block → sources_list fallback. Deduplicate by URL.

Keep protocol assumptions close to `src/search/client.ts`, `src/search/stream.ts`, and fixture-backed tests.

## Tool Output Format

```
## Answer
<synthesized answer>

## Sources
N sources
[1] Title (2d ago)
    https://url
    snippet preview...

## Meta
Provider: perplexity (oauth)
Model: <display_model>
```

- Age: human-readable relative time ("2d ago", "3h ago", "just now")
- Snippets: truncated to 240 chars
- Source count: respect `limit` parameter

## Key References

| What | Where |
|------|-------|
| Auth side effects and other rationale | `docs/design-decisions.md` |
| Request body, headers, answer/source extraction | `src/search/client.ts` |
| SSE parser and incremental merge behavior | `src/search/stream.ts` |
| Protocol fixtures and regression coverage | `test/fixtures/`, `test/search/` |

## Design Decisions

See `docs/design-decisions.md` for rationale on non-obvious choices.

## Common Gotchas

- `Type.Union([Type.Literal("a"), ...])` does NOT work for Google models — use `StringEnum` from `@mariozechner/pi-ai`
- Tool `execute` param order is `(toolCallId, params, signal, onUpdate, ctx)` — signal before onUpdate
- The SSE stream is NOT standard Server-Sent Events — it uses `data:` lines with JSON but requires custom parsing for multi-line data fields and `[DONE]` marker
- Perplexity SSE events are incremental snapshots, not deltas — each event contains the full state up to that point, but blocks must still be merged by `intended_usage` key
- macOS `defaults read` via `node:child_process` — handle non-zero exit code (app not installed) gracefully
- JWT `exp` claim is in seconds, not milliseconds — multiply by 1000
- Token file must be written with `0600` permissions — use `node:fs/promises` and enforce mode on existing files
- Always pass `AbortSignal` through to `fetch` for cancellation support
