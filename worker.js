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
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
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

  const headers = new Headers();
  const ct = upstreamRes.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=86400, immutable');
  return new Response(upstreamRes.body, { status: 200, headers });
}

/**
 * Durable Object: SignalingRoom
 * Manages WebSocket connections and WebRTC signaling for a room
 */
export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionId -> { ws, metadata }
  }
  
  async fetch(request) {
    // Upgrade to WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    server.accept();
    
    // Generate unique session ID
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { ws: server, joinedAt: Date.now() });

    console.log(`[Room] New peer: ${sessionId}. Total: ${this.sessions.size}`);

    // Analytics: Track P2P connection attempt
    console.log(JSON.stringify({
      event: 'peer_connected',
      method: 'p2p',
      peersInRoom: this.sessions.size,
      timestamp: new Date().toISOString()
    }));
    
    // Send connection confirmation
    server.send(JSON.stringify({
      type: 'connected',
      sessionId,
      peersCount: this.sessions.size - 1
    }));
    
    // Notify other peers
    this.broadcast({
      type: 'peer-joined',
      sessionId,
      peersCount: this.sessions.size
    }, sessionId);
    
    // Handle messages
    server.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(sessionId, data);
      } catch (error) {
        console.error('[Room] Invalid message:', error);
      }
    });
    
    // Handle disconnection
    server.addEventListener('close', () => {
      this.sessions.delete(sessionId);
      console.log(`[Room] Peer left: ${sessionId}. Remaining: ${this.sessions.size}`);
      
      this.broadcast({
        type: 'peer-left',
        sessionId,
        peersCount: this.sessions.size
      });
    });
    
    server.addEventListener('error', (error) => {
      console.error('[Room] WebSocket error:', error);
    });
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  
  handleMessage(fromSessionId, data) {
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
        const session = this.sessions.get(fromSessionId);
        if (session) {
          session.ws.send(JSON.stringify({ type: 'pong' }));
        }
        break;
        
      default:
        console.log(`[Room] Unknown message type: ${data.type}`);
    }
  }
  
  sendTo(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('[Room] Send error:', error);
      }
    }
  }
  
  broadcast(message, excludeSessionId = null) {
    const payload = JSON.stringify(message);
    for (const [sessionId, session] of this.sessions) {
      if (sessionId !== excludeSessionId) {
        try {
          session.ws.send(payload);
        } catch (error) {
          console.error('[Room] Broadcast error:', error);
        }
      }
    }
  }
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
    
    input[type="text"] {
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

    input[type="text"]:focus {
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

      .copy-link-btn {
        width: 100%;
        padding: 10px 16px;
        background: rgba(102, 126, 234, 0.1);
        color: #667eea;
        border: 1.5px solid #667eea;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }

      .copy-link-btn:hover {
        background: #667eea;
        color: white;
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
        padding: 36px 32px 40px;
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
        <button class="copy-link-btn" id="copyLinkBtn">🔗 Copy Link</button>
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
        <button class="dark-mode-toggle" id="darkModeToggle" title="Toggle dark mode"><i data-feather="moon"></i></button>
      </div>
    </div>

    <div class="right-panel">
    <div class="role-selector">
      <button class="role-btn active" id="sendRoleBtn">📤 Send</button>
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
        <p><strong>Click or drag to select a file</strong></p>
        <p style="font-size: 12px; color: #999; margin-top: 5px;">Direct P2P transfer</p>
      </div>
      <input type="file" id="fileInput">
      
      <div class="file-info" id="fileInfo">
        <div class="file-name" id="fileName"></div>
        <div class="file-size" id="fileSize"></div>
      </div>
      
      <button class="btn btn-waiting" id="sendBtn" disabled>Waiting for receiver...</button>
    </div>
    
    <!-- URL Mode -->
    <div class="section" id="urlSection">
      <p style="margin-bottom: 10px; color: #666; font-size: 14px;">Enter URL to share:</p>
      <div style="display: flex; gap: 8px; margin-bottom: 15px;">
        <input type="text" id="urlInput" placeholder="https://example.com"
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

    <!-- Receive Mode -->
    <div class="section" id="receiveSection">
      <p style="margin-bottom: 10px; color: #666; font-size: 14px;">Enter the 6-digit code from sender:</p>
      <input type="text" id="roomInput" placeholder="123456" maxlength="6" inputmode="numeric" pattern="[0-9]*">
      <button class="btn" id="joinBtn">Join Room</button>
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
      <!-- File: download button -->
      <div class="success-actions" id="successFileActions" style="display:none;">
        <a href="#" class="btn" id="successDownloadBtn" download>⬇ Download File</a>
      </div>
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

  <!-- Turnstile Widget (invisible, for cloud uploads only) -->
  <div class="cf-turnstile"
       id="turnstileWidget"
       data-sitekey="${turnstileSiteKey}"
       data-theme="light"
       data-size="invisible"
       data-callback="onTurnstileSuccess"
       style="display:none;">
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
    let selectedFile = null;
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
    const copyLinkBtn = document.getElementById('copyLinkBtn');
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
    const successDownloadBtn = document.getElementById('successDownloadBtn');
    const successTextActions = document.getElementById('successTextActions');
    const successTextDisplay = document.getElementById('successTextDisplay');
    const successCopyBtn = document.getElementById('successCopyBtn');
    const successResetBtn = document.getElementById('successResetBtn');
    
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

      if (type === 'file') {
        successIcon.textContent = '📦';
        successTitle.textContent = 'File Ready!';
        successMeta.textContent = data.fileName;
        successDownloadBtn.href = data.url;
        successDownloadBtn.download = data.fileName;
        successFileActions.style.display = 'flex';
      } else if (type === 'text') {
        successIcon.textContent = '📋';
        successTitle.textContent = 'Text Received!';
        successMeta.textContent = '';
        successTextDisplay.value = data.content;
        successTextActions.style.display = 'flex';
      }

      telehostPromo.style.display = 'block';
      receiveSuccessPanel.classList.add('active');
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
          const meta = manifest.files[0];
          const fileRes = await cache.match(meta.key);
          if (fileRes) {
            const blob = await fileRes.blob();
            const file = new File([blob], meta.name, { type: meta.type || blob.type || 'application/octet-stream' });

            sendModeBtn.click();
            try {
              const dt = new DataTransfer();
              dt.items.add(file);
              fileInput.files = dt.files;
            } catch (_) { /* DataTransfer not supported on some UA — selectedFile is still set */ }
            selectedFile = file;
            fileNameEl.textContent = file.name;
            fileSizeEl.textContent = formatFileSize(file.size);
            fileInfo.style.display = 'block';

            if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
              updateSendButton('p2p');
            } else if (ws && ws.readyState === WebSocket.OPEN) {
              updateSendButton('connecting');
            } else {
              updateSendButton('waiting');
            }

            showToast('Shared: ' + file.name);
            if (manifest.files.length > 1) {
              showError('Only the first of ' + manifest.files.length + ' shared files was loaded. Send them one at a time.');
            }
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
      if (!selectedFile) return;

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

        // Switch to send mode (receiver can still send files back)
        sendModeBtn.click();
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
        }
      };

      dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          
          // Handle URL message
          if (data.type === 'url') {
            statusText.textContent = '🔗 Received URL!';
            showToast('Redirecting to URL...');

            // Wait a moment then redirect
            setTimeout(() => {
              window.location.href = data.url;
            }, 1000);
            return;
          }

          // Handle text message
          if (data.type === 'text') {
            showReceivedText(data.content);
            return;
          }
          
          // Handle file metadata
          fileName = data.fileName;
          totalSize = data.fileSize;
          
          statusText.textContent = 'Receiving file via P2P...';
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
      if (!selectedFile) return;
      
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
      
      // Send metadata
      dataChannel.send(JSON.stringify({
        fileName: selectedFile.name,
        fileSize: selectedFile.size
      }));
      
      // Send file in chunks
      const reader = new FileReader();
      let offset = 0;
      
      reader.onload = (e) => {
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        
        const percent = (offset / selectedFile.size) * 100;
        progressFill.style.width = percent + '%';
        progressText.textContent = \`Sending... \${Math.round(percent)}%\`;
        
        if (offset < selectedFile.size) {
          readSlice(offset);
        } else {
          progressText.textContent = '✅ Transfer complete!';
          showToast('File sent successfully!');
          telehostPromo.style.display = 'block';
          setTimeout(() => {
            progress.style.display = 'none';
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send Another File';
          }, 2000);
        }
      };
      
      function readSlice(o) {
        const slice = selectedFile.slice(o, o + CONFIG.chunkSize);
        reader.readAsArrayBuffer(slice);
      }
      
      readSlice(0);
    }
    
    async function sendFileFallback() {
      try {
        // Check file size limit for R2
        if (selectedFile.size > CONFIG.maxFileSize) {
          showError('File too large for Cloud Relay (max 20MB). This file can only be sent via P2P.');
          sendBtn.disabled = false;
          return;
        }

        sendBtn.disabled = true;
        progress.style.display = 'block';
        progressText.textContent = 'Verifying...';

        // Get Turnstile token for bot protection
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

        progressText.textContent = 'Uploading to cloud...';

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('roomCode', roomCode);
        formData.append('fileName', selectedFile.name);
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

        if (result.success) {
          progressFill.style.width = '100%';
          progressText.textContent = '✅ Uploaded! Sharing link...';

          // Send download link to receiver via signaling
          ws.send(JSON.stringify({
            type: 'fallback-link',
            fileId: result.fileId,
            downloadUrl: result.downloadUrl,
            fileName: selectedFile.name
          }));

          showToast('File uploaded! Link sent to receiver.');

          setTimeout(() => {
            progress.style.display = 'none';
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send Another File';
          }, 2000);
        } else {
          throw new Error(result.error || 'Upload failed');
        }
        
      } catch (error) {
        console.error('❌ Fallback upload error:', error);

        // Provide helpful error message based on error type
        let errorMessage = error.message || 'Upload failed';
        if (error.message && error.message.includes('NetworkError')) {
          errorMessage = 'Network error. Please check your connection and try again.';
        } else if (error.message && error.message.includes('Bot verification')) {
          errorMessage = error.message; // Use specific bot verification error
        } else if (!error.message || error.message === 'Upload failed') {
          errorMessage = 'Upload failed. Please check your connection and try again.';
        }

        showError(errorMessage);
        sendBtn.disabled = false;
        progress.style.display = 'none';
      }
    }
    
    function handleFallbackLink(data) {
      statusText.textContent = 'File ready for download!';
      showToast('File received via Cloud Relay!');
      showReceiveSuccess('file', { fileName: data.fileName, url: data.downloadUrl });
    }

    function handleUrlFallback(data) {
      // Receiver gets URL redirect link (fallback)
      statusText.textContent = '🔗 Received URL (via cloud)!';
      showToast('Redirecting to URL...');

      // Wait a moment then redirect
      setTimeout(() => {
        window.location.href = data.redirectUrl;
      }, 1000);
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

      statusText.textContent = '✅ File ready!';
      showToast('File received!');
      showReceiveSuccess('file', { fileName, url });

      receivedChunks = [];
      receivedSize = 0;
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

    copyLinkBtn.addEventListener('click', () => {
      const url = window.location.origin + window.location.pathname + '?room=' + roomCode;
      navigator.clipboard.writeText(url).then(() => showToast('Link copied!')).catch(() => showToast('Copy failed'));
    });

    // QR Modal - Click outside to close
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) {
        closeQRModal();
      }
    });

    // QR Modal - Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && qrModal.classList.contains('show')) {
        closeQRModal();
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

    sendRoleBtn.addEventListener('click', () => {
      lastSendTypeBtn.click();
    });

    receiveRoleBtn.addEventListener('click', () => {
      receiveRoleBtn.classList.add('active');
      sendRoleBtn.classList.remove('active');
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
    });

    sendModeBtn.addEventListener('click', () => {
      activateSendRole();
      lastSendTypeBtn = sendModeBtn;
      sendModeBtn.classList.add('active');
      urlModeBtn.classList.remove('active');
      textModeBtn.classList.remove('active');
      sendSection.classList.add('active');
      urlSection.classList.remove('active');
      textSection.classList.remove('active');
    });

    urlModeBtn.addEventListener('click', () => {
      activateSendRole();
      lastSendTypeBtn = urlModeBtn;
      urlModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      textModeBtn.classList.remove('active');
      urlSection.classList.add('active');
      sendSection.classList.remove('active');
      textSection.classList.remove('active');
    });

    textModeBtn.addEventListener('click', () => {
      activateSendRole();
      lastSendTypeBtn = textModeBtn;
      textModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      urlModeBtn.classList.remove('active');
      textSection.classList.add('active');
      sendSection.classList.remove('active');
      urlSection.classList.remove('active');
      textInput.focus();
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

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        // Switch to send mode if not already there
        sendModeBtn.click();

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[0]);
        fileInput.files = dataTransfer.files;
        selectedFile = files[0];
        fileNameEl.textContent = selectedFile.name;
        fileSizeEl.textContent = formatFileSize(selectedFile.size);
        fileInfo.style.display = 'block';

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast('File selected: ' + selectedFile.name);
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
      
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        // Simulate file input change
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[0]);
        fileInput.files = dataTransfer.files;
        
        // Trigger change event
        selectedFile = files[0];
        fileNameEl.textContent = selectedFile.name;
        fileSizeEl.textContent = formatFileSize(selectedFile.size);
        fileInfo.style.display = 'block';

        // Update button based on current connection state
        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          // Connected via websocket but P2P not ready
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast('File selected: ' + selectedFile.name);
      }
    });
    
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        selectedFile = e.target.files[0];
        fileNameEl.textContent = selectedFile.name;
        fileSizeEl.textContent = formatFileSize(selectedFile.size);
        fileInfo.style.display = 'block';

        // Update button based on current connection state
        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          // Connected via websocket but P2P not ready
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

      sendModeBtn.click();
    });
  </script>
</body>
</html>`;
}