/**
 * Temporary File Drop - Cloudflare Worker with R2
 * Enhanced with Device Pairing & Link Sharing
 * 
 * Setup Instructions:
 * 1. Create an R2 bucket in your Cloudflare dashboard
 * 2. In wrangler.toml, add:
 *    [[r2_buckets]]
 *    binding = "FILE_BUCKET"
 *    bucket_name = "your-bucket-name"
 * 3. Deploy with: wrangler deploy
 */

// Configuration
const CONFIG = {
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB limit
  EXPIRY_HOURS: 2, // Files expire after 2 hours
  CLEANUP_INTERVAL: 3600000 // Cleanup check every hour (in ms)
};

// Main request handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    try {
      // Route handling
      if (request.method === 'GET' && url.pathname === '/') {
        return serveHTML(request);
      }
      
      if (request.method === 'POST' && url.pathname === '/upload') {
        return handleUpload(request, env);
      }
      
      if (request.method === 'GET' && url.pathname.startsWith('/download/')) {
        return handleDownload(request, env, url);
      }
      
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Scheduled cleanup of expired files
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredFiles(env));
  }
};

/**
 * Serve the HTML UI
 */
function serveHTML(request) {
  // Generate or retrieve device ID from cookie
  const cookies = request.headers.get('Cookie') || '';
  let deviceId = cookies.match(/deviceId=([^;]+)/)?.[1];
  
  if (!deviceId) {
    deviceId = generateDeviceId();
  }
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Temporary File Drop</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
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
      max-width: 550px;
      width: 100%;
    }
    
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    
    .subtitle {
      color: #666;
      margin-bottom: 20px;
      font-size: 14px;
    }
    
    .device-info {
      background: #f0f9ff;
      border: 2px solid #7dd3fc;
      border-radius: 8px;
      padding: 12px 15px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .device-label {
      font-size: 13px;
      color: #0c4a6e;
      font-weight: 600;
    }
    
    .device-code {
      font-family: monospace;
      font-size: 16px;
      font-weight: bold;
      color: #0369a1;
      letter-spacing: 1px;
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
      font-size: 14px;
    }
    
    .mode-btn.active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-color: #667eea;
    }
    
    .mode-btn:hover:not(.active) {
      border-color: #667eea;
      background: #f8f9ff;
    }
    
    .section {
      display: none;
    }
    
    .section.active {
      display: block;
    }
    
    .input-group {
      margin-bottom: 15px;
    }
    
    .input-label {
      display: block;
      margin-bottom: 6px;
      color: #555;
      font-size: 14px;
      font-weight: 600;
    }
    
    .input-label .optional {
      color: #999;
      font-weight: normal;
      font-size: 12px;
    }
    
    input[type="text"], input[type="url"] {
      width: 100%;
      padding: 12px;
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.2s;
    }
    
    input[type="text"]:focus, input[type="url"]:focus {
      outline: none;
      border-color: #667eea;
    }
    
    .upload-area {
      border: 3px dashed #ddd;
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      transition: all 0.3s;
      cursor: pointer;
      margin-bottom: 15px;
    }
    
    .upload-area:hover, .upload-area.drag-over {
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
      transition: width 0.3s;
      width: 0%;
    }
    
    .progress-text {
      text-align: center;
      margin-top: 8px;
      color: #666;
      font-size: 14px;
    }
    
    .result {
      display: none;
      background: #f0fdf4;
      border: 2px solid #86efac;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
    }
    
    .result h3 {
      color: #166534;
      margin-bottom: 10px;
      font-size: 18px;
    }
    
    .link-box {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }
    
    .link-input {
      flex: 1;
      padding: 10px;
      border: 1px solid #86efac;
      border-radius: 6px;
      font-size: 14px;
      font-family: monospace;
    }
    
    .copy-btn {
      background: #166534;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      white-space: nowrap;
    }
    
    .copy-btn:hover {
      background: #14532d;
    }
    
    .warning {
      color: #dc2626;
      font-size: 13px;
      margin-top: 10px;
    }
    
    .info {
      color: #0369a1;
      font-size: 13px;
      margin-top: 10px;
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
    
    .file-info {
      margin: 15px 0;
      padding: 15px;
      background: #f9fafb;
      border-radius: 8px;
    }
    
    .file-name {
      font-weight: 600;
      color: #333;
      margin-bottom: 5px;
      word-break: break-all;
    }
    
    .file-size {
      color: #666;
      font-size: 14px;
    }
    
    .hint {
      font-size: 12px;
      color: #999;
      margin-top: 5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📤 Temporary File Drop</h1>
    <p class="subtitle">Share files & links instantly. Expires in 2 hours.</p>
    
    <div class="device-info">
      <div>
        <div class="device-label">Your Device Code:</div>
      </div>
      <div class="device-code" id="deviceCode">${deviceId}</div>
    </div>
    
    <div class="mode-selector">
      <button class="mode-btn active" id="fileModeBtn">📁 File Upload</button>
      <button class="mode-btn" id="linkModeBtn">🔗 Share Link</button>
    </div>
    
    <!-- File Upload Section -->
    <div class="section active" id="fileSection">
      <div class="input-group">
        <label class="input-label">
          Target Device Code <span class="optional">(optional)</span>
        </label>
        <input type="text" id="targetDeviceFile" placeholder="Enter device code to restrict access">
        <div class="hint">Leave empty for public access</div>
      </div>
      
      <div class="upload-area" id="uploadArea">
        <div class="upload-icon">📁</div>
        <p><strong>Click to select</strong> or drag and drop</p>
        <p style="font-size: 12px; color: #999; margin-top: 5px;">Max size: 100MB</p>
      </div>
      
      <input type="file" id="fileInput">
      
      <div class="file-info" id="fileInfo" style="display: none;">
        <div class="file-name" id="fileName"></div>
        <div class="file-size" id="fileSize"></div>
      </div>
      
      <button class="btn" id="uploadBtn" disabled>Select a file first</button>
    </div>
    
    <!-- Link Share Section -->
    <div class="section" id="linkSection">
      <div class="input-group">
        <label class="input-label">
          Target Device Code <span class="optional">(optional)</span>
        </label>
        <input type="text" id="targetDeviceLink" placeholder="Enter device code to restrict access">
        <div class="hint">Leave empty for public access</div>
      </div>
      
      <div class="input-group">
        <label class="input-label">Link URL</label>
        <input type="url" id="linkUrl" placeholder="https://example.com">
        <div class="hint">Enter the URL you want to share</div>
      </div>
      
      <button class="btn" id="shareLinkBtn">Share Link</button>
    </div>
    
    <div class="progress" id="progress">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <div class="progress-text" id="progressText">Uploading...</div>
    </div>
    
    <div class="result" id="result">
      <h3 id="resultTitle">✅ Success!</h3>
      <p style="margin: 10px 0; color: #166534;" id="resultMessage">Share this link:</p>
      <div class="link-box">
        <input type="text" class="link-input" id="downloadLink" readonly>
        <button class="copy-btn" id="copyBtn">Copy</button>
      </div>
      <p class="warning">⚠️ This link will expire in 2 hours</p>
      <p class="info" id="pairingInfo" style="display: none;">🔒 Only accessible by device: <strong id="pairedDevice"></strong></p>
    </div>
    
    <div class="error" id="error"></div>
  </div>

  <script>
    // Set device ID cookie
    const deviceId = '${deviceId}';
    document.cookie = \`deviceId=\${deviceId}; path=/; max-age=\${365*24*60*60}; SameSite=Lax\`;
    
    // Elements
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('uploadArea');
    const uploadBtn = document.getElementById('uploadBtn');
    const fileModeBtn = document.getElementById('fileModeBtn');
    const linkModeBtn = document.getElementById('linkModeBtn');
    const fileSection = document.getElementById('fileSection');
    const linkSection = document.getElementById('linkSection');
    const shareLinkBtn = document.getElementById('shareLinkBtn');
    const linkUrl = document.getElementById('linkUrl');
    const targetDeviceFile = document.getElementById('targetDeviceFile');
    const targetDeviceLink = document.getElementById('targetDeviceLink');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const result = document.getElementById('result');
    const resultTitle = document.getElementById('resultTitle');
    const resultMessage = document.getElementById('resultMessage');
    const downloadLink = document.getElementById('downloadLink');
    const copyBtn = document.getElementById('copyBtn');
    const errorDiv = document.getElementById('error');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const pairingInfo = document.getElementById('pairingInfo');
    const pairedDevice = document.getElementById('pairedDevice');
    
    let selectedFile = null;
    const MAX_SIZE = 100 * 1024 * 1024; // 100MB
    
    // Mode switching
    fileModeBtn.addEventListener('click', () => {
      fileModeBtn.classList.add('active');
      linkModeBtn.classList.remove('active');
      fileSection.classList.add('active');
      linkSection.classList.remove('active');
      resetUI();
    });
    
    linkModeBtn.addEventListener('click', () => {
      linkModeBtn.classList.add('active');
      fileModeBtn.classList.remove('active');
      linkSection.classList.add('active');
      fileSection.classList.remove('active');
      resetUI();
    });
    
    // File upload handlers
    uploadArea.addEventListener('click', () => fileInput.click());
    
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });
    
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('drag-over');
    });
    
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });
    
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
      }
    });
    
    function handleFileSelect(file) {
      if (file.size > MAX_SIZE) {
        showError('File is too large. Maximum size is 100MB.');
        return;
      }
      
      selectedFile = file;
      fileName.textContent = file.name;
      fileSize.textContent = formatFileSize(file.size);
      fileInfo.style.display = 'block';
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload File';
      result.style.display = 'none';
      errorDiv.style.display = 'none';
    }
    
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }
    
    uploadBtn.addEventListener('click', async () => {
      if (!selectedFile) return;
      
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('deviceId', deviceId);
      
      const targetDevice = targetDeviceFile.value.trim();
      if (targetDevice) {
        formData.append('targetDevice', targetDevice);
      }
      
      uploadBtn.disabled = true;
      progress.style.display = 'block';
      result.style.display = 'none';
      errorDiv.style.display = 'none';
      
      try {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            progressFill.style.width = percent + '%';
            progressText.textContent = 'Uploading... ' + Math.round(percent) + '%';
          }
        });
        
        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            showSuccess(data.downloadUrl, targetDevice, 'File uploaded successfully!');
            progress.style.display = 'none';
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload Another File';
            fileInfo.style.display = 'none';
            selectedFile = null;
            fileInput.value = '';
            targetDeviceFile.value = '';
          } else {
            const error = JSON.parse(xhr.responseText);
            showError(error.error || 'Upload failed');
            progress.style.display = 'none';
            uploadBtn.disabled = false;
          }
        });
        
        xhr.addEventListener('error', () => {
          showError('Network error. Please try again.');
          progress.style.display = 'none';
          uploadBtn.disabled = false;
        });
        
        xhr.open('POST', '/upload');
        xhr.send(formData);
        
      } catch (error) {
        showError(error.message);
        progress.style.display = 'none';
        uploadBtn.disabled = false;
      }
    });
    
    // Link sharing handler
    shareLinkBtn.addEventListener('click', async () => {
      const url = linkUrl.value.trim();
      
      if (!url) {
        showError('Please enter a URL');
        return;
      }
      
      try {
        new URL(url); // Validate URL
      } catch {
        showError('Please enter a valid URL (must start with http:// or https://)');
        return;
      }
      
      const targetDevice = targetDeviceLink.value.trim();
      
      shareLinkBtn.disabled = true;
      progress.style.display = 'block';
      progressText.textContent = 'Creating link...';
      progressFill.style.width = '100%';
      result.style.display = 'none';
      errorDiv.style.display = 'none';
      
      try {
        const formData = new FormData();
        formData.append('link', url);
        formData.append('deviceId', deviceId);
        
        if (targetDevice) {
          formData.append('targetDevice', targetDevice);
        }
        
        const response = await fetch('/upload', {
          method: 'POST',
          body: formData
        });
        
        const data = await response.json();
        
        if (response.ok) {
          showSuccess(data.downloadUrl, targetDevice, 'Link created successfully!');
          linkUrl.value = '';
          targetDeviceLink.value = '';
        } else {
          showError(data.error || 'Failed to create link');
        }
        
      } catch (error) {
        showError(error.message);
      } finally {
        progress.style.display = 'none';
        shareLinkBtn.disabled = false;
      }
    });
    
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(downloadLink.value);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => {
          copyBtn.textContent = originalText;
        }, 2000);
      } catch (error) {
        downloadLink.select();
        document.execCommand('copy');
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 2000);
      }
    });
    
    function showSuccess(url, targetDevice, title) {
      resultTitle.textContent = '✅ ' + title;
      downloadLink.value = url;
      result.style.display = 'block';
      
      if (targetDevice) {
        pairingInfo.style.display = 'block';
        pairedDevice.textContent = targetDevice;
      } else {
        pairingInfo.style.display = 'none';
      }
    }
    
    function showError(message) {
      errorDiv.textContent = '❌ ' + message;
      errorDiv.style.display = 'block';
    }
    
    function resetUI() {
      result.style.display = 'none';
      errorDiv.style.display = 'none';
      progress.style.display = 'none';
      fileInfo.style.display = 'none';
      selectedFile = null;
      fileInput.value = '';
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Select a file first';
    }
  </script>
</body>
</html>`;
  
  const headers = new Headers({ 'Content-Type': 'text/html;charset=UTF-8' });
  
  // Set device ID cookie if not present
  if (!cookies.includes('deviceId=')) {
    headers.set('Set-Cookie', `deviceId=${deviceId}; Path=/; Max-Age=${365*24*60*60}; SameSite=Lax`);
  }
  
  return new Response(html, { headers });
}

/**
 * Handle file upload or link share
 */
async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const link = formData.get('link');
    const deviceId = formData.get('deviceId') || 'unknown';
    const targetDevice = formData.get('targetDevice') || '';
    
    // Validate that either file or link is provided
    if (!file && !link) {
      return new Response(JSON.stringify({ error: 'No file or link provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Generate unique ID
    const itemId = generateId();
    const timestamp = Date.now();
    const expiresAt = timestamp + (CONFIG.EXPIRY_HOURS * 60 * 60 * 1000);
    
    if (link) {
      // Handle link share
      const linkData = JSON.stringify({
        type: 'link',
        url: link,
        uploadedBy: deviceId,
        targetDevice: targetDevice,
        uploadedAt: timestamp,
        expiresAt: expiresAt
      });
      
      await env.FILE_BUCKET.put(itemId, linkData, {
        httpMetadata: {
          contentType: 'application/json'
        },
        customMetadata: {
          type: 'link',
          uploadedBy: deviceId,
          targetDevice: targetDevice,
          uploadedAt: timestamp.toString(),
          expiresAt: expiresAt.toString()
        }
      });
    } else {
      // Handle file upload
      if (file.size > CONFIG.MAX_FILE_SIZE) {
        return new Response(JSON.stringify({ error: 'File too large. Maximum size is 100MB.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const fileData = await file.arrayBuffer();
      await env.FILE_BUCKET.put(itemId, fileData, {
        httpMetadata: {
          contentType: file.type || 'application/octet-stream'
        },
        customMetadata: {
          type: 'file',
          originalName: file.name,
          uploadedBy: deviceId,
          targetDevice: targetDevice,
          uploadedAt: timestamp.toString(),
          expiresAt: expiresAt.toString()
        }
      });
    }
    
    // Generate download URL
    const downloadUrl = new URL(`/download/${itemId}`, request.url).toString();
    
    return new Response(JSON.stringify({
      success: true,
      itemId: itemId,
      downloadUrl: downloadUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      targetDevice: targetDevice || null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(JSON.stringify({ error: 'Upload failed: ' + error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Handle file download or link redirect
 */
async function handleDownload(request, env, url) {
  const itemId = url.pathname.split('/download/')[1];
  
  if (!itemId) {
    return new Response('Invalid download link', { status: 400 });
  }
  
  try {
    const object = await env.FILE_BUCKET.get(itemId);
    
    if (!object) {
      return new Response('File not found or expired', { status: 404 });
    }
    
    // Check if item has expired
    const expiresAt = parseInt(object.customMetadata?.expiresAt || '0');
    if (expiresAt && Date.now() > expiresAt) {
      await env.FILE_BUCKET.delete(itemId);
      return new Response('Link has expired', { status: 410 });
    }
    
    // Check device pairing
    const targetDevice = object.customMetadata?.targetDevice || '';
    if (targetDevice) {
      const cookies = request.headers.get('Cookie') || '';
      const requestDeviceId = cookies.match(/deviceId=([^;]+)/)?.[1];
      
      if (!requestDeviceId || requestDeviceId !== targetDevice) {
        return new Response('Access denied. This item is restricted to a specific device.', { 
          status: 403,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    }
    
    // Check if this is a link redirect
    const itemType = object.customMetadata?.type || 'file';
    
    if (itemType === 'link') {
      const linkData = JSON.parse(await object.text());
      
      // Redirect to the stored link
      return new Response(null, {
        status: 302,
        headers: {
          'Location': linkData.url,
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }
    
    // Return file with appropriate headers
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${object.customMetadata?.originalName || 'download'}"`);
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    return new Response(object.body, { headers });
    
  } catch (error) {
    console.error('Download error:', error);
    return new Response('Download failed: ' + error.message, { status: 500 });
  }
}

/**
 * Clean up expired files (called by cron trigger)
 */
async function cleanupExpiredFiles(env) {
  try {
    const list = await env.FILE_BUCKET.list();
    const now = Date.now();
    let deletedCount = 0;
    
    for (const object of list.objects) {
      const fullObject = await env.FILE_BUCKET.get(object.key);
      if (fullObject) {
        const expiresAt = parseInt(fullObject.customMetadata?.expiresAt || '0');
        if (expiresAt && now > expiresAt) {
          await env.FILE_BUCKET.delete(object.key);
          deletedCount++;
        }
      }
    }
    
    console.log(`Cleanup completed: ${deletedCount} expired files deleted`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

/**
 * Generate a unique ID for files
 */
function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result + '-' + Date.now();
}

/**
 * Generate a unique device ID (6-character code)
 */
function generateDeviceId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Remove ambiguous characters
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
