# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- Removed the Bun runtime dependency; Perplexity requests now use pi's Node runtime and development uses npm scripts.

### Fixed

- Require reliable `Set-Cookie` access for email OTP auth instead of silently dropping auth cookies on unsupported Node fetch runtimes.
- Cancel the Perplexity search response stream after terminal SSE events to avoid leaving fetch bodies open.

## [0.2.2] - 2026-06-22

### Fixed

- Route email OTP authentication requests through the Bun-backed Perplexity fetch path to avoid CSRF 403 failures under Node/jiti.
- Send browser-like auth headers and include response previews in OTP HTTP errors.

## [0.2.1] - 2026-05-11

### Changed

- Model selection is now controlled by `/perplexity-config` or `PI_PERPLEXITY_MODEL` instead of an LLM-facing tool parameter.
- Updated the configured model list with current Perplexity internal model slugs.

### Added

- Opt-in live E2E test for validating Perplexity model selection.

## [0.2.0] - 2026-03-21

### Added

- **`/perplexity-config` command** — Interactive configuration for default model and incognito mode, stored at `~/.config/pi-perplexity/config.json`
- **Model selection** — New `model` parameter on `perplexity_search` tool to choose Perplexity backend model (Sonar, GPT-5.4, Claude 4.6 Sonnet Thinking, Gemini 3.1 Pro, Deep Research, etc.)
- **Incognito toggle** — New `incognito` parameter to control whether searches appear in Perplexity web history
- **Config priority chain** — Per-call params → env vars (`PI_PERPLEXITY_MODEL`, `PI_PERPLEXITY_INCOGNITO`) → config file → defaults
- **Config display in TUI** — Render components now show model and incognito status

### Changed

- Auto-clear cached token on auth rejection instead of requiring manual `/perplexity-login --force`

### Fixed

- Restore error rendering and safe error handling in search client
- Apply config defaults to Perplexity UI settings
- Simplify current model label in config
- Isolate tests from `mock.module` cache pollution

## [0.1.3] - 2026-02-23

### Added

- `pi-extension` keyword for pi package discovery

## [0.1.2] - 2026-02-23

### Fixed

- Fix install commands in README
- Fix tag pattern to match v-prefixed tags
- Strip v prefix in version check
- Simplify README description

## [0.1.1] - 2026-02-23

### Added

- Perplexity web search tool (`perplexity_search`) for pi coding agent
- macOS desktop app token extraction (zero-interaction auth)
- Email OTP fallback authentication flow
- SSE stream client for Perplexity's internal API
- Source formatting with age, snippets, and deduplication
- TUI render components for tool calls and results
- Token persistence with secure file permissions
- npm publish GitHub Actions workflow with OIDC trusted publishing
- MIT license

### Technical

- Zero runtime dependencies — uses platform globals only
- Incremental SSE event merging with block-level deduplication
- JWT expiry tracking with 5-minute buffer
