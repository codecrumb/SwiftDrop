# Nearby Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Nearby Devices" tab that lets devices on the same network discover each other automatically and transfer files without sharing a room code.

**Architecture:** A new `NearbyLobby` Durable Object groups devices by public IP (`CF-Connecting-IP`). Devices announce themselves via WebSocket, see a live peer list, and initiate transfers by tapping a device name. The actual file transfer reuses the existing `SignalingRoom` + WebRTC path — Nearby just handles discovery and the accept/decline handshake. All Nearby UI is gated behind a settings toggle (off by default).

**Tech Stack:** Cloudflare Workers, Durable Objects (Hibernation API), WebSockets, localStorage, vanilla JS/HTML/CSS embedded in `worker.js`.

---

## File Map

| File | Change |
|---|---|
| `wrangler.toml` | Add `NearbyLobby` DO binding + migration |
| `worker.js` (server, ~line 932) | Add `NearbyLobby` class after `SignalingRoom` |
| `worker.js` (Worker fetch, ~line 113) | Add `GET /nearby` route |
| `worker.js` (HTML, ~line 2311) | Add Nearby tab to role selector (conditionally rendered) |
| `worker.js` (HTML, ~line 2369) | Add Nearby panel section |
| `worker.js` (HTML, ~line 2424) | Add Nearby section to Settings modal |
| `worker.js` (HTML, after settings modal) | Add incoming-request modal |
| `worker.js` (CSS, ~line 930 in template) | Add styles for Nearby tab, device list, request modal |
| `worker.js` (JS, ~line 2543) | Add all Nearby client-side logic |

---

## Task 1: wrangler.toml — Add NearbyLobby binding

**Files:**
- Modify: `wrangler.toml`

- [ ] **Step 1: Add binding and migration**

In `wrangler.toml`, after the `SignalingRoom` binding block, add:

```toml
[[durable_objects.bindings]]
name = "NEARBY"
class_name = "NearbyLobby"
```

Add a new migration entry after the existing `[[migrations]]` block:

```toml
[[migrations]]
tag = "v3"
new_sqlite_classes = ["NearbyLobby"]
```

- [ ] **Step 2: Verify config parses**

```bash
npx wrangler deploy --dry-run
```

Expected: "Your worker has access to the following bindings" lists both `ROOMS` and `NEARBY`. No errors.

- [ ] **Step 3: Commit**

```bash
git add wrangler.toml
git commit -m "config: add NearbyLobby Durable Object binding"
```

---

## Task 2: NearbyLobby Durable Object

**Files:**
- Modify: `worker.js` — add class after `SignalingRoom` (after line 931)

**Protocol:**

Client → Server:
- `{ type: 'announce', deviceId: string, displayName: string }` — sent once after connect
- `{ type: 'send-request', targetDeviceId: string, fileName: string, fileSize: number }` — sender taps a peer
- `{ type: 'send-response', targetDeviceId: string, accepted: boolean, roomCode: string|null }` — receiver accepts/declines
- `{ type: 'update-name', displayName: string }` — user renames their device
- `{ type: 'ping' }` — keep-alive

Server → Client:
- `{ type: 'connected', sessionId: string }` — sent on connect
- `{ type: 'peer-list', peers: [{ deviceId, displayName }] }` — full list excluding self, sent on any change
- `{ type: 'send-request', fromDeviceId: string, fromName: string, fileName: string, fileSize: number }` — relayed to target
- `{ type: 'send-accepted', roomCode: string }` — relayed to original sender when receiver accepts
- `{ type: 'send-declined' }` — relayed to original sender when receiver declines
- `{ type: 'pong' }` — keep-alive reply

- [ ] **Step 1: Add the class**

Insert the following after line 931 (the closing `}` of `SignalingRoom`):

```javascript
/**
 * Durable Object: NearbyLobby
 * Groups devices by public IP and manages presence + transfer handshake.
 * Keyed by IP address — all devices at the same IP share one instance.
 */
export class NearbyLobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    const sessionId = crypto.randomUUID();
    // Store sessionId only at connect time; deviceId added on 'announce'
    server.serializeAttachment({ sessionId, deviceId: null, displayName: null });
    this.state.acceptWebSocket(server, [sessionId]);

    await this.state.storage.deleteAlarm();

    server.send(JSON.stringify({ type: 'connected', sessionId }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      this.handleMessage(ws, data);
    } catch (e) {
      console.error('[Nearby] Invalid message:', e);
    }
  }

  async webSocketClose(ws) {
    const { sessionId, displayName } = ws.deserializeAttachment();
    console.log(`[Nearby] Peer left: ${displayName || sessionId}`);
    // Broadcast updated list after a tick so this socket is removed
    setTimeout(() => this.broadcastPeerList(), 0);
    const remaining = this.state.getWebSockets().length - 1;
    if (remaining === 0) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  webSocketError(ws, error) {
    console.error('[Nearby] WebSocket error:', error);
  }

  handleMessage(ws, data) {
    const attachment = ws.deserializeAttachment();

    switch (data.type) {
      case 'announce': {
        // Register device identity on this socket
        ws.serializeAttachment({
          ...attachment,
          deviceId: data.deviceId,
          displayName: data.displayName,
        });
        console.log(`[Nearby] Announced: ${data.displayName} (${data.deviceId.slice(0, 8)})`);
        this.broadcastPeerList();
        break;
      }

      case 'update-name': {
        ws.serializeAttachment({ ...attachment, displayName: data.displayName });
        this.broadcastPeerList();
        break;
      }

      case 'send-request': {
        const targetWs = this.findByDeviceId(data.targetDeviceId);
        if (!targetWs) return;
        const { deviceId: fromId, displayName: fromName } = ws.deserializeAttachment();
        targetWs.send(JSON.stringify({
          type: 'send-request',
          fromDeviceId: fromId,
          fromName,
          fileName: data.fileName,
          fileSize: data.fileSize,
        }));
        break;
      }

      case 'send-response': {
        const senderWs = this.findByDeviceId(data.targetDeviceId);
        if (!senderWs) return;
        if (data.accepted) {
          senderWs.send(JSON.stringify({ type: 'send-accepted', roomCode: data.roomCode }));
        } else {
          senderWs.send(JSON.stringify({ type: 'send-declined' }));
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        console.log(`[Nearby] Unknown message type: ${data.type}`);
    }
  }

  broadcastPeerList() {
    const allSockets = this.state.getWebSockets();
    for (const ws of allSockets) {
      const { deviceId: selfId } = ws.deserializeAttachment();
      if (!selfId) continue; // not yet announced
      const peers = allSockets
        .map(s => s.deserializeAttachment())
        .filter(a => a.deviceId && a.deviceId !== selfId)
        .map(a => ({ deviceId: a.deviceId, displayName: a.displayName }));
      try {
        ws.send(JSON.stringify({ type: 'peer-list', peers }));
      } catch (e) {
        console.error('[Nearby] broadcastPeerList error:', e);
      }
    }
  }

  findByDeviceId(deviceId) {
    for (const ws of this.state.getWebSockets()) {
      const { deviceId: id } = ws.deserializeAttachment();
      if (id === deviceId) return ws;
    }
    return null;
  }

  async alarm() {
    const peers = this.state.getWebSockets();
    if (peers.length > 0) return;
    console.log('[Nearby] Alarm fired: lobby empty, DO will evict.');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add worker.js
git commit -m "feat(server): add NearbyLobby Durable Object"
```

