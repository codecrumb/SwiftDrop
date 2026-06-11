# UI/Backend Review Fixes — 2026-06-11

- [x] Skip HTTPS redirect on localhost so `wrangler dev` works
- [x] Allow same-origin WebSocket connections even when ALLOWED_ORIGINS is set
- [x] Apply origin validation to /nearby (CSWSH gap)
- [x] Escape HTML in nearby display names + file names (XSS from peers on same IP)
- [x] Use crypto.getRandomValues for room code generation
- [x] Fix upload-area drag hover/leave hardcoded light colors (dark mode)
- [x] Verify in browser: WS connects locally, desktop + mobile render correctly

## Review

All changes are in worker.js only. Verified locally with `wrangler dev --local`:

- Same-origin `/ws` upgrade → 101; `Origin: https://evil.example` → 403 on both
  `/ws` and `/nearby`; allowlisted prod origin (`https://f.matan.us`) → 101.
- Headless browser screenshots (desktop 1280px + mobile 390px) show the app
  loading and the signaling WS connecting ("Share this code with receiver:"
  instead of the previous "Reconnecting in 2s…" loop caused by the 403).
- Served client JS passes `node --check` after the escapeHtml edits.

Root cause of broken local dev: wrangler v4 loads `.env.local`, whose
ALLOWED_ORIGINS only lists production domains, so localhost WS handshakes were
rejected; plus the HTTP→HTTPS redirect pushed the browser to a TLS-less
https://localhost.

XSS detail: nearby peer displayName (attacker-controlled by anyone sharing
your public IP) was interpolated into innerHTML in the peer list, trusted-device
list, and trust-offer toast. File names had the same pattern in the sender file
list. All now escaped via escapeHtml().
