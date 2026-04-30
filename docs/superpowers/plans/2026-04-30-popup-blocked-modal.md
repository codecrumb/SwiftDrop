# Pop-up Blocked Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top-right URL toast with a centered modal that appears only when the browser actually blocks a new tab, with a Retry button (user gesture) that always works, and a footer link to an in-project help page.

**Architecture:** All changes are in the single `worker.js` file. The modal is pure HTML/CSS/JS injected into the existing `getHTML()` page. A new `getHelpPage()` function serves `/help/popups` as a separate Worker route. Detection works by dropping `noopener` from `window.open()` and checking the return value for `null`.

**Tech Stack:** Cloudflare Worker, vanilla JS, Feather Icons (already loaded via unpkg), CSS custom properties (existing `--container-bg`, `--text-primary`, etc.)

---

## File Map

| File | Change |
|---|---|
| `worker.js` line ~71 | Add `/help/popups` route |
| `worker.js` line ~1088 | Add `getHelpPage()` function (before `getHTML`) |
| `worker.js` line ~1706 | Add modal + overlay CSS (after toast `@keyframes`) |
| `worker.js` line ~2738 | Add modal overlay + card HTML (after toast div) |
| `worker.js` line ~3222 | Add `popupOverlay` + `popupModal` element references |
| `worker.js` line ~4028 | Update P2P URL call site |
| `worker.js` line ~4341 | Update cloud relay call site |
| `worker.js` lines ~4556–4576 | Replace `showUrlToast()` with `showPopupBlockedModal()` + `hidePopupBlockedModal()` |

---

## Task 1: Add `/help/popups` route

**Files:**
- Modify: `worker.js:71` (route handler)
- Modify: `worker.js:1088` (add `getHelpPage()` before `getHTML`)

- [ ] **Step 1: Add the route** — insert after the closing brace of the `/` route handler (around line 71):

```js
    // Help page: allowing pop-ups
    if (url.pathname === '/help/popups' && request.method === 'GET') {
      return new Response(getHelpPage(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }
```

- [ ] **Step 2: Add `getHelpPage()` function** — insert the entire function just before the `/**` comment above `getHTML` (around line 1088):

