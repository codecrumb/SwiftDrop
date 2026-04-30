/**
 * SwiftDrop - P2P File Transfer with R2 Fallback
 * Cloudflare Worker + Durable Object + WebRTC + R2
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual cleanup trigger (protected with API key)
    if (url.pathname === '/cleanup' && request.method === 'POST') {
      // Require API key for manual cleanup
      const apiKey = request.headers.get('X-API-Key');
      const expectedKey = env.CLEANUP_API_KEY;

      if (!expectedKey) {
        return new Response(JSON.stringify({
          error: 'Cleanup endpoint disabled (CLEANUP_API_KEY not configured)'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!apiKey || apiKey !== expectedKey) {
        return new Response(JSON.stringify({
          error: 'Unauthorized - Invalid or missing API key'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const deleted = await cleanupExpiredFiles(env);
      return new Response(JSON.stringify({
        success: true,
        deletedCount: deleted,
        message: `Cleaned up ${deleted} expired files`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // TURN credentials endpoint — reads secret, never exposes it in source
    if (url.pathname === '/api/turn-credentials') {
      if (!env.METERED_TURN_CREDENTIALS) {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const creds = JSON.parse(env.METERED_TURN_CREDENTIALS);
        return new Response(JSON.stringify(creds), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Serve the UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHTML(env), {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Help page: allowing pop-ups
    if (url.pathname === '/help/popups' && request.method === 'GET') {
      return new Response(getHelpPage(), {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // PWA manifest (Android Web Share Target needs same-origin manifest + SW)
    if (url.pathname === '/manifest.webmanifest' && request.method === 'GET') {
      return new Response(getManifest(), {
        headers: {
          'Content-Type': 'application/manifest+json;charset=UTF-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // Service worker (must be served from same origin with scope /)
    if (url.pathname === '/sw.js' && request.method === 'GET') {
      return new Response(getServiceWorker(), {
        headers: {
          'Content-Type': 'application/javascript;charset=UTF-8',
          // Browsers require a short-lived SW response so updates are picked up
          'Cache-Control': 'no-cache',
          'Service-Worker-Allowed': '/'
        }
      });
    }

    // Same-origin icon proxy for PWA install + share target
    if (url.pathname.startsWith('/icons/') && request.method === 'GET') {
      return serveIcon(url.pathname);
    }

    // POST /share is only hit when the installed PWA's service worker is NOT yet
    // controlling the page (e.g. first launch after install). The SW normally
    // intercepts it and stashes the files in Cache Storage. As a graceful
    // fallback we redirect to the home page so the user can still send manually.
    if (url.pathname === '/share' && request.method === 'POST') {
      return Response.redirect(new URL('/?shared=unavailable', request.url).toString(), 303);
    }

    // WebSocket upgrade for signaling
    if (url.pathname === '/ws') {
      // Validate Origin to prevent Cross-Site WebSocket Hijacking (CSWSH).
      // Browsers always send an Origin header on WebSocket handshakes; a missing
      // or unlisted Origin from a browser context indicates a cross-site attempt.
      if (!isAllowedWebSocketOrigin(request, env)) {
        return new Response('Forbidden: origin not allowed', { status: 403 });
      }

      const roomCode = url.searchParams.get('room');
      if (!roomCode || roomCode.length !== 6) {
        return new Response('Invalid room code', { status: 400 });
      }

      // Get or create Durable Object for this room
      const id = env.ROOMS.idFromName(roomCode.toUpperCase());
      const room = env.ROOMS.get(id);

      // Forward WebSocket connection to the Durable Object
      return room.fetch(request);
    }

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

    // R2 Fallback: Upload file or URL
    if (url.pathname === '/upload' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('content-type') || '';

        // Handle URL upload (JSON)
        if (contentType.includes('application/json')) {
          const data = await request.json();
          const { urlId, url: targetUrl, roomCode, timestamp, turnstileToken } = data;

          if (!urlId || !targetUrl || !roomCode) {
            return new Response(JSON.stringify({ error: 'Missing required fields' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // Server-side URL protocol validation (whitelist http/https only)
          try {
            const urlObj = new URL(targetUrl);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
              return new Response(JSON.stringify({
                error: 'Invalid URL protocol (only http/https allowed)'
              }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          } catch (e) {
            return new Response(JSON.stringify({ error: 'Invalid URL' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // Verify Turnstile token
          const isValid = await verifyTurnstile(turnstileToken, env);
          if (!isValid) {
            return new Response(JSON.stringify({ error: 'Bot verification failed' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // Store URL in R2
          await env.FILE_STORAGE.put(urlId, targetUrl, {
            httpMetadata: {
              contentType: 'text/plain',
            },
            customMetadata: {
              roomCode,
              type: 'url',
              uploadedAt: timestamp.toString(),
              expiresAt: (timestamp + 20 * 60 * 1000).toString() // 20 minutes
            }
          });

          // Analytics: Track URL share via cloud relay
          console.log(JSON.stringify({
            event: 'url_shared',
            method: 'cloud_relay',
            roomCode,
            timestamp: new Date().toISOString()
          }));

          return new Response(JSON.stringify({
            success: true,
            urlId,
            redirectUrl: `/url-redirect/${urlId}`
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...getCorsHeaders(request, env)
            }
          });
        }

        // Handle file upload (FormData)
        const formData = await request.formData();
        const file = formData.get('file');
        const roomCode = formData.get('roomCode');
        const fileName = formData.get('fileName');
        const turnstileToken = formData.get('turnstileToken');

        if (!file || !roomCode) {
          return new Response(JSON.stringify({ error: 'Missing file or room code' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Verify Turnstile token
        const isValid = await verifyTurnstile(turnstileToken, env);
        if (!isValid) {
          return new Response(JSON.stringify({ error: 'Bot verification failed' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Server-side file size validation (20MB limit)
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
        if (file.size > MAX_FILE_SIZE) {
          return new Response(JSON.stringify({
            error: 'File too large (max 20MB). P2P mode supports larger files when both peers are connected.'
          }), {
            status: 413, // Payload Too Large
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Generate unique file ID
        const fileId = crypto.randomUUID();
        const timestamp = Date.now();

        // Store file in R2
        await env.FILE_STORAGE.put(fileId, file, {
          httpMetadata: {
            contentType: file.type || 'application/octet-stream',
          },
          customMetadata: {
            roomCode,
            fileName: sanitizeFilename(fileName || file.name),
            uploadedAt: timestamp.toString(),
            expiresAt: (timestamp + 20 * 60 * 1000).toString() // 20 minutes
          }
        });

        // Analytics: Track file upload via cloud relay
        console.log(JSON.stringify({
          event: 'file_upload',
          method: 'cloud_relay',
          fileSize: file.size,
          fileType: file.type || 'unknown',
          roomCode,
          timestamp: new Date().toISOString()
        }));

        return new Response(JSON.stringify({
          success: true,
          fileId,
          downloadUrl: `/download/${fileId}`
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request, env)
          }
        });
      } catch (error) {
        console.error('Upload error:', error);
        return new Response(JSON.stringify({ error: 'Upload failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // R2 Fallback: URL redirect (for URL sharing fallback)
    if (url.pathname.startsWith('/url-redirect/') && request.method === 'GET') {
      const urlId = url.pathname.split('/url-redirect/')[1];

      if (!urlId) {
        return new Response('URL ID required', { status: 400 });
      }

      try {
        const object = await env.FILE_STORAGE.get(urlId);

        if (!object) {
          return new Response('URL not found or expired', { status: 404 });
        }

        // Check expiration
        const expiresAt = parseInt(object.customMetadata?.expiresAt || '0');
        if (expiresAt && Date.now() > expiresAt) {
          await env.FILE_STORAGE.delete(urlId);
          console.log(`[R2] Deleted expired URL: ${urlId}`);
          return new Response('URL expired', { status: 410 });
        }

        // Read the URL from the object
        const redirectUrl = await object.text();

        // Analytics: Track URL redirect (successful download)
        console.log(JSON.stringify({
          event: 'url_redirect',
          method: 'cloud_relay',
          roomCode: object.customMetadata?.roomCode,
          timestamp: new Date().toISOString()
        }));

        // Delete the URL object after use
        try {
          await env.FILE_STORAGE.delete(urlId);
          console.log(`[R2] Deleted URL after redirect: ${urlId}`);
        } catch (deleteError) {
          console.error(`[R2] Failed to delete URL ${urlId}:`, deleteError);
        }

        // Redirect to the URL
        return Response.redirect(redirectUrl, 302);
      } catch (error) {
        console.error('URL redirect error:', error);
        return new Response('Redirect failed', { status: 500 });
      }
    }

    // R2 Fallback: Download file
    if (url.pathname.startsWith('/download/') && request.method === 'GET') {
      const fileId = url.pathname.split('/download/')[1];
      
      if (!fileId) {
        return new Response('File ID required', { status: 400 });
      }
      
      try {
        const object = await env.FILE_STORAGE.get(fileId);
        
        if (!object) {
          return new Response('File not found or expired', { status: 404 });
        }
        
        // Check expiration
        const expiresAt = parseInt(object.customMetadata?.expiresAt || '0');
        if (expiresAt && Date.now() > expiresAt) {
          await env.FILE_STORAGE.delete(fileId);
          console.log(`[R2] Deleted expired file: ${fileId}`);
          return new Response('File expired', { status: 410 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Content-Disposition', `attachment; filename="${sanitizeFilename(object.customMetadata?.fileName || 'download')}"`);

        // Add CORS headers for allowed origins
        const corsHeaders = getCorsHeaders(request, env);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          headers.set(key, value);
        });

        // Read the entire file into array buffer (files are < 20MB so this is safe)
        const arrayBuffer = await object.arrayBuffer();

        // Analytics: Track file download via cloud relay
        console.log(JSON.stringify({
          event: 'file_download',
          method: 'cloud_relay',
          fileSize: arrayBuffer.byteLength,
          fileName: object.customMetadata?.fileName || 'unknown',
          roomCode: object.customMetadata?.roomCode,
          timestamp: new Date().toISOString()
        }));

        // Now delete the file from R2 (properly awaited)
        try {
          await env.FILE_STORAGE.delete(fileId);
          console.log(`[R2] Deleted file after download: ${fileId}`);
        } catch (deleteError) {
          console.error(`[R2] Failed to delete file ${fileId}:`, deleteError);
          // Continue serving the file even if deletion fails
        }

        // Return the file content
        return new Response(arrayBuffer, { headers });
      } catch (error) {
        console.error('Download error:', error);
        return new Response('Download failed', { status: 500 });
      }
    }
    
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: getCorsHeaders(request, env)
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Scheduled cleanup (runs every 5 minutes via cron trigger)
  async scheduled(event, env, ctx) {
    console.log('[Cleanup] Starting scheduled cleanup...');
    const deleted = await cleanupExpiredFiles(env);
    console.log(`[Cleanup] Finished. Deleted ${deleted} expired files.`);
  }
};

/**
 * Get CORS headers for allowed origins only
 */
function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

  // Check if origin is in allowed list
  if (origin && allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
    };
  }

  // No CORS headers if origin not allowed (will block cross-origin requests)
  return {};
}

/**
 * Decide whether a WebSocket upgrade request comes from an allowed Origin.
 *
 * This blocks Cross-Site WebSocket Hijacking (CSWSH): the same-origin policy
 * does not apply to WebSocket handshakes, so any site a victim visits could
 * otherwise open a WS to our worker and speak as that user.
 *
 * Rules:
 *  - If ALLOWED_ORIGINS is configured, the Origin header MUST be present and
 *    MUST match one of the configured origins.
 *  - If ALLOWED_ORIGINS is not configured, allow the request but match the
 *    worker's origin (same-origin) when an Origin header is present. Requests
 *    without an Origin header (non-browser clients) are allowed in this mode
 *    to preserve current behavior for local/dev setups.
 */
function isAllowedWebSocketOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length > 0) {
    return Boolean(origin) && allowedOrigins.includes(origin);
  }

  // No explicit allowlist configured: fall back to same-origin check.
  if (!origin) return true;
  try {
    const requestOrigin = new URL(request.url).origin;
    return origin === requestOrigin;
  } catch {
    return false;
  }
}

/**
 * Sanitize filename to prevent XSS and path traversal attacks
 */
function sanitizeFilename(filename) {
  if (!filename) return 'download';

  return filename
    .replace(/[/\\]/g, '') // Remove path separators
    .replace(/\.\./g, '') // Remove parent directory references
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Only allow safe chars
    .substring(0, 255); // Limit length
}

/**
 * Verify Turnstile token for bot protection
 */
async function verifyTurnstile(token, env) {
  if (!token) {
    console.log('[Turnstile] No token provided');
    return false;
  }

  if (!env.TURNSTILE_SECRET) {
    console.warn('[Turnstile] TURNSTILE_SECRET not configured, skipping verification');
    return true; // Allow requests when Turnstile is not configured
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token
      })
    });

    const result = await response.json();
    console.log('[Turnstile] Verification result:', result.success);
    return result.success;
  } catch (error) {
    console.error('[Turnstile] Verification error:', error);
    return false;
  }
}

/**
 * Cleanup expired files from R2 storage
 */
async function cleanupExpiredFiles(env) {
  try {
    const now = Date.now();
    let deletedCount = 0;
    let cursor;
    let truncated = true;

    // List all objects in R2 bucket with metadata (efficient - no extra get() calls)
    do {
      const listed = await env.FILE_STORAGE.list({
        cursor: cursor,
        limit: 1000,
        include: ['customMetadata'] // Include metadata in list response
      });

      // Check each object for expiration
      for (const object of listed.objects) {
        try {
          // Read metadata directly from list() response (no get() needed!)
          const expiresAt = parseInt(object.customMetadata?.expiresAt || '0');

          if (expiresAt && now > expiresAt) {
            // File has expired, delete it
            await env.FILE_STORAGE.delete(object.key);
            deletedCount++;
            console.log(`[Cleanup] Deleted expired file: ${object.key} (expired at ${new Date(expiresAt).toISOString()})`);
          }
        } catch (err) {
          console.error(`[Cleanup] Error processing object ${object.key}:`, err);
        }
      }

      cursor = listed.cursor;
      truncated = listed.truncated;
    } while (truncated);

    return deletedCount;
  } catch (error) {
    console.error('[Cleanup] Error during cleanup:', error);
    return 0;
  }
}

/**
 * PWA manifest. share_target tells Android to offer SwiftDrop in the system
 * share sheet; the matching POST is intercepted by sw.js below.
 */
function getManifest() {
  return JSON.stringify({
    name: 'SwiftDrop',
    short_name: 'SwiftDrop',
    description: 'P2P file transfer with cloud fallback',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#667eea',
    background_color: '#ffffff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    share_target: {
      action: '/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [
          { name: 'files', accept: ['*/*'] }
        ]
      }
    }
  });
}

