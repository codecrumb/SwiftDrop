/**
 * SwiftDrop - P2P File Transfer with R2 Fallback
 * Cloudflare Worker + Durable Object + WebRTC + R2
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual cleanup trigger (for testing)
    if (url.pathname === '/cleanup' && request.method === 'POST') {
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
      return new Response(getHTML(), {
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
          const { urlId, url: targetUrl, roomCode, timestamp } = data;

          if (!urlId || !targetUrl || !roomCode) {
            return new Response(JSON.stringify({ error: 'Missing required fields' }), {
              status: 400,
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

          return new Response(JSON.stringify({
            success: true,
            urlId,
            redirectUrl: `/url-redirect/${urlId}`
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        // Handle file upload (FormData)
        const formData = await request.formData();
        const file = formData.get('file');
        const roomCode = formData.get('roomCode');
        const fileName = formData.get('fileName');

        if (!file || !roomCode) {
          return new Response(JSON.stringify({ error: 'Missing file or room code' }), {
            status: 400,
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
            fileName: fileName || file.name,
            uploadedAt: timestamp.toString(),
            expiresAt: (timestamp + 20 * 60 * 1000).toString() // 20 minutes
          }
        });

        return new Response(JSON.stringify({
          success: true,
          fileId,
          downloadUrl: `/download/${fileId}`
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
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
        headers.set('Content-Disposition', `attachment; filename="${object.customMetadata?.fileName || 'download'}"`);
        headers.set('Access-Control-Allow-Origin', '*');

        // Read the entire file into array buffer (files are < 20MB so this is safe)
        const arrayBuffer = await object.arrayBuffer();

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
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
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
 * Cleanup expired files from R2 storage
 */
