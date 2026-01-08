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

    // Serve the UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHTML(env), {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // WebSocket upgrade for signaling
    if (url.pathname === '/ws') {
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
              ...getCorsHeaders(request)
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
            ...getCorsHeaders(request)
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
        const corsHeaders = getCorsHeaders(request);
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
        headers: getCorsHeaders(request)
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
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = [
    'https://f.REDACTED.com',
    'https://swiftdrop.REDACTED.com',
    'https://swiftdrop.vop.workers.dev'
  ];

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
  <title>SwiftDrop - P2P File Transfer</title>
  <link rel="icon" href="https://faviconser.pages.dev/swiftdrop/favicon.ico">
  <link rel="icon" type="image/png" sizes="16x16" href="https://faviconser.pages.dev/swiftdrop/favicon-16.png">
  <link rel="icon" type="image/png" sizes="32x32" href="https://faviconser.pages.dev/swiftdrop/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="https://faviconser.pages.dev/swiftdrop/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="192x192" href="https://faviconser.pages.dev/swiftdrop/icon-192.png">
  <link rel="icon" type="image/png" sizes="512x512" href="https://faviconser.pages.dev/swiftdrop/icon-512.png">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
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

    .dark-mode-toggle {
      position: absolute;
      top: 20px;
      right: 20px;
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

    .mode-selector {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }

    .mode-btn {
      flex: 1;
      padding: 12px;
      border: 2px solid var(--border-color);
      background: var(--container-bg);
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      color: var(--text-primary);
      transition: all 0.2s;
    }
    
    .mode-btn.active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
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
      left: 50%;
      transform: translateX(-50%);
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      padding: 20px 24px;
      max-width: 500px;
      width: 90%;
      z-index: 3000;
      display: none;
      border: 2px solid #e5e7eb;
    }

    .cookie-banner.show {
      display: block;
      animation: slideUp 0.3s ease-out;
    }

    @keyframes slideUp {
      from {
        transform: translateX(-50%) translateY(100px);
        opacity: 0;
      }
      to {
        transform: translateX(-50%) translateY(0);
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
      color: #333;
      margin-bottom: 5px;
      font-size: 15px;
    }

    .cookie-banner-message {
      color: #666;
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
  </style>
</head>
<body>
  <div class="container">
    <button class="dark-mode-toggle" id="darkModeToggle" title="Toggle dark mode">🌙</button>
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

    <div class="mode-selector">
      <button class="mode-btn active" id="sendModeBtn">📤 Send File</button>
      <button class="mode-btn" id="urlModeBtn">🔗 Send URL</button>
      <button class="mode-btn" id="receiveModeBtn">📥 Receive</button>
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
      
      <button class="btn" id="sendBtn" disabled>Waiting for receiver...</button>
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
      <button class="btn" id="sendUrlBtn" disabled>Waiting for receiver...</button>
      <p style="margin-top: 10px; font-size: 12px; color: #999; text-align: center;">
        Receiver will be redirected to this URL
      </p>
    </div>
    
    <!-- Receive Mode -->
    <div class="section" id="receiveSection">
      <p style="margin-bottom: 10px; color: #666; font-size: 14px;">Enter the 6-digit code from sender:</p>
      <input type="text" id="roomInput" placeholder="ABC123" maxlength="6">
      <button class="btn" id="joinBtn">Join Room</button>
    </div>
    
    <div class="progress" id="progress">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <div class="progress-text" id="progressText">Transferring...</div>
    </div>
    
    <div class="download-area" id="downloadArea">
      <div style="font-size: 48px; margin-bottom: 10px;">📦</div>
      <div style="font-weight: 600; margin-bottom: 5px;" id="downloadFileName"></div>
      <a href="#" class="download-btn" id="downloadBtn" download>Download File</a>
    </div>
    
    <div class="error" id="error"></div>
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

    // Apply saved theme or default to light mode
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
      darkModeToggle.textContent = '☀️';
    }

    // Toggle dark mode
    darkModeToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark-mode');
      const isDark = document.body.classList.contains('dark-mode');
      darkModeToggle.textContent = isDark ? '☀️' : '🌙';
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
    const cookieBanner = document.getElementById('cookieBanner');
    const cookieBannerClose = document.getElementById('cookieBannerClose');
    const sendModeBtn = document.getElementById('sendModeBtn');
    const urlModeBtn = document.getElementById('urlModeBtn');
    const receiveModeBtn = document.getElementById('receiveModeBtn');
    const sendSection = document.getElementById('sendSection');
    const urlSection = document.getElementById('urlSection');
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
    const roomInput = document.getElementById('roomInput');
    const joinBtn = document.getElementById('joinBtn');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const downloadArea = document.getElementById('downloadArea');
    const downloadFileName = document.getElementById('downloadFileName');
    const downloadBtn = document.getElementById('downloadBtn');
    const errorDiv = document.getElementById('error');
    const toast = document.getElementById('toast');
    
    // Initialize
    init();

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

    // Helper function to generate QR code in modal
    function generateQRCode(roomCode) {
      // Clear existing QR code
      qrcodeDiv.innerHTML = '';

      // Generate full URL with room parameter
      const fullUrl = window.location.origin + window.location.pathname + '?room=' + roomCode;

      // Create QR code
      new QRCode(qrcodeDiv, {
        text: fullUrl,
        width: 220,
        height: 220,
        colorDark: '#667eea',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
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
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
          peerInfo.textContent = '✅ P2P connection established!';
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
      // Receiver gets download link
      downloadArea.style.display = 'block';
      downloadFileName.textContent = data.fileName;
      downloadBtn.href = data.downloadUrl;
      downloadBtn.download = data.fileName;

      statusText.textContent = 'File ready for download!';
      showToast('File received via Cloud Relay!');
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

    function downloadReceivedFile() {
      const blob = new Blob(receivedChunks);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      
      progress.style.display = 'none';
      statusText.textContent = '✅ File downloaded!';
      showToast('File downloaded successfully!');
      
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

    sendModeBtn.addEventListener('click', () => {
      sendModeBtn.classList.add('active');
      urlModeBtn.classList.remove('active');
      receiveModeBtn.classList.remove('active');
      sendSection.classList.add('active');
      urlSection.classList.remove('active');
      receiveSection.classList.remove('active');
    });

    urlModeBtn.addEventListener('click', () => {
      urlModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      receiveModeBtn.classList.remove('active');
      urlSection.classList.add('active');
      sendSection.classList.remove('active');
      receiveSection.classList.remove('active');
    });

    receiveModeBtn.addEventListener('click', () => {
      receiveModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      urlModeBtn.classList.remove('active');
      receiveSection.classList.add('active');
      sendSection.classList.remove('active');
      urlSection.classList.remove('active');
    });
    
    // File selection - click
    uploadArea.addEventListener('click', () => fileInput.click());
    
    // Drag and drop support
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
    
    joinBtn.addEventListener('click', () => {
      const code = roomInput.value.trim().toUpperCase();
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