---

## Task 3: Worker Route — GET /nearby

**Files:**
- Modify: `worker.js` — add route in the main `fetch` handler, after the `/ws` route block (around line 127)

- [ ] **Step 1: Add the route**

After the existing `/ws` route block (the block that ends with `return room.fetch(request);`), insert:

```javascript
    // Nearby discovery — WebSocket connection to NearbyLobby
    if (url.pathname === '/nearby') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const id = env.NEARBY.idFromName(`lobby:${clientIp}`);
      const lobby = env.NEARBY.get(id);
      return lobby.fetch(request);
    }
```

- [ ] **Step 2: Verify locally**

```bash
npx wrangler dev
```

Open browser DevTools console and run:
```javascript
const ws = new WebSocket('ws://localhost:8787/nearby');
ws.onmessage = e => console.log('MSG:', e.data);
ws.onopen = () => console.log('OPEN');
```

Expected: `OPEN` logged, then `MSG: {"type":"connected","sessionId":"..."}` within 1 second.

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat(server): add /nearby WebSocket route"
```

---

## Task 4: Client — Device Identity Module

**Files:**
- Modify: `worker.js` — add JS near the top of the `<script>` block (after line 2505, before the dark mode code)

- [ ] **Step 1: Add identity helpers**

Insert at the very top of the `<script>` block (after `<script>`):

```javascript
    // ── Nearby: Device Identity ──────────────────────────────────────────
    const NEARBY_ADJECTIVES = [
      'Swift','Quick','Bright','Cool','Bold','Calm','Keen','Wise','Fast','Smart',
      'Sharp','Brave','Steady','Quiet','Lively','Merry','Nimble','Jolly','Proud','Vivid'
    ];
    const NEARBY_ANIMALS = [
      'Penguin','Otter','Fox','Hawk','Wolf','Bear','Eagle','Tiger','Lion','Panda',
      'Rabbit','Falcon','Jaguar','Lynx','Moose','Raven','Seal','Whale','Zebra','Crane'
    ];

    function nearbyGenerateName() {
      const adj = NEARBY_ADJECTIVES[Math.floor(Math.random() * NEARBY_ADJECTIVES.length)];
      const animal = NEARBY_ANIMALS[Math.floor(Math.random() * NEARBY_ANIMALS.length)];
      return `${adj} ${animal}`;
    }

    function nearbyGetIdentity() {
      let deviceId = localStorage.getItem('nearbyDeviceId');
      let displayName = localStorage.getItem('nearbyDisplayName');
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem('nearbyDeviceId', deviceId);
      }
      if (!displayName) {
        displayName = nearbyGenerateName();
        localStorage.setItem('nearbyDisplayName', displayName);
      }
      return { deviceId, displayName };
    }

    function nearbySetDisplayName(name) {
      localStorage.setItem('nearbyDisplayName', name);
    }

    function nearbyIsEnabled() {
      return localStorage.getItem('nearbyEnabled') === 'true';
    }

    function nearbySetEnabled(val) {
      localStorage.setItem('nearbyEnabled', val ? 'true' : 'false');
    }

    // ── Nearby: Trusted Devices ──────────────────────────────────────────
    const NEARBY_TRUST_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    function nearbyGetTrusted() {
      try {
        const raw = localStorage.getItem('nearbyTrusted');
        if (!raw) return [];
        const all = JSON.parse(raw);
        const now = Date.now();
        return all.filter(t => now - t.trustedAt < NEARBY_TRUST_MS);
      } catch { return []; }
    }

    function nearbyIsTrusted(deviceId) {
      return nearbyGetTrusted().some(t => t.deviceId === deviceId);
    }

    function nearbyTrustDevice(deviceId, displayName) {
      const existing = nearbyGetTrusted().filter(t => t.deviceId !== deviceId);
      existing.push({ deviceId, displayName, trustedAt: Date.now() });
      localStorage.setItem('nearbyTrusted', JSON.stringify(existing));
    }

    function nearbyRevokeTrust(deviceId) {
      const updated = nearbyGetTrusted().filter(t => t.deviceId !== deviceId);
      localStorage.setItem('nearbyTrusted', JSON.stringify(updated));
    }
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Verify in browser console**