/**
 * Minimal service worker. Its only job is to intercept the share_target POST
 * to /share, stash the incoming files in Cache Storage, and redirect the
 * launched window to /?shared=1 which reads them back on load.
 *
 * Keep this tiny: it purposefully does NOT cache app shell. SwiftDrop is a
 * single-page Worker-rendered app and we do not want stale HTML.
 */
function getServiceWorker() {
  return `// SwiftDrop service worker — share_target handler only.
const SHARE_CACHE = 'swiftdrop-share-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(event));
    return;
  }
  // Everything else: let the network handle it (no app-shell caching).
});

async function handleShare(event) {
  const redirect = Response.redirect('/?shared=1', 303);
  try {
    const formData = await event.request.formData();
    const files = formData.getAll('files').filter((f) => f && typeof f === 'object' && 'name' in f && 'size' in f);
    const title = formData.get('title') || '';
    const text = formData.get('text') || '';
    const sharedUrl = formData.get('url') || '';

    const cache = await caches.open(SHARE_CACHE);

    // Clear any previous shared payload so we never surface stale files.
    const keys = await cache.keys();
    await Promise.all(keys.map((k) => cache.delete(k)));

    const manifest = {
      ts: Date.now(),
      title: String(title),
      text: String(text),
      url: String(sharedUrl),
      files: []
    };

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = '/__shared__/' + i + '/' + encodeURIComponent(f.name || ('file-' + i));
      await cache.put(
        new Request(key),
        new Response(f, {
          headers: {
            'Content-Type': f.type || 'application/octet-stream',
            'X-Shared-Name': encodeURIComponent(f.name || ('file-' + i))
          }
        })
      );
      manifest.files.push({
        key,
        name: f.name || ('file-' + i),
        type: f.type || 'application/octet-stream',
        size: typeof f.size === 'number' ? f.size : 0
      });
    }

    await cache.put(
      new Request('/__shared__/manifest.json'),
      new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/json' }
      })
    );

    return redirect;
  } catch (err) {
    return Response.redirect('/?shared=error', 303);
  }
}
`;
}

/**
 * Serve same-origin icons. Android's share target + install prompt only
 * advertise icons listed in the manifest, and Chrome fetches them from the
 * manifest's origin. We proxy the existing hosted favicons so we don't have
 * to check binary assets into the repo.
 */
async function serveIcon(pathname) {
  const map = {
    '/icons/icon-192.png': 'https://faviconser.pages.dev/swiftdrop/icon-192.png',
    '/icons/icon-512.png': 'https://faviconser.pages.dev/swiftdrop/icon-512.png',
    '/icons/icon-512-maskable.png': 'https://faviconser.pages.dev/swiftdrop/icon-512-maskable.png',
    '/icons/apple-touch-icon.png': 'https://faviconser.pages.dev/swiftdrop/apple-touch-icon.png',
    '/icons/favicon-16.png': 'https://faviconser.pages.dev/swiftdrop/favicon-16.png',
    '/icons/favicon-32.png': 'https://faviconser.pages.dev/swiftdrop/favicon-32.png',
    '/icons/favicon.ico': 'https://faviconser.pages.dev/swiftdrop/favicon.ico'
  };
  const upstream = map[pathname];
  if (!upstream) return new Response('Not Found', { status: 404 });

  const upstreamRes = await fetch(upstream, {
    cf: { cacheTtl: 86400, cacheEverything: true }
  });
  if (!upstreamRes.ok) {
    return new Response('Icon fetch failed', { status: 502 });
  }

  // faviconser.pages.dev returns a 200 HTML "Page Not Found" body when a file
  // is missing, which Chrome would then try to decode as a PNG and silently
  // fall back to a generic icon. Require an image content-type before we echo
  // the upstream body back.
  const ct = upstreamRes.headers.get('Content-Type') || '';
  if (!ct.startsWith('image/')) {
    return new Response('Upstream icon missing or not an image', { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=86400, immutable');
  return new Response(upstreamRes.body, { status: 200, headers });
}

/**
 * Durable Object: SignalingRoom
 * Manages WebSocket connections and WebRTC signaling for a room.
 * Uses the Hibernation API so the DO sleeps between messages and only
 * charges wall time while actively processing — not while connections sit idle.
 */
export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    // Upgrade to WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Generate unique session ID and attach it to the socket so it survives hibernation
    const sessionId = crypto.randomUUID();
    server.serializeAttachment({ sessionId, joinedAt: Date.now() });

    // Hibernation API: DO can sleep between messages; connections stay open
    this.state.acceptWebSocket(server, [sessionId]);

    // Cancel any pending eviction alarm — room is active again
    await this.state.storage.deleteAlarm();

    const allPeers = this.state.getWebSockets();
    console.log(`[Room] New peer: ${sessionId}. Total: ${allPeers.length}`);

    // Analytics: Track P2P connection attempt
    console.log(JSON.stringify({
      event: 'peer_connected',
      method: 'p2p',
      peersInRoom: allPeers.length,
      timestamp: new Date().toISOString()
    }));

    // Send connection confirmation
    server.send(JSON.stringify({
      type: 'connected',
      sessionId,
      peersCount: allPeers.length - 1
    }));

    // Notify other peers
    this.broadcast({
      type: 'peer-joined',
      sessionId,
      peersCount: allPeers.length
    }, sessionId);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  // Called by the runtime when a message arrives (DO wakes from hibernation if needed)
  webSocketMessage(ws, message) {
    try {
      const { sessionId } = ws.deserializeAttachment();
      const data = JSON.parse(message);
      this.handleMessage(sessionId, data, ws);
    } catch (error) {
      console.error('[Room] Invalid message:', error);
    }
  }

  // Called by the runtime when a connection closes
  async webSocketClose(ws, code, reason, wasClean) {
    const { sessionId } = ws.deserializeAttachment();
    // getWebSockets() still includes the closing socket during this handler
    const remaining = this.state.getWebSockets().length - 1;
    console.log(`[Room] Peer left: ${sessionId}. Remaining: ${remaining}`);

    this.broadcast({
      type: 'peer-left',
      sessionId,
      peersCount: remaining
    }, sessionId);

    if (remaining === 0) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      console.log('[Room] Room empty. Alarm set for 5 minutes.');
    }
  }

  // Called by the runtime on WebSocket error
  webSocketError(ws, error) {
    console.error('[Room] WebSocket error:', error);
  }

  handleMessage(fromSessionId, data, fromWs) {
    console.log(`[Room] Message: ${data.type} from ${fromSessionId.substring(0, 8)}`);

    switch (data.type) {
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        // Route WebRTC signaling messages
        if (data.target) {
          // Send to specific peer
          this.sendTo(data.target, {
            ...data,
            from: fromSessionId
          });
        } else {
          // Broadcast to all other peers
          this.broadcast({
            ...data,
            from: fromSessionId
          }, fromSessionId);
        }
        break;

      case 'fallback-link':
        // Relay fallback download link to other peer
        this.broadcast({
          type: 'fallback-link',
          fileId: data.fileId,
          downloadUrl: data.downloadUrl,
          fileName: data.fileName,
          fileIndex: data.fileIndex,
          fileCount: data.fileCount,
          from: fromSessionId
        }, fromSessionId);
        break;

      case 'url-fallback':
        // Relay URL redirect link to other peer
        this.broadcast({
          type: 'url-fallback',
          urlId: data.urlId,
          redirectUrl: data.redirectUrl,
          from: fromSessionId
        }, fromSessionId);
        break;

      case 'text-fallback':
        // Relay plain text directly to other peer (no R2 needed, text is small)
        this.broadcast({
          type: 'text-fallback',
          content: data.content,
          from: fromSessionId
        }, fromSessionId);
        break;

      case 'ping':
        // Keep-alive
        fromWs.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        console.log(`[Room] Unknown message type: ${data.type}`);
    }
  }

  sendTo(sessionId, message) {
    // Tags let us look up a specific WebSocket directly
    const [ws] = this.state.getWebSockets(sessionId);
    if (ws) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('[Room] Send error:', error);
      }
    }
  }

  broadcast(message, excludeSessionId = null) {
    const payload = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      const { sessionId } = ws.deserializeAttachment();
      if (sessionId !== excludeSessionId) {
        try {
          ws.send(payload);
        } catch (error) {
          console.error('[Room] Broadcast error:', error);
        }
      }
    }
  }

  // Called when the eviction alarm fires (5 min after last peer left)
  async alarm() {
    const peers = this.state.getWebSockets();
    if (peers.length > 0) {
      // A peer rejoined between the alarm being set and firing — nothing to do
      console.log(`[Room] Alarm fired but ${peers.length} peer(s) still present. Skipping.`);
      return;
    }
    console.log('[Room] Alarm fired: room confirmed empty. DO will evict naturally.');
  }
}

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

/**
 * Self-contained HTML help page explaining how to allow pop-ups.
 * Served at GET /help/popups — linked from the pop-up-blocked modal footer.
 */
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
    align-items: flex-start;
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

/**
 * HTML UI for SwiftDrop
 * Preserves existing design, adds WebRTC + R2 fallback logic
 */
