# Pop-up Blocked Modal — Design Spec

**Date:** 2026-04-30  
**Status:** Approved

---

## Problem

When a URL is received via P2P or cloud relay, SwiftDrop calls `window.open()` automatically. Browsers block this if it's not triggered by a user gesture. The current fallback shows a small top-right toast with a clickable link — easy to miss, no recovery action.

## Goal

Replace the toast with a large centered modal that clearly explains what happened and gives the user an immediate, reliable path to open the URL.

---

## Key Insight

**Retry via user gesture always works.** Browser popup blockers only block `window.open()` calls not triggered by direct user interaction. A click on the Retry button counts as a user gesture, so the URL will open successfully every time — no browser settings change required.

This means:
- "Retry" is the primary, friction-free fix
- "Browser settings" is optional (prevents future prompts)
- The modal copy should not imply a mandatory settings chore

---

## Detection Strategy

Currently `window.open()` is called with `noopener`, which always returns `null` — making it impossible to detect whether the popup was actually blocked. 

**Change:** Drop `noopener` from the `window.open()` call. A `null` return value means the popup was blocked; a non-null `WindowProxy` means it opened successfully.

Minor security trade-off: the opened page can access `window.opener`. Acceptable here since URLs come from a trusted, intentionally-paired peer device.

---

## Modal Design

### Layout

Option B — icon inline with title (left-aligned header), body text below, buttons below body, de-emphasized footer link at bottom.

### Copy hierarchy

| Element | Content |
|---|---|
| Icon | Feather `alert-triangle` (amber tint, in a rounded square badge) |
| Headline | **Pop-up blocked** |
| Body | Your browser blocked a new tab from opening. Click **Retry** to open it. |
| Primary button | ↻ Retry |
| Secondary button | Cancel |
| Footer link | Tired of seeing this? [Adjust browser settings →](https://telegra.ph/Allowing-SwiftDrop-to-open-new-tabs-04-30) |

### Theming

The modal uses the app's existing CSS custom properties so it automatically follows the dark/light toggle:

- **Background:** `--container-bg`
- **Border:** `--border-color`
- **Heading text:** `--text-primary`
- **Body text:** `--text-secondary`
- **Backdrop:** `rgba(0,0,0,0.5)` fixed overlay beneath the modal

Dark mode: amber `alert-triangle` tint (`rgba(251,191,36,0.12)` background, `#fbbf24` stroke).  
Light mode: amber tint (`rgba(245,158,11,0.10)` background, `#d97706` stroke).  
Retry button: `#4f46e5` (indigo) — matches existing primary action color in the app.

---

## Help Page

**Route:** `/help/popups` — served directly from `worker.js` as a new route handler.

**Screenshot image:** `https://i.imgur.com/8LQP8oS.png` (Imgur CDN) — referenced via `<img>` tag in the help page HTML.

The help page is a self-contained styled HTML page served from the Worker. It matches SwiftDrop's brand (dark/light theme aware), includes the screenshot, and explains that Retry always works and the settings change is only needed to prevent future prompts. Tone is informational, not alarming.

The modal's footer link opens `/help/popups` in a new tab (`target="_blank"`). When the project migrates to Cloudflare Pages, the image moves to `public/` and the URL gets updated — one-line change.

---

## Affected Code (`worker.js`)

Two call sites both get the same treatment:

1. **Line 4028–4032** — P2P direct URL handler  
2. **Line 4341–4346** — `handleUrlFallback()` (cloud relay)

`showUrlToast()` (lines 4556–4576) is **removed entirely** and replaced by the new modal system.

### New components to add

- `<div id="popupBlockedModal">` — modal HTML (hidden by default)
- `<div id="popupBlockedOverlay">` — full-screen backdrop
- CSS for modal + overlay + dark-mode variants (using CSS variables)
- `showPopupBlockedModal(url)` — shows modal, stores URL for Retry
- `hidePopupBlockedModal()` — hides modal + overlay
- Retry button: calls `window.open(storedUrl, '_blank')` (no `noopener`), then `hidePopupBlockedModal()`
- Cancel button: calls `hidePopupBlockedModal()`

### Updated call sites

```js
// Before (both sites):
showUrlToast(url);
window.open(url, '_blank', 'noopener');

// After:
const tab = window.open(url, '_blank');
if (!tab) showPopupBlockedModal(url);
```

---

## Out of Scope

- In-project help page (telegra.ph is sufficient)
- Changing the file/text fallback toast behavior
- Any other toast types
