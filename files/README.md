# SwiftDrop - P2P File Transfer with Cloud Fallback

A modern, serverless file-sharing application built on Cloudflare Workers that prioritizes direct peer-to-peer (P2P) transfers with automatic cloud storage fallback.

## 🌟 Features

- **P2P First**: Direct browser-to-browser file transfer using WebRTC DataChannels
- **Automatic Fallback**: Seamlessly falls back to R2 cloud storage if P2P fails
- **No Server Storage**: Files transferred P2P never touch the server
- **Real-time Signaling**: WebSocket-based signaling via Cloudflare Durable Objects
- **Simple Room Codes**: 6-character codes for easy peer connection
- **Progress Tracking**: Real-time transfer progress for both sender and receiver
- **Modern UI**: Clean, responsive interface with status indicators

## 🏗️ Architecture

```
┌─────────────┐                    ┌─────────────┐
│   Sender    │                    │  Receiver   │
│   Browser   │                    │   Browser   │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  ┌────────────────────────────┐ │
       └──┤  WebSocket Signaling       ├─┘
          │  (Durable Object)           │
          │  - Offer/Answer Exchange    │
          │  - ICE Candidates           │
          └────────────────────────────┘
       │                                  │
       │  ┌────────────────────────────┐ │
       └──┤  WebRTC P2P Connection     ├─┘
          │  (DataChannel)              │
          │  - Direct file transfer     │
          │  - No server intermediary   │
          └────────────────────────────┘
       │                                  │
       │  ┌────────────────────────────┐ │
       └──┤  R2 Fallback (if P2P fails)├─┘
          │  - Upload to R2             │
          │  - Download link via WS     │
          └────────────────────────────┘
```

### Components

1. **Cloudflare Worker** (`worker.js`)
   - Serves the HTML/CSS/JS UI
   - Handles WebSocket upgrade requests
   - Manages R2 upload/download endpoints

2. **Durable Object** (`SignalingRoom`)
   - One instance per room code
   - Manages WebSocket connections
   - Routes WebRTC signaling messages between peers
   - Handles peer join/leave events

3. **R2 Bucket** (`swiftdrop-files`)
   - Fallback storage for files when P2P fails
   - 24-hour expiration on stored files
   - Metadata tracking (uploader, timestamp, filename)

4. **Client-Side Logic**
   - WebRTC PeerConnection management
   - DataChannel file transfer with chunking
   - Automatic fallback detection and handling
   - Progress tracking and UI updates

## 🚀 Deployment

### Prerequisites

- Node.js 16+ installed
- Cloudflare account
- Wrangler CLI installed: `npm install -g wrangler`
- Authenticated with Wrangler: `wrangler login`

### Step 1: Create R2 Bucket

```bash
# Create the R2 bucket
wrangler r2 bucket create swiftdrop-files

# Verify it was created
wrangler r2 bucket list
```

### Step 2: Deploy the Worker

```bash
# Deploy to Cloudflare
wrangler deploy

# You'll see output like:
# Published swiftdrop (X.XX sec)
#   https://swiftdrop.your-subdomain.workers.dev
```

### Step 3: Test the Application

1. Open the deployed URL in two browser windows/tabs
2. Window 1 (Sender):
   - A 6-digit room code is automatically generated
   - Click to select a file
   - Wait for receiver to join
3. Window 2 (Receiver):
   - Click "📥 Receive File"
   - Enter the room code from Window 1
   - Click "Join Room"
4. Transfer begins automatically (P2P if possible, fallback if needed)

## 🔧 Configuration

### Timeout Settings

In `worker.js`, you can adjust the P2P connection timeout:

```javascript
const CONFIG = {
  p2pTimeout: 5000, // 5 seconds (default)
  chunkSize: 16384  // 16KB chunks
};
```

### File Expiration

Files stored in R2 expire after 24 hours by default. Modify in the upload handler:

```javascript
expiresAt: (timestamp + 24 * 60 * 60 * 1000).toString() // 24 hours
```

### STUN Servers

The default STUN servers are Google's public servers. You can add your own:

```javascript
const CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:your-stun-server.com:3478' }
  ]
};
```

## 📡 API Endpoints

### `GET /`
Serves the HTML UI

### `GET /ws?room=<CODE>`
WebSocket endpoint for signaling
- Upgrades to WebSocket
- Routes to appropriate Durable Object instance
- Manages peer connections

