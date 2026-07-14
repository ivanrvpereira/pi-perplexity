# pi-perplexity

A [pi](https://github.com/badlogic/pi-mono) extension that gives your coding agent real-time web search powered by your **Perplexity Pro or Max subscription**
## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent with its bundled Node runtime (Node 18.14.1+ if running outside pi)
- A **Perplexity Pro** or **Max** subscription
- macOS (for zero-interaction auth), an interactive terminal (for email OTP), or a signed-in browser session cookie/token

## Installation

```bash
pi install npm:pi-perplexity
```

Or from GitHub:

```bash
pi install github:ivanrvpereira/pi-perplexity
```

## Authentication

Run login once:

```text
/perplexity-login
```

This usually reuses an existing cached login, borrows the Perplexity macOS app login if available, or asks for your email OTP code.

If login fails with a Cloudflare “Just a moment...” page, use browser login instead:

```text
/perplexity-login --browser
```

### Browser login

Use this on Linux/headless machines when direct OTP is blocked.

1. Open `https://www.perplexity.ai` and sign in.
2. Open browser DevTools → **Network**.
3. Reload the page, or ask one Perplexity question.
4. Right-click a `www.perplexity.ai` request, preferably `perplexity_ask`.
5. Choose **Copy** → **Copy as cURL**.
6. Paste the copied cURL command into the pi prompt.

The copied text must include cookies. A good copy contains one of `-b`, `--cookie`, or `Cookie:`, and should include `__Secure-next-auth.session-token`. If it does not, copy a different request.

You can also paste just the request `Cookie:` header, or just the `__Secure-next-auth.session-token` cookie value. Full cURL is recommended because it also includes Cloudflare cookies like `cf_clearance`.

The token is saved to `~/.config/pi-perplexity/auth.json` (mode `0600`) and reused across sessions. On auth failure, run `/perplexity-login --force` to clear and re-authenticate.

### Environment variables

| Variable | Description |
|---|---|
| `PI_AUTH_NO_BORROW=1` | Skip macOS desktop app extraction and go straight to email OTP |
| `PI_PERPLEXITY_TOKEN` | Raw Perplexity session token/JWT/JWE copied from a browser or another machine |
| `PI_PERPLEXITY_COOKIE` / `PI_PERPLEXITY_COOKIES` | Full Perplexity `Cookie` header copied from a signed-in browser |
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

Queries always send `is_incognito: true`, so searches never appear in your Perplexity web history.

## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) using your subscription credentials obtained from the macOS app, email OTP, or a browser-imported session. Responses stream as incremental events that are merged into a final result. Network calls use the Node runtime already provided by pi; no extra runtime is required. Email OTP auth requires `Headers.getSetCookie()` support so auth cookies are exposed reliably.

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