```js
function getHelpPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Allowing pop-ups — SwiftDrop</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #f9fafb;
    --card-bg: #ffffff;
    --text-primary: #111827;
    --text-secondary: #6b7280;
    --text-tertiary: #9ca3af;
    --border: #e5e7eb;
    --accent: #4f46e5;
    --accent-soft: rgba(79,70,229,0.08);
    --warn-bg: rgba(245,158,11,0.10);
    --warn-stroke: #d97706;
    --tip-bg: #f0f4ff;
    --tip-border: #4f46e5;
    --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --card-bg: #1f2937;
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-tertiary: #6b7280;
      --border: #374151;
      --accent: #818cf8;
      --accent-soft: rgba(129,140,248,0.1);
      --warn-bg: rgba(251,191,36,0.12);
      --warn-stroke: #fbbf24;
      --tip-bg: rgba(79,70,229,0.12);
      --tip-border: #6366f1;
      --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.4);
    }
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text-primary);
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 48px 16px 64px;
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    padding: 36px 32px;
    max-width: 560px;
    width: 100%;
    height: fit-content;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .brand-icon {
    width: 32px; height: 32px;
    background: linear-gradient(135deg, #667eea, #764ba2);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }
  .brand-icon svg { width: 16px; height: 16px; stroke: white; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .brand-name { font-size: 15px; font-weight: 700; color: var(--text-primary); }

  .page-header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 20px;
  }
  .warn-badge {
    width: 40px; height: 40px; flex-shrink: 0;
    background: var(--warn-bg);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
  }
  .warn-badge svg {
    width: 20px; height: 20px;
    stroke: var(--warn-stroke); fill: none;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }
  h1 { font-size: 20px; font-weight: 700; line-height: 1.3; margin-bottom: 4px; }
  .page-desc { font-size: 14px; color: var(--text-secondary); line-height: 1.6; }

  .section { margin-top: 24px; }
  .section-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-tertiary); margin-bottom: 12px;
  }

  ol { padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
  ol li {
    display: flex; align-items: flex-start; gap: 12px;
    font-size: 14px; color: var(--text-secondary); line-height: 1.6;
  }
  .step-num {
    flex-shrink: 0;
    width: 22px; height: 22px;
    background: var(--accent-soft);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: var(--accent);
    margin-top: 2px;
  }
  ol li strong { color: var(--text-primary); }

  .screenshot {
    margin-top: 16px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .screenshot img {
    width: 100%;
    display: block;
  }

  .tip {
    margin-top: 20px;
    background: var(--tip-bg);
    border-left: 3px solid var(--tip-border);
    border-radius: 0 8px 8px 0;
    padding: 12px 16px;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.6;
  }
  .tip strong { color: var(--accent); }
</style>
</head>
<body>
<div class="card">
  <div class="brand">
    <div class="brand-icon">
      <svg viewBox="0 0 24 24"><path d="M22 2L11 13"></path><path d="M22 2L15 22 11 13 2 9l20-7z"></path></svg>
    </div>
    <span class="brand-name">SwiftDrop</span>
  </div>

  <div class="page-header">
    <div class="warn-badge">
      <svg viewBox="0 0 24 24">
        <polygon points="10.29 3.86 1.82 18 22.18 18 13.71 3.86 10.29 3.86"></polygon>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    </div>
    <div>
      <h1>Allowing SwiftDrop to open new tabs</h1>
      <p class="page-desc">Some browsers block websites from automatically opening new tabs as a security precaution.</p>
    </div>
  </div>

  <div class="section">
    <div class="section-label">How to allow pop-ups</div>
    <ol>
      <li>
        <div class="step-num">1</div>
        <div>Click the <strong>icon in your address bar</strong> — usually a blocked pop-up icon or the site settings padlock.</div>
      </li>
      <li>
        <div class="step-num">2</div>
        <div>Find <strong>"Pop-ups and redirects"</strong> or <strong>"Always allow pop-ups from this site"</strong> and set it to <strong>Allow</strong>.</div>
      </li>
      <li>
        <div class="step-num">3</div>
        <div>Reload the page if prompted, then press <strong>Retry</strong> in SwiftDrop.</div>
      </li>
    </ol>
  </div>

  <div class="screenshot">
    <img src="https://i.imgur.com/8LQP8oS.png" alt="Screenshot showing how to allow pop-ups in browser settings">
  </div>

  <div class="tip">
    <strong>Just want it to work now?</strong> Close this tab and click <strong>Retry</strong> in the SwiftDrop prompt — it always opens the link, no settings change needed. Adjusting the setting only prevents the prompt from appearing next time.
  </div>
</div>
</body>
</html>`;
}
```

- [ ] **Step 3: Verify the route works** — deploy or run the worker locally and open `/help/popups`. Confirm the page renders, the screenshot loads from Imgur, and it looks correct in both light and dark mode (toggle via OS/browser dark mode setting).

---

## Task 2: Add modal HTML

**Files:**
- Modify: `worker.js:2737` (after toast div)

- [ ] **Step 1: Add overlay and modal HTML** — insert immediately after the `<div class="toast" id="toast"></div>` line (~2737):

```html
  <div class="popup-overlay" id="popupOverlay"></div>
  <div class="popup-modal" id="popupModal">
    <div class="popup-modal-header">
      <div class="popup-modal-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="10.29 3.86 1.82 18 22.18 18 13.71 3.86 10.29 3.86"></polygon>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      </div>
      <h2 class="popup-modal-title">Pop-up blocked</h2>
    </div>
    <p class="popup-modal-body">Your browser blocked a new tab from opening. Click <strong>Retry</strong> to open it.</p>
    <div class="popup-modal-actions">
      <button class="popup-modal-retry" id="popupRetry">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
          <polyline points="1 4 1 10 7 10"></polyline>
          <path d="M3.51 15a9 9 0 1 0 .49-3.7"></path>
        </svg>
        Retry
      </button>
      <button class="popup-modal-cancel" id="popupCancel">Cancel</button>
    </div>
    <div class="popup-modal-footer">
      Tired of seeing this? <a href="/help/popups" target="_blank" rel="noopener">Adjust browser settings →</a>
    </div>
  </div>
