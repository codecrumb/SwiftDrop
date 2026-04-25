# Nearby Devices — Design Spec
_Date: 2026-04-25_

## Overview

Add an opt-in "Nearby Devices" feature that lets devices on the same network discover each other automatically and transfer files without sharing a room code. Room codes remain the default and primary flow; Nearby is a parallel, optional mode.

---

## Discovery Mechanism

**Server-side IP grouping (PairDrop model).**

When a device enables Nearby and opens the app, it connects to a new WebSocket endpoint `/nearby`. The Cloudflare Worker reads `CF-Connecting-IP` (the trusted real client IP) and routes the connection to a `NearbyLobby` Durable Object keyed on that IP. All devices sharing the same public IP see each other in the lobby in real time.

This is the same technique PairDrop uses at scale. The trade-off (same VPN/carrier-grade NAT groups strangers) is acceptable because:
1. The feature is opt-in — users knowingly enable discoverability
2. All transfers require the receiver to explicitly accept

No fallback to subnet detection via WebRTC ICE candidates — browser privacy changes (Chrome mDNS obfuscation) make local IP extraction unreliable enough that the added complexity isn't worth it.

---

## Infrastructure

### New: `NearbyLobby` Durable Object

- Keyed by public IP string (e.g. `lobby:203.0.113.42`)
- Manages WebSocket connections for all devices at that IP
- Broadcasts peer list updates when devices join/leave
- Handles pairing handshake messages (send request → accept/decline)
- Eviction alarm: clears 5 minutes after last peer disconnects (same pattern as `SignalingRoom`)

### Transfer Engine: Unchanged

Once two Nearby devices agree to transfer, the server silently creates a standard room code and connects both peers to an existing `SignalingRoom`. Everything from that point on — WebRTC DataChannel, R2 fallback, progress tracking, wake lock, backpressure — is identical to a normal room-code transfer.

---

## Device Identity & Names

Each device generates on first use (stored in `localStorage`):
- **UUID** — persistent device identifier, used for trust matching
- **Display name** — random fun name (e.g. "Swift Penguin", "Fast Otter"), user-editable at any time

Both are broadcast to the `NearbyLobby` on connect.

---

## Transfer Flow

### Untrusted device

1. Device A opens Nearby modal, sees "Swift Penguin" (Device B)
2. Device A selects a file and taps Device B's name
3. Device B receives a modal: _"Swift Penguin wants to send you sunset.jpg (4.2 MB) — Accept / Decline"_
4. Device B taps Accept
5. SwiftDrop silently creates a room, both devices join, transfer proceeds normally
6. After successful transfer, Device B is offered: _"Trust Swift Penguin? Skip confirmation next time"_ — optional, stored in `localStorage`

No emoji verification step. The accept/decline prompt with file name and size is sufficient — the receiver can always decline.

### Trusted device

Trust is stored as `{ uuid, displayName, trustedAt }` in `localStorage` (30-day expiry, checked client-side on each lobby connect). Trusted UUIDs are sent to the server so the lobby can flag them in the peer list.

When a trusted device initiates a transfer:
- **Auto-download ON** → transfer starts silently, no prompt
- **Auto-download OFF** → one-tap accept prompt (_"Swift Penguin wants to send sunset.jpg"_), no full confirmation modal

---

## UI

### Entry point: third tab in role selector

The role selector becomes `📤 Send | 📡 Nearby | 📥 Receive`. The Nearby tab **only renders when Nearby is enabled in settings** — users with the feature off see the original two-tab layout unchanged.

### Nearby tab content (right panel)

When the Nearby tab is active, the right panel shows:
- Your device name with an inline edit pencil icon
- List of discovered nearby devices (avatar/icon + display name)
- "No devices found" empty state with a brief hint
- Tapping a device name initiates a transfer (uses the file already selected in Send, or prompts to pick one)

The left panel in Nearby mode shows the device's own identity (name + discoverable status) instead of the room code.

### Incoming request

A separate overlay modal appears on the receiver regardless of what they're currently doing (Send tab, Receive tab, doesn't matter):
> _"Swift Penguin wants to send you sunset.jpg (4.2 MB)"_
> `[Accept]  [Decline]`

### Settings

A new section in the existing Settings modal:

```
Nearby Devices                              [Beta]
────────────────────────────────────────────────────
Enable Nearby Discovery          [toggle: off]

Your device name
[Swift Penguin                            ✏ Edit]

Trusted Devices
  Swift Penguin — trusted 3 days ago      [Remove]
  Fast Otter — trusted 12 days ago        [Remove]
```

The `[Beta]` badge appears only on the section header in Settings — not in the toolbar icon or Nearby modal.

---

## Settings Behavior

- **Default:** Nearby disabled. Toolbar icon hidden. No WebSocket connection to `/nearby` is opened.
- **Enabled:** Toolbar radar icon appears. App connects to `/nearby` WebSocket on load and reconnects on visibility change (tab regain focus).
- Nearby can be disabled at any time; the WebSocket is closed and the icon disappears.

---

## What Is Not Changing

- Room codes remain the default and primary transfer method
- All transfer logic (WebRTC, R2 fallback, chunking, backpressure, wake lock, beforeunload warning) is untouched
- The existing two-tab `Send | Receive` layout is untouched
- No changes to `SignalingRoom` Durable Object

---

## Out of Scope

- mDNS / true LAN discovery (not available in browsers)
- Cross-network Nearby (by definition impossible with IP grouping)
- Nearby for URL or Text send modes (file transfers only for v1)
- Trust sync across devices/browsers (localStorage is per-device)