async function cleanupExpiredFiles(env) {
  try {
    const now = Date.now();
    let deletedCount = 0;
    let cursor;
    let truncated = true;

    // List all objects in R2 bucket
    do {
      const listed = await env.FILE_STORAGE.list({
        cursor: cursor,
        limit: 1000
      });

      // Check each object for expiration
      for (const object of listed.objects) {
        try {
          // Get the full object to read metadata
          const fullObject = await env.FILE_STORAGE.get(object.key);

          if (!fullObject) continue;

          const expiresAt = parseInt(fullObject.customMetadata?.expiresAt || '0');

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
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SwiftDrop - P2P File Transfer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      max-width: 500px;
      width: 100%;
    }
    
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    
    .status {
      background: #f0f9ff;
      border: 2px solid #7dd3fc;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
      text-align: center;
    }
    
    .status.connected {
      background: #f0fdf4;
      border-color: #86efac;
    }
    
    .status.fallback {
      background: #fef3c7;
      border-color: #fbbf24;
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
      color: #666;
      margin-top: 8px;
    }
    
    .mode-selector {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    
    .mode-btn {
      flex: 1;
      padding: 12px;
      border: 2px solid #ddd;
      background: white;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
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
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 16px;
      font-family: monospace;
      text-transform: uppercase;
      letter-spacing: 2px;
      text-align: center;
      margin-bottom: 15px;
    }
    
    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }
    
    .upload-area {
      border: 3px dashed #ddd;
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      margin-bottom: 15px;
    }
    
    .upload-area:hover {
      border-color: #667eea;
      background: #f8f9ff;
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
      transition: transform 0.2s;
    }
    
    .btn:hover:not(:disabled) {
      transform: translateY(-2px);
    }
    
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
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
      background: #f9fafb;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      display: none;
    }
    
    .file-name {
      font-weight: 600;
      color: #333;
      word-break: break-all;
      margin-bottom: 5px;
    }
    
    .file-size {
      color: #666;
      font-size: 14px;
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
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 SwiftDrop</h1>
    <p class="subtitle">Instant P2P file transfer • Files auto-delete after download</p>
    
    <div class="status" id="status">
      <div id="statusText">Generating room code...</div>
      <div class="room-code" id="roomCode">------</div>
      <div class="peer-info" id="peerInfo">Waiting for connection...</div>
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
      <input type="text" id="urlInput" placeholder="https://example.com" 
             style="text-transform: none; letter-spacing: normal; margin-bottom: 20px;">
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

  <script>
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
    
    // Elements
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const roomCodeEl = document.getElementById('roomCode');
    const peerInfo = document.getElementById('peerInfo');
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
    
    function init() {
      roomCode = generateRoomCode();
      roomCodeEl.textContent = roomCode;
      connectWebSocket(roomCode);
    }
    
    function generateRoomCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    }
    
    function connectWebSocket(room) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws?room=\${room}\`);
      
      ws.onopen = () => {
        console.log('✅ WebSocket connected');
        statusText.textContent = isSender ? 'Share this code with receiver:' : 'Connected to room:';
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleSignalingMessage(data);
      };
      
      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        showError('Connection error. Please refresh.');
      };
      
      ws.onclose = () => {
        console.log('WebSocket closed');
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
          peerInfo.textContent = 'Peer connected! Establishing P2P...';
          status.classList.add('connected');
          roomCodeEl.classList.add('connected');
          showToast('Peer joined! Connecting...');
          
          if (isSender) {
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
          peerInfo.textContent = 'Peer disconnected';
          status.classList.remove('connected');
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
            console.log('⏱️ P2P timeout, will use fallback');
            peerInfo.textContent = 'P2P failed, using cloud fallback';
            status.classList.add('fallback');
            showToast('Using cloud storage fallback');
            
            if (selectedFile) {
              sendBtn.disabled = false;
              sendBtn.textContent = 'Send via Cloud';
            }
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
        peerInfo.textContent = '✅ Ready for P2P transfer!';
        
        if (p2pTimeout) clearTimeout(p2pTimeout);
        
        if (isSender && selectedFile) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send File (P2P)';
        }
        
        if (isSender && urlInput.value.trim()) {
          sendUrlBtn.disabled = false;
          sendUrlBtn.textContent = 'Send URL (P2P)';
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
      console.log('❌ P2P connection failed, using fallback');
      isP2PConnected = false;
      peerInfo.textContent = 'P2P failed, using cloud fallback';
      status.classList.add('fallback');
      
      if (isSender && selectedFile) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send via Cloud Storage';
      }
      
      if (isSender && urlInput.value.trim()) {
        // URL mode doesn't have cloud fallback, just disable
        sendUrlBtn.disabled = true;
        sendUrlBtn.textContent = 'P2P Required for URLs';
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
          showError('File too large for cloud fallback (max 20MB). This file can only be sent via P2P.');
          sendBtn.disabled = false;
          return;
        }

        sendBtn.disabled = true;
        progress.style.display = 'block';
        progressText.textContent = 'Uploading to cloud...';
        
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('roomCode', roomCode);
        formData.append('fileName', selectedFile.name);
        
        const response = await fetch('/upload', {
          method: 'POST',
          body: formData
        });
        
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
        showError('Upload failed. Please try again.');
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
      showToast('File received via cloud storage!');
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
      const url = urlInput.value.trim();

      if (!url) {
        showError('Please enter a URL');
        return;
      }

      // Basic URL validation
      try {
        new URL(url);
      } catch (e) {
        showError('Please enter a valid URL (e.g., https://example.com)');
        return;
      }

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
              timestamp: timestamp
            })
          });

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

            showToast('URL shared via cloud storage!');

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
          showError('Failed to share URL. Please try again.');
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
        
        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send File (P2P)';
        } else {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send via Cloud';
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
        
        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send File (P2P)';
        } else {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send via Cloud';
        }
      }
    });
    
    sendBtn.addEventListener('click', sendFile);
    
    // URL input handling
    urlInput.addEventListener('input', () => {
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open' && urlInput.value.trim()) {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Send URL (P2P)';
      } else if (urlInput.value.trim()) {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Enter valid URL';
      } else {
        sendUrlBtn.disabled = true;
      }
    });
    
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
      
      if (ws) ws.close();
      
      connectWebSocket(code);
      statusText.textContent = 'Connecting to room...';
      peerInfo.textContent = 'Waiting for sender...';
      
      sendModeBtn.click();
    });
  </script>
</body>
</html>`;
}