```

---

## Task 3: Add modal CSS

**Files:**
- Modify: `worker.js:1706` (after `@keyframes slideIn` block)

- [ ] **Step 1: Add overlay and modal styles** — insert after the closing `}` of `@keyframes slideIn` (after line 1705, before the `/* Clickable status container */` comment):

```css
    /* Pop-up blocked modal */
    .popup-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1100;
    }
    .popup-overlay.active {
      display: block;
    }

    .popup-modal {
      display: none;
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 1101;
      background: var(--container-bg);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 20px 20px 16px;
      width: 300px;
      max-width: calc(100vw - 32px);
      box-shadow: 0 20px 50px rgba(0,0,0,0.35);
    }
    .popup-modal.active {
      display: block;
    }

    .popup-modal-header {
      display: flex;
      align-items: center;
      gap: 11px;
      margin-bottom: 10px;
    }
    .popup-modal-icon {
      width: 34px;
      height: 34px;
      flex-shrink: 0;
      border-radius: 9px;
      background: rgba(251,191,36,0.12);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .popup-modal-icon svg {
      width: 17px;
      height: 17px;
      stroke: #fbbf24;
    }
    body:not(.dark-mode) .popup-modal-icon {
      background: rgba(245,158,11,0.10);
    }
    body:not(.dark-mode) .popup-modal-icon svg {
      stroke: #d97706;
    }

    .popup-modal-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.3;
    }
    .popup-modal-body {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.65;
      margin-bottom: 14px;
    }
    .popup-modal-body strong {
      color: var(--text-primary);
    }

    .popup-modal-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .popup-modal-retry {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .popup-modal-retry:hover {
      background: #4338ca;
    }
    .popup-modal-cancel {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .popup-modal-cancel:hover {
      background: var(--border-color);
    }

    .popup-modal-footer {
      font-size: 11px;
      color: var(--text-tertiary);
      text-align: center;
      line-height: 1.5;
    }
    .popup-modal-footer a {
      color: #6366f1;
      text-decoration: none;
    }
    .popup-modal-footer a:hover {
      text-decoration: underline;
    }
```

---

## Task 4: Add JS functions and wire up buttons

**Files:**
- Modify: `worker.js:3222` (add element references near other DOM refs)
- Modify: `worker.js:4556` (replace `showUrlToast` with new functions)

- [ ] **Step 1: Add element references** — find the block where `const toast = document.getElementById('toast')` is (~line 3222) and add two lines after it:

```js
    const popupOverlay = document.getElementById('popupOverlay');
    const popupModal = document.getElementById('popupModal');
```

- [ ] **Step 2: Replace `showUrlToast()` with the two new functions** — delete the entire `showUrlToast` function (lines ~4556–4576) and replace with:

```js
    let _pendingPopupUrl = null;

    function showPopupBlockedModal(url) {
      _pendingPopupUrl = url;
      popupOverlay.classList.add('active');
      popupModal.classList.add('active');
    }

    function hidePopupBlockedModal() {
      popupOverlay.classList.remove('active');
      popupModal.classList.remove('active');
      _pendingPopupUrl = null;
    }

    document.getElementById('popupRetry').addEventListener('click', () => {
      if (_pendingPopupUrl) window.open(_pendingPopupUrl, '_blank');
      hidePopupBlockedModal();
    });

    document.getElementById('popupCancel').addEventListener('click', hidePopupBlockedModal);
    document.getElementById('popupOverlay').addEventListener('click', hidePopupBlockedModal);
```

---

## Task 5: Update both `window.open` call sites

**Files:**
- Modify: `worker.js:4028` (P2P direct URL handler)
- Modify: `worker.js:4341` (cloud relay `handleUrlFallback`)

- [ ] **Step 1: Update P2P call site** — find this block (~line 4028):

```js
          if (data.type === 'url') {
            statusText.textContent = '🔗 Received URL!';
            showUrlToast(data.url);
            window.open(data.url, '_blank', 'noopener');
            return;
          }
```

Replace with:

```js
          if (data.type === 'url') {
            statusText.textContent = '🔗 Received URL!';
            const _tab = window.open(data.url, '_blank');
            if (!_tab) showPopupBlockedModal(data.url);
            return;
          }
```

- [ ] **Step 2: Update cloud relay call site** — find `handleUrlFallback` (~line 4341):

```js
    function handleUrlFallback(data) {
      // Receiver gets URL redirect link (fallback)
      statusText.textContent = '🔗 Received URL (via cloud)!';
      showUrlToast(data.redirectUrl);
      window.open(data.redirectUrl, '_blank', 'noopener');
    }
```

Replace with:

```js
    function handleUrlFallback(data) {
      statusText.textContent = '🔗 Received URL (via cloud)!';
      const _tab = window.open(data.redirectUrl, '_blank');
      if (!_tab) showPopupBlockedModal(data.redirectUrl);
    }
```

---

## Task 6: Verify end-to-end

- [ ] **Step 1: Deploy the worker** — run your normal deploy command (e.g. `wrangler deploy`).

- [ ] **Step 2: Test modal appears when blocked**
  - Open SwiftDrop in a browser with pop-ups blocked for the site
  - Send a URL from another device (or simulate by calling `showPopupBlockedModal('https://example.com')` in the browser console)
  - Confirm: overlay appears, modal centers on screen, icon and copy are correct, dark/light mode both look right

- [ ] **Step 3: Test Retry works**
  - With the modal open, click Retry
  - Confirm: new tab opens to the URL, modal dismisses

- [ ] **Step 4: Test Cancel**
  - Open modal again (console), click Cancel
  - Confirm: modal and overlay dismiss, no tab opens

- [ ] **Step 5: Test overlay click**
  - Open modal, click the dark overlay area (outside the card)
  - Confirm: modal dismisses

- [ ] **Step 6: Test help page**
  - Navigate to `/help/popups` directly
  - Confirm: page loads, screenshot shows, steps are readable, tip box renders
  - Toggle OS dark mode — confirm page re-themes automatically

- [ ] **Step 7: Test modal footer link**
  - Open modal, click "Adjust browser settings →"
  - Confirm: `/help/popups` opens in a new tab

- [ ] **Step 8: Test no-block path**
  - Allow pop-ups for the site in browser settings
  - Send a URL — confirm: tab opens immediately, modal does NOT appear

---

## Task 7: Commit

- [ ] **Step 1: Commit all changes**

```bash
git add worker.js
git commit -m "feat: replace URL toast with centered popup-blocked modal"
```
