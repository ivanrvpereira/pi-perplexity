# pi-perplexity

A [pi](https://github.com/badlogic/pi-mono) extension that gives your coding agent real-time web search powered by your **Perplexity Pro or Max subscription** — no API key, no extra credits, just your existing plan.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- [Bun](https://bun.sh) runtime (available on `PATH`)
- A **Perplexity Pro** or **Max** subscription
- macOS (for zero-interaction auth) _or_ an interactive terminal (for email OTP)

## Installation

```bash
pi install pi-perplexity
```

Or add to your `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "packages": ["pi-perplexity"]
}
```

## Authentication

Run the login command once to cache your token:

```
/perplexity-login
```

The extension tries two methods in order:

1. **macOS Desktop App** _(zero interaction)_ — borrows the JWT directly from the Perplexity macOS app if it's installed and signed in. Nothing to type.
2. **Email OTP** _(interactive fallback)_ — prompts for your Perplexity email, sends a one-time code, and prompts for the code.

The token is saved to `~/.config/pi-perplexity/auth.json` (mode `0600`) and reused across sessions. On auth failure, run `/perplexity-login --force` to clear and re-authenticate.

### Environment variables

| Variable | Description |
|---|---|
| `PI_AUTH_NO_BORROW=1` | Skip macOS desktop app extraction and go straight to email OTP |
| `PI_PERPLEXITY_EMAIL` | Pre-fill the email prompt (useful for non-interactive setups) |
| `PI_PERPLEXITY_OTP` | Pre-fill the OTP prompt |

## Usage

Once installed, the agent automatically calls `perplexity_search` whenever it needs current information. You can also ask it directly:

> "Search Perplexity for the latest React 19 release notes"

### Tool parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | The search query |
| `recency` | string | — | Filter by age: `hour` · `day` · `week` · `month` · `year` |
| `limit` | number | — | Max sources to include (1–50) |

### Output format

The tool returns structured text the agent can reason over:

```
## Answer
React 19 introduces Actions, use() hook, and improved Server Components...

## Sources
3 sources
[1] React 19 Release Notes (1d ago)
    https://react.dev/blog/2024/12/05/react-19
    React 19 is now stable. This release includes Actions for async...

[2] What's New in React 19 (3d ago)
    https://vercel.com/blog/react-19
    A deep dive into the new primitives landing in React 19...

## Meta
Provider: perplexity (oauth)
Model: pplx_pro_upgraded
```

All queries use `is_incognito: true` — nothing shows up in your Perplexity history.

## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) using your subscription credentials obtained from the macOS app or via email OTP. Responses stream as incremental events that are merged into a final result.

When pi loads extensions under Node/jiti, direct `fetch` to Perplexity gets Cloudflare-challenged, so the search client shells out to a Bun subprocess — that's the only reason Bun is required.

## Development

```bash
bun install        # Install dev dependencies
bun test           # Run tests
bunx tsc --noEmit  # Type check
```

### Project structure

```
src/
  index.ts          # Extension entry — registers tool and commands
  constants.ts      # Shared constants (User-Agent, API version)
  auth/
    login.ts        # macOS app extraction + email OTP flow
    storage.ts      # Token persistence (~/.config/pi-perplexity/auth.json)
  commands/
    login.ts        # /perplexity-login slash command handler
  search/
    types.ts        # Type definitions (StreamEvent, SearchResult, errors)
    client.ts       # POST to SSE endpoint, event merging, result extraction
    stream.ts       # SSE line parser + incremental event merging
    format.ts       # SearchResult → LLM-readable text
  render/
    call.ts         # TUI component for tool call display
    result.ts       # TUI component for tool result display
    util.ts         # Shared render utilities
```

## License

MIT — see [LICENSE](LICENSE) for details.
