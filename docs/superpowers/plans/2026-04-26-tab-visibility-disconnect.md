# Tab Visibility Disconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disconnect Room and Nearby WebSockets after a tab has been hidden for 60 seconds, and reconnect transparently when the tab becomes visible again.

**Architecture:** A single unified `visibilitychange` handler replaces the two existing ones. It manages a 60-second timer; when the timer fires it closes both WebSockets (skipping if a transfer is in progress). On visible, the timer is cancelled and connections are reopened. A new `nearbyIntentionalClose` flag mirrors the existing `isIntentionalClose` flag to suppress Nearby's 3-second auto-reconnect during intentional disconnects.

**Tech Stack:** Vanilla JS, WebSocket API, `document.visibilitychange`, `setTimeout`/`clearTimeout`

---

### Task 1: Add `nearbyIntentionalClose` flag to suppress Nearby auto-reconnect

The `nearbyConnect()` close handler auto-reconnects after 3 seconds whenever `nearbyIsEnabled()` is true (line 4782). Without a flag, intentionally closing Nearby on tab hide will just reconnect 3 seconds later.

**Files:**
- Modify: `worker.js:4751` (near `let nearbyWs = null`)
- Modify: `worker.js:4777-4783` (close handler inside `nearbyConnect`)
- Modify: `worker.js:4790-4794` (the `nearbyDisconnect` function)

- [ ] **Step 1: Declare `nearbyIntentionalClose` flag**

Find line 4751 (`let nearbyWs = null;`) and add the flag on the next line:

```js
let nearbyWs = null;
let nearbyIntentionalClose = false;
```

- [ ] **Step 2: Guard auto-reconnect with the flag**

Find the `close` event handler inside `nearbyConnect()` (lines 4777–4783):

```js
nearbyWs.addEventListener('close', () => {
  console.log('[Nearby] Disconnected');
  nearbyPeers = [];
  nearbyRenderPeers();
  // Reconnect after 3s if still enabled
  if (nearbyIsEnabled()) setTimeout(nearbyConnect, 3000);
});
```

Replace with:

```js
nearbyWs.addEventListener('close', () => {
  console.log('[Nearby] Disconnected');
  nearbyPeers = [];
  nearbyRenderPeers();
  // Reconnect after 3s if still enabled and close was not intentional
  if (nearbyIsEnabled() && !nearbyIntentionalClose) setTimeout(nearbyConnect, 3000);
  nearbyIntentionalClose = false;
});
```

- [ ] **Step 3: Set the flag in `nearbyDisconnect` before closing**

Find `nearbyDisconnect()` (lines 4790–4794):

```js
function nearbyDisconnect() {
  if (nearbyWs) {
    nearbyWs.close();
    nearbyWs = null;
  }
```

Replace with:

```js
function nearbyDisconnect() {
  if (nearbyWs) {
    nearbyIntentionalClose = true;
    nearbyWs.close();
    nearbyWs = null;
  }
```

- [ ] **Step 4: Manual smoke test**

Open the app in a browser with DevTools Network tab open. Enable Nearby. Confirm a WebSocket connection to `/nearby` appears. Toggle Nearby off via the settings toggle — confirm the WS closes and does NOT reopen after 3 seconds.

- [ ] **Step 5: Commit**

```bash
git add worker.js
git commit -m "fix(nearby): suppress auto-reconnect on intentional disconnect"
```

---

### Task 2: Replace both existing `visibilitychange` listeners with one unified handler

Two separate `visibilitychange` listeners exist today:
- Lines 3122–3127: re-acquires wake lock on visible
- Lines 4809–4814: calls `nearbyConnect()` on visible

They must be removed and replaced with a single handler that owns all visibility logic.

**Files:**
- Modify: `worker.js:3122-3127` (wake lock listener — remove)
- Modify: `worker.js:4809-4814` (Nearby reconnect listener — remove)
- Modify: `worker.js:3129` (after `transferInProgress` declaration — add unified handler)

- [ ] **Step 1: Remove the wake lock `visibilitychange` listener**

Find and remove lines 3122–3127:

```js
// Re-acquire after tab becomes visible again (wake lock auto-releases on hide)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && transferInProgress) {
    acquireWakeLock();
  }
});
```

Delete those 5 lines entirely.

- [ ] **Step 2: Remove the Nearby `visibilitychange` listener**

Find and remove lines 4809–4814:

```js
// Reconnect when tab regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && nearbyIsEnabled()) {
    nearbyConnect();
  }
});
```

Delete those 5 lines entirely.

- [ ] **Step 3: Add the unified handler**

Directly after `let transferInProgress = false;` (now ~line 3129 after the deletion in Step 1), add:

```js
// ── Tab Visibility Management ─────────────────────────────────────────────
// Disconnect WebSockets after 60s hidden to avoid wasting Durable Object
// invocations. Reconnect immediately when the tab becomes visible again.
// P2P (WebRTC data channel) is unaffected — it is peer-to-peer.
let visibilityHideTimer = null;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Start the 60-second countdown
    visibilityHideTimer = setTimeout(() => {
      visibilityHideTimer = null;
      if (transferInProgress) return; // never interrupt an active transfer

      // Close Room WebSocket (isIntentionalClose suppresses backoff reconnect)
      if (ws && ws.readyState <= WebSocket.OPEN) {
        isIntentionalClose = true;
        ws.close();
        isIntentionalClose = false;
      }

      // Close Nearby WebSocket (nearbyIntentionalClose suppresses auto-reconnect)
      nearbyDisconnect();
    }, 60_000);
  } else {
    // Tab is visible again — cancel any pending disconnect
    if (visibilityHideTimer !== null) {
      clearTimeout(visibilityHideTimer);
      visibilityHideTimer = null;
    }

    // Reconnect Room WebSocket if we have a room and it's gone
    if (roomCode && (!ws || ws.readyState > WebSocket.OPEN)) {
      connectWebSocket(roomCode, true);
    }

    // Reconnect Nearby if enabled and disconnected
    if (nearbyIsEnabled() && (!nearbyWs || nearbyWs.readyState > WebSocket.OPEN)) {
      nearbyConnect();
    }

    // Re-acquire wake lock if a transfer is in progress (auto-releases on hide)
    if (transferInProgress) acquireWakeLock();
  }
});
// ─────────────────────────────────────────────────────────────────────────
```

- [ ] **Step 4: Manual smoke test — quick tab switch**

Open app, join a room (or just load the page with Nearby enabled). Switch to a different tab for 5 seconds, come back. Confirm no "Reconnecting..." toast appears and both WebSockets stay connected.

- [ ] **Step 5: Manual smoke test — 60s hide**

Open app with DevTools → Network → WS filter. Join a room. Switch to a different tab. Wait 65 seconds. Switch back. Confirm:
1. The Room WS connection shows a close event at ~60s
2. A new WS connection opens immediately when you return
3. No "Connection lost" error toast (since we reconnected successfully)

- [ ] **Step 6: Manual smoke test — Nearby**

Enable Nearby. Switch tabs for 65 seconds. Return. Confirm Nearby WS closed while hidden and reopened on return without an error.

- [ ] **Step 7: Manual smoke test — transfer protection**

Start a file transfer (or simulate `transferInProgress = true` in DevTools console). Switch tabs for 65 seconds. Return. Confirm the Room WS stays connected throughout.

- [ ] **Step 8: Commit**

```bash
git add worker.js
git commit -m "feat: disconnect WebSockets after 60s hidden, reconnect on visible"
```
