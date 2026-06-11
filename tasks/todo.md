# Workers Static Assets Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move SwiftDrop's UI (currently a ~4,500-line template literal inside `worker.js`) into real static files served by Cloudflare Workers Static Assets, with the Turnstile site key delivered via a new `/api/config` endpoint instead of HTML interpolation.

**Architecture:** A new `public/` directory holds `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, and `help/popups.html`, declared via `[assets]` in `wrangler.toml`. Asset requests are served directly by Cloudflare (free, no Worker invocation) except `/` + `/index.html`, which use `run_worker_first` so the existing worker-level HTTP→HTTPS redirect still runs (workers.dev has no zone-level "Always Use HTTPS"). The Turnstile widget switches from implicit (`data-sitekey` interpolated into HTML) to explicit rendering: the page fetches `/api/config` and calls `turnstile.render()` lazily. The worker keeps everything else: `/ws`, `/nearby`, `/upload`, `/download/*`, `/url-redirect/*`, `/share` POST fallback, `/icons/*` proxy, `/api/turn-credentials`, `/cleanup`, both Durable Objects, and the cron job.

**Tech Stack:** Cloudflare Workers + Static Assets, wrangler 4.x (already at ^4.84.0, supports `run_worker_first` arrays), vanilla JS UI, Turnstile.

**Conventions:** Commit messages follow repo style (`refactor:`, `feat:`, `fix:` prefixes). NEVER add a `Co-Authored-By` line (user rule). Local dev runs via `npx wrangler dev --local`. Note: wrangler v4 auto-loads `.env.local` if present (it sets ALLOWED_ORIGINS for prod domains incl. `https://f.matan.us`; same-origin localhost WS still works after commit 32b8fcd).

**Why the extraction is scripted, not hand-edited:** Inside the template literal, client-side code is escaped (36 `` \` ``, 35 `\${`, 3 `\\`). Evaluating `getHTML()` in Node and writing the *result* to disk lets the JS engine do the unescaping — zero chance of hand-unescape errors.

**Key current locations in `worker.js` (5,816 lines):**
- Route handlers to replace/remove: `/` + `/index.html` (lines 73–80), `/help/popups` (83–90), `/manifest.webmanifest` (93–100), `/sw.js` (103–112)
- Generators to delete after migration: `getManifest()` (608–638), `getServiceWorker()` (648–733), `getHelpPage()` (1119–~1322), `getHTML(env)` (1325–5816)
- Inside `getHTML`'s template: one `<style>` block (file lines 1345–2937), exactly one bare `<script>` block (3269–5814; the head's CDN tags all have `src=` attributes so they don't match `<script>`), and exactly one interpolation: `${turnstileSiteKey}` at line 3133
- Turnstile client code: `getTurnstileToken()` (3997–4021), `window.onTurnstileSuccess` (4023–4026), `turnstile.reset('#turnstileWidget')` (~4698)

---

### Task 1: Capture baseline responses (no commit)

**Files:** none (writes to `/tmp/swiftdrop-baseline/`)

- [ ] **Step 1: Start the local dev server in the background**

Run: `npx wrangler dev --local` (background, from repo root). Wait for "Ready on http://localhost:8787".

- [ ] **Step 2: Capture baselines**

```bash
mkdir -p /tmp/swiftdrop-baseline
curl -s http://localhost:8787/ -o /tmp/swiftdrop-baseline/index.html
curl -s http://localhost:8787/sw.js -o /tmp/swiftdrop-baseline/sw.js
curl -s http://localhost:8787/manifest.webmanifest -o /tmp/swiftdrop-baseline/manifest.webmanifest
curl -s http://localhost:8787/help/popups -o /tmp/swiftdrop-baseline/popups.html
curl -s http://localhost:8787/api/turn-credentials -o /tmp/swiftdrop-baseline/turn.json
```

Expected: all files non-empty; `index.html` ends with `</html>`. Check whether `.dev.vars` or `.env.local` sets `TURNSTILE_SITE_ID` (`grep -l TURNSTILE_SITE_ID .dev.vars .env.local 2>/dev/null`) — if so, the baseline HTML contains it in `data-sitekey="..."` and the diff in Task 2 Step 3 must account for it.

- [ ] **Step 3: Stop the dev server**

---

### Task 2: Extract the UI into `public/` via a one-shot script

**Files:**
- Modify: `worker.js` (append one temporary export line)
- Create: `scripts/extract-ui.mjs` (deleted again in Task 4)
- Create: `public/index.html`, `public/styles.css`, `public/app.js`, `public/sw.js`, `public/manifest.webmanifest`, `public/help/popups.html`

- [ ] **Step 1: Add a temporary export at the end of `worker.js`**

```js
// TEMP: for scripts/extract-ui.mjs — removed after extraction
export { getHTML, getHelpPage, getManifest, getServiceWorker };
```

(`worker.js` has no imports and no top-level side effects, so plain Node can import it.)

- [ ] **Step 2: Write `scripts/extract-ui.mjs`**

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { getHTML, getHelpPage, getManifest, getServiceWorker } =
  await import(join(root, 'worker.js'));

// Empty env => data-sitekey="" — matches a local baseline with no TURNSTILE_SITE_ID set.
const html = getHTML({});

const styleOpen = html.indexOf('<style>');
const styleClose = html.indexOf('</style>');
const scriptOpen = html.indexOf('<script>'); // exactly one bare <script>; CDN tags use <script src=
const scriptClose = html.lastIndexOf('</script>');
if ([styleOpen, styleClose, scriptOpen, scriptClose].some((i) => i === -1)) {
  throw new Error('marker not found');
}
if (html.indexOf('<style>', styleOpen + 1) !== -1) throw new Error('more than one <style> block');
if (html.indexOf('<script>', scriptOpen + 1) !== -1) throw new Error('more than one bare <script> block');

const css = html.slice(styleOpen + '<style>'.length, styleClose);
const js = html.slice(scriptOpen + '<script>'.length, scriptClose);

const indexHtml =
  html.slice(0, styleOpen) +
  '<link rel="stylesheet" href="/styles.css">' +
  html.slice(styleClose + '</style>'.length, scriptOpen) +
  '<script src="/app.js"></script>' +
  html.slice(scriptClose + '</script>'.length);

// Verify the split is lossless: reassembling must reproduce getHTML({}) byte-for-byte.
const reassembled = indexHtml
  .replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
  .replace('<script src="/app.js"></script>', '<script>' + js + '</script>');
if (reassembled !== html) throw new Error('reassembly mismatch — split is lossy');

mkdirSync(join(root, 'public', 'help'), { recursive: true });
writeFileSync(join(root, 'public', 'index.html'), indexHtml);
writeFileSync(join(root, 'public', 'styles.css'), css.trim() + '\n');
writeFileSync(join(root, 'public', 'app.js'), js.trim() + '\n');
writeFileSync(join(root, 'public', 'sw.js'), getServiceWorker());
writeFileSync(join(root, 'public', 'manifest.webmanifest'), getManifest());
writeFileSync(join(root, 'public', 'help', 'popups.html'), getHelpPage());
console.log('extracted OK');
```

Note: the lossless check uses the UNtrimmed `css`/`js` (trimming happens only at write time), so the ordering above matters — don't move `.trim()` earlier.

- [ ] **Step 3: Run the extraction and verify**

```bash
node scripts/extract-ui.mjs        # expected: "extracted OK"
node --check public/app.js         # expected: no output (valid JS)
node --check public/sw.js          # expected: no output
diff /tmp/swiftdrop-baseline/sw.js public/sw.js                                # expected: identical
diff /tmp/swiftdrop-baseline/manifest.webmanifest public/manifest.webmanifest  # identical
diff /tmp/swiftdrop-baseline/popups.html public/help/popups.html               # identical
```

If local env sets `TURNSTILE_SITE_ID`, the only acceptable index diff vs baseline is the `data-sitekey` value; otherwise spot-check `grep -c 'data-sitekey=""' public/index.html` → `1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/extract-ui.mjs public/ worker.js
git commit -m "refactor: extract inline UI from worker.js into public/ static files"
```

---

### Task 3: Serve `public/` via Workers Static Assets + add `/api/config`

**Files:**
- Modify: `wrangler.toml`
- Modify: `worker.js` (route handlers at lines 54–112 region)
- Create: `public/_headers`

- [ ] **Step 1: Add the assets config to `wrangler.toml`** (after `preview_urls = true`)

```toml
# Static UI served from public/. run_worker_first keeps the worker's
# HTTP->HTTPS redirect on the HTML route (workers.dev has no zone-level
# "Always Use HTTPS"); all other assets are served directly and free.
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = ["/", "/index.html"]
```

- [ ] **Step 2: Create `public/_headers`**

```
/sw.js
  Cache-Control: no-cache
```

(Browsers need a short-lived SW response so updates are picked up. `Service-Worker-Allowed` is no longer needed: `/sw.js` sits at the root, so its default scope already covers `/`.)

- [ ] **Step 3: Replace the four UI route handlers in `worker.js`**

Replace the `/` + `/index.html` handler (lines 73–80) with:

```js
    // Serve the UI (static asset; run_worker_first routes it through here
    // so the HTTPS redirect above applies)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(request);
    }
```

Delete the `/help/popups`, `/manifest.webmanifest`, and `/sw.js` handlers entirely (lines 83–112) — unmatched paths fall through to asset serving automatically. The old `Access-Control-Allow-Origin: *` on the HTML is intentionally dropped (documents don't need CORS).

- [ ] **Step 4: Add the `/api/config` endpoint** (right after the `/api/turn-credentials` handler, ~line 70)

```js
    // Public client config. Turnstile site keys are public by design, but
    // serving from env (not hardcoding in the static HTML) means rotation
    // never requires a code change.
    if (url.pathname === '/api/config') {
      return new Response(JSON.stringify({
        turnstileSiteKey: env.TURNSTILE_SITE_ID || ''
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
```

- [ ] **Step 5: Verify with the dev server**

Start `npx wrangler dev --local`, then:

```bash
curl -s http://localhost:8787/ | diff /tmp/swiftdrop-baseline/index.html -    # only diffs: <link stylesheet> + <script src> replacing inline blocks
curl -s http://localhost:8787/styles.css | head -3                             # CSS, not HTML
curl -sI http://localhost:8787/sw.js | grep -i 'cache-control\|content-type'   # no-cache + javascript
curl -sI http://localhost:8787/manifest.webmanifest | grep -i content-type     # application/manifest+json (if wrong, add to _headers)
curl -s http://localhost:8787/help/popups | diff /tmp/swiftdrop-baseline/popups.html -   # identical
curl -s http://localhost:8787/api/config                                        # {"turnstileSiteKey":""} (or local env value)
curl -s http://localhost:8787/api/turn-credentials | diff /tmp/swiftdrop-baseline/turn.json -  # identical (regression check)
```

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml worker.js public/_headers
git commit -m "feat: serve UI via Workers Static Assets and add /api/config"
```

---

### Task 4: Strip the dead generators from `worker.js`

**Files:**
- Modify: `worker.js`
- Delete: `scripts/extract-ui.mjs`

- [ ] **Step 1: Delete dead code from `worker.js`**

Delete (line numbers are pre-deletion; work bottom-up so they stay valid):
1. The temporary `export { getHTML, ... }` line at EOF (added in Task 2)
2. `getHTML(env)` — function start `function getHTML(env) {` through the final closing backtick + `}` (1325–5816)
3. `getHelpPage()` (1119 through its closing `}`)
4. `getServiceWorker()` (648–733 region — the SW code incl. `handleShare` lives INSIDE its template string; confirm boundaries by reading before deleting)
5. `getManifest()` (608–638)

Keep `serveIcon()` and everything else.

- [ ] **Step 2: Verify nothing references the deleted functions**

```bash
grep -n 'getHTML\|getHelpPage\|getManifest\|getServiceWorker' worker.js   # expected: no matches
node --check worker.js                                                     # expected: no output
wc -l worker.js                                                            # expected: ~1,100 lines
```

- [ ] **Step 3: Re-run the Task 3 Step 5 curl checks** (re-verify `/`, `/sw.js`, `/api/config` still serve correctly)

- [ ] **Step 4: Delete the one-shot extraction script and commit**

```bash
git rm scripts/extract-ui.mjs
git add worker.js
git commit -m "refactor: remove inline UI generators superseded by static assets"
```

---

### Task 5: Explicit Turnstile rendering from `/api/config`

**Files:**
- Modify: `public/index.html` (Turnstile script tag + widget div)
- Modify: `public/app.js` (render/execute logic)

- [ ] **Step 1: Switch the Turnstile API script to explicit mode in `public/index.html`**

Old:
```html
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```
New:
```html
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
```

- [ ] **Step 2: Replace the widget div in `public/index.html`**

Old:
```html
  <!-- Turnstile Widget (invisible, for cloud uploads only) -->
  <div class="cf-turnstile"
       id="turnstileWidget"
       data-sitekey=""
       data-theme="light"
       data-size="invisible"
       data-callback="onTurnstileSuccess"
       style="display:none;">
  </div>
```
New:
```html
  <!-- Turnstile Widget (invisible, for cloud uploads only; rendered explicitly
       with the sitekey from /api/config) -->
  <div id="turnstileWidget" style="display:none;"></div>
```

- [ ] **Step 3: Add config fetch + lazy explicit render in `public/app.js`**

Insert directly above the existing `// Turnstile helper functions` comment (just before `getTurnstileToken`):

```js
    // Client config (Turnstile sitekey) is served from /api/config so key
    // rotation never requires touching the static files.
    const clientConfigPromise = fetch('/api/config')
      .then((r) => r.json())
      .catch(() => ({}));

    let turnstileWidgetRendered = false;

    function waitForTurnstileApi() {
      return new Promise((resolve, reject) => {
        if (window.turnstile) return resolve();
        let waited = 0;
        const timer = setInterval(() => {
          if (window.turnstile) {
            clearInterval(timer);
            resolve();
          } else if ((waited += 100) >= 10000) {
            clearInterval(timer);
            reject(new Error('Turnstile not available'));
          }
        }, 100);
      });
    }

    async function ensureTurnstileWidget() {
      if (turnstileWidgetRendered) return;
      const { turnstileSiteKey } = await clientConfigPromise;
      if (!turnstileSiteKey) throw new Error('Turnstile not configured');
      await waitForTurnstileApi();
      window.turnstile.render('#turnstileWidget', {
        sitekey: turnstileSiteKey,
        theme: 'light',
        size: 'invisible',
        callback: window.onTurnstileSuccess
      });
      turnstileWidgetRendered = true;
    }
```

- [ ] **Step 4: Make `getTurnstileToken` render first**

Old (in `public/app.js`):
```js
    async function getTurnstileToken() {
      return new Promise((resolve, reject) => {
        if (!window.turnstile) {
          console.error('Turnstile not loaded');
          reject(new Error('Turnstile not available'));
          return;
        }

        try {
```
New:
```js
    async function getTurnstileToken() {
      await ensureTurnstileWidget();
      return new Promise((resolve, reject) => {
        try {
```
(The body of the `try` — `window.turnstile.execute('#turnstileWidget', {...})` — and everything after stays unchanged. `window.onTurnstileSuccess` must remain defined; it now also serves as the render callback. The existing `turnstile.reset('#turnstileWidget')` call keeps working since the widget renders into the same container.)

- [ ] **Step 5: Verify**

```bash
node --check public/app.js   # expected: no output
```

Then with `npx wrangler dev --local` running, load `http://localhost:8787/` in a browser (screenshot via headless Opera per project convention) and confirm: page renders identically, no console errors on load (a Turnstile error must NOT appear at startup — rendering is lazy), and `/api/config` is fetched. If local env has a real `TURNSTILE_SITE_ID`, exercise a cloud upload to confirm the invisible widget executes.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: render Turnstile explicitly with sitekey from /api/config"
```

---

### Task 6: End-to-end verification + docs

**Files:**
- Modify: `README.md` / `PROJECT_OVERVIEW.md` / `DEPLOYMENT.md` / `QUICKSTART.md` (only where they describe the single-file layout)

- [ ] **Step 1: Full local smoke test** (`npx wrangler dev --local`)

- Home page renders (headless Opera screenshot, compare against pre-migration look — desktop 1280px and mobile 390px like last time)
- Open the page and confirm the signaling WebSocket to `/ws?room=XXXXXX` connects (the UI shows "Share this code with receiver:")
- `/help/popups`, `/manifest.webmanifest`, `/sw.js`, `/icons/icon-192.png` all return 200
- `/api/config` and `/api/turn-credentials` return JSON
- `http://` → `https://` redirect can't be tested locally (localhost is exempted) — verify after deploy with `curl -sI http://<workers.dev-host>/ | grep -i location`

- [ ] **Step 2: Grep the docs for stale claims**

```bash
grep -rn 'single.file\|worker\.js.*UI\|inline.*HTML' README.md PROJECT_OVERVIEW.md DEPLOYMENT.md QUICKSTART.md
```

Update any sentence claiming the UI is inlined in `worker.js`; describe `public/` + `[assets]` instead. Keep edits minimal.

- [ ] **Step 3: Commit**

```bash
git add README.md PROJECT_OVERVIEW.md DEPLOYMENT.md QUICKSTART.md
git commit -m "docs: describe public/ static assets layout"
```

- [ ] **Step 4: Deploy is a separate, user-approved step** — `npm run deploy`, then re-run the smoke checks against the live URL (including the HTTP redirect and a real Turnstile cloud upload). Ask the user before deploying.

---

## Review

Executed 2026-06-11 on branch `static-assets-migration` (6 commits, c3720b7..e44d7c4), subagent-driven with per-task spec + quality reviews. Final integration review: READY TO MERGE.

- worker.js: 5,816 → 967 lines; UI now in `public/` (extraction was script-generated and verified byte-lossless against `getHTML({})`; sw.js/manifest/help page byte-identical to pre-migration responses).
- `[assets]` serving verified live: correct content types, `no-cache` on /sw.js via `_headers`, `/help/popups` extensionless serving works, API/WS/icons routes unshadowed.
- `/api/config` serves the Turnstile sitekey with `Cache-Control: no-store` (added after quality review); app.js renders Turnstile explicitly + lazily; widget div carries no sitekey.
- Smoke: all endpoints 200; desktop + mobile headless screenshots styled correctly with room code visible (WS signaling works); no Turnstile console errors on load.
- Deliberately NOT done: long-lived asset caching + version busting (no build step → manual busting is a footgun; default ETag revalidation is correct), method guard on /api/config (adjacent routes have none).
- Deploy + post-deploy checks (HTTP→HTTPS redirect, real cloud upload) still pending user approval.