With `wrangler dev` running, open the app and run:

```javascript
nearbyGetIdentity()
// Expected: { deviceId: "some-uuid", displayName: "Swift Penguin" } (or similar)

nearbyTrustDevice('test-id', 'Fast Otter');
nearbyIsTrusted('test-id');
// Expected: true

nearbyRevokeTrust('test-id');
nearbyIsTrusted('test-id');
// Expected: false
```

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat(client): add nearby device identity + trusted devices helpers"
```

---

## Task 5: Settings UI — Nearby Section

**Files:**
- Modify: `worker.js` — add HTML in the Settings modal and CSS

- [ ] **Step 1: Add Nearby section to Settings modal HTML**

Inside the Settings modal content div (after the `keepScreenAwakeToggle` row, before the GitHub row at ~line 2469), insert:

```html
      <div class="settings-section-header">
        Nearby Devices <span class="settings-beta-badge">Beta</span>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span>Enable Nearby Discovery</span>
          <span class="settings-desc">Find devices on the same network without a room code</span>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="nearbyEnabledToggle">
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div id="nearbySettingsExpanded" style="display:none;">
        <div class="settings-row">
          <div class="settings-label">
            <span>Your device name</span>
            <span class="settings-desc">How you appear to nearby devices</span>
          </div>
          <div class="nearby-name-edit">
            <span id="nearbyNameDisplay"></span>
            <button class="nearby-edit-btn" id="nearbyEditNameBtn" title="Edit name">✏</button>
          </div>
        </div>
        <div class="settings-row" id="nearbyNameInputRow" style="display:none;">
          <input type="text" id="nearbyNameInput" maxlength="30" placeholder="Enter device name"
                 style="flex:1; margin:0; font-size:14px;">
          <button class="nearby-edit-btn" id="nearbyNameSaveBtn">Save</button>
        </div>
        <div class="settings-row settings-label" id="nearbyTrustedHeader" style="display:none;">
          <span style="font-weight:600;">Trusted Devices</span>
        </div>
        <div id="nearbyTrustedList"></div>
      </div>
```

- [ ] **Step 2: Add CSS for settings additions**

In the CSS section of the `<style>` block (search for `.settings-github-row` and add after its closing rule):

```css
    .settings-section-header {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 12px 0 4px;
    }
    .settings-beta-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      color: #fff;
      background: #7c3aed;
      border-radius: 4px;
      padding: 1px 5px;
      margin-left: 6px;
      vertical-align: middle;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .nearby-name-edit {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
    }
    .nearby-edit-btn {
      background: none;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .nearby-trusted-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 13px;
      border-bottom: 1px solid var(--border-color);
    }
    .nearby-trusted-item:last-child { border-bottom: none; }
    .nearby-trusted-remove {
      background: none;
      border: none;
      color: #ef4444;
      cursor: pointer;
      font-size: 12px;
      padding: 2px 6px;
    }
```

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat(ui): add Nearby section to Settings modal"
```

---

## Task 6: Settings JS — Nearby Toggle + Name Edit + Trusted List

**Files:**
- Modify: `worker.js` — add JS after the existing settings JS (after the `closeSettingsModal` listener block, around line 2580)

- [ ] **Step 1: Add settings JS**

Insert after the `settingsModal.addEventListener('click', ...)` listener:

