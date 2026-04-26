# Tab Visibility Disconnect Design

**Date:** 2026-04-26  
**Status:** Approved

## Problem

Open browser tabs that are not visible (backgrounded, minimised, or in a different window) keep their WebSocket connections to the Durable Object alive indefinitely. The 25-second keepalive pings wake the DO every 25 seconds per open tab, even when no user activity is occurring. With multiple tabs open this wastes Durable Object invocations for nothing.

## Goal

Disconnect WebSocket connections when a tab has been hidden for more than 60 seconds, and transparently reconnect when the tab becomes visible again. P2P (WebRTC data channel) connections are unaffected.

## Chosen Approach: 60-second timer on hide (Option A)

A single unified `visibilitychange` handler manages a 60-second timer. If the tab is still hidden when the timer fires, both the Room WebSocket and the Nearby WebSocket are closed. When the tab becomes visible again, any pending timer is cancelled and closed connections are reopened.

## Design

### Visibility Manager

A small set of functions added to the existing inline script in `worker.js`. No new files, no new abstractions.

**State added:**
- `visibilityHideTimer` — holds the `setTimeout` reference (or `null`)

**Logic:**

On `visibilitychange → hidden`:
1. Start a 60-second timer.
2. When the timer fires:
   - If `transferInProgress` is `true`, do nothing (skip disconnect).
   - Otherwise, close Room WS (`isIntentionalClose = true` before closing to suppress backoff reconnects).
   - Close Nearby WS the same way.

On `visibilitychange → visible`:
1. Cancel any pending `visibilityHideTimer`.
2. If Room WS is absent or closed and `roomCode` is set, call `connectWebSocket(roomCode, true)`.
3. If Nearby WS is absent or closed and `nearbyIsEnabled()`, call `nearbyConnect()`.
4. Re-acquire wake lock if `transferInProgress` is true (existing behaviour, kept here).

### Listener consolidation

Three separate `visibilitychange` listeners currently exist:
- Line 3123: wake lock re-acquire
- Line 4810: Nearby reconnect on visible

Both are removed and their logic is merged into the single new unified handler. This prevents ordering bugs and keeps the visibility logic in one place.

### What is not changed

| Thing | Status |
|---|---|
| WebRTC data channel / `pc` | Untouched — P2P stays alive |
| Reconnect backoff (5-attempt) | Untouched — still fires for real network drops |
| `isIntentionalClose` flag | Reused as-is |
| `transferInProgress` flag | Reused as-is |
| `nearbyIsEnabled()` check | Reused as-is |
| Ping intervals | Cleared on close (already happens in `onclose`) |

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Tab hidden → visible before 60s | Timer cancelled, nothing disconnects, zero flicker |
| Tab hidden during active transfer | Timer fires but disconnect is skipped (`transferInProgress`) |
| Tab visible after disconnect | Immediate reconnect via existing `connectWebSocket` / `nearbyConnect` |
| Room WS disconnects while hidden | `isIntentionalClose = true` prevents 5-attempt backoff from running |
| P2P established, tab goes hidden | Signaling WS closes after 60s (P2P unaffected); reconnects on visible |

## Files Changed

- `worker.js` — only file modified (~30–40 lines net change)
