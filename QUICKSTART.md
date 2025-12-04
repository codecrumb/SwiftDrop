# SwiftDrop - Quick Start Guide

Get SwiftDrop up and running in 5 minutes.

## TL;DR

```bash
# 1. Install Wrangler
npm install -g wrangler

# 2. Login to Cloudflare
wrangler login

# 3. Create R2 bucket
wrangler r2 bucket create swiftdrop-files

# 4. Deploy
wrangler deploy

# 5. Open the URL and start transferring files! 🚀
```

## What You Get

- **P2P file transfer** - Direct browser-to-browser, nothing stored on server
- **Automatic fallback** - If P2P fails, uses cloud storage (R2)
- **Simple interface** - Just share a 6-digit code
- **No registration** - Works immediately
- **Free tier** - Cloudflare's free tier handles most use cases

## 5-Minute Setup

### 1. Prerequisites

- Node.js installed ([download](https://nodejs.org/))
- Cloudflare account ([signup](https://dash.cloudflare.com/sign-up))

### 2. Install Wrangler

```bash
npm install -g wrangler
```

### 3. Login

```bash
wrangler login
```

This opens your browser to authorize Wrangler.

### 4. Clone/Download Files

You need these 2 files:
- `worker.js` - Main application code
- `wrangler.toml` - Configuration

### 5. Update Configuration

Edit `wrangler.toml`:

```toml
account_id = "your-account-id"  # Get with: wrangler whoami
```

### 6. Create Storage

```bash
wrangler r2 bucket create swiftdrop-files
```

### 7. Deploy

```bash
wrangler deploy
```

**Done!** 🎉

You'll get a URL like: `https://swiftdrop.your-name.workers.dev`

## First Transfer

### As Sender:
1. Open the deployed URL
2. Note the 6-digit code (e.g., "ABC123")
3. Click to select a file
4. Share code with receiver

### As Receiver:
1. Open the same URL
2. Click "📥 Receive File"
3. Enter the 6-digit code
4. Click "Join Room"

**Transfer starts automatically!**

## How It Works

```
┌─────────┐                           ┌─────────┐
│ Sender  │──── WebRTC P2P ────────────│Receiver │
└─────────┘     (Direct, Fast)        └─────────┘
     │                                      │
     │        If P2P fails:                 │
     │                                      │
     └────────── R2 Cloud ─────────────────┘
              (Fallback, Reliable)
```

- **Try P2P first** (5 second timeout)
- **Fall back to cloud** if P2P fails
- **No data stored** if P2P succeeds

## Testing

### Test P2P Mode:
1. Open 2 browser tabs
2. Different networks = more realistic test
3. Should connect in < 5 seconds

### Test Fallback Mode:
1. Disable WebRTC in browser settings
2. Transfer should use cloud storage
3. Takes longer but more reliable

## Common Issues

### ❌ "No account_id found"
```bash
# Get your account ID
wrangler whoami

# Update wrangler.toml
```

### ❌ "R2 bucket not found"
```bash
wrangler r2 bucket create swiftdrop-files
```

### ❌ P2P not working?
- Try different network
- Try different browser
- Fallback still works!

## What's Free?

**Cloudflare Free Tier includes:**
- ✅ 100,000 Worker requests/day
- ✅ 10 GB R2 storage
- ✅ 1 million R2 writes/month
- ✅ 10 million R2 reads/month

**Typical usage:**
- 1000 files/day = well within limits
- Most transfers use P2P = no R2 usage
- Fallback only when needed

## Next Steps

### Add Custom Domain
```bash
wrangler domains add yourdomain.com
```

### Monitor Usage
```bash
wrangler tail  # Live logs
```

### Update Code
```bash
# Edit worker.js
wrangler deploy  # Redeploy
```

## Key Features

✅ **Privacy** - P2P transfers never touch server  
✅ **Speed** - Direct peer-to-peer = fastest possible  
✅ **Reliability** - Automatic fallback if P2P fails  
✅ **Simplicity** - Just share a 6-digit code  
✅ **Cost-effective** - Free tier handles most use  

## Limits

**Browser limits:**
- ~500MB per file (memory constraint)
- Larger files possible but may be slow

**Worker limits:**
- 100MB upload (free tier)
- 500MB upload (paid tier)

**No account limits:**
- No file count limits
- No bandwidth limits
- No user limits

## Files Overview

```
swiftdrop/
├── worker.js          # Main application (Backend + Frontend)
├── wrangler.toml      # Cloudflare configuration
├── README.md          # Full documentation
├── DEPLOYMENT.md      # Detailed deployment guide
├── TROUBLESHOOTING.md # Debug common issues
└── package.json       # NPM scripts (optional)
```

## Commands Cheat Sheet

```bash
# Development
wrangler dev                    # Local testing
wrangler dev --remote          # Remote testing

# Deployment
wrangler deploy                # Deploy to production
wrangler deployments list      # View deployments
wrangler rollback <id>         # Rollback deployment

# Monitoring
wrangler tail                  # Live logs
wrangler tail --status error   # Error logs only

# R2 Management
wrangler r2 bucket list               # List buckets
wrangler r2 object list --bucket X    # List objects
wrangler r2 bucket delete X           # Delete bucket

# Cleanup
wrangler delete                # Delete worker
```

## Pro Tips

1. **Test locally first:**
   ```bash
   wrangler dev
   ```

2. **Use custom domain:**
   - Easier to remember
   - More professional
   - Free on Cloudflare

3. **Monitor logs:**
   ```bash
   wrangler tail
   ```

4. **Set up alerts:**
   - Cloudflare dashboard → Workers → Analytics
   - Get notified of errors

5. **Bookmark deployment URL:**
   - Share with team
   - Quick access

## Need Help?

📚 **Documentation:**
- [README.md](./README.md) - Full docs
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Step-by-step deployment
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Debug issues

🔗 **Resources:**
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
- [WebRTC Documentation](https://webrtc.org/)

💬 **Community:**
- [Cloudflare Community](https://community.cloudflare.com/)
- [Cloudflare Discord](https://discord.gg/cloudflaredev)

---

**That's it!** 🎉 You now have a fully functional P2P file transfer app running on Cloudflare's edge network.

Share your deployment URL and start transferring files instantly!