function getHTML(env) {
  const turnstileSiteKey = env.TURNSTILE_SITE_ID || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#667eea">
  <title>SwiftDrop - P2P File Transfer</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="https://faviconser.pages.dev/swiftdrop/favicon.ico">
  <link rel="icon" type="image/png" sizes="16x16" href="https://faviconser.pages.dev/swiftdrop/favicon-16.png">
  <link rel="icon" type="image/png" sizes="32x32" href="https://faviconser.pages.dev/swiftdrop/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="https://faviconser.pages.dev/swiftdrop/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="192x192" href="https://faviconser.pages.dev/swiftdrop/icon-192.png">
  <link rel="icon" type="image/png" sizes="512x512" href="https://faviconser.pages.dev/swiftdrop/icon-512.png">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script src="https://unpkg.com/feather-icons/dist/feather.min.js"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    :root {
      --bg-gradient-start: #667eea;
      --bg-gradient-end: #764ba2;
      --container-bg: #ffffff;
      --text-primary: #333333;
      --text-secondary: #666666;
      --text-tertiary: #999999;
      --border-color: #dddddd;
      --input-bg: #ffffff;
      --status-bg: #f0f9ff;
      --status-border: #7dd3fc;
      --status-connected-bg: #f0fdf4;
      --status-connected-border: #86efac;
      --status-relay-bg: #dbeafe;
      --status-relay-border: #3b82f6;
      --status-connecting-bg: #fef3c7;
      --status-connecting-border: #fbbf24;
      --upload-area-hover: #f8f9ff;
      --file-info-bg: #f9fafb;
      --shadow-color: rgba(0, 0, 0, 0.3);
    }

    body.dark-mode {
      --bg-gradient-start: #1e1b4b;
      --bg-gradient-end: #312e81;
      --container-bg: #1f2937;
      --text-primary: #f3f4f6;
      --text-secondary: #d1d5db;
      --text-tertiary: #9ca3af;
      --border-color: #374151;
      --input-bg: #111827;
      --status-bg: #1e3a5f;
      --status-border: #3b82f6;
      --status-connected-bg: #1e4d2b;
      --status-connected-border: #22c55e;
      --status-relay-bg: #1e3a5f;
      --status-relay-border: #60a5fa;
      --status-connecting-bg: #422006;
      --status-connecting-border: #fbbf24;
      --upload-area-hover: #374151;
      --file-info-bg: #374151;
      --shadow-color: rgba(0, 0, 0, 0.6);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      transition: background 0.3s ease;
    }

    .container {
      background: var(--container-bg);
      border-radius: 16px;
      box-shadow: 0 20px 60px var(--shadow-color);
      padding: 40px;
      max-width: 500px;
      width: 100%;
      position: relative;
      transition: background 0.3s ease, box-shadow 0.3s ease;
    }
    
    h1 {
      color: var(--text-primary);
      margin-bottom: 10px;
      font-size: 28px;
      transition: color 0.3s ease;
    }

    .subtitle {
      color: var(--text-secondary);
      margin-bottom: 30px;
      font-size: 14px;
      transition: color 0.3s ease;
    }

    .toolbar {
      position: absolute;
      top: 20px;
      right: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .dark-mode-toggle {
      background: var(--border-color);
      border: none;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }

    .dark-mode-toggle:hover {
      transform: scale(1.1);
    }

    .dark-mode-toggle {
      color: var(--text-secondary);
    }

    .dark-mode-toggle svg {
      width: 20px;
      height: 20px;
      stroke: currentColor;
    }

    .github-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--border-color);
      color: var(--text-primary);
      transition: all 0.3s ease;
      text-decoration: none;
    }

    .github-link:hover {
      transform: scale(1.1);
    }

    .github-link svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    .status {
      background: var(--status-bg);
      border: 2px solid var(--status-border);
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
      text-align: center;
      transition: background 0.3s ease, border-color 0.3s ease;
    }

    .status.connected {
      background: var(--status-connected-bg);
      border-color: var(--status-connected-border);
    }

    .status.relay {
      background: var(--status-relay-bg);
      border-color: var(--status-relay-border);
    }

    .status.connecting {
      background: var(--status-connecting-bg);
      border-color: var(--status-connecting-border);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 16px;
      font-size: 13px;
      font-weight: 600;
      margin-top: 10px;
    }

    .status-badge.badge-waiting {
      background: #f3f4f6;
      color: #6b7280;
    }

    .status-badge.badge-connecting {
      background: #fef3c7;
      color: #f59e0b;
    }

    .status-badge.badge-p2p {
      background: #d1fae5;
      color: #059669;
    }

    .status-badge.badge-relay {
      background: #dbeafe;
      color: #3b82f6;
    }
    
    .room-code {
      font-size: 32px;
      font-weight: bold;
      font-family: monospace;
      letter-spacing: 4px;
      color: #0369a1;
      margin: 10px 0;
    }
    
    .room-code.connected {
      color: #166534;
    }

    body.dark-mode .room-code {
      color: #60a5fa;
    }

    body.dark-mode .room-code.connected {
      color: #4ade80;
    }

    body.dark-mode .status.clickable:hover .room-code {
      color: #0369a1;
    }

    .peer-info {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 8px;
      transition: color 0.3s ease;
    }

    .role-selector {
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
    }

    .role-btn {
      flex: 1;
      padding: 14px 12px;
      border: 2px solid var(--border-color);
      background: var(--container-bg);
      border-radius: 10px;
      cursor: pointer;
      font-weight: 700;
      font-size: 16px;
      color: var(--text-primary);
      transition: all 0.2s;
    }

    .role-btn.active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-color: #667eea;
    }

    .role-hint {
      text-align: center;
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 14px;
    }

    .send-type-selector {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .send-type-btn {
      flex: 1;
      padding: 8px 10px;
      border: 1.5px solid var(--border-color);
      background: var(--container-bg);
      border-radius: 7px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      color: var(--text-secondary);
      transition: all 0.2s;
    }

    .send-type-btn.active {
      background: rgba(102, 126, 234, 0.12);
      color: #667eea;
      border-color: #667eea;
    }
    
    .section {
      display: none;
    }
    
    .section.active {
      display: block;
    }
    
    input[type="text"], input[type="url"] {
      width: 100%;
      padding: 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      font-size: 16px;
      font-family: monospace;
      text-transform: uppercase;
      letter-spacing: 2px;
      text-align: center;
      margin-bottom: 15px;
      background: var(--input-bg);
      color: var(--text-primary);
      transition: all 0.3s ease;
    }

    input[type="text"]:focus, input[type="url"]:focus {
      outline: none;
      border-color: #667eea;
    }

    textarea.text-input {
      width: 100%;
      padding: 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      font-size: 14px;
      font-family: monospace;
      resize: vertical;
      background: var(--input-bg);
      color: var(--text-primary);
      box-sizing: border-box;
      transition: all 0.3s ease;
      min-height: 120px;
    }

    textarea.text-input:focus {
      outline: none;
      border-color: #667eea;
    }

    .text-receive-area {
      background: #f0fdf4;
      border: 2px solid #86efac;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
      text-align: center;
    }

    body.dark-mode .text-receive-area {
      background: #052e16;
      border-color: #166534;
    }

    .upload-area {
      border: 3px dashed var(--border-color);
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 15px;
      color: var(--text-primary);
    }

    .upload-area:hover {
      border-color: #667eea;
      background: var(--upload-area-hover);
    }
    
    .upload-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
    
    input[type="file"] {
      display: none;
    }
    
    .btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 14px 32px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.2s;
    }

    .btn:hover:not(:disabled) {
      transform: translateY(-2px);
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Button state variations */
    .btn-waiting:disabled {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      opacity: 0.5;
      cursor: not-allowed;
      animation: pulse-waiting 2s ease-in-out infinite;
    }

    @keyframes pulse-waiting {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }

    .btn-gray {
      background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
      opacity: 0.7;
    }

    .btn-gray:hover {
      opacity: 0.85;
      transform: translateY(-1px);
    }

    .btn-active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }

    .btn-blue {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    }
    
    .progress {
      margin: 20px 0;
      display: none;
    }
    
    .progress-bar {
      height: 8px;
      background: #eee;
      border-radius: 4px;
      overflow: hidden;
    }
    
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      width: 0%;
      transition: width 0.3s;
    }
    
    .progress-text {
      text-align: center;
      margin-top: 8px;
      color: #666;
      font-size: 14px;
    }
    
    .file-info {
      background: var(--file-info-bg);
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      display: none;
      transition: background 0.3s ease;
    }

    .file-name {
      font-weight: 600;
      color: var(--text-primary);
      word-break: break-all;
      margin-bottom: 5px;
      transition: color 0.3s ease;
    }

    .file-size {
      color: var(--text-secondary);
      font-size: 14px;
      transition: color 0.3s ease;
    }

    .file-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 180px;
      overflow-y: auto;
    }

    .file-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--container-bg);
      border-radius: 6px;
      border: 1px solid var(--border-color);
      transition: background 0.3s ease, border-color 0.3s ease;
    }

    .file-row-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.3s ease;
    }

    .file-row-size {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
      transition: color 0.3s ease;
    }

    .file-row-remove {
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 2px;
      border-radius: 4px;
      transition: color 0.2s;
    }

    .file-row-remove:hover {
      color: #ef4444;
    }

    .download-area {
      background: #f0fdf4;
      border: 2px solid #86efac;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
      display: none;
      text-align: center;
    }
    
    .download-btn {
      background: #22c55e;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
      margin-top: 10px;
      font-weight: 600;
    }
    
    .error {
      background: #fef2f2;
      border: 2px solid #fca5a5;
      color: #991b1b;
      padding: 15px;
      border-radius: 8px;
      margin-top: 20px;
      display: none;
    }
    
    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      background: white;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: none;
      z-index: 1000;
      max-width: 300px;
    }
    
    .toast.show {
      display: block;
      animation: slideIn 0.3s ease-out;
    }
    
    @keyframes slideIn {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    /* Clickable status container (sender only) */
    .status.clickable {
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }

    .status.clickable:hover {
      background: #f8faff;
      border-color: #667eea;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
    }

    .status.clickable::after {
      content: '👆 Click for QR code';
      position: absolute;
      bottom: -25px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 11px;
      color: #9ca3af;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
      white-space: nowrap;
    }

    .status.clickable:hover::after {
      opacity: 1;
    }

    /* QR Modal */
    .qr-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      z-index: 2000;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    }

    .qr-modal.show {
      display: flex;
    }

    .qr-modal-content {
      background: var(--container-bg);
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 90%;
      position: relative;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalSlideIn 0.3s ease-out;
      transition: background 0.3s ease;
    }

    @keyframes modalSlideIn {
      from {
        transform: scale(0.9);
        opacity: 0;
      }
      to {
        transform: scale(1);
        opacity: 1;
      }
    }

    .qr-modal-close {
      position: absolute;
      top: 15px;
      right: 15px;
      background: var(--file-info-bg);
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .qr-modal-close:hover {
      background: var(--border-color);
      color: var(--text-primary);
    }

    .qr-modal-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 20px;
      text-align: center;
      transition: color 0.3s ease;
    }

    .qr-modal-room-code {
      font-size: 36px;
      font-weight: bold;
      font-family: monospace;
      letter-spacing: 6px;
      color: #667eea;
      text-align: center;
      margin-bottom: 25px;
    }

    .qr-modal-qr {
      display: flex;
      justify-content: center;
      margin-bottom: 20px;
    }

    #qrcode {
      display: inline-block;
      padding: 15px;
      background: white;
      border: 2px solid #e5e7eb;
      border-radius: 12px;
    }

    .qr-modal-instructions {
      text-align: center;
      color: var(--text-secondary);
      font-size: 14px;
      transition: color 0.3s ease;
    }

    /* Settings Button */
    .settings-btn {
      background: var(--border-color);
      border: none;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      color: var(--text-secondary);
    }

    .settings-btn:hover {
      transform: scale(1.1);
    }

    .settings-btn svg {
      width: 20px;
      height: 20px;
      stroke: currentColor;
    }

    /* Settings Modal */
    .settings-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      z-index: 2000;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    }

    .settings-modal.show {
      display: flex;
    }

    .settings-modal-content {
      background: var(--container-bg);
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 90%;
      position: relative;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalSlideIn 0.3s ease-out;
      transition: background 0.3s ease;
    }

    .settings-modal-close {
      position: absolute;
      top: 15px;
      right: 15px;
      background: var(--file-info-bg);
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .settings-modal-close:hover {
      background: var(--border-color);
      color: var(--text-primary);
    }

    .settings-modal-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 24px;
      transition: color 0.3s ease;
    }

    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 0;
      border-bottom: 1px solid var(--border-color);
      gap: 16px;
    }

    .settings-row:last-child {
      border-bottom: none;
    }

    .settings-label {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .settings-label span:first-child {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      transition: color 0.3s ease;
    }

    .settings-desc {
      font-size: 12px;
      color: var(--text-secondary);
      transition: color 0.3s ease;
    }

    .settings-github-row {
      justify-content: flex-start;
      display: none;
    }

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
      cursor: pointer;
      border-bottom: 1px dashed var(--border-color);
    }
    .nearby-identity-name:hover { border-bottom-color: var(--text-secondary); }
    .nearby-identity-input {
      font-weight: 600;
      font-size: 13px;
      border: none;
      border-bottom: 2px solid #667eea;
      background: transparent;
      color: var(--text-primary);
      outline: none;
      width: 140px;
      padding: 0;
      margin: 0;
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
      color: var(--text-primary);
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

    @media (max-width: 400px) {
      .settings-github-row { display: flex; }
    }

    .settings-github-link {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 14px;
      transition: color 0.2s ease;
    }

    .settings-github-link:hover {
      color: var(--text-primary);
    }

    .settings-toggle {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }

    .settings-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .settings-toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--border-color);
      border-radius: 24px;
      transition: 0.2s;
    }

    .settings-toggle-slider::before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: 0.2s;
    }

    .settings-toggle input:checked + .settings-toggle-slider {
      background: #667eea;
    }

    .settings-toggle input:checked + .settings-toggle-slider::before {
      transform: translateX(20px);
    }

    /* Paste Button */
    .paste-btn {
      background: var(--file-info-bg);
      color: #667eea;
      border: 2px solid #667eea;
      padding: 12px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      transition: all 0.3s ease;
    }

    .paste-btn:hover {
      background: #667eea;
      color: white;
    }

    /* Cookie Consent Banner */
    .cookie-banner {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--container-bg);
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      padding: 20px 24px;
      max-width: 320px;
      width: calc(100% - 40px);
      z-index: 3000;
      display: none;
      border: 2px solid var(--border-color);
      transition: background 0.3s ease, border-color 0.3s ease;
    }

    .cookie-banner.show {
      display: block;
      animation: slideUp 0.3s ease-out;
    }

    @keyframes slideUp {
      from {
        transform: translateY(100px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .cookie-banner-content {
      display: flex;
      align-items: flex-start;
      gap: 15px;
    }

    .cookie-banner-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .cookie-banner-text {
      flex: 1;
    }

    .cookie-banner-title {
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 5px;
      font-size: 15px;
    }

    .cookie-banner-message {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.5;
    }

    .cookie-banner-close {
      background: #667eea;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 12px;
    }

    .cookie-banner-close:hover {
      background: #5568d3;
      transform: translateY(-1px);
    }

    /* Receive success panel */
    .receive-success {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 20px 0;
      gap: 12px;
    }

    .receive-success.active {
      display: flex;
    }

    .success-icon {
      font-size: 64px;
      line-height: 1;
    }

    .success-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .success-meta {
      font-size: 14px;
      color: var(--text-secondary);
      word-break: break-all;
    }

    .success-textarea {
      width: 100%;
      padding: 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      font-size: 14px;
      font-family: monospace;
      resize: vertical;
      background: var(--input-bg);
      color: var(--text-primary);
      box-sizing: border-box;
      min-height: 120px;
      text-align: left;
    }

    .success-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }

    #successFileActions {
      max-height: 260px;
      overflow-y: auto;
    }

    .btn-reset {
      background: none;
      border: 2px solid var(--border-color);
      color: var(--text-secondary);
      padding: 10px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.2s;
    }

    .btn-reset:hover {
      border-color: #667eea;
      color: #667eea;
    }

    /* TeleHost promo */
    .telehost-promo {
      display: none;
      margin-top: 16px;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--file-info-bg);
      border: 1px solid var(--border-color);
      text-align: center;
      font-size: 13px;
      color: var(--text-secondary);
      transition: background 0.3s ease, border-color 0.3s ease;
    }

    .telehost-promo a {
      color: #667eea;
      font-weight: 600;
      text-decoration: none;
    }

    .telehost-promo a:hover {
      text-decoration: underline;
    }

    /* Full-page drag overlay */
    #dragOverlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(15, 10, 40, 0.88);
      backdrop-filter: blur(3px);
      border: 4px dashed rgba(167, 139, 250, 0.7);
      pointer-events: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }
    #dragOverlay.active {
      display: flex;
      pointer-events: all;
    }
    #dragOverlay .drag-overlay-icon {
      font-size: 64px;
      line-height: 1;
    }
    #dragOverlay .drag-overlay-text {
      font-size: 24px;
      font-weight: 700;
      color: #ffffff;
    }
    #dragOverlay .drag-overlay-sub {
      font-size: 14px;
      color: #c4b5fd;
    }

    /* Inline QR wrapper and receive state — always hidden on mobile */
    .qr-inline-wrapper, .left-receive-state { display: none; }

    /* ── Desktop two-column layout ── */
    @media (min-width: 768px) {
      .container {
        max-width: 920px;
        padding: 0;
        display: grid;
        grid-template-columns: 300px 1fr;
        overflow: hidden;
        align-items: stretch;
      }

      .left-panel {
        padding: 10px 28px;
        border-right: 1px solid var(--border-color);
        background: linear-gradient(160deg, rgba(102,126,234,0.07) 0%, rgba(118,75,162,0.04) 100%);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        transition: background 0.3s ease, border-color 0.3s ease;
      }

      body.dark-mode .left-panel {
        background: linear-gradient(160deg, rgba(102,126,234,0.12) 0%, rgba(118,75,162,0.08) 100%);
      }

      .left-panel h1 {
        font-size: 26px;
        margin-top: 10px;
        margin-bottom: 8px;
      }

      .left-panel .subtitle {
        font-size: 12px;
        margin-bottom: 28px;
      }

      .left-panel .status {
        width: 100%;
        margin-bottom: 0;
        margin-top: 28px;
      }

      .left-panel .room-code {
        font-size: 38px;
        letter-spacing: 6px;
      }

      .qr-inline-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
        margin-top: 20px;
        gap: 14px;
      }

      #qrInlineCode {
        padding: 12px;
        background: white;
        border-radius: 12px;
        border: 2px solid var(--border-color);
        display: inline-block;
        line-height: 0;
      }

      .qr-inline-wrapper {
        position: relative;
        cursor: pointer;
        margin-top: 16px;
      }

      .qr-inline-wrapper::after {
        content: '👆 Click to copy link';
        position: absolute;
        bottom: -22px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 11px;
        color: #9ca3af;
        opacity: 0;
        transition: opacity 0.2s;
        pointer-events: none;
        white-space: nowrap;
      }

      .qr-inline-wrapper:hover::after {
        opacity: 1;
      }

      .left-receive-state {
        margin-top: auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        text-align: center;
        padding: 24px 0;
      }

      .left-receive-icon {
        font-size: 56px;
        line-height: 1;
      }

      .left-receive-title {
        font-size: 18px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .left-receive-sub {
        font-size: 13px;
        color: var(--text-secondary);
        line-height: 1.5;
      }

      .right-panel {
        padding: 20px 32px 40px;
        min-height: 500px;
      }

      .right-panel .upload-area {
        padding: 60px 20px;
      }

      .right-panel .upload-icon {
        font-size: 64px;
      }

      #roomInput {
        font-size: 28px;
        padding: 16px;
        letter-spacing: 8px;
        border-width: 2.5px;
      }

      #roomInput:focus {
        border-color: #667eea;
        box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
      }

      .toolbar {
        position: static;
        margin-top: 24px;
        align-self: center;
      }

    }

    @media (max-width: 400px) {
      .github-link { display: none; }
    }
  </style>