```javascript
    // ── Nearby Settings JS ───────────────────────────────────────────────
    const nearbyEnabledToggle = document.getElementById('nearbyEnabledToggle');
    const nearbySettingsExpanded = document.getElementById('nearbySettingsExpanded');
    const nearbyNameDisplay = document.getElementById('nearbyNameDisplay');
    const nearbyEditNameBtn = document.getElementById('nearbyEditNameBtn');
    const nearbyNameInputRow = document.getElementById('nearbyNameInputRow');
    const nearbyNameInput = document.getElementById('nearbyNameInput');
    const nearbyNameSaveBtn = document.getElementById('nearbyNameSaveBtn');
    const nearbyTrustedHeader = document.getElementById('nearbyTrustedHeader');
    const nearbyTrustedList = document.getElementById('nearbyTrustedList');

    function nearbyRefreshSettingsUI() {
      const { displayName } = nearbyGetIdentity();
      nearbyNameDisplay.textContent = displayName;
      nearbyEnabledToggle.checked = nearbyIsEnabled();
      nearbySettingsExpanded.style.display = nearbyIsEnabled() ? 'block' : 'none';
      nearbyRenderTrustedList();
    }

    function nearbyRenderTrustedList() {
      const trusted = nearbyGetTrusted();
      nearbyTrustedHeader.style.display = trusted.length > 0 ? 'flex' : 'none';
      nearbyTrustedList.innerHTML = '';
      for (const t of trusted) {
        const item = document.createElement('div');
        item.className = 'nearby-trusted-item';
        const daysAgo = Math.floor((Date.now() - t.trustedAt) / 86400000);
        item.innerHTML = \`
          <span>\${t.displayName} <span style="color:var(--text-secondary);font-size:12px;">· trusted \${daysAgo === 0 ? 'today' : daysAgo + 'd ago'}</span></span>
          <button class="nearby-trusted-remove" data-id="\${t.deviceId}">Remove</button>
        \`;
        item.querySelector('button').addEventListener('click', () => {
          nearbyRevokeTrust(t.deviceId);
          nearbyRenderTrustedList();
        });
        nearbyTrustedList.appendChild(item);
      }
    }

    nearbyEnabledToggle.addEventListener('change', () => {
      nearbySetEnabled(nearbyEnabledToggle.checked);
      nearbySettingsExpanded.style.display = nearbyEnabledToggle.checked ? 'block' : 'none';
      nearbyUpdateTabVisibility();
      if (nearbyEnabledToggle.checked) {
        nearbyConnect();
      } else {
        nearbyDisconnect();
      }
    });

    nearbyEditNameBtn.addEventListener('click', () => {
      nearbyNameInput.value = nearbyGetIdentity().displayName;
      nearbyNameInputRow.style.display = 'flex';
      nearbyEditNameBtn.style.display = 'none';
      nearbyNameInput.focus();
    });

    nearbyNameSaveBtn.addEventListener('click', () => {
      const newName = nearbyNameInput.value.trim();
      if (!newName) return;
      nearbySetDisplayName(newName);
      nearbyNameDisplay.textContent = newName;
      nearbyNameInputRow.style.display = 'none';
      nearbyEditNameBtn.style.display = '';
      // Notify lobby of name change
      if (nearbyWs && nearbyWs.readyState === WebSocket.OPEN) {
        nearbyWs.send(JSON.stringify({ type: 'update-name', displayName: newName }));
      }
    });

    // Refresh settings UI each time the modal opens
    settingsBtn.addEventListener('click', nearbyRefreshSettingsUI);
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Verify manually**

With `wrangler dev` running:
1. Open Settings — Nearby Devices section should show with Beta badge
2. Toggle on → expanded section appears with device name
3. Click ✏ → name input appears
4. Type a new name, click Save → name updates
5. Toggle off → expanded section hides

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat(client): nearby settings toggle, name edit, trusted list rendering"
```

---

## Task 7: Nearby Tab HTML + CSS

**Files:**
- Modify: `worker.js` — HTML and CSS

- [ ] **Step 1: Add Nearby tab button to role selector**

Find the role selector HTML (around line 2312):
```html
    <div class="role-selector">
      <button class="role-btn active" id="sendRoleBtn">📤 Send</button>
      <button class="role-btn" id="receiveRoleBtn">📥 Receive</button>
    </div>
```

Replace with:
```html
    <div class="role-selector">
      <button class="role-btn active" id="sendRoleBtn">📤 Send</button>
      <button class="role-btn nearby-tab-btn" id="nearbyRoleBtn" style="display:none;">📡 Nearby</button>
      <button class="role-btn" id="receiveRoleBtn">📥 Receive</button>
    </div>
```

- [ ] **Step 2: Add Nearby panel section**

After the `receiveSection` div (around line 2381), add:

```html
    <!-- Nearby Mode -->
    <div class="section" id="nearbySection">
      <div class="nearby-identity-row">
        <span class="nearby-identity-label">You appear as:</span>
        <span class="nearby-identity-name" id="nearbyIdentityName"></span>
      </div>
      <div class="nearby-peer-list" id="nearbyPeerList">
        <div class="nearby-empty" id="nearbyEmpty">
          <div style="font-size:32px; margin-bottom:8px;">📡</div>
          <div style="font-weight:600; margin-bottom:4px;">Looking for devices…</div>
          <div style="font-size:13px; color:var(--text-secondary);">Other devices on this network will appear here</div>
        </div>
      </div>
      <p class="nearby-hint" id="nearbyHint" style="display:none;">Select a file in <strong>Send</strong> tab first, then tap a device</p>
    </div>
```

- [ ] **Step 3: Add incoming-request modal**

After the QR modal closing div (around line 2489), add:

