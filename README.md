# pi-perplexity

A [pi](https://github.com/badlogic/pi-mono) extension that gives your coding agent real-time web search powered by your **Perplexity Pro or Max subscription**
## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent with its bundled Node runtime (Node 18.14.1+ if running outside pi)
- A **Perplexity Pro** or **Max** subscription
- macOS (for zero-interaction auth) _or_ an interactive terminal (for email OTP)

## Installation

```bash
pi install npm:pi-perplexity
```

Or from GitHub:

```bash
pi install github:ivanrvpereira/pi-perplexity
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
| `PI_PERPLEXITY_MODEL` | Override the configured search model |

## Usage

Once installed, the agent automatically calls `perplexity_search` whenever it needs current information. You can also ask it directly:

> "Search Perplexity for the latest React 19 release notes"

### Tool parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | The search query |
| `recency` | string | — | Filter by age: `hour` · `day` · `week` · `month` · `year` |
| `limit` | number | — | Max sources to include (1–50) |

Model selection is configured globally with `/perplexity-config` or `PI_PERPLEXITY_MODEL`; it is not exposed as a tool parameter, so agent-generated tool calls cannot accidentally override your configured model.

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

Queries always use `is_incognito: true` so the extension does not write to your Perplexity history.

## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) using your subscription credentials obtained from the macOS app or via email OTP. Responses stream as incremental events that are merged into a final result. Network calls use the Node runtime already provided by pi; no extra runtime is required. Email OTP auth requires `Headers.getSetCookie()` support so auth cookies are exposed reliably.

## Development

```bash
npm install          # Install dev dependencies
npm test             # Run tests
npm run typecheck    # Type check
```

Optional live model-selection E2E test (requires cached auth from `/perplexity-login`):

```bash
PI_PERPLEXITY_E2E=1 npm test
PI_PERPLEXITY_E2E=1 PI_PERPLEXITY_E2E_MODELS=pplx_pro_upgraded,gpt54 npm test
```

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Disclaimer

This project is intended for **educational and demonstration purposes only**. It reverse-engineers an undocumented internal endpoint and uses credentials borrowed from the Perplexity macOS desktop app. This likely violates Perplexity's Terms of Service. Use at your own risk — your account may be suspended. The author makes no warranties and accepts no liability for any consequences of its use.