### `POST /upload`
Fallback upload endpoint
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `file`: File blob
  - `roomCode`: 6-character room code
  - `fileName`: Original filename
- **Response**: `{ success: true, fileId: "...", downloadUrl: "/download/..." }`

### `GET /download/:fileId`
Fallback download endpoint
- Streams file from R2
- Sets proper Content-Disposition headers
- Checks expiration and deletes expired files

## 🔍 How It Works

### P2P Transfer Flow

1. **Sender** generates room code, connects to signaling server
2. **Receiver** enters room code, connects to same signaling server
3. **Signaling** server notifies both peers of each other's presence
4. **Sender** creates WebRTC PeerConnection and DataChannel
5. **Sender** generates SDP offer, sends via signaling server
6. **Receiver** receives offer, creates answer, sends back
7. **Both** exchange ICE candidates for NAT traversal
8. **DataChannel** opens (if successful within 5 seconds)
9. **Sender** sends file metadata, then chunks over DataChannel
10. **Receiver** receives chunks, reassembles file, triggers download

### Fallback Flow (if P2P fails)

1. P2P connection timeout (5 seconds) expires
2. **Sender** uploads file to R2 via `/upload` endpoint
3. **Sender** sends download link to receiver via signaling
4. **Receiver** shows download button with link to `/download/:fileId`
5. **Receiver** clicks download, file streams from R2

## 🛠️ Development

### Local Testing

```bash
# Start local development server
wrangler dev

# Access at http://localhost:8787
```

**Note**: Local testing with two separate browsers is tricky. For full testing:
1. Deploy to Cloudflare
2. Use the deployed URL for testing
3. Or use `wrangler dev --remote` for remote development mode

### Viewing Logs

```bash
# Tail production logs
wrangler tail

# View specific deployment logs
wrangler tail --format json
```

### Debugging

Enable detailed logging in the worker:

```javascript
// In SignalingRoom class
console.log(`[Room] Message type: ${data.type}`);
console.log(`[Room] Peer count: ${this.sessions.size}`);
```

## 🔐 Security Considerations

1. **Room Codes**: Currently 6 characters (~2 billion combinations)
   - Consider increasing length for production
   - Add rate limiting on room creation

2. **File Size Limits**: No server-side limits currently enforced
   - Add max file size validation
   - Consider Worker memory limits (~128MB)

3. **R2 Expiration**: Files expire after 24 hours
   - Consider implementing cleanup worker
   - Add lifecycle policies to R2 bucket

4. **CORS**: Currently allows all origins
   - Restrict to your domain in production

## 📊 Performance

- **P2P Transfer**: Limited only by peer bandwidth and browser memory
- **Fallback Upload**: Limited by Cloudflare Worker limits
  - Max request size: 100MB (Workers Free), 500MB (Workers Paid)
  - Consider chunked uploads for very large files
- **Concurrent Connections**: Durable Objects can handle thousands of WebSocket connections

## 🐛 Troubleshooting

### P2P Always Failing?

1. Check browser console for WebRTC errors
2. Verify STUN servers are accessible
3. Test from different networks (corporate firewalls may block WebRTC)
4. Try different browsers (Chrome, Firefox have best WebRTC support)

### Files Not Uploading to R2?

1. Verify R2 bucket exists: `wrangler r2 bucket list`
2. Check Worker logs: `wrangler tail`
3. Verify binding name matches `wrangler.toml`

### WebSocket Connection Failing?

1. Check Durable Object is deployed: `wrangler deployments list`
2. Verify migration ran successfully
3. Check for CORS issues in browser console

## 📝 License

MIT License - feel free to use for personal or commercial projects

## 🤝 Contributing

Contributions welcome! Areas for improvement:

- [ ] Add file encryption for P2P transfers
- [ ] Implement resumable uploads for fallback
- [ ] Add progress indicators for multi-file transfers
- [ ] Create admin panel for R2 cleanup
- [ ] Add authentication/authorization
- [ ] Implement rate limiting
- [ ] Add telemetry and analytics
- [ ] Mobile app using same backend

## 🙏 Acknowledgments

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)

Inspired by:
- [Cloudflare Workers Chat Demo](https://github.com/cloudflare/workers-chat-demo)
- [Veet Video Call App](https://github.com/megaconfidence/veet)