```html
  <!-- Nearby: Incoming Transfer Request Modal -->
  <div class="nearby-request-modal" id="nearbyRequestModal" style="display:none;">
    <div class="nearby-request-content">
      <div class="nearby-request-icon">📡</div>
      <div class="nearby-request-from" id="nearbyRequestFrom"></div>
      <div class="nearby-request-file" id="nearbyRequestFile"></div>
      <div class="nearby-request-size" id="nearbyRequestSize"></div>
      <div class="nearby-request-actions">
        <button class="btn" id="nearbyAcceptBtn">Accept</button>
        <button class="btn-reset" id="nearbyDeclineBtn">Decline</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Add CSS for Nearby panel and modal**

In the CSS `<style>` block, after the `.nearby-trusted-remove` rule added in Task 5, add:

```css
    .nearby-identity-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .nearby-identity-name {
      font-weight: 600;
      color: var(--text-primary);
    }
    .nearby-peer-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 120px;
    }
    .nearby-empty {
      text-align: center;
      padding: 24px 0;
      color: var(--text-secondary);
    }
    .nearby-peer-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .nearby-peer-item:hover { background: var(--hover-bg, rgba(0,0,0,0.04)); }
    .nearby-peer-name {
      font-weight: 600;
      font-size: 15px;
    }
    .nearby-peer-trusted {
      font-size: 11px;
      color: #7c3aed;
      margin-left: 6px;
    }
    .nearby-peer-status {
      font-size: 12px;
      color: var(--text-secondary);
    }
    .nearby-hint {
      font-size: 12px;
      color: var(--text-secondary);
      text-align: center;
      margin-top: 10px;
    }
    /* Incoming request modal */
    .nearby-request-modal {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      z-index: 1100;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nearby-request-content {
      background: var(--card-bg, #fff);
      border-radius: 16px;
      padding: 28px 24px;
      max-width: 320px;
      width: 90%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    }
    body.dark-mode .nearby-request-content { background: #1e1e2e; }
    .nearby-request-icon { font-size: 36px; margin-bottom: 8px; }
    .nearby-request-from { font-weight: 700; font-size: 17px; margin-bottom: 4px; }
    .nearby-request-file { font-size: 14px; color: var(--text-secondary); word-break: break-all; }
    .nearby-request-size { font-size: 13px; color: var(--text-secondary); margin-bottom: 18px; }
    .nearby-request-actions { display: flex; gap: 10px; justify-content: center; }
    .nearby-request-actions .btn { flex: 1; }
    .nearby-request-actions .btn-reset {
      flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color);
      background: none; cursor: pointer; font-size: 14px; color: var(--text-secondary);
    }
```

- [ ] **Step 5: Commit**

```bash
git add worker.js
git commit -m "feat(ui): add Nearby tab, panel, and incoming-request modal HTML+CSS"
```

---

## Task 8: Nearby Tab JS — Visibility + Switching

**Files:**
- Modify: `worker.js` — JS section

- [ ] **Step 1: Add tab switching logic**

Find the role selector JS (search for `sendRoleBtn` / `receiveRoleBtn` listeners in the script) and extend it. Add the following near those listeners:

```javascript
    // ── Nearby Tab Visibility + Switching ────────────────────────────────
    const nearbyRoleBtn = document.getElementById('nearbyRoleBtn');
    const nearbySection = document.getElementById('nearbySection');
    const nearbyIdentityName = document.getElementById('nearbyIdentityName');
    const nearbyPeerList = document.getElementById('nearbyPeerList');
    const nearbyEmpty = document.getElementById('nearbyEmpty');
    const nearbyHint = document.getElementById('nearbyHint');

    function nearbyUpdateTabVisibility() {
      nearbyRoleBtn.style.display = nearbyIsEnabled() ? '' : 'none';
      if (!nearbyIsEnabled() && nearbySection.classList.contains('active')) {
        // Switch back to Send if Nearby tab was active and got disabled
        switchToRole('send');
      }
    }

    function switchToRole(role) {
      // 'send', 'receive', or 'nearby'
      [sendRoleBtn, receiveRoleBtn, nearbyRoleBtn].forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      const sendTypeSelector = document.getElementById('sendTypeSelector');
      const roleHint = document.getElementById('roleHint');

      if (role === 'send') {
        sendRoleBtn.classList.add('active');
        // re-activate whichever send sub-tab was last active
        const activeSendSection = document.getElementById(
          localStorage.getItem('activeSendSection') || 'sendSection'
        );
        if (activeSendSection) activeSendSection.classList.add('active');
        sendTypeSelector.style.display = '';
        roleHint.textContent = 'Share your room code with the other device';
      } else if (role === 'receive') {
        receiveRoleBtn.classList.add('active');
        receiveSection.classList.add('active');
        sendTypeSelector.style.display = 'none';
        roleHint.textContent = 'Enter the code from the sender\'s screen';
      } else if (role === 'nearby') {
        nearbyRoleBtn.classList.add('active');
        nearbySection.classList.add('active');
        sendTypeSelector.style.display = 'none';
        roleHint.textContent = 'Tap a device to send';
        // Show identity name
        nearbyIdentityName.textContent = nearbyGetIdentity().displayName;
        nearbyUpdateHint();
      }
    }

    function nearbyUpdateHint() {
      // Show hint if no file selected yet
      const hasFile = document.getElementById('fileInfo') &&
        !document.getElementById('fileInfo').style.display?.includes('none') &&
        document.getElementById('fileList')?.children.length > 0;
      nearbyHint.style.display = hasFile ? 'none' : '';
    }

    nearbyRoleBtn.addEventListener('click', () => switchToRole('nearby'));

    // Wire existing role buttons to use switchToRole
    sendRoleBtn.addEventListener('click', () => switchToRole('send'));
    receiveRoleBtn.addEventListener('click', () => switchToRole('receive'));

    // Init: show/hide Nearby tab based on saved setting
    nearbyUpdateTabVisibility();
    // ─────────────────────────────────────────────────────────────────────
```

**Important:** Remove the old `sendRoleBtn.addEventListener('click', ...)` and `receiveRoleBtn.addEventListener('click', ...)` listeners that were already in the file (they'll conflict). Search for them and delete them before inserting the above.

- [ ] **Step 2: Verify tab switching**

With `wrangler dev`:
1. Enable Nearby in Settings → Nearby tab appears between Send and Receive
2. Click Nearby tab → Nearby panel shows, send-type selector hides
3. Click Send → returns to Send panel
4. Disable Nearby in Settings → tab disappears, switches back to Send if needed

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat(client): nearby tab visibility + role switching"
```

---

## Task 9: NearbyLobby WebSocket Client + Peer List Rendering

**Files:**
- Modify: `worker.js` — JS section

- [ ] **Step 1: Add WebSocket client**

Insert after the tab switching JS block:

```javascript
    // ── NearbyLobby WebSocket Client ──────────────────────────────────────
    let nearbyWs = null;
    let nearbyPeers = []; // [{ deviceId, displayName }]
    let nearbyPendingRequest = null; // { fromDeviceId, fromName, fileName, fileSize }

    function nearbyConnect() {
      if (!nearbyIsEnabled()) return;
      if (nearbyWs && nearbyWs.readyState <= WebSocket.OPEN) return;

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      nearbyWs = new WebSocket(\`\${proto}://\${location.host}/nearby\`);

      nearbyWs.addEventListener('open', () => {
        console.log('[Nearby] Connected to lobby');
        const { deviceId, displayName } = nearbyGetIdentity();
        nearbyWs.send(JSON.stringify({ type: 'announce', deviceId, displayName }));
        nearbyStartPing();
      });

      nearbyWs.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          nearbyHandleMessage(data);
        } catch (err) {
          console.error('[Nearby] Bad message:', err);
        }
      });

      nearbyWs.addEventListener('close', () => {
        console.log('[Nearby] Disconnected');
        nearbyPeers = [];
        nearbyRenderPeers();
        // Reconnect after 3s if still enabled
        if (nearbyIsEnabled()) setTimeout(nearbyConnect, 3000);
      });

      nearbyWs.addEventListener('error', () => {
        console.error('[Nearby] WebSocket error');
      });
    }

    function nearbyDisconnect() {
      if (nearbyWs) {
        nearbyWs.close();
        nearbyWs = null;
      }
      nearbyPeers = [];
      nearbyRenderPeers();
    }

    let nearbyPingInterval = null;
    function nearbyStartPing() {
      clearInterval(nearbyPingInterval);
      nearbyPingInterval = setInterval(() => {
        if (nearbyWs && nearbyWs.readyState === WebSocket.OPEN) {
          nearbyWs.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    }

    // Reconnect when tab regains focus
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && nearbyIsEnabled()) {
        nearbyConnect();
      }
    });

    // Auto-connect on load if enabled
    if (nearbyIsEnabled()) nearbyConnect();
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Add peer list renderer**

Insert after the above block:

```javascript
    // ── Nearby Peer Rendering ─────────────────────────────────────────────
    function nearbyRenderPeers() {
      nearbyPeerList.innerHTML = '';
      if (nearbyPeers.length === 0) {
        nearbyPeerList.appendChild(nearbyEmpty);
        return;
      }
      for (const peer of nearbyPeers) {
        const trusted = nearbyIsTrusted(peer.deviceId);
        const item = document.createElement('div');
        item.className = 'nearby-peer-item';
        item.dataset.deviceId = peer.deviceId;
        item.innerHTML = \`
          <div>
            <span class="nearby-peer-name">\${peer.displayName}</span>
            \${trusted ? '<span class="nearby-peer-trusted">✓ Trusted</span>' : ''}
          </div>
          <span class="nearby-peer-status">Tap to send</span>
        \`;
        item.addEventListener('click', () => nearbyInitiateSend(peer));
        nearbyPeerList.appendChild(item);
      }
    }
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Verify peer list**

With `wrangler dev`:
1. Open app in two tabs (both on same localhost = same IP in dev)
2. Enable Nearby in both tabs
3. Click Nearby tab in each
4. Expected: each tab shows the other's device name in the peer list

- [ ] **Step 4: Commit**

```bash
git add worker.js
git commit -m "feat(client): nearby WebSocket client + peer list rendering"
```

---

## Task 10: Message Handler + Send Request Flow

**Files:**
- Modify: `worker.js` — JS section

- [ ] **Step 1: Add message handler**

Insert after the peer rendering block:

```javascript
    // ── Nearby Message Handler ────────────────────────────────────────────
    function nearbyHandleMessage(data) {
      switch (data.type) {
        case 'connected':
          console.log('[Nearby] Session:', data.sessionId);
          break;

        case 'peer-list':
          nearbyPeers = data.peers;
          nearbyRenderPeers();
          break;

        case 'send-request':
          nearbyHandleIncomingRequest(data);
          break;

        case 'send-accepted':
          // Receiver accepted — join the room they created
          nearbySenderJoinRoom(data.roomCode);
          break;

        case 'send-declined':
          nearbyClosePendingRequest();
          showToast('Transfer declined');
          break;

        case 'pong':
          break;

        default:
          console.log('[Nearby] Unknown message:', data.type);
      }
    }
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Add sender initiation logic**

Insert after the message handler:

```javascript
    // ── Nearby: Sender Side ───────────────────────────────────────────────
    let nearbySendTargetDeviceId = null;
    let nearbySendFile = null;

    function nearbyInitiateSend(peer) {
      // Grab the currently selected file(s) from the Send flow
      const fileInput = document.getElementById('fileInput');
      const files = fileInput.files;
      if (!files || files.length === 0) {
        // Switch to Send tab so user can pick a file
        switchToRole('send');
        showToast('Select a file first, then come back to Nearby');
        return;
      }
      const file = files[0]; // v1: single file
      nearbySendTargetDeviceId = peer.deviceId;
      nearbySendFile = file;

      // Update peer item to show "Waiting…"
      const item = nearbyPeerList.querySelector(\`[data-device-id="\${peer.deviceId}"]\`);
      if (item) item.querySelector('.nearby-peer-status').textContent = 'Waiting…';

      nearbyWs.send(JSON.stringify({
        type: 'send-request',
        targetDeviceId: peer.deviceId,
        fileName: file.name,
        fileSize: file.size,
      }));
    }

    function nearbySenderJoinRoom(roomCode) {
      if (!nearbySendFile) return;
      // Store peer for trust offer before clearing state
      const peer = nearbyPeers.find(p => p.deviceId === nearbySendTargetDeviceId);
      if (peer) nearbyLastTransferPeer = { deviceId: peer.deviceId, displayName: peer.displayName };
      // Switch to Send tab and trigger transfer
      switchToRole('send');
      nearbyTriggerSend(roomCode, nearbySendFile);
      nearbySendTargetDeviceId = null;
      nearbySendFile = null;
    }

    function nearbyClosePendingRequest() {
      nearbySendTargetDeviceId = null;
      nearbySendFile = null;
      nearbyRenderPeers(); // reset peer statuses
    }
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat(client): nearby message handler + sender initiation"
```

---

## Task 11: Incoming Request Modal + Receiver Side

**Files:**
- Modify: `worker.js` — JS section

- [ ] **Step 1: Add incoming request handler**

Insert after the sender side block:

```javascript
    // ── Nearby: Receiver Side ─────────────────────────────────────────────
    const nearbyRequestModal = document.getElementById('nearbyRequestModal');
    const nearbyRequestFrom = document.getElementById('nearbyRequestFrom');
    const nearbyRequestFile = document.getElementById('nearbyRequestFile');
    const nearbyRequestSize = document.getElementById('nearbyRequestSize');
    const nearbyAcceptBtn = document.getElementById('nearbyAcceptBtn');
    const nearbyDeclineBtn = document.getElementById('nearbyDeclineBtn');

    let nearbyIncomingRequest = null; // { fromDeviceId, fromName, fileName, fileSize }

    function nearbyHandleIncomingRequest(data) {
      nearbyIncomingRequest = data;
      const trusted = nearbyIsTrusted(data.fromDeviceId);
      const autoDownload = localStorage.getItem('autoDownloadFiles') === 'true';

      if (trusted && autoDownload) {
        // Fully frictionless: auto-accept
        nearbyAcceptIncoming();
        return;
      }

      // Show accept/decline modal
      nearbyRequestFrom.textContent = \`\${data.fromName} wants to send you:\`;
      nearbyRequestFile.textContent = data.fileName;
      nearbyRequestSize.textContent = formatFileSize(data.fileSize);
      nearbyRequestModal.style.display = 'flex';
    }

    function nearbyAcceptIncoming() {
      if (!nearbyIncomingRequest) return;
      // Receiver generates the room code
      const roomCode = Math.random().toString(10).slice(2, 8).padStart(6, '0');
      const { fromDeviceId } = nearbyIncomingRequest;

      nearbyRequestModal.style.display = 'none';
      nearbyWs.send(JSON.stringify({
        type: 'send-response',
        targetDeviceId: fromDeviceId,
        accepted: true,
        roomCode,
      }));

      // Join the room as receiver
      nearbyReceiverJoinRoom(roomCode, nearbyIncomingRequest);
      nearbyIncomingRequest = null;
    }

    function nearbyDeclineIncoming() {
      if (!nearbyIncomingRequest) return;
      nearbyWs.send(JSON.stringify({
        type: 'send-response',
        targetDeviceId: nearbyIncomingRequest.fromDeviceId,
        accepted: false,
        roomCode: null,
      }));
      nearbyRequestModal.style.display = 'none';
      nearbyIncomingRequest = null;
    }

    nearbyAcceptBtn.addEventListener('click', nearbyAcceptIncoming);
    nearbyDeclineBtn.addEventListener('click', nearbyDeclineIncoming);
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Add `formatFileSize` helper if not already present**

Search the existing JS for `formatFileSize`. If it doesn't exist, add it:

```javascript
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
```

- [ ] **Step 3: Verify modal**

With `wrangler dev`, two tabs:
1. Tab A: select a file, go to Nearby, tap Tab B's device name
2. Tab B: incoming request modal appears with file name and size
3. Click Decline → modal closes, Tab A shows "Transfer declined" toast
4. Repeat, click Accept → modal closes (transfer will stall until Task 12 wires up the room join, which is expected at this stage)

- [ ] **Step 4: Commit**

```bash
git add worker.js
git commit -m "feat(client): nearby incoming request modal + accept/decline"
```

---

## Task 12: Transfer Handoff — Room Join

**Files:**
- Modify: `worker.js` — JS section

This task wires `nearbyTriggerSend` (sender) and `nearbyReceiverJoinRoom` (receiver) into the existing room-code transfer flow.

- [ ] **Step 1: Study the existing join + send flow**

In the existing JS, find:
- How the sender connects to a room (look for where `signalingWs` or the WebSocket to `/ws?room=` is opened)
- How the receiver joins a room (look for `joinBtn` click handler and `roomInput`)
- How a send is triggered once the data channel is open

Note the exact function names — you'll call them from the Nearby side.

- [ ] **Step 2: Add `nearbyTriggerSend`**

The sender already has a file selected in `fileInput`. We need to connect to the signaling room with the given code and trigger the send once the data channel opens.

Find the function that initiates a send (called when `sendBtn` is clicked while connected). Add a nearby-specific entry point:

```javascript
    function nearbyTriggerSend(roomCode, file) {
      // Pre-populate the file input state so the existing send logic picks it up
      // (The file is already in fileInput.files from the user's earlier selection)
      // Connect to the signaling room as the sender
      connectToRoom(roomCode, 'sender');
    }
```

Replace `connectToRoom(roomCode, 'sender')` with the actual call used in the existing codebase — find the function that is called when the sender's WebSocket connects to `/ws?room=`. Look at how the room code and sender/receiver role are established, and mirror that call here.

- [ ] **Step 3: Add `nearbyReceiverJoinRoom`**

```javascript
    function nearbyReceiverJoinRoom(roomCode, requestData) {
      // Switch to receive tab and auto-join the room
      switchToRole('receive');
      const roomInput = document.getElementById('roomInput');
      roomInput.value = roomCode;
      document.getElementById('joinBtn').click();
    }
```

- [ ] **Step 4: End-to-end test**

With `wrangler dev`, two tabs:
1. Tab A: select a small test file, go to Nearby, tap Tab B's device name
2. Tab B: accept the request
3. Expected: both tabs switch to their Send/Receive roles, progress bar appears, transfer completes, file downloads

- [ ] **Step 5: Commit**

```bash
git add worker.js
git commit -m "feat(client): nearby transfer handoff - wire room join to existing send/receive flow"
```

---

## Task 13: Trusted Devices — Post-Transfer Offer

**Files:**
- Modify: `worker.js` — JS section

- [ ] **Step 1: Hook into transfer completion**

Find the point in the existing JS where a successful transfer is confirmed (where the receive success panel is shown, or where `transferInProgress` is set to `false` after a completed send/receive). 

Add a check: if the transfer was initiated via Nearby and the other device is not yet trusted, show a trust offer toast.

Add these helpers:

```javascript
    // ── Nearby: Post-Transfer Trust Offer ────────────────────────────────
    let nearbyLastTransferPeer = null; // { deviceId, displayName } set before transfer

    function nearbyOfferTrust(deviceId, displayName) {
      if (nearbyIsTrusted(deviceId)) return; // already trusted
      // Re-use the existing toast mechanism with a confirm action
      const toastEl = document.getElementById('toast');
      toastEl.innerHTML = \`
        Trust <strong>\${displayName}</strong>? Skip confirmation next time.
        <button id="nearbyTrustYes" style="margin-left:10px;background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:13px;">Trust</button>
      \`;
      toastEl.style.display = 'flex';
      toastEl.style.alignItems = 'center';
      toastEl.classList.add('show');
      document.getElementById('nearbyTrustYes').addEventListener('click', () => {
        nearbyTrustDevice(deviceId, displayName);
        showToast(\`\${displayName} trusted!\`);
      });
      setTimeout(() => toastEl.classList.remove('show'), 8000);
    }
    // ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Call `nearbyOfferTrust` after transfer**

The `nearbySenderJoinRoom` function (Task 10) already stores `nearbyLastTransferPeer` using `nearbyPeers.find(...)` before clearing state — no change needed there.

In `nearbyAcceptIncoming` (Task 11), store the peer **before** setting `nearbyIncomingRequest = null`:
```javascript
    function nearbyAcceptIncoming() {
      if (!nearbyIncomingRequest) return;
      const roomCode = Math.random().toString(10).slice(2, 8).padStart(6, '0');
      const { fromDeviceId, fromName } = nearbyIncomingRequest;
      // Store peer for trust offer BEFORE clearing
      nearbyLastTransferPeer = { deviceId: fromDeviceId, displayName: fromName };
      nearbyRequestModal.style.display = 'none';
      nearbyWs.send(JSON.stringify({
        type: 'send-response',
        targetDeviceId: fromDeviceId,
        accepted: true,
        roomCode,
      }));
      nearbyReceiverJoinRoom(roomCode, nearbyIncomingRequest);
      nearbyIncomingRequest = null;
    }
```

Find the transfer completion callback in the existing code (where the success panel shows or download triggers). Add:
```javascript
    if (nearbyLastTransferPeer) {
      nearbyOfferTrust(nearbyLastTransferPeer.deviceId, nearbyLastTransferPeer.displayName);
      nearbyLastTransferPeer = null;
    }
```

- [ ] **Step 3: Verify trust flow**

With `wrangler dev`, two tabs:
1. Complete a full Nearby transfer (Task 12 must pass first)
2. Expected: after transfer, a toast appears: "Trust [name]? Skip confirmation next time. [Trust]"
3. Click Trust → device appears in Settings → Trusted Devices list
4. Do another Nearby transfer with same device → no modal, auto-accepted (with auto-download on) or one-tap (with auto-download off)

- [ ] **Step 4: Commit**

```bash
git add worker.js
git commit -m "feat(client): offer trust after nearby transfer, skip confirmation for trusted devices"
```

---

## Task 14: Deploy + Smoke Test

- [ ] **Step 1: Deploy to production**

```bash
npx wrangler deploy
```

Expected output ends with: "Deployed swiftdrop triggers" and a URL.

- [ ] **Step 2: Smoke test on two real devices**

Use two physical devices (or a phone + laptop) on the same WiFi:
1. Both open the deployed URL
2. Enable Nearby in Settings on both
3. Each device's name appears in the other's Nearby tab
4. Select a file on Device A, tap Device B in Nearby
5. Device B receives the request modal with correct file name + size
6. Accept → transfer completes
7. Trust offer appears on both devices after success

- [ ] **Step 3: Verify opt-in gate**

1. Open app fresh (Nearby disabled by default)
2. Confirm: no Nearby tab visible, no WebSocket connection to `/nearby` (check DevTools Network tab)
3. Enable in Settings → tab appears, WS connects

- [ ] **Step 4: Verify trusted + auto-download**

1. Trust a device, enable Auto-download in Settings
2. Send a file from trusted device → file downloads silently, no modal

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: Nearby Devices - complete implementation"
```

---

## Notes for Implementor

- **Task 8 conflict:** The existing `sendRoleBtn` and `receiveRoleBtn` click listeners must be removed before adding the new `switchToRole` wrappers, or they'll fire twice.
- **Task 12 — study first:** The exact function names for connecting to a room as sender/receiver depend on the existing code. Read those sections carefully before writing the `nearbyTriggerSend` and `nearbyReceiverJoinRoom` implementations — the plan shows the intent; the implementor must match the actual API.
- **wrangler dev + two tabs:** `CF-Connecting-IP` is not set in local dev — all connections from localhost get the same IP naturally, so the lobby grouping works without special handling during development.
- **No test framework:** All testing is manual via `wrangler dev` with two browser tabs or two devices.
