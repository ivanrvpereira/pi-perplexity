# Security Policy

## Supported Versions

Only the latest published version of `pi-perplexity` receives security fixes.

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via [GitHub private vulnerability reporting](https://github.com/ivanrvpereira/pi-perplexity/security/advisories/new).

You can expect an initial response within a week. Please include steps to reproduce and the impact you believe the issue has.

## Scope Notes

- This extension talks to an undocumented Perplexity endpoint and stores auth tokens at `~/.config/pi-perplexity/auth.json` (mode `0600`). Issues around token handling or storage are in scope.
- The package is published to npm via GitHub Actions OIDC trusted publishing; no long-lived publish tokens exist.
