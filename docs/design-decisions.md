# Design Decisions

## AUTH errors do not auto-clear the cached token

When Perplexity returns 401/403 and `SearchError("AUTH")` is thrown, `src/index.ts` returns an error message directing the user to run `/perplexity-login --force`. It does **not** call `clearToken()` automatically.

**Rationale:** A 401 can be transient — network blip, Cloudflare hiccup, clock skew. Auto-clearing on every 4xx would silently discard a still-valid token and force unnecessary re-authentication. The user decides when to re-login. `/perplexity-login --force` clears and re-authenticates in one explicit step.

The token is only cleared when the user explicitly requests it (`--force`) or calls `clearToken()` directly (e.g. in tests or future tooling).
