# pi-perplexity

A [pi](https://github.com/nickarrow/pi-coding-agent) extension that provides web search via a Perplexity Pro/Max subscription. Uses your existing subscription — no API credits consumed.

## Installation

```bash
pi install pi-perplexity
```

## Usage

Once installed, the agent gains a `perplexity_search` tool it can call automatically when it needs to look something up. You can also trigger a search by asking the agent to search for something.

### Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `recency` | string | no | Filter by age: `hour`, `day`, `week`, `month`, `year` |
| `limit` | number | no | Max sources to return (1–50) |

### Slash Command

```
/perplexity-login            # Authenticate and save token
/perplexity-login --force    # Clear cached token and re-authenticate
```

## Authentication

The extension tries two auth methods in order:

1. **macOS Desktop App** (automatic) — Borrows the JWT from the Perplexity macOS app if installed and signed in. Zero interaction required.

2. **Email OTP** (interactive fallback) — Prompts for your Perplexity email, sends a one-time code, and prompts for the code.

The token is cached at `~/.config/pi-perplexity/auth.json` (permissions `0600`). On HTTP 401/403, the cached token is automatically cleared so the next search re-authenticates.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_AUTH_NO_BORROW=1` | Skip macOS desktop app token extraction |
| `PI_PERPLEXITY_EMAIL` | Email for OTP auth (skips interactive prompt) |
| `PI_PERPLEXITY_OTP` | OTP code for non-interactive auth |

## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) with your subscription credentials. Responses stream as incremental events that are merged into a final result containing an answer and sources.

All queries use `is_incognito: true` — nothing appears in your Perplexity search history.

### Output Format

The tool returns structured text the agent can reason over:

```
## Answer
<synthesized answer with inline citations>

## Sources
3 sources
[1] Example Article (2d ago)
    https://example.com/article
    Brief snippet of the source content...

[2] Another Source (5h ago)
    https://example.com/other
    Another snippet preview...

## Meta
Provider: perplexity (oauth)
Model: pplx_pro_upgraded
```

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime
- pi coding agent (`@mariozechner/pi-coding-agent`)

### Commands

```bash
bun install             # Install dev dependencies
bun test                # Run tests (30 tests across 6 files)
bunx tsc --noEmit       # Type check
```

### Project Structure

```
src/
  index.ts              # Extension entry — registers tool and commands
  auth/
    login.ts            # macOS app extraction + email OTP flow
    storage.ts          # Token persistence (~/.config/pi-perplexity/auth.json)
  commands/
    login.ts            # /perplexity-login slash command
  search/
    types.ts            # Type definitions (StreamEvent, SearchResult, errors)
    client.ts           # HTTP POST to SSE endpoint, event merging, result extraction
    stream.ts           # SSE line parser + incremental event merging
    format.ts           # SearchResult → LLM-readable text output
  render/
    call.ts             # TUI component for tool call display
    result.ts           # TUI component for tool result display
    util.ts             # Shared render utilities
```

### Runtime Dependencies

This extension depends on the `bun` runtime package at execution time.

Why: when pi loads extensions under Node/jiti, direct `fetch` to Perplexity is Cloudflare-challenged, so searches are executed through a Bun subprocess.

Everything else uses platform globals:

- `fetch` — HTTP requests
- `crypto.randomUUID()` — request IDs
- `ReadableStream` — SSE parsing
- `Intl.DateTimeFormat` — timezone detection

Peer dependencies (`@sinclair/typebox`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`) are provided by pi at runtime.

## Requirements

- Perplexity **Pro** or **Max** subscription
- Bun installed and available on `PATH` (used by the search client when running under Node/jiti)
- macOS (for desktop app token extraction) or interactive terminal (for email OTP)

## License

Private — not published.