</head>
<body>
  <!-- Full-page drag overlay -->
  <div id="dragOverlay">
    <div class="drag-overlay-icon">📁</div>
    <div class="drag-overlay-text">Drop your file anywhere!</div>
    <div class="drag-overlay-sub">Release to select this file</div>
  </div>

  <div class="container">
    <div class="left-panel">
      <h1>🚀 SwiftDrop</h1>
      <p class="subtitle">Instant P2P file transfer • Files auto-delete after download</p>

      <div class="status" id="status">
        <div id="statusText">Generating room code...</div>
        <div class="room-code" id="roomCode">------</div>
        <div class="status-badge badge-waiting" id="statusBadge">
          <span class="status-icon">⏳</span>
          <span class="status-text">Waiting for peer...</span>
        </div>
      </div>

      <!-- Inline QR + copy link (desktop sender only) -->
      <div class="qr-inline-wrapper" id="qrInlineWrapper" style="display:none;">
        <div id="qrInlineCode"></div>
      </div>

      <!-- Receive mode state (desktop only) -->
      <div class="left-receive-state" id="leftReceiveState" style="display:none;">
        <div class="left-receive-icon">📡</div>
        <div class="left-receive-title">Ready to Receive</div>
        <div class="left-receive-sub">Enter the code from the sender's screen</div>
      </div>

      <div class="toolbar">
        <a class="github-link" href="https://github.com/codecrumb/SwiftDrop" target="_blank" rel="noopener" title="View on GitHub">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        </a>
        <button class="settings-btn" id="settingsBtn" title="Settings"><i data-feather="settings"></i></button>
        <button class="dark-mode-toggle" id="darkModeToggle" title="Toggle dark mode"><i data-feather="moon"></i></button>
      </div>
    </div>

    <div class="right-panel">
    <div class="role-selector">
      <button class="role-btn active" id="sendRoleBtn">📤 Send</button>
      <button class="role-btn nearby-tab-btn" id="nearbyRoleBtn" style="display:none;">📡 Nearby</button>
      <button class="role-btn" id="receiveRoleBtn">📥 Receive</button>
    </div>
    <p class="role-hint" id="roleHint">Share your room code with the other device</p>
    <div class="send-type-selector" id="sendTypeSelector">
      <button class="send-type-btn active" id="sendModeBtn">📁 File</button>
      <button class="send-type-btn" id="urlModeBtn">🔗 URL</button>
      <button class="send-type-btn" id="textModeBtn">📋 Text</button>
    </div>
    
    <!-- Send Mode -->
    <div class="section active" id="sendSection">
      <div class="upload-area" id="uploadArea">
        <div class="upload-icon">📁</div>
        <p><strong>Click or drag to select files</strong></p>
        <p style="font-size: 12px; color: #999; margin-top: 5px;">Direct P2P transfer</p>
      </div>
      <input type="file" id="fileInput" multiple>
      
      <div class="file-info" id="fileInfo">
        <div class="file-list" id="fileList"></div>
        <div class="file-name" id="fileName" style="display:none;"></div>
        <div class="file-size" id="fileSize" style="display:none;"></div>
      </div>
      
      <button class="btn btn-waiting" id="sendBtn" disabled>Waiting for receiver...</button>
    </div>
    
    <!-- URL Mode -->
    <div class="section" id="urlSection">
      <p style="margin-bottom: 10px; color: #666; font-size: 14px;">Enter URL to share:</p>
      <div style="display: flex; gap: 8px; margin-bottom: 15px;">
        <input type="url" id="urlInput" placeholder="https://example.com" inputmode="url"
               style="flex: 1; text-transform: none; letter-spacing: normal; margin-bottom: 0;">
        <button id="pasteUrlBtn" class="paste-btn">
          📋 Paste
        </button>
      </div>
      <button class="btn btn-waiting" id="sendUrlBtn" disabled>Waiting for receiver...</button>
      <p style="margin-top: 10px; font-size: 12px; color: #999; text-align: center;">
        Receiver will be redirected to this URL
      </p>
    </div>
    
    <!-- Text Mode -->
    <div class="section" id="textSection">
      <p style="margin-bottom: 10px; color: var(--text-secondary); font-size: 14px;">Paste or type text to share:</p>
      <textarea class="text-input" id="textInput" placeholder="Paste your text here (env vars, snippets, notes...)"></textarea>
      <div style="display: flex; gap: 8px; margin-top: 8px;">
        <button id="pasteTextBtn" class="paste-btn" style="flex: 1;">📋 Paste</button>
        <button id="clearTextBtn" class="paste-btn" style="flex: 1;">✕ Clear</button>
      </div>
      <button class="btn btn-waiting" id="sendTextBtn" disabled style="margin-top: 10px;">Waiting for receiver...</button>
    </div>

    <!-- Nearby Mode -->
    <div class="section" id="nearbySection">
      <div class="nearby-identity-row">
        <span class="nearby-identity-label">You appear as:</span>
        <span class="nearby-identity-name" id="nearbyIdentityName" title="Tap to rename"></span>
        <input type="text" id="nearbyIdentityInput" class="nearby-identity-input" maxlength="30" style="display:none;">
      </div>
      <div class="nearby-peer-list" id="nearbyPeerList">
        <div class="nearby-empty" id="nearbyEmpty">
          <div style="font-size:32px; margin-bottom:8px;">📡</div>
          <div style="font-weight:600; margin-bottom:4px;">Looking for devices…</div>
          <div style="font-size:13px; color:var(--text-secondary);">Other devices on this network will appear here</div>
        </div>
      </div>
    </div>

    <!-- Receive Mode -->
    <div class="section" id="receiveSection">
      <div id="receiveJoinForm">
        <p style="margin-bottom: 10px; color: #666; font-size: 14px;">Enter the 6-digit code from sender:</p>
        <input type="text" id="roomInput" placeholder="123456" maxlength="6" inputmode="numeric" pattern="[0-9]*">
        <button class="btn" id="joinBtn">Join Room</button>
      </div>
      <div id="receiveJoinedState" style="display:none; text-align:center; padding: 12px 0;">
        <div style="font-size: 28px; margin-bottom: 8px;">📡</div>
        <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">Connected to room <span id="receiveJoinedCode"></span></div>
        <div style="font-size: 13px; color: #888;">Waiting for sender to transfer files…</div>
        <button id="changeRoomBtn" style="margin-top: 10px; background: none; border: none; color: #888; font-size: 12px; cursor: pointer; text-decoration: underline; padding: 0;">Wrong room? Change</button>
      </div>
    </div>
    
    <div class="progress" id="progress">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <div class="progress-text" id="progressText">Transferring...</div>
    </div>
    
    <!-- Receive success panel (replaces right panel on transfer complete) -->
    <div class="receive-success" id="receiveSuccessPanel">
      <div class="success-icon" id="successIcon">📦</div>
      <div class="success-title" id="successTitle">File Ready!</div>
      <div class="success-meta" id="successMeta"></div>
      <!-- File: download button(s) — populated dynamically -->
      <div class="success-actions" id="successFileActions" style="display:none;"></div>
      <!-- Text: textarea + copy -->
      <div class="success-actions" id="successTextActions" style="display:none;">
        <textarea class="success-textarea" id="successTextDisplay" readonly></textarea>
        <button class="btn" id="successCopyBtn">📋 Copy to Clipboard</button>
      </div>
      <div class="telehost-promo" id="telehostPromo" style="width:100%;">
        Need permanent file hosting? Try <a href="https://telehost.pages.dev" target="_blank" rel="noopener">TeleHost</a> — free &amp; forever.
      </div>
      <button class="btn-reset" id="successResetBtn">↩ Transfer Another</button>
    </div>

    <div class="error" id="error"></div>
    </div><!-- /right-panel -->
  </div>

  <div class="toast" id="toast"></div>

  <div class="popup-overlay" id="popupOverlay"></div>
  <div class="popup-modal" id="popupModal" role="dialog" aria-modal="true" aria-labelledby="popupModalTitle">
    <div class="popup-modal-header">
      <div class="popup-modal-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="10.29 3.86 1.82 18 22.18 18 13.71 3.86 10.29 3.86"></polygon>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      </div>
      <h2 class="popup-modal-title" id="popupModalTitle">Pop-up blocked</h2>
    </div>
    <p class="popup-modal-body">Your browser blocked a new tab from opening. Click <strong>Retry</strong> to open it.</p>
    <div class="popup-modal-actions">
      <button class="popup-modal-retry" id="popupRetry">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
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

  <!-- Turnstile Widget (invisible, for cloud uploads only) -->
  <div class="cf-turnstile"
       id="turnstileWidget"
       data-sitekey="${turnstileSiteKey}"
       data-theme="light"
       data-size="invisible"
       data-callback="onTurnstileSuccess"
       style="display:none;">
  </div>

  <!-- Settings Modal -->
  <div class="settings-modal" id="settingsModal">
    <div class="settings-modal-content">
      <button class="settings-modal-close" id="settingsModalClose">✕</button>
      <div class="settings-modal-title">Settings</div>
      <div class="settings-row">
        <div class="settings-label">
          <span>Auto-copy text</span>
          <span class="settings-desc">Automatically copy received text to clipboard</span>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="autoCopyToggle">
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span>Auto-download files</span>
          <span class="settings-desc">Automatically download files when received</span>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="autoDownloadToggle">
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span>Auto-join on code entry</span>
          <span class="settings-desc">Automatically join when the 6th digit is typed (no need to tap Join)</span>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="autoJoinToggle">
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span>Keep screen awake during transfers</span>
          <span class="settings-desc">Prevent the screen from dimming while a file transfer is in progress</span>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="keepScreenAwakeToggle">
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
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
      <div class="settings-row settings-github-row">
        <a href="https://github.com/codecrumb/SwiftDrop" target="_blank" rel="noopener" class="settings-github-link">
          <svg viewBox="0 0 16 16" aria-hidden="true" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          View on GitHub
        </a>
      </div>
    </div>
  </div>

  <!-- QR Code Modal -->
  <div class="qr-modal" id="qrModal">
    <div class="qr-modal-content">
      <button class="qr-modal-close" id="qrModalClose">✕</button>
      <div class="qr-modal-title">Join this room</div>
      <div class="qr-modal-room-code" id="modalRoomCode">------</div>
      <div class="qr-modal-qr">
        <div id="qrcode"></div>
      </div>
      <div class="qr-modal-instructions">Scan to join instantly</div>
    </div>
  </div>

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

  <!-- Cookie Consent Banner -->
  <div class="cookie-banner" id="cookieBanner">
    <div class="cookie-banner-content">
      <div class="cookie-banner-icon">🍪</div>
      <div class="cookie-banner-text">
        <div class="cookie-banner-title">Cookie Notice</div>
        <div class="cookie-banner-message">
          We use cookies for Turnstile verification to protect against bots. By continuing to use SwiftDrop, you accept our use of cookies.
        </div>
        <button class="cookie-banner-close" id="cookieBannerClose">Got it!</button>
      </div>
    </div>
  </div>

  <script>
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
      return \`\${adj} \${animal}\`;
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

    // Dark Mode
    const darkModeToggle = document.getElementById('darkModeToggle');
    const savedTheme = localStorage.getItem('theme');

    function setThemeIcon(isDark) {
      darkModeToggle.innerHTML = \`<i data-feather="\${isDark ? 'sun' : 'moon'}"></i>\`;
      feather.replace();
    }

    // Apply saved theme or default to light mode
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    }

    // Render initial icon after feather is ready
    window.addEventListener('load', () => {
      feather.replace();
      setThemeIcon(document.body.classList.contains('dark-mode'));
    });

    // Toggle dark mode
    darkModeToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark-mode');
      const isDark = document.body.classList.contains('dark-mode');
      setThemeIcon(isDark);
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });

    // Settings Modal
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const settingsModalClose = document.getElementById('settingsModalClose');
    const autoCopyToggle = document.getElementById('autoCopyToggle');
    const autoDownloadToggle = document.getElementById('autoDownloadToggle');
    const autoJoinToggle = document.getElementById('autoJoinToggle');
    const keepScreenAwakeToggle = document.getElementById('keepScreenAwakeToggle');

    // Load saved settings (auto-copy default on, auto-download default off, auto-join default on, keep awake default on)
    autoCopyToggle.checked = localStorage.getItem('autoCopyText') !== 'false';
    autoDownloadToggle.checked = localStorage.getItem('autoDownloadFiles') === 'true';
    autoJoinToggle.checked = localStorage.getItem('autoJoinRoom') !== 'false';
    keepScreenAwakeToggle.checked = localStorage.getItem('keepScreenAwake') !== 'false';

    autoCopyToggle.addEventListener('change', () => {
      localStorage.setItem('autoCopyText', autoCopyToggle.checked ? 'true' : 'false');
    });

    autoDownloadToggle.addEventListener('change', () => {
      localStorage.setItem('autoDownloadFiles', autoDownloadToggle.checked ? 'true' : 'false');
    });

    autoJoinToggle.addEventListener('change', () => {
      localStorage.setItem('autoJoinRoom', autoJoinToggle.checked ? 'true' : 'false');
    });

    keepScreenAwakeToggle.addEventListener('change', () => {
      localStorage.setItem('keepScreenAwake', keepScreenAwakeToggle.checked ? 'true' : 'false');
      if (!keepScreenAwakeToggle.checked) releaseWakeLock();
    });

    function openSettingsModal() {
      settingsModal.classList.add('show');
      document.body.style.overflow = 'hidden';
    }

    function closeSettingsModal() {
      settingsModal.classList.remove('show');
      document.body.style.overflow = '';
    }

    settingsBtn.addEventListener('click', openSettingsModal);
    settingsModalClose.addEventListener('click', closeSettingsModal);
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });

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

    // Wake Lock — prevents screen from dimming during active transfers
    let wakeLock = null;

    async function acquireWakeLock() {
      if (!('wakeLock' in navigator)) return;
      if (localStorage.getItem('keepScreenAwake') === 'false') return;
      if (wakeLock) return; // already held
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (e) {
        console.warn('Wake lock request failed:', e);
      }
    }

    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
      }
    }

    let transferInProgress = false;

    window.addEventListener('beforeunload', (e) => {
      if (transferInProgress) {
        e.preventDefault();
      }
    });

    // Configuration
    const CONFIG = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      p2pTimeout: 10000, // 10 seconds to establish P2P
      chunkSize: 16384, // 16KB chunks
      maxFileSize: 20 * 1024 * 1024 // 20MB limit for R2 fallback
    };

    // Fetch TURN credentials from worker (secret never touches client source)
    fetch('/api/turn-credentials')
      .then(r => r.json())
      .then(turnServers => {
        if (Array.isArray(turnServers) && turnServers.length > 0) {
          CONFIG.iceServers = CONFIG.iceServers.concat(turnServers);
        }
      })
      .catch(() => {}); // silently ignore — STUN-only fallback still works
    
    // State
    let ws = null;
    let pc = null;
    let dataChannel = null;
    let sessionId = null;
    let roomCode = null;
    let isSender = true;
    let selectedFiles = [];        // Array<File>
    let receivedFiles = [];        // {fileName, url}[] collected across a batch
    let pendingFileCount = 0;      // total files expected in current batch
    let receivedFileCount = 0;     // files completed so far in current batch
    let receivedChunks = [];
    let receivedSize = 0;
    let totalSize = 0;
    let fileName = '';
    let p2pTimeout = null;
    let isP2PConnected = false;
    let turnstileToken = null;
    let wsReconnectAttempts = 0;
    let wsReconnectTimeout = null;
    let isIntentionalClose = false;
    let pingInterval = null;

    // Elements
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const roomCodeEl = document.getElementById('roomCode');
    const statusBadge = document.getElementById('statusBadge');
    const qrModal = document.getElementById('qrModal');
    const qrModalClose = document.getElementById('qrModalClose');
    const modalRoomCode = document.getElementById('modalRoomCode');
    const qrcodeDiv = document.getElementById('qrcode');
    const qrInlineWrapper = document.getElementById('qrInlineWrapper');
    const qrInlineCodeEl = document.getElementById('qrInlineCode');
    const leftReceiveState = document.getElementById('leftReceiveState');
    const cookieBanner = document.getElementById('cookieBanner');
    const cookieBannerClose = document.getElementById('cookieBannerClose');
    const sendRoleBtn = document.getElementById('sendRoleBtn');
    const receiveRoleBtn = document.getElementById('receiveRoleBtn');
    const roleHint = document.getElementById('roleHint');
    const sendTypeSelector = document.getElementById('sendTypeSelector');
    const sendModeBtn = document.getElementById('sendModeBtn');
    const urlModeBtn = document.getElementById('urlModeBtn');
    const textModeBtn = document.getElementById('textModeBtn');
    const sendSection = document.getElementById('sendSection');
    const urlSection = document.getElementById('urlSection');
    const textSection = document.getElementById('textSection');
    const receiveSection = document.getElementById('receiveSection');
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileList = document.getElementById('fileList');
    const fileNameEl = document.getElementById('fileName');
    const fileSizeEl = document.getElementById('fileSize');
    const sendBtn = document.getElementById('sendBtn');
    const urlInput = document.getElementById('urlInput');
    const pasteUrlBtn = document.getElementById('pasteUrlBtn');
    const sendUrlBtn = document.getElementById('sendUrlBtn');
    const textInput = document.getElementById('textInput');
    const pasteTextBtn = document.getElementById('pasteTextBtn');
    const clearTextBtn = document.getElementById('clearTextBtn');
    const sendTextBtn = document.getElementById('sendTextBtn');
    const roomInput = document.getElementById('roomInput');
    const joinBtn = document.getElementById('joinBtn');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const errorDiv = document.getElementById('error');
    const toast = document.getElementById('toast');
    const telehostPromo = document.getElementById('telehostPromo');
    const receiveSuccessPanel = document.getElementById('receiveSuccessPanel');
    const successIcon = document.getElementById('successIcon');
    const successTitle = document.getElementById('successTitle');
    const successMeta = document.getElementById('successMeta');
    const successFileActions = document.getElementById('successFileActions');
    const successTextActions = document.getElementById('successTextActions');
    const successTextDisplay = document.getElementById('successTextDisplay');
    const successCopyBtn = document.getElementById('successCopyBtn');
    const successResetBtn = document.getElementById('successResetBtn');
    
    const receiveJoinForm = document.getElementById('receiveJoinForm');
    const receiveJoinedState = document.getElementById('receiveJoinedState');
    const receiveJoinedCode = document.getElementById('receiveJoinedCode');
    const changeRoomBtn = document.getElementById('changeRoomBtn');

    changeRoomBtn.addEventListener('click', () => {
      // Disconnect from current room
      if (ws) {
        isIntentionalClose = true;
        ws.close();
        isIntentionalClose = false;
        ws = null;
      }
      roomCode = null;
      // Pre-fill the input with the current code so they can edit it
      roomInput.value = receiveJoinedCode.textContent;
      // Show the join form again
      receiveJoinedState.style.display = 'none';
      receiveJoinForm.style.display = '';
      roomInput.focus();
      roomInput.select();
    });

    // Render the selected files list with individual remove buttons
    function renderFileList() {
      fileList.innerHTML = '';
      if (selectedFiles.length === 0) {
        fileInfo.style.display = 'none';
        return;
      }
      selectedFiles.forEach((file, i) => {
        const row = document.createElement('div');
        row.className = 'file-row';
        row.innerHTML = \`<span class="file-row-name" title="\${file.name}">\${file.name}</span><span class="file-row-size">\${formatFileSize(file.size)}</span><button class="file-row-remove" data-index="\${i}" title="Remove">×</button>\`;
        fileList.appendChild(row);
      });
      fileInfo.style.display = 'block';
      fileList.querySelectorAll('.file-row-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedFiles.splice(parseInt(btn.dataset.index), 1);
          const dt = new DataTransfer();
          selectedFiles.forEach(f => dt.items.add(f));
          fileInput.files = dt.files;
          if (selectedFiles.length === 0) updateSendButton('waiting');
          renderFileList();
        });
      });
    }

    // Switch to receive tab and show "joined" state (hides code entry form)
    function activateReceiveJoined(code) {
      receiveRoleBtn.click();
      receiveJoinForm.style.display = 'none';
      receiveJoinedState.style.display = '';
      receiveJoinedCode.textContent = code;
      leftReceiveState.querySelector('.left-receive-sub').textContent = 'Waiting for sender to transfer files…';
    }

    // Show receive success panel (replaces right panel content)
    function showReceiveSuccess(type, data) {
      // Hide all normal right-panel content
      document.querySelector('.role-selector').style.display = 'none';
      roleHint.style.display = 'none';
      sendTypeSelector.style.display = 'none';
      sendSection.style.display = 'none';
      urlSection.style.display = 'none';
      textSection.style.display = 'none';
      receiveSection.style.display = 'none';
      progress.style.display = 'none';

      // Reset both action blocks
      successFileActions.style.display = 'none';
      successTextActions.style.display = 'none';

      if (type === 'files') {
        const files = Array.isArray(data) ? data : [data];
        successIcon.textContent = '📦';
        successTitle.textContent = files.length === 1 ? 'File Ready!' : \`\${files.length} Files Ready!\`;
        successMeta.textContent = '';
        successFileActions.innerHTML = '';
        files.forEach(({ fileName: fn, url }) => {
          const a = document.createElement('a');
          a.href = url;
          a.download = fn;
          a.className = 'btn';
          a.textContent = \`⬇ \${fn}\`;
          successFileActions.appendChild(a);
        });
        if (files.length > 1) {
          const dlAll = document.createElement('button');
          dlAll.className = 'btn';
          dlAll.textContent = '⬇ Download All';
          dlAll.addEventListener('click', () => {
            successFileActions.querySelectorAll('a.btn').forEach(a => a.click());
          });
          successFileActions.appendChild(dlAll);
        }
        successFileActions.style.display = 'flex';
        if (localStorage.getItem('autoDownloadFiles') === 'true') {
          files.forEach(({ url, fileName: fn }) => {
            const a = document.createElement('a');
            a.href = url;
            a.download = fn;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          });
        }
      } else if (type === 'text') {
        successIcon.textContent = '📋';
        successTitle.textContent = 'Text Received!';
        successMeta.textContent = '';
        successTextDisplay.value = data.content;
        successTextActions.style.display = 'flex';
        if (localStorage.getItem('autoCopyText') !== 'false') {
          navigator.clipboard.writeText(data.content).then(() => showToast('Text copied to clipboard!'));
        }
      }

      telehostPromo.style.display = 'block';
      receiveSuccessPanel.classList.add('active');

      // Nearby: offer to trust the sender after a successful transfer
      if (nearbyLastTransferPeer) {
        nearbyOfferTrust(nearbyLastTransferPeer.deviceId, nearbyLastTransferPeer.displayName);
        nearbyLastTransferPeer = null;
      }
    }

    // Reset back to normal state
    successResetBtn.addEventListener('click', () => {
      receiveSuccessPanel.classList.remove('active');
      document.querySelector('.role-selector').style.display = '';
      roleHint.style.display = '';
      sendTypeSelector.style.display = '';
      // Clear inline styles set by showReceiveSuccess so CSS classes take over
      sendSection.style.display = '';
      urlSection.style.display = '';
      textSection.style.display = '';
      receiveSection.style.display = '';
      progress.style.display = '';
      // Reset receive section to show the join form again
      receiveJoinForm.style.display = '';
      receiveJoinedState.style.display = 'none';
      leftReceiveState.querySelector('.left-receive-sub').textContent = "Enter the code from the sender's screen";
      sendRoleBtn.click();
    });

    // Copy button in success panel
    successCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(successTextDisplay.value).then(() => {
        showToast('Copied to clipboard!');
      });
    });

    // Initialize
    init();

    // --- PWA: register service worker + handle share_target payload -----
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
          console.warn('[PWA] SW registration failed', err);
        });
      });
    }

    async function loadSharedPayload() {
      const params = new URLSearchParams(window.location.search);
      const shared = params.get('shared');
      if (!shared) return;

      // Strip the ?shared param so a manual refresh doesn't re-trigger this.
      const cleaned = window.location.pathname +
        (params.get('room') ? ('?room=' + params.get('room')) : '') +
        window.location.hash;
      history.replaceState(null, '', cleaned);

      if (shared === 'error' || shared === 'unavailable') {
        showError('Could not receive shared content. Please reload the app from your home screen and try again.');
        return;
      }
      if (!('caches' in window)) return;

      try {
        const cache = await caches.open('swiftdrop-share-v1');
        const manifestRes = await cache.match('/__shared__/manifest.json');
        if (!manifestRes) return;
        const manifest = await manifestRes.json();

        if (manifest.files && manifest.files.length > 0) {
          const loadedFiles = [];
          for (const meta of manifest.files) {
            const fileRes = await cache.match(meta.key);
            if (fileRes) {
              const blob = await fileRes.blob();
              loadedFiles.push(new File([blob], meta.name, { type: meta.type || blob.type || 'application/octet-stream' }));
            }
          }

          if (loadedFiles.length > 0) {
            sendModeBtn.click();
            selectedFiles = loadedFiles;
            try {
              const dt = new DataTransfer();
              loadedFiles.forEach(f => dt.items.add(f));
              fileInput.files = dt.files;
            } catch (_) {}

            renderFileList();

            if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
              updateSendButton('p2p');
            } else if (ws && ws.readyState === WebSocket.OPEN) {
              updateSendButton('connecting');
            } else {
              updateSendButton('waiting');
            }

            showToast(selectedFiles.length === 1
              ? ('Shared: ' + selectedFiles[0].name)
              : ('Shared ' + selectedFiles.length + ' files'));
          }
        } else if (manifest.url) {
          urlModeBtn.click();
          urlInput.value = manifest.url;
          urlInput.dispatchEvent(new Event('input'));
          showToast('Shared URL ready to send');
        } else if (manifest.text || manifest.title) {
          textModeBtn.click();
          textInput.value = [manifest.title, manifest.text].filter(Boolean).join('\\n\\n');
          textInput.dispatchEvent(new Event('input'));
          showToast('Shared text ready to send');
        }

        // Payload consumed — clear the cache so it isn't reused.
        const keys = await cache.keys();
        await Promise.all(keys.map((k) => cache.delete(k)));
      } catch (e) {
        console.error('[share] failed to load payload', e);
      }
    }
    loadSharedPayload();
    // --------------------------------------------------------------------

    // Helper function to update status badge
    function updateStatusBadge(state, message) {
      const badge = statusBadge;
      const icon = badge.querySelector('.status-icon');
      const text = badge.querySelector('.status-text');

      // Remove all badge classes
      badge.className = 'status-badge';
      status.className = 'status';

      switch(state) {
        case 'waiting':
          badge.classList.add('badge-waiting');
          icon.textContent = '⏳';
          text.textContent = message || 'Waiting for peer...';
          break;
        case 'connecting':
          badge.classList.add('badge-connecting');
          status.classList.add('connecting');
          icon.textContent = '🔄';
          text.textContent = message || 'Connecting...';
          break;
        case 'p2p':
          badge.classList.add('badge-p2p');
          status.classList.add('connected');
          roomCodeEl.classList.add('connected');
          icon.textContent = '✅';
          text.textContent = message || 'P2P Connected';
          break;
        case 'relay':
          badge.classList.add('badge-relay');
          status.classList.add('relay');
          icon.textContent = '☁️';
          text.textContent = message || 'Cloud Relay Active';
          break;
      }
    }

    // Helper function to update send button state
    function updateSendButton(state) {
      if (selectedFiles.length === 0) return;

      // Remove all button state classes
      sendBtn.className = 'btn';

      switch(state) {
        case 'waiting':
          sendBtn.classList.add('btn-waiting');
          sendBtn.disabled = true;
          sendBtn.textContent = 'Waiting for receiver...';
          break;
        case 'connecting':
          // Gray but clickable - allows skipping P2P attempt
          sendBtn.classList.add('btn-gray');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Upload via Cloud';
          break;
        case 'p2p':
          // Active purple - P2P is ready
          sendBtn.classList.add('btn-active');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send File (P2P)';
          break;
        case 'relay':
          // Blue highlighted - Cloud Relay active
          sendBtn.classList.add('btn-blue');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Upload via Cloud';
          break;
      }
    }

    // Helper function to generate QR code in modal + inline panel
    function generateQRCode(roomCode) {
      qrcodeDiv.innerHTML = '';
      qrInlineCodeEl.innerHTML = '';

      const fullUrl = window.location.origin + window.location.pathname + '?room=' + roomCode;

      // Modal QR
      new QRCode(qrcodeDiv, {
        text: fullUrl,
        width: 220,
        height: 220,
        colorDark: '#667eea',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });

      // Inline panel QR (desktop only, but harmless to generate on mobile)
      new QRCode(qrInlineCodeEl, {
        text: fullUrl,
        width: 148,
        height: 148,
        colorDark: '#667eea',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });

      // Show inline wrapper (CSS hides it on mobile)
      qrInlineWrapper.style.display = '';
    }

    // Open QR modal
    function openQRModal() {
      if (!isSender) return; // Only senders can open modal
      modalRoomCode.textContent = roomCode;
      qrModal.classList.add('show');
      document.body.style.overflow = 'hidden'; // Prevent background scroll
    }

    // Close QR modal
    function closeQRModal() {
      qrModal.classList.remove('show');
      document.body.style.overflow = ''; // Restore scroll
    }

    // Turnstile helper functions
    async function getTurnstileToken() {
      return new Promise((resolve, reject) => {
        if (!window.turnstile) {
          console.error('Turnstile not loaded');
          reject(new Error('Turnstile not available'));
          return;
        }

        try {
          // Execute Turnstile (invisible mode)
          window.turnstile.execute('#turnstileWidget', {
            callback: (token) => {
              turnstileToken = token;
              resolve(token);
            },
            'error-callback': () => {
              reject(new Error('Turnstile verification failed'));
            }
          });
        } catch (error) {
          console.error('Turnstile execution error:', error);
          reject(error);
        }
      });
    }

    // Turnstile success callback (called by Turnstile widget)
    window.onTurnstileSuccess = function(token) {
      turnstileToken = token;
    };

    // Cookie consent functions
    function checkCookieConsent() {
      const dismissed = localStorage.getItem('cookieConsentDismissed');
      if (!dismissed) {
        // Show banner after a short delay for better UX
        setTimeout(() => {
          cookieBanner.classList.add('show');
        }, 500);
      }
    }

    function dismissCookieBanner() {
      cookieBanner.classList.remove('show');
      localStorage.setItem('cookieConsentDismissed', 'true');
    }

    // URL validation and auto-prepend
    function validateAndPrepareURL(inputUrl) {
      let url = inputUrl.trim();

      // Auto-prepend https:// if no protocol
      if (url && !url.match(/^https?:\\/\\//i)) {
        url = 'https://' + url;
      }

      // Validate URL format with TLD check (2-6 letters, handles .co.uk etc)
      const urlPattern = /^https?:\\/\\/([a-zA-Z0-9-]+\\.)*[a-zA-Z0-9-]+\\.[a-zA-Z]{2,6}(\\/.*)?$/;

      if (!url || !urlPattern.test(url)) {
        return { valid: false, url: null };
      }

      // Additional validation using URL constructor and protocol whitelist
      try {
        const urlObj = new URL(url);
        // Only allow http: and https: protocols (prevent javascript:, data:, file:, etc.)
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
          return { valid: false, url: null };
        }
        return { valid: true, url };
      } catch (e) {
        return { valid: false, url: null };
      }
    }

    // Paste URL from clipboard
    async function pasteURLFromClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        const result = validateAndPrepareURL(text);

        if (result.valid) {
          urlInput.value = result.url;
          showToast('URL pasted and validated!');

          // Enable send button if connected
          if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
            sendUrlBtn.disabled = false;
            sendUrlBtn.textContent = 'Send URL (P2P)';
          } else if (ws && ws.readyState === WebSocket.OPEN) {
            sendUrlBtn.disabled = false;
            sendUrlBtn.textContent = 'Send URL (via Cloud)';
          }
        } else {
          showError('Invalid URL in clipboard. Please check the format.');
        }
      } catch (error) {
        console.error('Clipboard access error:', error);
        showError('Could not access clipboard. Please paste manually.');
      }
    }

    function init() {
      // Check cookie consent on page load
      checkCookieConsent();

      // Check for auto-join via URL parameter
      const urlParams = new URLSearchParams(window.location.search);
      const autoJoinRoom = urlParams.get('room');

      if (autoJoinRoom && autoJoinRoom.length === 6) {
        // Auto-join the room from URL parameter
        isSender = false;
        roomCode = autoJoinRoom.toUpperCase();
        roomCodeEl.textContent = roomCode;
        connectWebSocket(roomCode);
        statusText.textContent = 'Joining room...';
        showToast('Joining room ' + roomCode + '...');

        activateReceiveJoined(roomCode);
      } else {
        // Normal sender flow
        isSender = true;
        roomCode = generateRoomCode();
        roomCodeEl.textContent = roomCode;
        generateQRCode(roomCode); // Generate QR code for modal
        connectWebSocket(roomCode);

        // Make status clickable for senders
        status.classList.add('clickable');
      }
    }
    
    function generateRoomCode() {
      const chars = '0123456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    }
    
    function connectWebSocket(room, isReconnect = false) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws?room=\${room}\`);

      ws.onopen = () => {
        console.log('✅ WebSocket connected');
        wsReconnectAttempts = 0; // Reset reconnect counter on successful connection

        // Send keepalive pings to prevent browser from closing idle connections
        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);

        if (isReconnect) {
          statusText.textContent = 'Reconnected!';
          showToast('Connection restored!');
        } else {
          statusText.textContent = isSender ? 'Share this code with receiver:' : 'Connected to room:';
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleSignalingMessage(data);
      };

      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed', event.code, event.reason);

        clearInterval(pingInterval);
        pingInterval = null;

        // Don't reconnect if close was intentional or max retries exceeded
        if (isIntentionalClose || wsReconnectAttempts >= 5) {
          if (wsReconnectAttempts >= 5) {
            showError('Connection lost. Please refresh the page.');
          }
          return;
        }

        // Attempt reconnection with exponential backoff
        wsReconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 16000); // 1s, 2s, 4s, 8s, 16s

        console.log(\`🔄 Reconnecting in \${delay/1000}s (attempt \${wsReconnectAttempts}/5)...\`);
        statusText.textContent = \`Reconnecting in \${delay/1000}s...\`;
        showToast(\`Connection lost. Reconnecting (attempt \${wsReconnectAttempts}/5)...\`);

        wsReconnectTimeout = setTimeout(() => {
          console.log(\`🔄 Attempting reconnect \${wsReconnectAttempts}/5\`);
          connectWebSocket(room, true);
        }, delay);
      };
    }
    
    async function handleSignalingMessage(data) {
      console.log('📡 Signaling:', data.type);
      
      switch (data.type) {
        case 'connected':
          sessionId = data.sessionId;
          console.log('My session:', sessionId);
          break;
          
        case 'peer-joined':
          updateStatusBadge('connecting', 'Connecting...');
          statusText.textContent = 'Peer connected! Establishing connection...';
          showToast('Peer joined! Connecting...');

          if (isSender) {
            // Update button to gray/clickable state (allows skipping P2P)
            updateSendButton('connecting');
            // Start P2P connection with timeout
            await initiatePeerConnection();
          }
          break;
          
        case 'offer':
          await handleOffer(data);
          break;
          
        case 'answer':
          await handleAnswer(data);
          break;
          
        case 'ice-candidate':
          await handleIceCandidate(data);
          break;
          
        case 'fallback-link':
          // Receiver got fallback download link
          handleFallbackLink(data);
          break;

        case 'url-fallback':
          // Receiver got URL redirect link (fallback)
          handleUrlFallback(data);
          break;

        case 'text-fallback':
          // Receiver got plain text via cloud relay
          handleTextFallback(data);
          break;

        case 'peer-left':
          updateStatusBadge('waiting', 'Waiting for peer...');
          statusText.textContent = 'Peer disconnected';
          roomCodeEl.classList.remove('connected');
          sendBtn.disabled = true;
          showToast('Peer disconnected');
          break;

        case 'pong':
          // keepalive acknowledgement — no action needed
          break;
      }
    }
    
    async function initiatePeerConnection() {
      try {
        pc = new RTCPeerConnection(CONFIG);
        setupPeerConnectionHandlers();
        
        // Create data channel
        dataChannel = pc.createDataChannel('file-transfer', {
          ordered: true
        });
        setupDataChannel();
        
        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        ws.send(JSON.stringify({
          type: 'offer',
          offer: offer
        }));
        
        // Set timeout for P2P connection
        p2pTimeout = setTimeout(() => {
          if (!isP2PConnected) {
            console.log('☁️ Using Cloud Relay for this transfer');
            updateStatusBadge('relay', 'Cloud Relay Active');
            statusText.textContent = 'Using Cloud Relay for this transfer';
            showToast('Using Cloud Relay');
            updateSendButton('relay');
          }
        }, CONFIG.p2pTimeout);
        
      } catch (error) {
        console.error('❌ P2P initiation error:', error);
        handleP2PFailure();
      }
    }
    
    async function handleOffer(data) {
      try {
        pc = new RTCPeerConnection(CONFIG);
        setupPeerConnectionHandlers();
        
        // Set up data channel handler
        pc.ondatachannel = (event) => {
          dataChannel = event.channel;
          setupDataChannel();
        };
        
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        ws.send(JSON.stringify({
          type: 'answer',
          answer: answer,
          target: data.from
        }));
        
      } catch (error) {
        console.error('❌ Handle offer error:', error);
      }
    }
    
    async function handleAnswer(data) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (error) {
        console.error('❌ Handle answer error:', error);
      }
    }
    
    async function handleIceCandidate(data) {
      try {
        if (data.candidate && pc) {
          console.log('📥 Received ICE candidate:', data.candidate.type, data.candidate.candidate);
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log('✅ ICE candidate added successfully');
        }
      } catch (error) {
        console.error('❌ ICE candidate error:', error);
      }
    }
    
    function setupPeerConnectionHandlers() {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('📤 Sending ICE candidate:', event.candidate.type, event.candidate.candidate);
          ws.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        } else {
          console.log('✅ ICE gathering complete');
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        
        if (pc.connectionState === 'connected') {
          isP2PConnected = true;
          if (p2pTimeout) clearTimeout(p2pTimeout);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          handleP2PFailure();
        }
      };
      
      pc.onicegatheringstatechange = () => {
        console.log('🧊 ICE gathering state:', pc.iceGatheringState);
      };
      
      pc.oniceconnectionstatechange = () => {
        console.log('🔌 ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          console.log('✅ ICE connection successful!');
        }
      };
    }
    
    function setupDataChannel() {
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256KB low-water mark
      
      dataChannel.onopen = () => {
        console.log('✅ Data channel open');
        isP2PConnected = true;
        updateStatusBadge('p2p', 'P2P Connected');
        statusText.textContent = 'Ready for P2P transfer!';

        if (p2pTimeout) clearTimeout(p2pTimeout);

        if (isSender) {
          updateSendButton('p2p');

          if (urlInput.value.trim()) {
            sendUrlBtn.disabled = false;
            sendUrlBtn.textContent = 'Send URL (P2P)';
          }

          if (textInput.value.trim()) {
            sendTextBtn.disabled = false;
            sendTextBtn.textContent = 'Send Text (P2P)';
          }

          // Nearby: auto-send if triggered from Nearby tab
          if (nearbyAutoSendPending) {
            const type = nearbyAutoSendPending;
            nearbyAutoSendPending = null;
            setTimeout(() => {
              if (type === 'file') sendFile();
              else if (type === 'url') sendUrl();
              else if (type === 'text') sendText();
            }, 100);
          }
        }
      };

      dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          
          // Handle URL message
          if (data.type === 'url') {
            statusText.textContent = '🔗 Received URL!';
            showUrlToast(data.url);
            window.open(data.url, '_blank', 'noopener');
            return;
          }

          // Handle text message
          if (data.type === 'text') {
            showReceivedText(data.content);
            return;
          }
          
          // Handle batch-start announcement
          if (data.type === 'file-batch-start') {
            pendingFileCount = data.fileCount;
            receivedFileCount = 0;
            receivedFiles = [];
            return;
          }

          // Handle file metadata
          // Backward compat: old sender never sent file-batch-start
          if (pendingFileCount === 0) {
            pendingFileCount = 1;
            receivedFileCount = 0;
            receivedFiles = [];
          }

          fileName = data.fileName;
          totalSize = data.fileSize;

          if ((data.fileIndex ?? 0) === 0) {
            transferInProgress = true;
            acquireWakeLock();
          }

          statusText.textContent = pendingFileCount > 1
            ? \`Receiving file \${(data.fileIndex ?? 0) + 1}/\${pendingFileCount}...\`
            : 'Receiving file via P2P...';
          fileInfo.style.display = 'block';
          fileNameEl.textContent = fileName;
          fileSizeEl.textContent = formatFileSize(totalSize);
          progress.style.display = 'block';

          receivedChunks = [];
          receivedSize = 0;
        } else {
          // File chunk
          receivedChunks.push(event.data);
          receivedSize += event.data.byteLength;
          
          const percent = (receivedSize / totalSize) * 100;
          progressFill.style.width = percent + '%';
          progressText.textContent = \`Receiving... \${Math.round(percent)}%\`;
          
          if (receivedSize >= totalSize) {
            downloadReceivedFile();
          }
        }
      };
      
      dataChannel.onerror = (error) => {
        console.error('❌ Data channel error:', error);
        handleP2PFailure();
      };
      
      dataChannel.onclose = () => {
        console.log('Data channel closed');
      };
    }
    
    function handleP2PFailure() {
      console.log('☁️ Switching to Cloud Relay');
      isP2PConnected = false;
      updateStatusBadge('relay', 'Cloud Relay Active');
      statusText.textContent = 'Connected via Cloud Relay';

      if (isSender) {
        updateSendButton('relay');

        if (urlInput.value.trim()) {
          sendUrlBtn.disabled = false;
          sendUrlBtn.textContent = 'Send URL (via Cloud)';
        }

        if (textInput.value.trim()) {
          sendTextBtn.disabled = false;
          sendTextBtn.textContent = 'Send Text (via Cloud)';
        }
      }
    }
    
    async function sendFile() {
      if (selectedFiles.length === 0) return;

      // Try P2P first if connected
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        await sendFileP2P();
      } else {
        await sendFileFallback();
      }
    }
    
    async function sendFileP2P() {
      sendBtn.disabled = true;
      progress.style.display = 'block';
      transferInProgress = true;
      await acquireWakeLock();

      const totalBytes = selectedFiles.reduce((s, f) => s + f.size, 0);

      // Announce batch size to receiver
      dataChannel.send(JSON.stringify({
        type: 'file-batch-start',
        fileCount: selectedFiles.length
      }));

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // Send per-file metadata
        dataChannel.send(JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          fileIndex: i
        }));

        // Send chunks — wrapped in a Promise so we await completion before next file
        await new Promise((resolve) => {
          const reader = new FileReader();
          let offset = 0;
          const priorBytes = selectedFiles.slice(0, i).reduce((s, f) => s + f.size, 0);

          reader.onload = (e) => {
            dataChannel.send(e.target.result);
            offset += e.target.result.byteLength;

            const percent = ((priorBytes + offset) / totalBytes) * 100;
            progressFill.style.width = percent + '%';
            progressText.textContent = selectedFiles.length > 1
              ? \`Sending \${i + 1}/\${selectedFiles.length}: \${Math.round(percent)}%\`
              : \`Sending... \${Math.round(percent)}%\`;

            if (offset < file.size) {
              // Backpressure: pause if the send buffer is above 1MB
              if (dataChannel.bufferedAmount > 1 * 1024 * 1024) {
                dataChannel.onbufferedamountlow = () => {
                  dataChannel.onbufferedamountlow = null;
                  readSlice(offset);
                };
              } else {
                readSlice(offset);
              }
            } else {
              resolve();
            }
          };

          function readSlice(o) {
            const slice = file.slice(o, o + CONFIG.chunkSize);
            reader.readAsArrayBuffer(slice);
          }

          readSlice(0);
        });
      }

      transferInProgress = false;
      releaseWakeLock();
      progressText.textContent = '✅ Transfer complete!';
      showToast(selectedFiles.length === 1 ? 'File sent successfully!' : \`\${selectedFiles.length} files sent!\`);
      telehostPromo.style.display = 'block';
      setTimeout(() => {
        progress.style.display = 'none';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Another File';
      }, 2000);
    }
    
    async function sendFileFallback() {
      try {
        // Validate all files up front
        for (const file of selectedFiles) {
          if (file.size > CONFIG.maxFileSize) {
            showError(\`"\${file.name}" is too large for Cloud Relay (max 20MB). Use P2P mode.\`);
            sendBtn.disabled = false;
            return;
          }
        }

        sendBtn.disabled = true;
        progress.style.display = 'block';
        transferInProgress = true;
        await acquireWakeLock();

        for (let i = 0; i < selectedFiles.length; i++) {
          const file = selectedFiles[i];

          progressText.textContent = selectedFiles.length > 1
            ? \`Verifying file \${i + 1}/\${selectedFiles.length}...\`
            : 'Verifying...';

          // Get Turnstile token for bot protection (one per file)
          let token;
          try {
            token = await getTurnstileToken();
          } catch (error) {
            console.error('Turnstile verification failed:', error);
            showError('Verification failed. Please try again.');
            sendBtn.disabled = false;
            progress.style.display = 'none';
            return;
          }

          progressText.textContent = selectedFiles.length > 1
            ? \`Uploading \${i + 1}/\${selectedFiles.length}: \${file.name}...\`
            : 'Uploading to cloud...';

          const formData = new FormData();
          formData.append('file', file);
          formData.append('roomCode', roomCode);
          formData.append('fileName', file.name);
          formData.append('turnstileToken', token);

          const response = await fetch('/upload', {
            method: 'POST',
            body: formData
          });

          if (!response.ok) {
            const result = await response.json();
            if (response.status === 403) {
              throw new Error('Bot verification failed. Please refresh and try again.');
            }
            throw new Error(result.error || 'Upload failed');
          }

          const result = await response.json();
          if (!result.success) throw new Error(result.error || 'Upload failed');

          progressFill.style.width = \`\${((i + 1) / selectedFiles.length) * 100}%\`;

          // Notify receiver about this file
          ws.send(JSON.stringify({
            type: 'fallback-link',
            fileId: result.fileId,
            downloadUrl: result.downloadUrl,
            fileName: file.name,
            fileIndex: i,
            fileCount: selectedFiles.length
          }));

          // Reset Turnstile widget so it can issue a fresh token for the next file
          if (window.turnstile && i < selectedFiles.length - 1) {
            window.turnstile.reset('#turnstileWidget');
          }
        }

        transferInProgress = false;
        releaseWakeLock();
        progressText.textContent = '✅ Uploaded! Links sent.';
        showToast(selectedFiles.length === 1 ? 'File uploaded! Link sent to receiver.' : \`\${selectedFiles.length} files uploaded!\`);

        setTimeout(() => {
          progress.style.display = 'none';
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Another File';
        }, 2000);

      } catch (error) {
        console.error('❌ Fallback upload error:', error);

        let errorMessage = error.message || 'Upload failed';
        if (error.message && error.message.includes('NetworkError')) {
          errorMessage = 'Network error. Please check your connection and try again.';
        } else if (error.message && error.message.includes('Bot verification')) {
          errorMessage = error.message;
        } else if (!error.message || error.message === 'Upload failed') {
          errorMessage = 'Upload failed. Please check your connection and try again.';
        }

        transferInProgress = false;
        releaseWakeLock();
        showError(errorMessage);
        sendBtn.disabled = false;
        progress.style.display = 'none';
      }
    }

    function handleFallbackLink(data) {
      const totalInBatch = data.fileCount ?? 1;
      if ((data.fileIndex ?? 0) === 0 || receivedFiles.length === 0) {
        receivedFiles = [];
        pendingFileCount = totalInBatch;
        receivedFileCount = 0;
      }

      receivedFiles.push({ fileName: data.fileName, url: data.downloadUrl });
      receivedFileCount++;

      if (receivedFileCount >= pendingFileCount) {
        statusText.textContent = receivedFiles.length === 1 ? 'File ready for download!' : 'All files ready!';
        showToast(receivedFiles.length === 1 ? 'File received via Cloud Relay!' : \`\${receivedFiles.length} files received!\`);
        showReceiveSuccess('files', receivedFiles);
        pendingFileCount = 0;
        receivedFileCount = 0;
      } else {
        statusText.textContent = \`Received \${receivedFileCount}/\${pendingFileCount} files...\`;
        showToast(\`File \${receivedFileCount}/\${pendingFileCount} received\`);
      }
    }

    function handleUrlFallback(data) {
      // Receiver gets URL redirect link (fallback)
      statusText.textContent = '🔗 Received URL (via cloud)!';
      showUrlToast(data.redirectUrl);
      window.open(data.redirectUrl, '_blank', 'noopener');
    }

    function handleTextFallback(data) {
      showReceivedText(data.content);
      statusText.textContent = '📋 Text received via Cloud!';
      showToast('Text received!');
    }

    function showReceivedText(content) {
      statusText.textContent = '📋 Text received!';
      showToast('Text received!');
      showReceiveSuccess('text', { content });
    }

    async function sendText() {
      const content = textInput.value.trim();
      if (!content) {
        showError('Please enter some text');
        return;
      }

      sendTextBtn.disabled = true;

      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'text', content }));
        statusText.textContent = '✅ Text sent via P2P!';
        showToast('Text sent!');
        setTimeout(() => {
          sendTextBtn.disabled = false;
          textInput.value = '';
        }, 2000);
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        // Send directly via signaling relay — text is tiny, no R2 needed
        ws.send(JSON.stringify({ type: 'text-fallback', content }));
        statusText.textContent = '✅ Text sent via Cloud!';
        showToast('Text sent!');
        setTimeout(() => {
          sendTextBtn.disabled = false;
          textInput.value = '';
        }, 2000);
      } else {
        showError('Not connected. Please wait for a peer to join.');
        sendTextBtn.disabled = false;
      }
    }

    function downloadReceivedFile() {
      const blob = new Blob(receivedChunks);
      const url = URL.createObjectURL(blob);

      receivedFiles.push({ fileName, url });
      receivedFileCount++;
      receivedChunks = [];
      receivedSize = 0;

      if (receivedFileCount >= pendingFileCount) {
        transferInProgress = false;
        releaseWakeLock();
        statusText.textContent = receivedFiles.length === 1 ? '✅ File ready!' : '✅ All files ready!';
        showToast(receivedFiles.length === 1 ? 'File received!' : \`\${receivedFiles.length} files received!\`);
        showReceiveSuccess('files', receivedFiles);
        pendingFileCount = 0;
        receivedFileCount = 0;
      } else {
        progressText.textContent = \`File \${receivedFileCount}/\${pendingFileCount} received, waiting for next...\`;
      }
    }
    
    async function sendUrl() {
      const inputUrl = urlInput.value.trim();

      if (!inputUrl) {
        showError('Please enter a URL');
        return;
      }

      // Validate and prepare URL (auto-prepend https://)
      const result = validateAndPrepareURL(inputUrl);

      if (!result.valid) {
        showError('Invalid URL format. Please enter a valid URL (e.g., example.com or https://example.com)');
        return;
      }

      const url = result.url;

      // Update input with validated URL (with protocol)
      urlInput.value = url;

      sendUrlBtn.disabled = true;

      // Try P2P first if available
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        // Send URL via DataChannel
        dataChannel.send(JSON.stringify({
          type: 'url',
          url: url
        }));

        statusText.textContent = '✅ URL sent via P2P!';
        showToast('URL shared successfully!');

        setTimeout(() => {
          sendUrlBtn.disabled = false;
          urlInput.value = '';
        }, 2000);
      } else {
        // Use R2 fallback
        try {
          progress.style.display = 'block';
          progressText.textContent = 'Verifying...';

          // Get Turnstile token for bot protection
          let token;
          try {
            token = await getTurnstileToken();
          } catch (error) {
            console.error('Turnstile verification failed:', error);
            showError('Verification failed. Please try again.');
            sendUrlBtn.disabled = false;
            progress.style.display = 'none';
            return;
          }

          progressText.textContent = 'Uploading URL...';

          const urlId = crypto.randomUUID();
          const timestamp = Date.now();

          // Upload URL as text to R2
          const response = await fetch('/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              urlId: urlId,
              url: url,
              roomCode: roomCode,
              timestamp: timestamp,
              turnstileToken: token
            })
          });

          if (!response.ok) {
            const result = await response.json();
            if (response.status === 403) {
              throw new Error('Bot verification failed. Please refresh and try again.');
            }
            throw new Error(result.error || 'URL upload failed');
          }

          const result = await response.json();

          if (result.success) {
            progressFill.style.width = '100%';
            progressText.textContent = '✅ URL uploaded!';

            // Send URL redirect link to receiver via signaling
            ws.send(JSON.stringify({
              type: 'url-fallback',
              urlId: urlId,
              redirectUrl: '/url-redirect/' + urlId
            }));

            showToast('URL shared via Cloud Relay!');

            setTimeout(() => {
              progress.style.display = 'none';
              sendUrlBtn.disabled = false;
              urlInput.value = '';
            }, 2000);
          } else {
            throw new Error(result.error || 'URL upload failed');
          }
        } catch (error) {
          console.error('❌ URL fallback error:', error);

          // Provide helpful error message based on error type
          let errorMessage = error.message || 'Failed to share URL';
          if (error.message && error.message.includes('NetworkError')) {
            errorMessage = 'Network error. Please check your connection and try again.';
          } else if (error.message && error.message.includes('Bot verification')) {
            errorMessage = error.message; // Use specific bot verification error
          } else if (error.message && error.message.includes('Invalid URL protocol')) {
            errorMessage = error.message; // Use specific protocol error
          } else if (!error.message || error.message === 'Failed to share URL') {
            errorMessage = 'Failed to share URL. Please check your connection and try again.';
          }

          showError(errorMessage);
          sendUrlBtn.disabled = false;
          progress.style.display = 'none';
        }
      }
    }
    
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    
    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    function showUrlToast(url) {
      // Show a persistent clickable link as fallback for blocked popups.
      // window.open with 'noopener' always returns null in modern browsers,
      // so we can't detect blocking — just always show the link.
      toast.textContent = '';
      const label = document.createElement('div');
      label.textContent = '🔗 URL received — tap to open:';
      label.style.cssText = 'margin-bottom:8px;font-weight:500;font-size:13px;';
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const display = url.length > 45 ? url.slice(0, 45) + '…' : url;
      link.textContent = display;
      link.style.cssText = 'display:block;word-break:break-all;color:#007aff;font-size:12px;';
      link.addEventListener('click', () => toast.classList.remove('show'));
      toast.appendChild(label);
      toast.appendChild(link);
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 10000);
    }
    
    function showError(message) {
      errorDiv.textContent = '❌ ' + message;
      errorDiv.style.display = 'block';
      setTimeout(() => {
        errorDiv.style.display = 'none';
      }, 5000);
    }
    
    // Event Listeners

    // Cookie Banner - Close button
    cookieBannerClose.addEventListener('click', dismissCookieBanner);

    // QR Modal - Click status to open (sender only)
    status.addEventListener('click', () => {
      if (isSender) {
        openQRModal();
      }
    });

    // QR Modal - Close button
    qrModalClose.addEventListener('click', closeQRModal);

    qrInlineWrapper.addEventListener('click', () => {
      const url = window.location.origin + window.location.pathname + '?room=' + roomCode;
      navigator.clipboard.writeText(url).then(() => showToast('Link copied!')).catch(() => showToast('Copy failed'));
    });

    // QR Modal - Click outside to close
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) {
        closeQRModal();
      }
    });

    // Escape key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (qrModal.classList.contains('show')) closeQRModal();
        if (settingsModal.classList.contains('show')) closeSettingsModal();
      }
    });

    let lastSendTypeBtn = sendModeBtn;

    function activateSendRole() {
      sendRoleBtn.classList.add('active');
      receiveRoleBtn.classList.remove('active');
      sendTypeSelector.style.display = '';
      receiveSection.classList.remove('active');
      roleHint.textContent = 'Share your room code with the other device';
      status.style.display = '';
      if (qrInlineCodeEl.innerHTML) qrInlineWrapper.style.display = '';
      leftReceiveState.style.display = 'none';
    }

    // ── Nearby Tab Visibility + Switching ────────────────────────────────
    const nearbyRoleBtn = document.getElementById('nearbyRoleBtn');
    const nearbySection = document.getElementById('nearbySection');
    const nearbyIdentityName = document.getElementById('nearbyIdentityName');
    const nearbyIdentityInput = document.getElementById('nearbyIdentityInput');
    const nearbyPeerList = document.getElementById('nearbyPeerList');
    const nearbyEmpty = document.getElementById('nearbyEmpty');

    function nearbyUpdateTabVisibility() {
      nearbyRoleBtn.style.display = nearbyIsEnabled() ? '' : 'none';
      if (!nearbyIsEnabled() && nearbySection.classList.contains('active')) {
        switchToRole('send');
      }
    }

    function switchToRole(role) {
      [sendRoleBtn, receiveRoleBtn, nearbyRoleBtn].forEach(b => b.classList.remove('active'));
      nearbySection.classList.remove('active');

      // Restore send buttons whenever leaving Nearby mode
      sendBtn.style.display = '';
      sendUrlBtn.style.display = '';
      sendTextBtn.style.display = '';

      if (role === 'send') {
        lastSendTypeBtn.click();
      } else if (role === 'receive') {
        receiveRoleBtn.classList.add('active');
        sendTypeSelector.style.display = 'none';
        receiveSection.classList.add('active');
        sendSection.classList.remove('active');
        urlSection.classList.remove('active');
        textSection.classList.remove('active');
        roleHint.textContent = 'Enter the code shown on the other device';
        status.style.display = 'none';
        qrInlineWrapper.style.display = 'none';
        leftReceiveState.style.display = '';
        roomInput.focus();
      } else if (role === 'nearby') {
        nearbyRoleBtn.classList.add('active');
        nearbySection.classList.add('active');
        // Show the send-type selector and whichever sub-section was last active
        sendTypeSelector.style.display = '';
        receiveSection.classList.remove('active');
        // Re-activate the last send sub-section (sendSection/urlSection/textSection)
        // so drag-drop, paste, and file input all work inside Nearby
        lastSendTypeBtn.click(); // this also sets the right section active
        // But override the role-button state that lastSendTypeBtn.click() sets
        [sendRoleBtn, receiveRoleBtn, nearbyRoleBtn].forEach(b => b.classList.remove('active'));
        nearbyRoleBtn.classList.add('active');
        // Hide the "Waiting for receiver…" action buttons — tap-to-send replaces them
        sendBtn.style.display = 'none';
        sendUrlBtn.style.display = 'none';
        sendTextBtn.style.display = 'none';
        status.style.display = 'none';
        qrInlineWrapper.style.display = 'none';
        leftReceiveState.style.display = 'none';
        roleHint.textContent = 'Pick content above, then tap a device';
        nearbyIdentityName.textContent = nearbyGetIdentity().displayName;
      }
    }

    function nearbyIsActive() {
      return nearbySection.classList.contains('active');
    }

    nearbyRoleBtn.addEventListener('click', () => switchToRole('nearby'));
    sendRoleBtn.addEventListener('click', () => switchToRole('send'));
    receiveRoleBtn.addEventListener('click', () => switchToRole('receive'));

    // Init: show/hide Nearby tab based on saved setting
    nearbyUpdateTabVisibility();

    // ── Nearby: Inline Name Edit ──────────────────────────────────────────
    function nearbyBeginRename() {
      nearbyIdentityInput.value = nearbyGetIdentity().displayName;
      nearbyIdentityName.style.display = 'none';
      nearbyIdentityInput.style.display = '';
      nearbyIdentityInput.focus();
      nearbyIdentityInput.select();
    }

    function nearbyCommitRename() {
      const newName = nearbyIdentityInput.value.trim();
      if (newName) {
        nearbySetDisplayName(newName);
        if (nearbyWs && nearbyWs.readyState === WebSocket.OPEN) {
          nearbyWs.send(JSON.stringify({ type: 'update-name', displayName: newName }));
        }
        // Keep settings UI in sync
        const settingsDisplay = document.getElementById('nearbyNameDisplay');
        if (settingsDisplay) settingsDisplay.textContent = newName;
      }
      nearbyIdentityName.textContent = nearbyGetIdentity().displayName;
      nearbyIdentityInput.style.display = 'none';
      nearbyIdentityName.style.display = '';
    }

    nearbyIdentityName.addEventListener('click', nearbyBeginRename);
    nearbyIdentityInput.addEventListener('blur', nearbyCommitRename);
    nearbyIdentityInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nearbyIdentityInput.blur();
      if (e.key === 'Escape') {
        nearbyIdentityInput.value = nearbyGetIdentity().displayName;
        nearbyIdentityInput.blur();
      }
    });
    // ─────────────────────────────────────────────────────────────────────

    // ── NearbyLobby WebSocket Client ──────────────────────────────────────
    let nearbyWs = null;
    let nearbyIntentionalClose = false;
    let nearbyPeers = []; // [{ deviceId, displayName }]

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
        // Reconnect after 3s if still enabled and close was not intentional
        if (nearbyIsEnabled() && !nearbyIntentionalClose) setTimeout(nearbyConnect, 3000);
        nearbyIntentionalClose = false;
      });

      nearbyWs.addEventListener('error', () => {
        console.error('[Nearby] WebSocket error');
      });
    }

    function nearbyDisconnect() {
      if (nearbyWs) {
        nearbyIntentionalClose = true;
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

    // ── Tab Visibility Management ─────────────────────────────────────────────
    // Disconnect WebSockets after 60s hidden to avoid wasting Durable Object
    // invocations. Reconnect immediately when the tab becomes visible again.
    // P2P (WebRTC data channel) is unaffected — it is peer-to-peer.
    let visibilityHideTimer = null;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        visibilityHideTimer = setTimeout(() => {
          visibilityHideTimer = null;
          if (transferInProgress) return;

          if (ws && ws.readyState <= WebSocket.OPEN) {
            isIntentionalClose = true;
            ws.close();
            isIntentionalClose = false;
          }

          nearbyDisconnect();
        }, 60_000);
      } else {
        if (visibilityHideTimer !== null) {
          clearTimeout(visibilityHideTimer);
          visibilityHideTimer = null;
        }

        if (roomCode && (!ws || ws.readyState > WebSocket.OPEN)) {
          connectWebSocket(roomCode, true);
        }

        if (nearbyIsEnabled() && (!nearbyWs || nearbyWs.readyState > WebSocket.OPEN)) {
          nearbyConnect();
        }

        if (transferInProgress) acquireWakeLock();
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Auto-connect on load if enabled
    if (nearbyIsEnabled()) nearbyConnect();
    // ─────────────────────────────────────────────────────────────────────

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

    // ── Nearby: Sender Side ───────────────────────────────────────────────
    let nearbySendTargetDeviceId = null;
    let nearbyContentType = null; // 'file' | 'url' | 'text'
    let nearbyLastTransferPeer = null; // { deviceId, displayName }
    // (nearbySendFile removed — content lives in selectedFiles/urlInput/textInput)

    // Tap a device → check what content is ready and send it
    function nearbyInitiateSend(peer) {
      // Determine active content type and validate content exists
      let contentType, fileName, fileSize;

      if (sendSection.classList.contains('active')) {
        if (!selectedFiles.length) {
          showToast('Pick a file above first');
          return;
        }
        contentType = 'file';
        fileName = selectedFiles.length === 1
          ? selectedFiles[0].name
          : \`\${selectedFiles.length} files\`;
        fileSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
      } else if (urlSection.classList.contains('active')) {
        if (!urlInput.value.trim()) {
          showToast('Enter a URL above first');
          return;
        }
        contentType = 'url';
        fileName = urlInput.value.trim();
        fileSize = 0;
      } else if (textSection.classList.contains('active')) {
        if (!textInput.value.trim()) {
          showToast('Enter some text above first');
          return;
        }
        contentType = 'text';
        fileName = 'Text snippet';
        fileSize = new Blob([textInput.value]).size;
      } else {
        showToast('Pick content above first');
        return;
      }

      nearbySendTargetDeviceId = peer.deviceId;
      nearbyContentType = contentType;

      // Update peer item to show "Waiting…"
      const item = nearbyPeerList.querySelector(\`[data-device-id="\${peer.deviceId}"]\`);
      if (item) item.querySelector('.nearby-peer-status').textContent = 'Waiting…';

      nearbyWs.send(JSON.stringify({
        type: 'send-request',
        targetDeviceId: peer.deviceId,
        fileName,
        fileSize,
      }));
    }

    function nearbySenderJoinRoom(roomCode) {
      if (!nearbyContentType) return;
      const peer = nearbyPeers.find(p => p.deviceId === nearbySendTargetDeviceId);
      if (peer) nearbyLastTransferPeer = { deviceId: peer.deviceId, displayName: peer.displayName };
      const type = nearbyContentType;
      nearbySendTargetDeviceId = null;
      nearbyContentType = null;
      switchToRole('send');
      nearbyTriggerSend(roomCode, type);
    }

    function nearbyClosePendingRequest() {
      nearbySendTargetDeviceId = null;
      nearbyContentType = null;
      nearbyRenderPeers();
    }
    // ─────────────────────────────────────────────────────────────────────

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

      nearbyRequestFrom.textContent = \`\${data.fromName} wants to send you:\`;
      nearbyRequestFile.textContent = data.fileName;
      nearbyRequestSize.textContent = formatFileSize(data.fileSize);
      nearbyRequestModal.style.display = 'flex';
    }

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

    // ── Nearby: Transfer Handoff ──────────────────────────────────────────
    let nearbyAutoSendPending = null; // null | 'file' | 'url' | 'text'

    function nearbyTriggerSend(roomCode, contentType) {
      // Content is already prepared in selectedFiles / urlInput / textInput
      // Close existing signaling connection and join as sender with the given room code
      isSender = true;
      if (ws) {
        isIntentionalClose = true;
        ws.close();
        isIntentionalClose = false;
      }
      roomCodeEl.textContent = roomCode;
      generateQRCode(roomCode);
      connectWebSocket(roomCode);
      status.classList.add('clickable');
      nearbyAutoSendPending = contentType;
    }

    function nearbyReceiverJoinRoom(roomCode) {
      // Switch to receive tab and auto-join the room
      switchToRole('receive');
      const ri = document.getElementById('roomInput');
      ri.value = roomCode;
      document.getElementById('joinBtn').click();
    }

    // ── Nearby: Post-Transfer Trust Offer ────────────────────────────────
    function nearbyOfferTrust(deviceId, displayName) {
      if (nearbyIsTrusted(deviceId)) return; // already trusted
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

    sendModeBtn.addEventListener('click', () => {
      if (!nearbyIsActive()) activateSendRole();
      lastSendTypeBtn = sendModeBtn;
      sendModeBtn.classList.add('active');
      urlModeBtn.classList.remove('active');
      textModeBtn.classList.remove('active');
      sendSection.classList.add('active');
      urlSection.classList.remove('active');
      textSection.classList.remove('active');
      if (nearbyIsActive()) { sendBtn.style.display = 'none'; }
    });

    urlModeBtn.addEventListener('click', () => {
      if (!nearbyIsActive()) activateSendRole();
      lastSendTypeBtn = urlModeBtn;
      urlModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      textModeBtn.classList.remove('active');
      urlSection.classList.add('active');
      sendSection.classList.remove('active');
      textSection.classList.remove('active');
      if (nearbyIsActive()) { sendUrlBtn.style.display = 'none'; }
    });

    textModeBtn.addEventListener('click', () => {
      if (!nearbyIsActive()) activateSendRole();
      lastSendTypeBtn = textModeBtn;
      textModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      urlModeBtn.classList.remove('active');
      textSection.classList.add('active');
      sendSection.classList.remove('active');
      urlSection.classList.remove('active');
      textInput.focus();
      if (nearbyIsActive()) { sendTextBtn.style.display = 'none'; }
    });
    
    // File selection - click
    uploadArea.addEventListener('click', () => fileInput.click());
    
    // Full-page drag overlay
    const dragOverlay = document.getElementById('dragOverlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        if (receiveSuccessPanel.classList.contains('active')) {
          successResetBtn.click();
          sendRoleBtn.click();
        }
        dragOverlay.classList.add('active');
      }
    });

    document.addEventListener('dragleave', (e) => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dragOverlay.classList.remove('active');
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    dragOverlay.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      dragOverlay.classList.remove('active');

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        // Switch to send mode if not already there
        sendModeBtn.click();

        selectedFiles = [...selectedFiles, ...files];
        const dataTransfer = new DataTransfer();
        selectedFiles.forEach(f => dataTransfer.items.add(f));
        fileInput.files = dataTransfer.files;
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast(files.length === 1
          ? ('Added: ' + files[0].name)
          : (files.length + ' files added'));
      }
    });

    // Drag and drop support (small upload area still works too)
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '#667eea';
      uploadArea.style.background = '#f8f9ff';
    });

    uploadArea.addEventListener('dragleave', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '#ddd';
      uploadArea.style.background = '';
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '#ddd';
      uploadArea.style.background = '';

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        selectedFiles = [...selectedFiles, ...files];
        const dataTransfer = new DataTransfer();
        selectedFiles.forEach(f => dataTransfer.items.add(f));
        fileInput.files = dataTransfer.files;
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast(files.length === 1
          ? ('Added: ' + files[0].name)
          : (files.length + ' files added'));
      }
    });
    
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length > 0) {
        selectedFiles = [...selectedFiles, ...files];
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }
      }
    });
    
    sendBtn.addEventListener('click', sendFile);

    // URL input handling - validate on input
    urlInput.addEventListener('input', () => {
      const inputValue = urlInput.value.trim();

      if (!inputValue) {
        sendUrlBtn.disabled = true;
        return;
      }

      // Enable button if there's text (validation happens on send)
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Send URL (P2P)';
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Send URL (via Cloud)';
      }
    });

    // Paste URL button
    pasteUrlBtn.addEventListener('click', pasteURLFromClipboard);

    sendUrlBtn.addEventListener('click', sendUrl);

    // Text mode listeners
    textInput.addEventListener('input', () => {
      const hasContent = textInput.value.trim().length > 0;
      if (!hasContent) {
        sendTextBtn.disabled = true;
        return;
      }
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        sendTextBtn.disabled = false;
        sendTextBtn.textContent = 'Send Text (P2P)';
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        sendTextBtn.disabled = false;
        sendTextBtn.textContent = 'Send Text (via Cloud)';
      }
    });

    pasteTextBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) {
          showError('Clipboard is empty.');
          return;
        }
        textInput.value = text;
        textInput.dispatchEvent(new Event('input'));
        showToast('Pasted from clipboard!');
      } catch (e) {
        showError('Could not access clipboard. Please paste manually (Ctrl+V / Cmd+V).');
      }
    });

    clearTextBtn.addEventListener('click', () => {
      textInput.value = '';
      sendTextBtn.disabled = true;
    });


    sendTextBtn.addEventListener('click', sendText);

    joinBtn.addEventListener('click', () => {
      const code = roomInput.value.trim().replace(/\D/g, '');
      if (code.length !== 6) {
        showError('Please enter a 6-digit room code');
        return;
      }

      isSender = false;
      roomCode = code;
      roomCodeEl.textContent = code;

      // Mark as intentional close to prevent reconnection
      if (ws) {
        isIntentionalClose = true;
        ws.close();
        isIntentionalClose = false;
      }

      connectWebSocket(code);
      statusText.textContent = 'Connecting to room...';

      // Receivers don't get clickable status
      status.classList.remove('clickable');

      activateReceiveJoined(code);
    });

    // Auto-join when 6th digit is typed
    roomInput.addEventListener('input', () => {
      const code = roomInput.value.replace(/\D/g, '');
      if (code.length === 6 && localStorage.getItem('autoJoinRoom') !== 'false') {
        joinBtn.click();
      }
    });

    // Global paste handler: files → File tab, URLs → URL tab, text → Text tab
    document.addEventListener('paste', (e) => {
      // Let native paste work in inputs/textareas
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const items = Array.from(e.clipboardData.items);
      const fileItems = items.filter(i => i.kind === 'file');

      if (fileItems.length > 0) {
        e.preventDefault();
        const files = fileItems.map(i => i.getAsFile()).filter(Boolean);
        if (files.length === 0) return;

        sendModeBtn.click();
        selectedFiles = [...selectedFiles, ...files];
        const dataTransfer = new DataTransfer();
        selectedFiles.forEach(f => dataTransfer.items.add(f));
        fileInput.files = dataTransfer.files;
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast(files.length === 1
          ? ('Added: ' + files[0].name)
          : (files.length + ' files added'));
        return;
      }

      const textItem = items.find(i => i.kind === 'string' && i.type === 'text/plain');
      if (textItem) {
        textItem.getAsString((text) => {
          text = text.trim();
          if (!text) return;
          const lc = text.toLowerCase();
          const isUrl = lc.startsWith('http://') || lc.startsWith('https://') || lc.startsWith('ftp://') ||
            (!text.includes(' ') && text.indexOf(String.fromCharCode(10)) === -1 && /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(text));
          if (isUrl) {
            urlModeBtn.click();
            urlInput.value = text;
            urlInput.dispatchEvent(new Event('input'));
            showToast('URL pasted!');
          } else {
            textModeBtn.click();
            textInput.value = text;
            textInput.dispatchEvent(new Event('input'));
            showToast('Text pasted!');
          }
        });
      }
    });
  </script>
</body>
</html>`;
}