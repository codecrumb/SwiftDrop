# SwiftDrop Troubleshooting Guide

Common issues and their solutions when deploying and using SwiftDrop.

## Table of Contents

- [Deployment Issues](#deployment-issues)
- [P2P Connection Issues](#p2p-connection-issues)
- [R2 Fallback Issues](#r2-fallback-issues)
- [WebSocket Issues](#websocket-issues)
- [Performance Issues](#performance-issues)
- [Browser-Specific Issues](#browser-specific-issues)

---

## Deployment Issues

### ❌ Error: "No account_id found in wrangler.toml"

**Symptom:** Deployment fails with missing account ID error

**Solution:**
```bash
# 1. Get your account ID
wrangler whoami

# 2. Update wrangler.toml
# Replace account_id value with your actual account ID
```

**Alternative:** Let Wrangler auto-detect:
```bash
wrangler init
# Follow prompts to link your account
```

---

### ❌ Error: "A request to the Cloudflare API failed"

**Symptom:** API errors during deployment

**Solutions:**

1. **Check authentication:**
```bash
wrangler logout
wrangler login
```

2. **Verify account permissions:**
   - Ensure you have Workers permissions
   - Check if account is in good standing

3. **Check API status:**
   - Visit https://www.cloudflarestatus.com/

---

### ❌ Error: "R2 bucket 'swiftdrop-files' not found"

**Symptom:** Worker deploys but fails at runtime with R2 errors

**Solution:**
```bash
# Create the bucket
wrangler r2 bucket create swiftdrop-files

# Verify it exists
wrangler r2 bucket list

# Check binding name matches wrangler.toml
# Should be: binding = "FILE_STORAGE"
```

---

### ❌ Durable Object Migration Errors

**Symptom:** Error about Durable Object class not found or migration issues

**Solution:**
```bash
# Method 1: Force redeploy
wrangler delete
wrangler deploy

# Method 2: Check migrations in wrangler.toml
# Ensure [[migrations]] section exists

# Method 3: Update migration tag
# Change tag = "v1" to tag = "v2" in wrangler.toml
# Then redeploy
```

---

## P2P Connection Issues

### ❌ P2P Always Timing Out

**Symptom:** Connections always fall back to R2, never use P2P

**Debugging Steps:**

1. **Check browser console:**
```javascript
// Look for errors like:
// "ICE failed"
// "Connection failed"
// "DataChannel error"
```

2. **Test STUN server accessibility:**
```bash
# In browser console:
fetch('https://stun.l.google.com:19302')
  .catch(e => console.log('STUN blocked:', e))
```

3. **Network restrictions:**
   - Corporate firewalls often block WebRTC
   - VPNs may interfere
   - Test from different network (mobile hotspot)

4. **Browser settings:**
   - Check if WebRTC is disabled in browser settings
   - Privacy extensions may block WebRTC

**Solutions:**

1. **Add more STUN servers:**
```javascript
// In worker.js CONFIG
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' }
]
```

2. **Add TURN server (for strict firewalls):**
```javascript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-turn-server.com:3478',
    username: 'user',
    credential: 'pass'
  }
]
```

3. **Increase timeout:**
```javascript
// In worker.js CONFIG
p2pTimeout: 10000, // 10 seconds instead of 5
```

---

### ❌ ICE Candidates Not Exchanging

**Symptom:** Connection stuck at "gathering" or "checking" state

**Debugging:**
```javascript
// Add to peer connection setup:
pc.onicegatheringstatechange = () => {
  console.log('ICE gathering:', pc.iceGatheringState);
};

pc.oniceconnectionstatechange = () => {
  console.log('ICE connection:', pc.iceConnectionState);
};
```

**Expected flow:**
1. `new` → `gathering` → `complete`
2. `new` → `checking` → `connected`

**If stuck at `gathering`:**
- STUN servers not accessible
- Network blocking UDP

**If stuck at `checking`:**
- NAT traversal failing
- Need TURN server
- Firewall blocking connections

---

### ❌ DataChannel Opens but Transfer Fails

**Symptom:** Connection succeeds but file transfer errors

**Common causes:**

1. **Browser memory limits:**
   - Files > 500MB may fail in browsers
   - Use smaller chunk sizes for large files

2. **DataChannel buffer overflow:**
```javascript
// Check buffered amount
if (dataChannel.bufferedAmount > 16 * 1024 * 1024) {
  // Wait before sending more
  await new Promise(resolve => setTimeout(resolve, 100));
}
```

3. **Network instability:**
   - Connection drops during transfer
   - Add reconnection logic

**Solution - Add buffer management:**
```javascript
// In sendFileP2P function
const MAX_BUFFER = 16 * 1024 * 1024; // 16MB

async function waitForBuffer() {
  while (dataChannel.bufferedAmount > MAX_BUFFER) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Before each send:
await waitForBuffer();
dataChannel.send(chunk);
```

---

## R2 Fallback Issues

### ❌ Upload to R2 Fails

**Symptom:** Error when uploading file to R2

**Debugging:**
```bash
# Check worker logs
wrangler tail --status error

# Look for upload errors
```

**Common causes:**

1. **File too large:**
   - Workers free tier: 100MB max
   - Workers paid tier: 500MB max
   - Solution: Implement chunked upload

2. **R2 permissions:**
```bash
# Verify R2 access
wrangler r2 bucket list
```

3. **Missing form data:**
```javascript
// Ensure all required fields are present:
// - file
// - roomCode  
// - fileName
```

**Solution - Add error handling:**
```javascript
try {
  const formData = await request.formData();
  if (!formData.get('file')) {
    return new Response(JSON.stringify({ 
      error: 'Missing file' 
    }), { status: 400 });
  }
  // ... rest of upload logic
} catch (error) {
  console.error('Upload error:', error);
  return new Response(JSON.stringify({ 
    error: error.message 
  }), { status: 500 });
}
```

---

### ❌ Download from R2 Fails

**Symptom:** 404 or 500 error when downloading

**Debugging:**
```bash
# List R2 objects
wrangler r2 object list --bucket swiftdrop-files

# Check specific object
wrangler r2 object get --bucket swiftdrop-files --key <file-id>
```

**Common causes:**

1. **File expired:**
   - Default expiration: 24 hours
   - Check customMetadata.expiresAt

2. **File ID mismatch:**
   - Verify fileId in URL matches R2 key

3. **File not uploaded:**
   - Upload may have failed silently
   - Check upload response

---

## WebSocket Issues

### ❌ WebSocket Connection Refused

**Symptom:** WebSocket fails to connect, error in console

**Debugging:**
```javascript
ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = (event) => {
  console.log('Close code:', event.code);
  console.log('Close reason:', event.reason);
};
```

**Close codes:**
- `1000`: Normal closure
- `1006`: Abnormal closure (no close frame)
- `1011`: Server error

**Solutions:**

1. **Check Durable Object deployment:**
```bash
wrangler deployments list
# Should show successful deployment
```

2. **Verify binding:**
```toml
# In wrangler.toml
[[durable_objects.bindings]]
name = "ROOMS"  # Must match code
class_name = "SignalingRoom"  # Must match export
```

3. **Check URL format:**
```javascript
// Correct format:
wss://your-worker.workers.dev/ws?room=ABC123
// Not:
wss://your-worker.workers.dev/ws/ABC123
```

---

### ❌ WebSocket Messages Not Routing

**Symptom:** Peers connect but can't communicate

**Debugging:**
```javascript
// In Durable Object, add logging:
handleMessage(fromSessionId, data) {
  console.log(`From: ${fromSessionId.substring(0, 8)}`);
  console.log(`Type: ${data.type}`);
  console.log(`Sessions: ${this.sessions.size}`);
  console.log(`Target: ${data.target || 'broadcast'}`);
}
```

**Common causes:**

1. **Session ID mismatch:**
   - Sender using wrong target ID
   - Solution: Echo back session IDs

2. **Message format wrong:**
```javascript
// Must be valid JSON:
ws.send(JSON.stringify({
  type: 'offer',
  offer: sdp,
  target: recipientId  // Important!
}));
```

3. **Broadcast excluding all:**
```javascript
// Check excludeSessionId logic:
this.broadcast(message, senderId); // Correct
this.broadcast(message); // Wrong - no exclusion
```

---

## Performance Issues

### ❌ Slow File Transfers

**Symptom:** Transfer slower than expected

**Measurement:**
```javascript
// Add timing
const startTime = Date.now();
// ... transfer ...
const duration = (Date.now() - startTime) / 1000;
const speedMbps = (fileSize * 8) / (duration * 1000000);
console.log(`Speed: ${speedMbps.toFixed(2)} Mbps`);
```

**Optimization:**

1. **Adjust chunk size:**
```javascript
// Smaller chunks: More overhead, more reliable
chunkSize: 8192 // 8KB

// Larger chunks: Less overhead, faster
chunkSize: 65536 // 64KB
```

2. **Disable bufferedAmount checks:**
```javascript
// For reliable connections, skip waits
dataChannel.send(chunk); // No await
```

3. **Use concurrent transfers:**
```javascript
// Multiple DataChannels
const channels = [
  pc.createDataChannel('file-0'),
  pc.createDataChannel('file-1'),
  pc.createDataChannel('file-2')
];
```

---

### ❌ High Memory Usage

**Symptom:** Browser slows down or crashes with large files

**Solutions:**

1. **Don't store entire file in memory:**
```javascript
// Bad:
const fileData = await file.arrayBuffer();

// Good:
const reader = new FileReader();
const slice = file.slice(offset, offset + chunkSize);
reader.readAsArrayBuffer(slice);
```

2. **Clear received chunks:**
```javascript
// After download, clear memory
downloadReceivedFile();
receivedChunks = []; // Important!
receivedSize = 0;
```

3. **Add file size limits:**
```javascript
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
if (file.size > MAX_FILE_SIZE) {
  showError('File too large (max 200MB)');
  return;
}
```

---

## Browser-Specific Issues

### Chrome/Edge

**Known issues:**
- DataChannel buffer management strict
- May throttle large transfers

**Solutions:**
```javascript
// Add buffering checks
if (dataChannel.bufferedAmount > threshold) {
  await delay(100);
}
```

### Firefox

**Known issues:**
- Different ICE gathering behavior
- May need longer timeout

**Solutions:**
```javascript
// Increase timeout for Firefox
const isFirefox = navigator.userAgent.includes('Firefox');
p2pTimeout: isFirefox ? 10000 : 5000
```

### Safari

**Known issues:**
- WebRTC support limited
- May require user gesture for file access

**Solutions:**
```javascript
// Add user interaction check
uploadArea.addEventListener('click', (e) => {
  if (e.isTrusted) { // User-initiated
    fileInput.click();
  }
});
```

### Mobile Browsers

**Known issues:**
- Limited memory
- Background tab restrictions

**Solutions:**
- Reduce chunk size
- Add "keep alive" pings
- Warn users to keep tab active

---

## General Debugging Tools

### Enable Verbose Logging

```javascript
// Add at top of worker.js
const DEBUG = true;

function log(...args) {
  if (DEBUG) console.log('[SwiftDrop]', ...args);
}

// Use throughout code:
log('Peer connected:', sessionId);
```

### Browser DevTools

1. **Network tab:**
   - Check WebSocket frames
   - Monitor upload/download

2. **Console:**
   - Check for errors
   - View log messages

3. **Application tab:**
   - Check for service workers interfering
   - Clear storage if needed

### Wrangler Tools

```bash
# Real-time logs
wrangler tail

# Filter errors only
wrangler tail --status error

# JSON output for parsing
wrangler tail --format json | jq

# Check deployments
wrangler deployments list

# Check R2 usage
wrangler r2 object list --bucket swiftdrop-files
```

---

## Getting Help

If you're still stuck:

1. **Check browser console** for specific errors
2. **Check worker logs** with `wrangler tail`
3. **Try different browser/network** to isolate issue
4. **Search Cloudflare Community** for similar issues
5. **File issue** with:
   - Browser/OS version
   - Error messages
   - Steps to reproduce
   - Console logs

---

## Prevention Checklist

Before deploying:

- [ ] R2 bucket created and accessible
- [ ] Durable Object deployed successfully
- [ ] Account ID correct in wrangler.toml
- [ ] Tested locally with `wrangler dev`
- [ ] Verified WebRTC works in target browsers
- [ ] File size limits appropriate
- [ ] Error handling in place
- [ ] Logging enabled for debugging

After deploying:

- [ ] Test P2P from different networks
- [ ] Test fallback by disabling WebRTC
- [ ] Monitor logs for errors
- [ ] Check R2 storage usage
- [ ] Verify cleanup of expired files
- [ ] Test on mobile devices
- [ ] Load test with concurrent users
