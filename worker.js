/**
 * SwiftDrop - P2P File Transfer with R2 Fallback
 * Cloudflare Worker + Durable Object + WebRTC + R2
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Enforce HTTPS. Redirecting here means WebSocket connections always use
    // wss:// (because the page itself is loaded over HTTPS) and mobile browsers
    // don't show the "not secure" warning. Skipped for localhost so
    // `wrangler dev` (no TLS) keeps working.
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'http:' && !isLocalhost) {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }

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

    // Public client config. Turnstile site keys are public by design, but
    // serving from env (not hardcoding in the static HTML) means rotation
    // never requires a code change.
    if (url.pathname === '/api/config') {
      return new Response(JSON.stringify({
        turnstileSiteKey: env.TURNSTILE_SITE_ID || ''
      }), {
        headers: {
          'Content-Type': 'application/json',
          // Never cache: rotated keys must take effect immediately
          'Cache-Control': 'no-store'
        }
      });
    }

    // Serve the UI (static asset; run_worker_first routes it through here
    // so the HTTPS redirect above applies)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(request);
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
      return Response.redirect(`${url.origin}/?shared=unavailable`, 303);
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
      // Same CSWSH protection as /ws
      if (!isAllowedWebSocketOrigin(request, env)) {
        return new Response('Forbidden: origin not allowed', { status: 403 });
      }
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
 *  - Same-origin requests are always allowed (by definition not cross-site),
 *    so the app keeps working on localhost dev and any new domain pointed at
 *    the worker without touching ALLOWED_ORIGINS.
 *  - If ALLOWED_ORIGINS is configured, a cross-origin request MUST match one
 *    of the configured origins.
 *  - If ALLOWED_ORIGINS is not configured, requests without an Origin header
 *    (non-browser clients) are allowed to preserve current behavior for
 *    local/dev setups.
 */
function isAllowedWebSocketOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (origin) {
    try {
      if (origin === new URL(request.url).origin) return true;
    } catch {
      return false;
    }
  }

  if (allowedOrigins.length > 0) {
    return Boolean(origin) && allowedOrigins.includes(origin);
  }

  // No explicit allowlist configured: allow non-browser clients (no Origin).
  return !origin;
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
